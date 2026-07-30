//! 범용 스케줄러 — 트리거 산술·잡 원장·lease·backoff, 그리고 발화 경로.
//!
//! 한 작업(Job)은 트리거 하나에 registry 명령 하나를 묶는다. 트리거 넷: At(절대 1회)·
//! Every(고정 간격)·Cron(5필드, UTC)·Reconcile(타이머 없는 순수 사건 — poke 시에만).
//!
//! 견고성: 영속(시간 기반만 — crash 복구), lease(한 작업은 자기 자신과 동시에 두 번 안 돈다),
//! backoff(발화 명령이 실패면 지수 재시도).
//!
//! **창도 프레임워크 타입도 모른다.** 발화는 계약 둘만 만진다 — 명령 중개(CommandDispatch)와
//! 상태(ScheduleState). 프레임워크에 남는 것은 조립(상태 조회·영속)뿐이다.
//!
//! 폴링 비선호 — 정공법(sleep-until-due·완료 트리거·사건 poke)이 메인이다. 주기 틱·안전망
//! 폴링은 두지 않는다.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use soksak_core::command_dispatch::CommandDispatch;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 예약 명세는 코어가 단일 진실이다 — 스케줄러와 서비스 원장이 둘 다 이 모양을 쓴다.
pub use soksak_core::schedule_spec::{default_concurrency, JobSpec, Retry, Trigger};


const DEFAULT_TIMEOUT_MS: u64 = 30_000;

// ── 순수 스케줄 계산 ─────────────────────────────────────────────────────────

// recurring 트리거의 `after` 직후 다음 발화 시각. At/Reconcile 은 주기가 없으므로 None.
fn next_after(trigger: &Trigger, after: u64) -> Option<u64> {
    match trigger {
        Trigger::At { .. } => None,
        Trigger::Reconcile => None,
        Trigger::Every { every_ms, anchor } => {
            let e = (*every_ms).max(1);
            let base = anchor.unwrap_or(0);
            if after < base {
                return Some(base);
            }
            let k = (after - base) / e + 1;
            Some(base + k * e)
        }
        Trigger::Cron { expr } => cron::cron_next(expr, after),
    }
}

// 등록 직후 첫 발화 시각. At=그 시각(과거면 즉시), recurring=now 이후 첫 슬롯, Reconcile=None(타이머 없음).
fn first_fire(trigger: &Trigger, now: u64) -> Option<u64> {
    match trigger {
        Trigger::At { at } => Some(*at),
        Trigger::Reconcile => None,
        _ => next_after(trigger, now),
    }
}

// 발화(due=last_due) 후 재무장 시각. At=None(1회), recurring=last_due 이후 다음 슬롯(드리프트 없음),
// Reconcile=None. 실행이 한 주기보다 길었으면 다음 슬롯이 과거라 즉시 1회 catch-up(running 게이트가 중첩 차단).
fn rearm(trigger: &Trigger, last_due: u64) -> Option<u64> {
    next_after(trigger, last_due)
}

// 지수 backoff — attempt 1부터. base*2^(attempt-1), max_ms 상한. 시프트 포화로 overflow 방지.
fn backoff_delay(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let shift = (attempt.saturating_sub(1)).min(20);
    base_ms.saturating_mul(1u64 << shift).min(max_ms)
}

// 프로세스-생존 작업의 발화 중 대기 판정. 살아있음 = 프로세스 alive(main.js 가 onExit 까지 reply 보류).
// 코어는 staleness·heartbeat 를 안 본다 — reply 가 곧 ground truth(tool 실행 중에도 프로세스 alive → 오판 0).
//   Forever  — zombie_backstop None = reply/cancel 까지 무한 대기.
//   Wait(d)  — claim+backstop 까지 d 남음. 그 안에 reply 오면 done.
//   Backstop — backstop 경과(reply 영영 없음) = 좀비. ok:false → backoff.
#[derive(Debug, PartialEq)]
enum ProcWait {
    Forever,
    Wait(u64),
    Backstop,
}

