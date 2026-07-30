// 스케줄러 몸의 검사 — 규칙은 lib.rs 가, 그 증명은 여기가 진다.
//
// 프레임워크를 안 띄운다: 발화가 계약 둘(중개·상태)만 만지므로 심은 중개자로 전 규칙을 잰다.
use super::*;
use serde_json::json;

// wire 계약 — JS app.scheduler 가 보내고 kv 가 저장하는 JSON 형태를 정확히 역직렬화한다.
// (kind 태그 lowercase, every_ms 필드명 그대로.) 깨지면 런타임 발화/복구가 조용히 실패.
#[test]
fn trigger_wire_format() {
    let at: Trigger = serde_json::from_value(json!({"kind":"at","at":123})).unwrap();
    assert_eq!(at, Trigger::At { at: 123 });
    let ev: Trigger = serde_json::from_value(json!({"kind":"every","every_ms":1000})).unwrap();
    assert_eq!(
        ev,
        Trigger::Every {
            every_ms: 1000,
            anchor: None
        }
    );
    let ev2: Trigger =
        serde_json::from_value(json!({"kind":"every","every_ms":1000,"anchor":50})).unwrap();
    assert_eq!(
        ev2,
        Trigger::Every {
            every_ms: 1000,
            anchor: Some(50)
        }
    );
    let cr: Trigger =
        serde_json::from_value(json!({"kind":"cron","expr":"0 0 * * *"})).unwrap();
    assert_eq!(
        cr,
        Trigger::Cron {
            expr: "0 0 * * *".into()
        }
    );
    let rc: Trigger = serde_json::from_value(json!({"kind":"reconcile"})).unwrap();
    assert_eq!(rc, Trigger::Reconcile);
}

// JobSpec 영속 round-trip — kv 저장(serde_json::to_value) → 로드(from_value) 동일.
#[test]
fn jobspec_persist_roundtrip() {
    let s = JobSpec {
        id: Some("sch-1".into()),
        trigger: Trigger::Cron {
            expr: "*/5 * * * *".into(),
        },
        command: "notify.show".into(),
        params: json!({"title":"틱"}),
        retry: Some(Retry {
            max: 3,
            base_ms: 1000,
            max_ms: 60_000,
        }),
        concurrency: 2,
        timeout_ms: Some(600_000),
        process_lease: true,
        zombie_backstop_ms: Some(10_800_000),
        owner: None,
    };
    let v = serde_json::to_value(&s).unwrap();
    let back: JobSpec = serde_json::from_value(v).unwrap();
    assert_eq!(back.id.as_deref(), Some("sch-1"));
    assert_eq!(back.trigger, s.trigger);
    assert_eq!(back.command, "notify.show");
    assert_eq!(back.retry, s.retry);
    assert_eq!(back.concurrency, 2);
    assert_eq!(back.timeout_ms, Some(600_000));
    assert!(back.process_lease);
    assert_eq!(back.zombie_backstop_ms, Some(10_800_000));
}

// ── owner 축 수명(PS14) — 서비스 unbind 의 단일 회수 경로·bind 부팅 poke ────
fn owned_spec(owner: Option<&str>, command: &str, trigger: Trigger) -> JobSpec {
    JobSpec {
        id: None,
        trigger,
        command: command.into(),
        params: json!({}),
        retry: None,
        concurrency: 1,
        timeout_ms: None,
        process_lease: false,
        zombie_backstop_ms: None,
        owner: owner.map(str::to_string),
    }
}

#[test]
fn cancel_by_owner_removes_only_that_owners_jobs() {
    let st = ScheduleState::default();
    st.register(owned_spec(Some("p1"), "a", Trigger::Reconcile), 0);
    st.register(
        owned_spec(
            Some("p1"),
            "b",
            Trigger::Every {
                every_ms: 1000,
                anchor: None,
            },
        ),
        0,
    );
    st.register(owned_spec(Some("p2"), "c", Trigger::Reconcile), 0);
    st.register(owned_spec(None, "d", Trigger::Reconcile), 0);
    assert_eq!(st.cancel_by_owner("p1"), 2, "p1 소유 2건 회수");
    let left: Vec<String> = st.list().into_iter().map(|v| v.command).collect();
    assert_eq!(left.len(), 2);
    assert!(
        left.contains(&"c".to_string()) && left.contains(&"d".to_string()),
        "타 소유·코어 잡 불가침: {left:?}"
    );
    assert_eq!(st.cancel_by_owner("p1"), 0, "멱등");
}