fn process_wait(now: u64, claim: u64, zombie_backstop_ms: Option<u64>) -> ProcWait {
    match zombie_backstop_ms {
        None => ProcWait::Forever,
        Some(b) => {
            let deadline = claim.saturating_add(b);
            if now >= deadline {
                ProcWait::Backstop
            } else {
                ProcWait::Wait(deadline - now)
            }
        }
    }
}

// ── cron 평가(5필드, UTC) ────────────────────────────────────────────────────
mod cron {
    // "분 시 일 월 요일". 표준 Vixie 의미 — 일·요일이 둘 다 제한되면 OR 매칭. 평가는 UTC(결정적·DST 무관).
    pub struct Fields {
        min: u64,  // bit i (0..59)
        hour: u64, // bit i (0..23)
        dom: u64,  // bit i (1..31)
        mon: u64,  // bit i (1..12)
        dow: u64,  // bit i (0..6, 0=일)
        dom_star: bool,
        dow_star: bool,
    }

    // 한 필드를 비트마스크로. "*" | "*/s" | "a" | "a-b" | "a-b/s" 의 콤마 리스트. 범위 밖이면 None.
    pub fn parse_field(spec: &str, lo: u64, hi: u64) -> Option<(u64, bool)> {
        let mut mask: u64 = 0;
        let mut is_star = false;
        for tok in spec.split(',') {
            let tok = tok.trim();
            if tok.is_empty() {
                return None;
            }
            // step 분리(a-b/s 또는 */s).
            let (range_part, step) = match tok.split_once('/') {
                Some((r, s)) => (r, s.parse::<u64>().ok().filter(|&v| v >= 1)?),
                None => (tok, 1),
            };
            let (start, end) = if range_part == "*" {
                if step == 1 {
                    is_star = true;
                }
                (lo, hi)
            } else if let Some((a, b)) = range_part.split_once('-') {
                (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?)
            } else {
                let v = range_part.parse::<u64>().ok()?;
                (v, v)
            };
            if start < lo || end > hi || start > end {
                return None;
            }
            let mut v = start;
            while v <= end {
                mask |= 1u64 << v;
                v += step;
            }
        }
        if mask == 0 {
            return None;
        }
        Some((mask, is_star))
    }

    pub fn parse(expr: &str) -> Option<Fields> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            return None;
        }
        let (min, _) = parse_field(parts[0], 0, 59)?;
        let (hour, _) = parse_field(parts[1], 0, 23)?;
        let (dom, dom_star) = parse_field(parts[2], 1, 31)?;
        let (mon, _) = parse_field(parts[3], 1, 12)?;
        // 요일은 0·7 둘 다 일요일 — 7 비트를 0 으로 접는다.
        let (mut dow, dow_star) = parse_field(parts[4], 0, 7)?;
        if dow & (1 << 7) != 0 {
            dow = (dow & !(1 << 7)) | 1;
        }
        Some(Fields {
            min,
            hour,
            dom,
            mon,
            dow,
            dom_star,
            dow_star,
        })
    }

    // Howard Hinnant civil_from_days — 1970-01-01 기준 일수 → (월, 일). 연도는 불필요.
    pub fn month_day(days: i64) -> (u32, u32) {
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64; // [0,146096]
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0,399]
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0,365]
        let mp = (5 * doy + 2) / 153; // [0,11]
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1,31]
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1,12]
        (m, d)
    }

    // 1970-01-01 = 목(4). 0=일.
    pub fn weekday(days: i64) -> u32 {
        (((days % 7) + 4).rem_euclid(7)) as u32
    }

    pub fn day_match(f: &Fields, d: u32, wd: u32) -> bool {
        let dom_hit = (f.dom >> d) & 1 == 1;
        let dow_hit = (f.dow >> wd) & 1 == 1;
        match (f.dom_star, f.dow_star) {
            (true, true) => true,
            (false, true) => dom_hit,
            (true, false) => dow_hit,
            (false, false) => dom_hit || dow_hit, // Vixie OR
        }
    }

    // after_ms 직후(strictly) 다음 발화 ms. 파싱 실패/5년 내 매칭 없음이면 None.
    pub fn cron_next(expr: &str, after_ms: u64) -> Option<u64> {
        let f = parse(expr)?;
        let start_min = after_ms / 60_000 + 1; // 다음 분 경계(엄격히 이후).
        let mut em = start_min as i64;
        let cap = em + 366 * 5 * 24 * 60; // ~5년 상한(불가능 spec 보호).
        while em < cap {
            let days = em.div_euclid(1440);
            let tod = em.rem_euclid(1440);
            let (mo, d) = month_day(days);
            let wd = weekday(days);
            if (f.mon >> mo) & 1 == 0 || !day_match(&f, d, wd) {
                em += 1440 - tod; // 다음 날 00:00 으로 점프.
                continue;
            }
            let h = (tod / 60) as u32;
            if (f.hour >> h) & 1 == 0 {
                em += 60 - (tod % 60); // 다음 시 :00 으로 점프.
                continue;
            }
            let mi = (tod % 60) as u32;
            if (f.min >> mi) & 1 == 1 {
                return Some(em as u64 * 60_000);
            }
            em += 1;
        }
        None
    }
}