#[test]
fn poke_owner_arms_only_that_owners_reconcile_jobs() {
    let st = ScheduleState::default();
    st.register(owned_spec(Some("p1"), "mine", Trigger::Reconcile), 0);
    st.register(owned_spec(Some("p2"), "theirs", Trigger::Reconcile), 0);
    st.poke_owner("p1", 42);
    for v in st.list() {
        match v.command.as_str() {
            "mine" => assert_eq!(v.next_at, Some(42), "owner 잡은 즉시 무장"),
            "theirs" => assert_eq!(v.next_at, None, "타 owner Reconcile 은 불가침"),
            other => panic!("예상 밖 잡: {other}"),
        }
    }
}

// 프로세스 작업의 claim 이 Fire 에 process_lease·zombie_backstop·claimed_at 을 싣는다(fire_process 진입 조건).
#[test]
fn process_job_claim_carries_lease() {
    let st = ScheduleState::default();
    let mut s = spec(Trigger::At { at: 100 });
    s.process_lease = true;
    s.zombie_backstop_ms = Some(10_800_000);
    st.register(s, 0);
    let f = st.claim_due(150);
    assert!(f[0].process_lease);
    assert_eq!(f[0].zombie_backstop_ms, Some(10_800_000));
    assert_eq!(f[0].claimed_at, 150);
}

// seq set/take — cancel-wakes-wait 용. take 후 None.
#[test]
fn seq_set_take() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let f = st.claim_due(100);
    st.set_seq(&id, 42, f[0].epoch);
    assert_eq!(st.take_seq(&id), Some(42));
    assert_eq!(st.take_seq(&id), None); // 이미 회수.
    assert!(st.exists(&id));
}

fn spec_id(id: &str, trigger: Trigger) -> JobSpec {
    let mut s = spec(trigger);
    s.id = Some(id.into());
    s
}

// ① 벡터1 — 발화 중 재등록(running)은 config 만 갱신·runtime 보존. 2차 동시 발화 없음(단일 in-flight).
#[test]
fn reregister_during_inflight_keeps_single_fire() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let ep1 = st.epoch_of(&id).unwrap();
    let f = st.claim_due(150); // running(epoch ep1).
    assert_eq!(f.len(), 1);
    // 발화 중 재등록 — 덮어쓰기였다면 running=false 로 리셋돼 재발화. Option B 는 보존.
    st.register(
        spec_id(
            &id,
            Trigger::Cron {
                expr: "0 0 * * *".into(),
            },
        ),
        200,
    );
    assert_eq!(st.epoch_of(&id), Some(ep1)); // epoch 보존(같은 인스턴스).
    assert!(st.claim_due(300).is_empty()); // running 유지 → 2차 발화 0(lease).
                                           // live fire 완료(같은 epoch) → 정상 동작. config 갱신(At→Cron)됐으니 rearm 됨(제거 X).
    let c = st.complete(&id, true, 400, f[0].epoch);
    assert!(!c.removed);
    assert!(matches!(st.list()[0].trigger, Trigger::Cron { .. })); // 갱신된 config.
}

// ① 벡터2 — cancel(제거)+register(재생성) race: old fire 의 complete 가 epoch mismatch 로 no-op
//   (재생성 job 오염 안 함).
#[test]
fn complete_stale_epoch_is_noop() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let f = st.claim_due(150); // old fire(ep1).
    let ep1 = f[0].epoch;
    st.cancel(&id); // 제거(old fire 깨움).
    st.register(spec_id(&id, Trigger::At { at: 5000 }), 0); // 재생성(ep2, idle).
    let ep2 = st.epoch_of(&id).unwrap();
    assert_ne!(ep1, ep2);
    let c = st.complete(&id, true, 200, ep1); // old fire 의 완료 — 현재는 ep2.
    assert!(!c.removed); // no-op.
    assert_eq!(st.list()[0].next_at, Some(5000)); // 재생성 job 무손상.
    assert!(!st.list()[0].running);
}

// ① 벡터2 — old fire 의 set_seq 가 epoch mismatch 로 재생성 job 의 seq 를 훔치지 않음.
#[test]
fn set_seq_stale_epoch_is_noop() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let f = st.claim_due(150);
    let ep1 = f[0].epoch;
    st.cancel(&id);
    st.register(spec_id(&id, Trigger::At { at: 5000 }), 0); // 재생성 ep2.
    st.set_seq(&id, 999, ep1); // old fire 의 seq 기록 시도 — ep2 라 무시.
    assert_eq!(st.take_seq(&id), None); // 재생성 job seq steal 없음.
}