// ── Job 상태 ─────────────────────────────────────────────────────────────────

struct Job {
    id: String,
    trigger: Trigger,
    command: String,
    params: Value,
    retry: Option<Retry>,
    concurrency: u32,
    owner: Option<String>, // 소유자(플러그인 id) — owner 축 수명 관리(cancel_by_owner)의 키.
    timeout_ms: u64,       // 비-프로세스 발화 응답 대기 상한.
    process_lease: bool,   // true=프로세스-생존 lease(reply=프로세스 exit 까지 대기).
    zombie_backstop_ms: Option<u64>, // 프로세스 작업 좀비 backstop(None=무한).
    epoch: u64,            // 이 job 인스턴스 세대. 전체 교체(재생성) 시 바뀜 — 발화 중 fire 가
    // 자기 epoch 와 대조해 교체된 job 을 오염시키지 않게(complete/set_seq).
    // 런타임:
    next_at: Option<u64>, // 다음 예정 발화(None=대기/완료).
    last_due: u64,        // 마지막으로 claim 된 예정 시각(드리프트 없는 re-arm 기준).
    seq: Option<u64>,     // 발화 중 ipc pending seq(cancel 이 채널 끊어 wait 깨움).
    running: bool,        // lease 보유 중(중첩 차단).
    pending: bool,        // 실행 중 다음 발화 요청 도착(완료 후 1회로 합침).
    attempt: u32,         // 현재 backoff 재시도 회차.
}

// 발화 대상(락 밖 dispatch 용).
#[derive(Clone)]
pub struct Fire {
    id: String,
    command: String,
    params: Value,
    timeout_ms: u64,
    process_lease: bool, // true=fire_process(프로세스-생존 lease).
    zombie_backstop_ms: Option<u64>,
    claimed_at: u64, // claim 시각 = 좀비 backstop 기준.
    due: u64,        // 예정 발화 시각 — 같은 due 의 재시도가 공유하는 idempotency 키 축(PS12).
    epoch: u64, // claim 시 job 세대 — complete/set_seq 가 이걸로 교체된 job 을 건드리지 않는다.
}

// 완료 후 후처리 결과 — removed 면 영속에서도 제거해야 한다(At 1회 종료).
pub struct Completion {
    pub removed: bool,
}

// list 노출 형태 — 트리거·런타임 포함.
#[derive(serde::Serialize)]
pub struct JobView {
    pub id: String,
    pub trigger: Trigger,
    pub command: String,
    pub params: Value,
    pub next_at: Option<u64>,
    pub running: bool,
    pub concurrency: u32,
}

#[derive(Default)]
struct Inner {
    jobs: HashMap<String, Job>,
    seq: u64,        // 자동 id 생성용.
    next_epoch: u64, // job 인스턴스 세대 — 전체 교체마다 +1(같은 id 재생성도 구분).
    started: bool,
}

// 다음 깨울 시각 — running 작업은 제외(완료가 notify 로 깨운다). None=대기 중 타이머 없음.
fn earliest_wake(jobs: &HashMap<String, Job>) -> Option<u64> {
    jobs.values()
        .filter(|j| !j.running)
        .filter_map(|j| j.next_at)
        .min()
}