// 발화 timeout — 미지정 시 30s 기본, 지정 시 그 값이 Fire 로 전달(LLM exec 가 길게 잡는 노브).
#[test]
fn fire_carries_timeout() {
    let st = ScheduleState::default();
    st.register(spec(Trigger::At { at: 100 }), 0); // timeout 미지정.
    let f = st.claim_due(150);
    assert_eq!(f[0].timeout_ms, DEFAULT_TIMEOUT_MS); // 기본 30s.

    let st2 = ScheduleState::default();
    let mut s = spec(Trigger::At { at: 100 });
    s.timeout_ms = Some(600_000); // GLM exec 류.
    st2.register(s, 0);
    let f2 = st2.claim_due(150);
    assert_eq!(f2[0].timeout_ms, 600_000);
}

// 분=15배수 cron, 에폭 0(=1970-01-01T00:00:00Z, 분0 매칭) 직후 → 분15 = 900000.
#[test]
fn cron_every_15min() {
    assert_eq!(cron::cron_next("*/15 * * * *", 0), Some(900_000));
    assert_eq!(cron::cron_next("5 * * * *", 0), Some(300_000));
}

// 매일 0시 — 0 직후 다음 자정 = 다음 날(86400000).
#[test]
fn cron_daily_midnight() {
    assert_eq!(cron::cron_next("0 0 * * *", 0), Some(86_400_000));
}

// 매월 1일 0시 — Jan1 직후 Feb1(31일=2678400000).
#[test]
fn cron_first_of_month() {
    assert_eq!(cron::cron_next("0 0 1 * *", 0), Some(2_678_400_000));
}

// 월요일 0시 — 1970-01-01(목) 직후 첫 월요일 = Jan5(4일=345600000).
#[test]
fn cron_weekday_monday() {
    assert_eq!(cron::cron_next("0 0 * * 1", 0), Some(345_600_000));
}

// 일·요일 둘 다 제한 → OR. 13일 또는 금요일 — 0 직후 첫 금요일 Jan2(86400000)가 13일보다 빠름.
#[test]
fn cron_dom_dow_or() {
    assert_eq!(cron::cron_next("0 0 13 * 5", 0), Some(86_400_000));
}

// 요일 7=일요일(0 으로 접힘) — 1970-01-04 가 첫 일요일(3일=259200000).
#[test]
fn cron_sunday_seven() {
    assert_eq!(cron::cron_next("0 0 * * 7", 0), Some(259_200_000));
}

// 파싱 실패(필드 수·범위 밖) → None.
#[test]
fn cron_invalid() {
    assert_eq!(cron::cron_next("* * *", 0), None);
    assert_eq!(cron::cron_next("60 * * * *", 0), None);
    assert_eq!(cron::cron_next("* 24 * * *", 0), None);
}

// Every — anchor 격자 기준 strictly-after.
#[test]
fn every_grid() {
    let t = Trigger::Every {
        every_ms: 1000,
        anchor: None,
    };
    assert_eq!(next_after(&t, 2500), Some(3000));
    assert_eq!(next_after(&t, 3000), Some(4000)); // 경계는 다음 슬롯.
    let a = Trigger::Every {
        every_ms: 1000,
        anchor: Some(5000),
    };
    assert_eq!(next_after(&a, 0), Some(5000)); // anchor 이전이면 anchor 가 첫 슬롯.
    assert_eq!(next_after(&a, 5000), Some(6000));
}

// first_fire/rearm — At 1회, recurring 재무장, Reconcile 타이머 없음.
#[test]
fn first_fire_and_rearm() {
    let at = Trigger::At { at: 999 };
    assert_eq!(first_fire(&at, 100), Some(999));
    assert_eq!(rearm(&at, 999), None); // At 은 재무장 없음.

    let ev = Trigger::Every {
        every_ms: 100,
        anchor: None,
    };
    assert_eq!(rearm(&ev, 500), Some(600)); // last_due 기준 드리프트 없음.

    let rc = Trigger::Reconcile;
    assert_eq!(first_fire(&rc, 100), None);
    assert_eq!(rearm(&rc, 100), None);
}

// backoff — 지수 증가·상한.
#[test]
fn backoff_caps() {
    assert_eq!(backoff_delay(1, 1000, 60_000), 1000);
    assert_eq!(backoff_delay(2, 1000, 60_000), 2000);
    assert_eq!(backoff_delay(3, 1000, 60_000), 4000);
    assert_eq!(backoff_delay(7, 1000, 60_000), 60_000); // 64000 → 상한.
    assert_eq!(backoff_delay(99, 1000, 60_000), 60_000); // overflow 없음.
}

// process_wait — 프로세스-생존 작업 대기 판정. None=무한, Some=claim+backstop 까지 Wait, 초과=Backstop.
#[test]
fn process_wait_cases() {
    // 무한(None) — reply/cancel 까지.
    assert_eq!(process_wait(0, 0, None), ProcWait::Forever);
    assert_eq!(process_wait(99_999_999, 0, None), ProcWait::Forever);
    // 유한 — claim+backstop 까지 남은 시간.
    assert_eq!(
        process_wait(0, 0, Some(10_800_000)),
        ProcWait::Wait(10_800_000)
    );
    assert_eq!(
        process_wait(800_000, 0, Some(10_800_000)),
        ProcWait::Wait(10_000_000)
    );
    // claim 오프셋 반영.
    assert_eq!(process_wait(1_000, 500, Some(2_000)), ProcWait::Wait(1_500)); // 500+2000=2500, -1000.
                                                                              // backstop 경과(reply 영영 없음) → Backstop(좀비).
    assert_eq!(
        process_wait(10_800_000, 0, Some(10_800_000)),
        ProcWait::Backstop
    ); // 경계.
    assert_eq!(
        process_wait(11_000_000, 0, Some(10_800_000)),
        ProcWait::Backstop
    );
}

fn spec(trigger: Trigger) -> JobSpec {
    JobSpec {
        id: None,
        trigger,
        command: "x".into(),
        params: json!({}),
        retry: None,
        concurrency: 1,
        timeout_ms: None,
        process_lease: false,
        zombie_backstop_ms: None,
        owner: None,
    }
}

// B2 — 코어 시간기반만 persist. Reconcile·플러그인 소유(owner)는 제외(부팅 orphan 재장전 차단).
#[test]
fn should_persist_only_core_time_based() {
    let cron = || Trigger::Cron {
        expr: "*/5 * * * *".into(),
    };
    assert!(should_persist(&spec(cron()))); // 코어 + 시간기반 → 저장
    assert!(!should_persist(&spec(Trigger::Reconcile))); // 무상태 → 제외
    let mut owned = spec(cron());
    owned.owner = Some("soksak-plugin-workflow".into());
    assert!(!should_persist(&owned)); // 플러그인 소유 → 제외(activate 재장전)
}

// register → id 발급·next_at 무장, list 정렬, cancel 제거.
#[test]
fn register_list_cancel() {
    let st = ScheduleState::default();
    let id1 = st.register(spec(Trigger::At { at: 300 }), 0);
    let mut s2 = spec(Trigger::At { at: 100 });
    s2.id = Some("fixed".into());
    st.register(s2, 0);
    let list = st.list();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, "fixed"); // next_at 100 먼저.
    assert_eq!(list[0].next_at, Some(100));
    assert!(st.cancel(&id1));
    assert!(!st.cancel(&id1));
    assert_eq!(st.list().len(), 1);
}

// At 발화 → 성공 완료 → 제거(removed). lease(claim 중 재claim 0).
#[test]
fn at_fires_once_then_removed() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let f1 = st.claim_due(150);
    assert_eq!(f1.len(), 1);
    assert!(st.claim_due(150).is_empty()); // running — 재claim 없음.
    let c = st.complete(&id, true, 200, f1[0].epoch);
    assert!(c.removed);
    assert!(st.list().is_empty());
}

// recurring 발화 → 완료 시 다음 슬롯 재무장(드리프트 없음·제거 안 됨).
#[test]
fn every_rearms_after_complete() {
    let st = ScheduleState::default();
    let id = st.register(
        spec(Trigger::Every {
            every_ms: 100,
            anchor: Some(0),
        }),
        50,
    );
    // first_fire(now=50) → 다음 슬롯 100.
    assert_eq!(st.list()[0].next_at, Some(100));
    let f = st.claim_due(120);
    assert_eq!(f.len(), 1);
    let c = st.complete(&id, true, 130, f[0].epoch);
    assert!(!c.removed);
    assert_eq!(st.list()[0].next_at, Some(200)); // last_due(100) 기준 → 200, 130 드리프트 없음.
}