pub struct ScheduleState {
    inner: Mutex<Inner>,
    cv: Condvar,
}

impl Default for ScheduleState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            cv: Condvar::new(),
        }
    }
}

impl ScheduleState {
    // 등록(멱등 — id 지정 시 교체). 첫 발화 시각 계산해 무장. 반환=id. 영속은 호출 명령층이 담당.
    pub fn register(&self, spec: JobSpec, now: u64) -> String {
        let mut inner = self.inner.lock().unwrap();
        let id = spec.id.unwrap_or_else(|| {
            inner.seq += 1;
            format!("sch-{}", inner.seq)
        });
        // 발화 중(running) 재등록 = config 만 갱신, 런타임(running/seq/next_at/epoch) 보존. 덮어쓰면(아래)
        // running 이 false 로 리셋돼 claim_due 가 2차 동시 발화 → 단일 in-flight lease 가 깨진다(예: 긴
        // process_lease exec 도중 플러그인 re-activate). 강제 재시작이 필요하면 cancel 후 register 한다.
        if let Some(job) = inner.jobs.get_mut(&id) {
            if job.running {
                job.trigger = spec.trigger;
                job.command = spec.command;
                job.params = spec.params;
                job.retry = spec.retry;
                job.concurrency = spec.concurrency.max(1);
                job.owner = spec.owner;
                job.timeout_ms = spec.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
                job.process_lease = spec.process_lease;
                job.zombie_backstop_ms = spec.zombie_backstop_ms;
                // epoch·running·seq·last_due·pending·attempt·next_at(None) 보존 — live fire 가 그대로 완주.
                drop(inner);
                self.cv.notify_all();
                return id;
            }
        }
        // 신규 또는 idle: 전체 교체. 새 epoch 부여 — cancel+register race 로 이전 fire 가 살아 있어도
        // 그 fire 의 complete/set_seq 가 epoch mismatch 로 no-op → 재생성 job 오염 차단.
        inner.next_epoch += 1;
        let epoch = inner.next_epoch;
        let next_at = first_fire(&spec.trigger, now);
        inner.jobs.insert(
            id.clone(),
            Job {
                id: id.clone(),
                trigger: spec.trigger,
                command: spec.command,
                params: spec.params,
                retry: spec.retry,
                concurrency: spec.concurrency.max(1),
                owner: spec.owner,
                timeout_ms: spec.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
                process_lease: spec.process_lease,
                zombie_backstop_ms: spec.zombie_backstop_ms,
                epoch,
                next_at,
                last_due: 0,
                seq: None,
                running: false,
                pending: false,
                attempt: 0,
            },
        );
        drop(inner);
        self.cv.notify_all();
        id
    }

    pub fn cancel(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let removed = inner.jobs.remove(id).is_some();
        drop(inner);
        if removed {
            self.cv.notify_all();
        }
        removed
    }

    // owner(플러그인 id)의 잡 전부 취소 — 서비스 unbind·플러그인 소멸의 단일 수명 회수 경로
    // (PS14: 서비스 스케줄은 절대 고아가 될 수 없다). 반환=제거 수.
    pub fn cancel_by_owner(&self, owner: &str) -> usize {
        let Ok(mut inner) = self.inner.lock() else {
            return 0;
        };
        let doomed: Vec<String> = inner
            .jobs
            .values()
            .filter(|j| j.owner.as_deref() == Some(owner))
            .map(|j| j.id.clone())
            .collect();
        for id in &doomed {
            inner.jobs.remove(id);
        }
        drop(inner);
        if !doomed.is_empty() {
            self.cv.notify_all();
        }
        doomed.len()
    }