// 실패 → backoff 재시도 예약, 소진 후 At 종료.
#[test]
fn retry_then_give_up() {
    let st = ScheduleState::default();
    let mut s = spec(Trigger::At { at: 100 });
    s.retry = Some(Retry {
        max: 1,
        base_ms: 1000,
        max_ms: 60_000,
    });
    let id = st.register(s, 0);
    let ep = st.epoch_of(&id).unwrap(); // 재시도 내내 epoch 불변(Option B/재시도는 교체 아님).
    st.claim_due(150);
    let c1 = st.complete(&id, false, 200, ep); // 1회차 실패 → 재시도.
    assert!(!c1.removed);
    assert_eq!(st.list()[0].next_at, Some(1200)); // 200 + backoff(1)=1000.
    st.claim_due(1300);
    let c2 = st.complete(&id, false, 1400, ep); // 재시도 소진 → 종료.
    assert!(c2.removed);
    assert!(st.list().is_empty());
}

// Reconcile — 타이머 없음(next_at None), poke 로 즉시 due. 실행 중 poke 는 pending coalesce.
#[test]
fn reconcile_poke_and_coalesce() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::Reconcile), 0);
    assert_eq!(st.list()[0].next_at, None); // 타이머 없음.
    st.poke(None, 500); // 모든 reconcile.
    assert_eq!(st.list()[0].next_at, Some(500));
    let f = st.claim_due(500);
    assert_eq!(f.len(), 1);
    st.poke(Some(&id), 600); // 실행 중 poke → pending.
    assert_eq!(st.list()[0].next_at, None); // 아직 running.
    let c = st.complete(&id, true, 700, f[0].epoch);
    assert!(!c.removed);
    assert_eq!(st.list()[0].next_at, Some(700)); // pending coalesce → 즉시 재발화.
}

// ── 발화(fire_simple·fire_process) ──────────────────────────────────────
// 발화가 만지는 것은 계약 둘(명령 중개·스케줄 상태)뿐이다. 아래 테스트가 Tauri 없이
// 돈다는 사실 자체가 "발화는 벤더 타입이 아니다"의 증명이다. 시간은 기다리지 않는다 —
// 답은 미리 채널에 실려 있거나(정상) 송신측이 사라져 있다(취소).

#[derive(Debug, PartialEq)]
enum Call {
    Request {
        method: String,
        timeout_ms: u64,
        origin: Option<String>,
        key: Option<String>,
    },
    Open {
        method: String,
        origin: Option<String>,
    },
    Close(u64),
}

struct FakeDispatch {
    reply: Value,             // request 가 돌려줄 봉투.
    open_reply: Option<Value>, // open 채널에 미리 실어 둘 답(None=송신측 소멸 → 취소·좀비와 같은 모양).
    refuse_open: bool,        // 배달 실패.
    calls: Mutex<Vec<Call>>,
}

const FAKE_SEQ: u64 = 77;

impl FakeDispatch {
    fn answering(reply: Value) -> Self {
        FakeDispatch {
            reply,
            open_reply: None,
            refuse_open: false,
            calls: Mutex::new(Vec::new()),
        }
    }
    fn opening(open_reply: Option<Value>) -> Self {
        FakeDispatch {
            open_reply,
            ..FakeDispatch::answering(Value::Null)
        }
    }
    fn refusing() -> Self {
        FakeDispatch {
            refuse_open: true,
            ..FakeDispatch::answering(Value::Null)
        }
    }
}

impl soksak_core::command_dispatch::CommandDispatch for FakeDispatch {
    fn request(
        &self,
        method: String,
        _params: Value,
        timeout_ms: u64,
        origin: Option<&str>,
        key: Option<String>,
    ) -> Value {
        self.calls.lock().unwrap().push(Call::Request {
            method,
            timeout_ms,
            origin: origin.map(str::to_string),
            key,
        });
        self.reply.clone()
    }
    fn open(
        &self,
        method: String,
        _params: Value,
        origin: Option<&str>,
    ) -> Option<(u64, std::sync::mpsc::Receiver<Value>)> {
        self.calls.lock().unwrap().push(Call::Open {
            method,
            origin: origin.map(str::to_string),
        });
        if self.refuse_open {
            return None;
        }
        let (tx, rx) = std::sync::mpsc::sync_channel::<Value>(1);
        if let Some(v) = self.open_reply.clone() {
            let _ = tx.try_send(v);
        }
        Some((FAKE_SEQ, rx)) // tx 는 여기서 소멸 — 답이 없으면 대기가 즉시 끊긴다.
    }
    fn close(&self, seq: u64) {
        self.calls.lock().unwrap().push(Call::Close(seq));
    }
}

// 비-프로세스 발화 — 중개 계약으로 명령을 부르고, 답의 ok 로 완료한다.
#[test]
fn a_fire_needs_no_shell_type() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let f = st.claim_due(150);
    let epoch = f[0].epoch;
    let d = FakeDispatch::answering(json!({ "ok": true }));
    let c = fire_simple(&d, &st, f[0].clone());
    assert!(c.removed, "At 1회 발화는 성공 후 제거");
    assert_eq!(
        d.calls.lock().unwrap()[0],
        Call::Request {
            method: "x".into(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            origin: Some("schedule".into()),
            // 같은 due 의 재시도가 공유하는 idempotency 키(PS12).
            key: Some(format!("sch:{id}:{epoch}:100")),
        }
    );
}

// 실패 답은 backoff 로 간다 — 발화가 답의 ok 를 그대로 읽는지 고정한다.
#[test]
fn a_failed_reply_keeps_the_job_for_backoff() {
    let st = ScheduleState::default();
    let mut s = spec(Trigger::At { at: 100 });
    s.retry = Some(Retry {
        max: 1,
        base_ms: 1000,
        max_ms: 60_000,
    });
    st.register(s, 0);
    let f = st.claim_due(150);
    let d = FakeDispatch::answering(json!({ "ok": false, "code": "INTERNAL" }));
    let c = fire_simple(&d, &st, f[0].clone());
    assert!(!c.removed);
    assert!(
        st.list()[0].next_at.is_some(),
        "재시도 여력이 있으면 다시 무장한다"
    );
}

// 프로세스 발화 — 답을 받으면 대기 자리를 회수하고 완료한다(누수 0).
#[test]
fn a_process_fire_reclaims_its_pending_slot() {
    let st = ScheduleState::default();
    let id = st.register(spec(Trigger::At { at: 100 }), 0);
    let mut f = st.claim_due(150);
    f[0].process_lease = true;
    f[0].zombie_backstop_ms = Some(10_800_000);
    let d = FakeDispatch::opening(Some(json!({ "ok": true })));
    let c = fire_process(&d, &st, f[0].clone());
    assert!(c.removed);
    let calls = d.calls.lock().unwrap();
    assert_eq!(
        calls[0],
        Call::Open {
            method: "x".into(),
            origin: Some("schedule".into())
        }
    );
    assert_eq!(calls[1], Call::Close(FAKE_SEQ), "대기 자리는 반드시 회수");
    // 보고(removed)와 사실(장부)이 어긋나면 호출자가 지운 잡의 영속을 남긴다.
    assert!(!st.exists(&id), "성공한 At 은 발화와 함께 사라진다");
}

// 답이 영영 없는 발화(취소·좀비)는 실패로 완료한다 — 조용히 사라지지 않는다.
#[test]
fn a_process_fire_without_a_reply_completes_as_failure() {
    let st = ScheduleState::default();
    st.register(spec(Trigger::At { at: 100 }), 0);
    let mut f = st.claim_due(150);
    f[0].process_lease = true;
    let d = FakeDispatch::opening(None); // 무한 대기지만 송신측이 사라져 즉시 끊긴다.
    let c = fire_process(&d, &st, f[0].clone());
    assert!(c.removed, "재시도 없는 At 은 실패로도 종료");
    assert_eq!(d.calls.lock().unwrap()[1], Call::Close(FAKE_SEQ));
}

// 배달 실패(창 없음·emit 실패)는 실패 완료로 끝난다. 회수할 자리도 없다.
#[test]
fn an_undelivered_process_fire_completes_as_failure() {
    let st = ScheduleState::default();
    st.register(spec(Trigger::At { at: 100 }), 0);
    let mut f = st.claim_due(150);
    f[0].process_lease = true;
    let d = FakeDispatch::refusing();
    let c = fire_process(&d, &st, f[0].clone());
    assert!(c.removed);
    let calls = d.calls.lock().unwrap();
    assert_eq!(calls.len(), 1, "배달 못 했으면 회수할 자리도 없다");
}

// next_wake — running 작업 제외(완료 notify 가 깨움). 대기 작업의 최소 next_at.
#[test]
fn next_wake_excludes_running() {
    let st = ScheduleState::default();
    st.register(spec(Trigger::At { at: 1000 }), 0);
    st.register(spec(Trigger::At { at: 500 }), 0);
    assert_eq!(st.next_wake(0), Some(500));
    st.claim_due(500); // id2 running.
    assert_eq!(st.next_wake(600), Some(1000)); // running 제외 → 다음 대기.
}