    // owner 의 Reconcile 잡 즉시 발화 — bind 직후 부팅 스캔·리스폰 되먹임(PS10·PS14).
    // 전역 poke(None)와 같은 의미론을 owner 로 스코프한다(running 이면 pending 합침).
    pub fn poke_owner(&self, owner: &str, now: u64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let mut woke = false;
        for job in inner.jobs.values_mut() {
            if job.owner.as_deref() != Some(owner) || !matches!(job.trigger, Trigger::Reconcile) {
                continue;
            }
            if job.running {
                job.pending = true;
            } else {
                job.next_at = Some(now);
            }
            woke = true;
        }
        drop(inner);
        if woke {
            self.cv.notify_all();
        }
    }

    pub fn list(&self) -> Vec<JobView> {
        let inner = self.inner.lock().unwrap();
        let mut v: Vec<JobView> = inner
            .jobs
            .values()
            .map(|j| JobView {
                id: j.id.clone(),
                trigger: j.trigger.clone(),
                command: j.command.clone(),
                params: j.params.clone(),
                next_at: j.next_at,
                running: j.running,
                concurrency: j.concurrency,
            })
            .collect();
        // next_at 오름차순(None=뒤). 안정적 표시.
        v.sort_by(|a, b| match (a.next_at, b.next_at) {
            (Some(x), Some(y)) => x.cmp(&y).then(a.id.cmp(&b.id)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.id.cmp(&b.id),
        });
        v
    }

    // 즉시 발화 요청 — id 지정 시 그 작업, 미지정 시 모든 Reconcile 작업. running 이면 pending(완료 후 합침).
    pub fn poke(&self, id: Option<&str>, now: u64) {
        let mut inner = self.inner.lock().unwrap();
        let mut woke = false;
        for job in inner.jobs.values_mut() {
            let target = match id {
                Some(t) => job.id == t,
                None => matches!(job.trigger, Trigger::Reconcile),
            };
            if !target {
                continue;
            }
            if job.running {
                job.pending = true;
            } else {
                job.next_at = Some(now);
            }
            woke = true;
        }
        drop(inner);
        if woke {
            self.cv.notify_all();
        }
    }

    // due(next_at<=now·!running) 작업을 claim — running 표시, next_at 비움(완료 시 재계산), last_due 기록.
    pub fn claim_due(&self, now: u64) -> Vec<Fire> {
        let mut inner = self.inner.lock().unwrap();
        let mut fires = vec![];
        for job in inner.jobs.values_mut() {
            if job.running {
                continue;
            }
            if let Some(at) = job.next_at {
                if at <= now {
                    job.running = true;
                    job.last_due = at;
                    job.next_at = None; // 실행 중 재claim 차단(완료에서 재무장).
                    job.seq = None;
                    fires.push(Fire {
                        id: job.id.clone(),
                        command: job.command.clone(),
                        params: job.params.clone(),
                        timeout_ms: job.timeout_ms,
                        process_lease: job.process_lease,
                        zombie_backstop_ms: job.zombie_backstop_ms,
                        claimed_at: now,
                        due: at,
                        epoch: job.epoch,
                    });
                }
            }
        }
        fires
    }

    // 다음 깨울 시각(테스트 핀) — running 작업 제외 불변식을 고정. park_until_due 와 같은 헬퍼를 쓴다.
    #[cfg(test)]
    pub fn next_wake(&self, _now: u64) -> Option<u64> {
        earliest_wake(&self.inner.lock().unwrap().jobs)
    }

    // 다음 due 까지 park — due 판정과 wait 를 한 번의 락 보유로 묶어 missed-wakeup 을 막는다(완료/poke/
    // register 는 같은 락으로 next_at 을 세팅하므로, 우리 판정 전이면 즉시 재루프, 후면 notify 가 깨운다).
    // 이미 due 면 즉시 반환(루프가 claim). 타이머 없으면 1시간 캡 후 깬다(notify 가 정상 경로).
    pub fn park_until_due(&self) {
        let inner = self.inner.lock().unwrap();
        let now = now_ms();
        let any_due = inner
            .jobs
            .values()
            .any(|j| !j.running && j.next_at.is_some_and(|a| a <= now));
        if any_due {
            return;
        }
        let wait = match earliest_wake(&inner.jobs) {
            Some(at) => Duration::from_millis(at.saturating_sub(now).clamp(1, 3_600_000)),
            None => Duration::from_secs(3_600),
        };
        let _ = self.cv.wait_timeout(inner, wait);
    }

    // 발화 완료 후처리 — lease 해제 + 재시도/재무장/coalesce + At 종료 정리. epoch 가 현재 job 과 다르면
    // (재등록 전체교체·cancel+register 로 인스턴스가 바뀜) 이 fire 는 orphan → no-op(교체된 job 안 건드림).
    pub fn complete(&self, id: &str, ok: bool, now: u64, epoch: u64) -> Completion {
        let mut inner = self.inner.lock().unwrap();
        let Some(job) = inner.jobs.get_mut(id) else {
            return Completion { removed: false };
        };
        if job.epoch != epoch {
            return Completion { removed: false }; // orphaned old fire — 현재 인스턴스 보호.
        }
        job.running = false;
        job.seq = None; // 발화 종료 — seq 정리(cancel 이 더는 이 fire 를 깨울 필요 없음).
                        // 실패 + 재시도 여력 → backoff 재시도 예약(정상 일정 대신 우선).
        if !ok {
            if let Some(retry) = job.retry.clone() {
                if job.attempt < retry.max {
                    job.attempt += 1;
                    let d = backoff_delay(job.attempt, retry.base_ms, retry.max_ms);
                    job.next_at = Some(now + d);
                    drop(inner);
                    self.cv.notify_all();
                    return Completion { removed: false };
                }
            }
        }
        // 성공/재시도 소진 → 재무장(recurring=다음 슬롯, At=None). last_due 기준이라 드리프트 없음.
        job.attempt = 0;
        job.next_at = rearm(&job.trigger, job.last_due);
        // 실행 중 도착한 발화 요청 합침(reconcile poke 등) — 1회로.
        if job.pending {
            job.pending = false;
            job.next_at = Some(now);
        }
        // At 1회 종료(재무장 없음·대기 없음) → 제거(영속도 제거 대상).
        let removed = job.next_at.is_none() && matches!(job.trigger, Trigger::At { .. });
        if removed {
            inner.jobs.remove(id);
        }
        drop(inner);
        self.cv.notify_all();
        Completion { removed }
    }

    // 발화 중 seq 기록 — epoch 일치 시만(교체된 job 의 seq 를 덮어쓰지 않게).
    pub fn set_seq(&self, id: &str, seq: u64, epoch: u64) {
        if let Some(j) = self.inner.lock().unwrap().jobs.get_mut(id) {
            if j.epoch == epoch {
                j.seq = Some(seq);
            }
        }
    }

    // 발화 중 seq 회수(cancel 이 채널 끊어 wait 깨우는 용). 작업 제거 전에 호출.
    pub fn take_seq(&self, id: &str) -> Option<u64> {
        self.inner
            .lock()
            .unwrap()
            .jobs
            .get_mut(id)
            .and_then(|j| j.seq.take())
    }

    #[cfg(test)]
    pub fn exists(&self, id: &str) -> bool {
        self.inner.lock().unwrap().jobs.contains_key(id)
    }

    // 테스트 핀 — job 의 현재 epoch(인스턴스 세대).
    #[cfg(test)]
    pub fn epoch_of(&self, id: &str) -> Option<u64> {
        self.inner.lock().unwrap().jobs.get(id).map(|j| j.epoch)
    }
}

// ── 발화 ─────────────────────────────────────────────────────────────────────

pub fn fire_simple(dispatch: &dyn CommandDispatch, st: &ScheduleState, f: Fire) -> Completion {
    // idempotency 키(PS12) — 같은 due 의 재시도는 같은 키를 나른다(서비스가 res 캐시로 dedup).
    let key = format!("sch:{}:{}:{}", f.id, f.epoch, f.due);
    let reply = dispatch.request(
        f.command,
        f.params,
        f.timeout_ms,
        Some("schedule"),
        Some(key),
    );
    let ok = reply.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    st.complete(&f.id, ok, now_ms(), f.epoch)
}

// 프로세스-생존 발화 — 배달 후 reply(프로세스 exit)까지 대기(클램프 안 거침 — 도는 중 안 자름).
// reply 가 ground truth: 정상=ok:true(done), crash/무결과=ok:false(backoff). 좀비(reply 영영 없음)는
// zombie_backstop 에 거둔다. cancel 은 close 가 채널 끊어 즉시 깨움(누수 0).
pub fn fire_process(dispatch: &dyn CommandDispatch, st: &ScheduleState, f: Fire) -> Completion {
    let Some((seq, rx)) = dispatch.open(f.command, f.params, Some("schedule")) else {
        // 배달 실패 — 프론트 도달 불가. 실패로 완료(backoff 여지).
        return st.complete(&f.id, false, now_ms(), f.epoch);
    };
    st.set_seq(&f.id, seq, f.epoch);
    // reply=Some(프로세스 exit) / None(좀비 backstop·취소). 무한은 recv(차단), 유한은 recv_timeout.
    let reply: Option<Value> = match process_wait(now_ms(), f.claimed_at, f.zombie_backstop_ms) {
        ProcWait::Forever => rx.recv().ok(), // reply 또는 cancel(Disconnected→None).
        ProcWait::Wait(d) => rx.recv_timeout(Duration::from_millis(d.max(1))).ok(), // Timeout/Disconnect→None.
        ProcWait::Backstop => None, // 이미 좀비 backstop 초과(드묾).
    };
    dispatch.close(seq); // 대기 자리 회수(멱등).
                         // reply 의 ok 로 완료(None=좀비/취소→ok:false). complete 가 epoch·존재를 검사 — 취소(제거)·재등록
                         // (전체교체)된 job 은 no-op(removed:false) 라 이중 처리·재생성 job 오염·seq steal 이 없다.
    let ok = reply
        .as_ref()
        .and_then(|v| v.get("ok"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    st.complete(&f.id, ok, now_ms(), f.epoch)
}

// ── 발화 스레드 ──────────────────────────────────────────────────────────────

/// 1회 기동(lazy). due 를 claim → 락 밖 단명 스레드에서 발화하고, 다음 wake 까지 Condvar 로 잔다.
///
/// 프레임워크가 주는 것은 둘뿐이다: 명령 중개자(발화가 부를 곳)와 제거된 잡의 영속 회수.
/// 그 둘은 각각 그 프로세스의 것이라 프로세스를 못 건넌다 — 창 레지스트리 라우팅과 저장소
/// 커넥션이다.
///
/// 폴링하지 않는다: 다음 due 까지 정확히 자고, 새 일정·취소·poke 가 Condvar 로 깨운다.
pub fn ensure_started(
    state: &'static ScheduleState,
    dispatch: std::sync::Arc<dyn CommandDispatch>,
    forget_persisted: std::sync::Arc<dyn Fn(&str) + Send + Sync>,
) {
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.started {
            return;
        }
        inner.started = true;
    }
    std::thread::spawn(move || loop {
        let fires = state.claim_due(now_ms());
        // 락 밖에서 발화 — 각 작업을 단명 스레드로 분리(긴 명령이 루프·서로를 막지 않게).
        for f in fires {
            let d = std::sync::Arc::clone(&dispatch);
            let forget = std::sync::Arc::clone(&forget_persisted);
            std::thread::spawn(move || {
                let id = f.id.clone();
                let done = if f.process_lease {
                    fire_process(d.as_ref(), state, f)
                } else {
                    fire_simple(d.as_ref(), state, f)
                };
                if done.removed {
                    forget(&id);
                }
            });
        }
        // 다음 due 까지 park(due 판정+wait 한 락 — missed-wakeup 차단).
        state.park_until_due();
    });
}

// 코어가 이 잡을 지속 저장하는가. 시간 기반(At/Every/Cron)이고 코어 소유(owner=None)일 때만 true.
// Reconcile 은 무상태(칸반이 단일 진실)라 제외, 플러그인 소유(owner=Some)는 플러그인이 activate 에서
// 재장전하므로 제외(B2) — 부팅 시 owner 없이 orphan 재장전하는 구멍을 닫는다.
pub fn should_persist(spec: &JobSpec) -> bool {
    spec.trigger.is_time_based() && spec.owner.is_none()
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
