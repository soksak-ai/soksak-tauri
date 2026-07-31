// 활동 허브(A1) — 앱에서 일어나는 실행 사실의 단일 스트림(P12 실행 가시성의 본체).
// 공급자는 둘: ① 프론트 이벤트(command.started/finished·turn.ended·view.activated —
// activityFeed.ts) ② 커맨드 레지스트리 execute 계측(registry.ts — 오케스트레이터가 내리는
// 모든 명령이 이 경로다). 소비자는 셋: 오케스트레이터 창(listen "activity"), 소켓 구독
// (events.subscribe — A2), 조회 커맨드(activity.recent).
//
// 구조: Rust 싱글톤 링버퍼(크로스윈도우 단일진실, cap 초과 시 오래된 것 탈락) + 창 무관
// app.emit("activity") 브로드캐스트 + app.data records(core/activity) 영속(retention trim).
// seq 는 단조 증가 — since 커서(재접속 백필)·소비자 읽음 커서(kv 영속)의 기준이므로 앱
// 재시작을 넘어 단조여야 한다: 부트에서 영속 최댓값으로 재개(resume_from). 런마다 0 재시작이면
// 영속 커서가 미래를 가리켜 소비자(낭독 등)가 전면 침묵하는 잠복 결함(실측).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;
// 적재 규칙(도장·단조)과 보관 축 판정은 코어가 소유한다 — 창 없는 프로세스도 같은 규칙으로
// 적재해야 하고, 규칙이 둘이면 그 차이는 조용하다.
use soksak_core::activity::{retention_scope, Ledger};
use tauri::{AppHandle, Manager};

use crate::window_oracle::WindowOracle;

const RING_CAP: usize = 2000;
// 구독자 큐 상한 — 느린 소켓 소비자가 발행을 막지 못한다(bounded). 초과 시 오래된 것부터
// 버린다(drop-oldest — 최신이 진실, 유실 구간은 seq gap 으로 드러나 since 백필로 메꾼다).
const SUB_CAP: usize = 256;
// records 영속 상한 — 링보다 넉넉히(재시작 후 recent 백필의 원천).
use soksak_core::activity::{COLL, NS};

// 영속 보관 2계층(§5 R4)의 축 이름과 판정은 코어가 소유한다(retention_scope). 링(라이브
// 뷰)은 시간창이 본질이라 혼합 유지 — 역사 보증은 영속의 몫.

pub struct ActivityHub {
    inner: Mutex<HubInner>,
    subs: Mutex<Vec<Arc<Subscriber>>>,
}

struct HubInner {
    ring: VecDeque<Value>,
    /// seq 할당자 — 이 앱 프로세스가 이 원장에 대해 갖는 유일한 것.
    ledger: Ledger,
}

/// 소켓 스트리밍 구독자(A2) — bounded 큐 + 알림. 소비는 pop_wait(블로킹, 소켓 쓰기 스레드).
pub struct Subscriber {
    queue: Mutex<VecDeque<Value>>,
    cv: Condvar,
    closed: AtomicBool,
}

impl Subscriber {
    fn push(&self, entry: Value) {
        let mut q = self.queue.lock().unwrap();
        q.push_back(entry);
        while q.len() > SUB_CAP {
            q.pop_front(); // drop-oldest
        }
        self.cv.notify_one();
    }

    /// 다음 항목(블로킹, 주기적 타임아웃으로 closed 재확인). None = 구독 종료.
    pub fn pop_wait(&self) -> Option<Value> {
        let mut q = self.queue.lock().unwrap();
        loop {
            if let Some(v) = q.pop_front() {
                return Some(v);
            }
            if self.closed.load(Ordering::Relaxed) {
                return None;
            }
            let (g, _) = self.cv.wait_timeout(q, Duration::from_secs(1)).unwrap();
            q = g;
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.cv.notify_all();
    }
}

impl Default for ActivityHub {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HubInner {
                ring: VecDeque::new(),
                ledger: Ledger::default(),
            }),
            subs: Mutex::new(Vec::new()),
        }
    }
}

impl ActivityHub {
    /// 항목 발행 — seq/ts 를 부여해 링에 넣고 부여된 entry 를 돌려준다(emit/영속은 호출측).
    pub fn push(&self, kind: &str, source: &str, payload: Value) -> Value {
        let mut g = self.inner.lock().unwrap();
        let entry = g.ledger.admit(now_ms(), kind, source, payload);
        g.ring.push_back(entry.clone());
        while g.ring.len() > RING_CAP {
            g.ring.pop_front();
        }
        entry
    }

    /// 스트리밍 구독 등록(A2) — 이후 publish 가 이 구독자 큐로도 흐른다. 해지는 unsubscribe.
    pub fn subscribe(&self) -> Arc<Subscriber> {
        let sub = Arc::new(Subscriber {
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            closed: AtomicBool::new(false),
        });
        self.subs.lock().unwrap().push(sub.clone());
        sub
    }

    pub fn unsubscribe(&self, sub: &Arc<Subscriber>) {
        sub.close();
        self.subs.lock().unwrap().retain(|s| !Arc::ptr_eq(s, sub));
    }

    fn fan_out_subs(&self, entry: &Value) {
        for s in self.subs.lock().unwrap().iter() {
            s.push(entry.clone());
        }
    }

    /// seq 재개(부트 1회) — 영속 최댓값 위에서 이어간다(단조 보존, 뒤로는 절대 안 감).
    pub fn resume_from(&self, last: u64) {
        self.inner.lock().unwrap().ledger.resume_from(last);
    }

    /// since(exclusive) 이후 항목 — 재접속 백필 커서. None = 최신 limit 개.
    pub fn recent(&self, since: Option<u64>, limit: usize) -> Vec<Value> {
        // 고르는 규칙은 코어가 소유한다 — cored 도 같은 이름을 서빙하므로 두 벌이면 같은
        // 커서에 다른 답이 나가고, 그 차이는 오류가 아니라 "안 온 활동"으로 나타난다.
        let g = self.inner.lock().unwrap();
        soksak_core::activity::pick_recent(g.ring.iter().cloned().collect(), since, limit)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── 발행 3단: 적재 · 부채질 · 영속 ────────────────────────────────────────────
// 셋은 한 함수였고 그 함수는 AppHandle 로 시작했다. 그래서 원장에 한 줄 남기고 싶을 뿐인
// 함수까지 AppHandle 을 받았다(호출 지점 22). 실제로 프레임워크 타입이 필요한 것은 창 브로드캐스트
// 하나뿐이다 — 적재는 허브만, 영속은 커넥션만 있으면 선다. 앱 밖 cored 는 적재까지 하고
// 부채질·영속은 프레임워크에 넘긴다.

/// 적재 — 허브에 항목을 넣고 seq·ts 를 매겨 돌려준다. 프레임워크 타입 없이 선다.
/// 부채질하지 않는다: 적재가 창까지 밀면 둘은 다시 한 몸이 되고, cored 가 쓸 수 없다.
pub fn admit(hub: &ActivityHub, kind: &str, source: &str, payload: Value) -> Value {
    hub.push(kind, source, payload)
}

/// 부채질 — 소켓 스트리밍 구독자(A2) + 전 창 브로드캐스트.
/// 반환 = 창에 닿았는가. 삼키지 않는다 — 무시할지는 호출자가 정한다.
pub fn fan_out(hub: &ActivityHub, windows: &dyn WindowOracle, entry: &Value) -> bool {
    hub.fan_out_subs(entry);
    windows.broadcast("activity", entry.clone())
}

/// 영속(retention trim) — 커넥션 하나면 선다. 반환 = 이번 항목이 기록됐는가.
/// 실패는 회복 큐로 가고 false 로 돌아온다 — 라이브 스트림은 막지 않는다.
/// 영속 — 쓰기는 저장소 계층이 소유한다(soksak_store::activity_persist). 여기는 부르기만 한다.
///
/// 회복 큐·보관 정리·실패 계수가 여기 살던 동안 cored 의 같은 일은 raw SQL 한 줄이었다.
/// 두 벌은 갈릴 때까지 조용하고, 실제로 한쪽만 보관 정리를 받고 있었다.
pub fn persist(conn: &rusqlite::Connection, entry: &Value) -> bool {
    soksak_store::activity_persist::persist_entry(conn, entry)
}

/// 발행 본체 — 3단을 앱 프로세스에서 잇는다. 프론트(activityFeed·registry 계측)와
/// 코어 내부가 공용하는 단일 진입점.
pub fn publish(app: &AppHandle, kind: &str, source: &str, payload: Value) -> Value {
    let hub = app.state::<ActivityHub>();
    let entry = admit(&hub, kind, source, payload);
    // 창 배달 실패는 발행을 멈추지 않는다 — 원장의 진실은 링·영속이고, 창은 구독자 하나다.
    let _ = fan_out(&hub, app, &entry);
    // 영속 실패도 스트림을 막지 않는다(라이브 우선, 회복 큐 + 콘솔 보고).
    let st = app.state::<crate::data::DbState>();
    if let Ok(guard) = st.conn.lock() {
        if let Some(conn) = guard.as_ref() {
            let _ = persist(conn, &entry);
        }
    }
    entry
}

// ── 영속 실패 회복 큐 ────────────────────────────────────────────────────────
// 호스트 메모리 고갈(실측: 스왑 55.8/57.3GB — sqlite malloc 이 SQLITE_NOMEM(7))에서 영속이
// 연쇄 실패하면 관찰 사실(boot.step 등)이 통째로 사라지고, 매 건 eprintln 이 로그를 폭주시켰다
// (실측 3,391줄 — 이 로그 자체가 부하다). 실패분은 상한 큐에 보관했다가 회복되면 순서대로
// 늦게라도 영속한다. 상한 초과는 오래된 것부터 드롭하되 드롭 수를 센다(침묵 유실 금지).
pub fn init_collection(conn: &rusqlite::Connection) {
    let _ = soksak_store::store::define(conn, NS, COLL, &["kind".into(), "seq".into()], &[]);
}

/// 영속 행 크기 불변식(바이트) — 초과 payload 는 요약형으로 강등된다.
// 요약·상한·행 자리 규칙은 코어가 소유한다 — 앱과 cored 가 같은 원장에 쓰므로
// 두 벌이면 한쪽이 쓴 것을 다른 쪽이 못 읽거나, 같은 seq 에 다른 모양이 남는다.
use soksak_core::activity::summarize_for_persist;
// 상한 상수는 코어가 강제한다(summarize_for_persist 안에서) — 여기서는 검사가 그 값을 대조한다.
#[cfg(test)]
use soksak_core::activity::PERSIST_DOC_CAP;

/// 영속본 요약(§5) — media.base64 스트립(kind·path 유지), 직렬화 크기 상한 강제.
/// 링·이벤트(라이브)는 원본 그대로 — 이 함수는 영속 경로 전용이다.

/// 부트 1회 — 영속 최댓값에서 seq 재개(재시작을 넘는 단조). 레코드 없음(신선 설치) = 0 유지.
/// 전 scope(신호+저신호) 최댓값 — 어느 쪽이 마지막이었든 뒤로 가지 않는다.
pub fn resume_seq(app: &AppHandle, conn: &rusqlite::Connection) {
    let last = soksak_store::store::query(
        conn,
        NS,
        COLL,
        None,
        None,
        Some("seq"),
        true,
        Some(1),
        None,
        None,
    )
    .ok()
    .and_then(|rows| {
        rows.first()
            .and_then(|e| e.get("seq").and_then(Value::as_u64))
    })
    .unwrap_or(0);
    app.state::<ActivityHub>().resume_from(last);
}

// 프론트 공급자 진입점 — activityFeed.ts / registry.ts 계측이 invoke.
#[tauri::command]
pub fn activity_publish(app: AppHandle, kind: String, source: String, payload: Value) -> Value {
    publish(&app, &kind, &source, payload)
}

/// 영속 상태 — **도장을 받은 것과 원장에 남은 것이 갈릴 수 있다.**
///
/// 발행은 도장(seq)을 받고 끝나지만 영속은 그다음이다. 쓰기가 실패하면 회복 큐에 담기고
/// 다음 성공에 흘러가는데, 그 사이 밖에서는 "발행 성공"만 보인다 — 실측 2026-07-31: 앱 도장
/// 86160, DB 최대 86097 로 63건이 어디에도 안 보인 채 대기 중이었다. 세는 자리가 없으면
/// 그 63건은 유실인지 대기인지조차 구분되지 않는다.
#[tauri::command]
pub fn activity_persist_stats() -> Value {
    serde_json::json!({
        "failures": soksak_store::activity_persist::persist_failures(),
        "drops": soksak_store::activity_persist::persist_drops(),
        "pending": soksak_store::activity_persist::persist_pending(),
        "lastError": soksak_store::activity_persist::persist_last_error(),
    })
}

// 조회 — activity.recent 커맨드 핸들러(창 무관 단일진실이라 어느 창에서 물어도 같다).
#[tauri::command]
pub fn activity_recent(app: AppHandle, since: Option<u64>, limit: Option<usize>) -> Vec<Value> {
    app.state::<ActivityHub>()
        .recent(since, limit.unwrap_or(200).min(RING_CAP))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persist_summary_strips_base64_and_caps_doc() {
        // media.base64 스트립(kind 유지) — 기록은 관찰 요약(§5).
        let e = serde_json::json!({"seq":1,"ts":2,"kind":"command.executed","source":"ui",
            "payload":{"command":"window.snapshot","ok":true,"message":"m",
                       "media":{"kind":"image/png","base64":"AAAA"}}});
        let p = summarize_for_persist(&e);
        assert!(p["payload"]["media"].get("base64").is_none());
        assert_eq!(p["payload"]["media"]["kind"], "image/png");

        // 상한 초과 payload 는 요약형 강등 — 상관·노출 축(parentId/origin)은 살아남는다.
        let big = "x".repeat(PERSIST_DOC_CAP + 1024);
        let e2 = serde_json::json!({"seq":9,"ts":8,"kind":"command.executed","source":"remote",
            "payload":{"command":"c","ok":true,"code":"OK","message":"m","huge":big,
                       "parentId":"t1","origin":"schedule"}});
        let p2 = summarize_for_persist(&e2);
        let ser = serde_json::to_string(&p2).unwrap();
        assert!(ser.len() < PERSIST_DOC_CAP);
        assert_eq!(p2["payload"]["truncated"], true);
        assert_eq!(p2["payload"]["parentId"], "t1");
        assert_eq!(p2["payload"]["origin"], "schedule");
        assert!(p2["payload"].get("huge").is_none());
        assert_eq!(p2["seq"], 9);
    }

    #[test]
    fn seq_monotonic_and_ring_trims() {
        let hub = ActivityHub::default();
        for i in 0..(RING_CAP + 50) {
            let e = hub.push("t", "test", json!({ "i": i }));
            assert_eq!(e["seq"].as_u64().unwrap(), (i + 1) as u64);
        }
        let g = hub.inner.lock().unwrap();
        assert_eq!(g.ring.len(), RING_CAP);
        // 앞이 잘리고 뒤가 남는다(오래된 것 탈락).
        assert_eq!(g.ring.front().unwrap()["seq"].as_u64().unwrap(), 51);
    }

    #[test]
    fn resume_keeps_seq_monotonic_across_restart() {
        let hub = ActivityHub::default();
        hub.resume_from(500); // 부트: 영속 최댓값에서 재개
        let e = hub.push("t", "test", json!({}));
        assert_eq!(e["seq"].as_u64().unwrap(), 501);
        hub.resume_from(10); // 뒤로는 절대 안 감(단조)
        let e = hub.push("t", "test", json!({}));
        assert_eq!(e["seq"].as_u64().unwrap(), 502);
    }

    #[test]
    fn recent_since_cursor_and_limit() {
        let hub = ActivityHub::default();
        for i in 0..10 {
            hub.push("t", "test", json!({ "i": i }));
        }
        // since=7 → 8,9,10
        let v = hub.recent(Some(7), 100);
        assert_eq!(
            v.iter()
                .map(|e| e["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![8, 9, 10]
        );
        // limit 은 최신 우선(꼬리 유지)
        let v = hub.recent(None, 2);
        assert_eq!(
            v.iter()
                .map(|e| e["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![9, 10]
        );
    }
}

#[cfg(test)]
mod split_tests {
    use super::*;
    use crate::window_oracle::WindowOracle;
    use serde_json::json;
    use soksak_core::activity::{SCOPE, SCOPE_LOW};

    /// 계약만 구현한 창 — Tauri 없이 부채질을 검증한다.
    #[derive(Default)]
    struct FakeWindows {
        sent: Mutex<Vec<(String, Value)>>,
    }

    impl WindowOracle for FakeWindows {
        fn live_labels(&self) -> Vec<String> {
            vec!["main".to_string()]
        }
        fn emit_to(&self, _label: &str, _event: &str, _payload: Value) -> bool {
            true
        }
        fn broadcast(&self, event: &str, payload: Value) -> bool {
            self.sent.lock().unwrap().push((event.to_string(), payload));
            true
        }
    }

    #[test]
    fn admitting_needs_no_shell_and_does_not_fan_out() {
        // cored 프로세스가 적재만 하고 부채질을 셸로 넘길 수 있으려면, 적재가 단독으로
        // 서야 한다 — 적재가 부채질까지 하면 둘은 다시 한 몸이다.
        let hub = ActivityHub::default();
        let sub = hub.subscribe();
        let entry = admit(&hub, "boot.step", "core", json!({ "step": "ready" }));
        assert_eq!(entry["seq"], 1);
        assert_eq!(entry["kind"], "boot.step");
        assert!(entry["ts"].as_u64().is_some(), "ts 는 적재가 매긴다");
        assert_eq!(hub.recent(None, 10).len(), 1, "링에는 남는다");
        assert_eq!(
            sub.queue.lock().unwrap().len(),
            0,
            "적재 단독은 구독자에게 흐르지 않는다"
        );
    }

    // 항목의 모양과 번호는 코어 규칙이 소유한다. 코어가 자기 도장을 따로 찍으면 cored 가
    // 적재한 항목과 앱이 적재한 항목이 미묘하게 달라지고, 그 차이는 소비자에게만 보인다.
    #[test]
    fn the_entry_shape_comes_from_the_core_rule() {
        let hub = ActivityHub::default();
        hub.resume_from(41);
        let entry = admit(&hub, "command.executed", "remote", json!({ "command": "c" }));
        let ts = entry["ts"].as_u64().expect("ts");
        assert_eq!(
            entry,
            soksak_core::activity::stamp(42, ts, "command.executed", "remote", json!({ "command": "c" })),
            "코어가 규칙 밖에서 항목을 짓고 있다"
        );
    }

    #[test]
    fn fanning_out_reaches_subscribers_and_windows() {
        let hub = ActivityHub::default();
        let sub = hub.subscribe();
        let windows = FakeWindows::default();
        let entry = admit(&hub, "command.executed", "remote", json!({ "command": "c" }));
        assert!(fan_out(&hub, &windows, &entry));
        assert_eq!(sub.queue.lock().unwrap().len(), 1, "소켓 구독자(A2)");
        let sent = windows.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "activity", "창 이벤트 이름은 그대로다");
        assert_eq!(sent[0].1["seq"], 1);
    }

    #[test]
    fn retention_scope_follows_payload_origin() {
        // 저신호(origin 보유) 판정은 발행 경로 안에 파묻혀 있어 단독 검증이 불가능했다.
        assert_eq!(retention_scope(&json!({"payload":{"origin":"schedule"}})), SCOPE_LOW);
        assert_eq!(
            retention_scope(&json!({"payload":{"origin":""}})),
            SCOPE,
            "빈 문자열은 origin 이 아니다"
        );
        assert_eq!(retention_scope(&json!({"payload":{"command":"c"}})), SCOPE);
        assert_eq!(retention_scope(&json!({})), SCOPE);
    }

    // 회복 큐는 저장소 계층이 소유한다(soksak_store::activity_persist) — 그 큐는 프로세스
    // 전역이라 영속을 만지는 테스트끼리는 여전히 직렬화한다. 비우는 일은 그 계층의 검사가
    // 자기 안에서 한다(여기서 남의 내부 상태를 만지지 않는다).
    static PERSIST_SERIAL: Mutex<()> = Mutex::new(());

    fn persist_fixture() -> std::sync::MutexGuard<'static, ()> {
        PERSIST_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn persisting_needs_only_a_connection() {
        let _serial = persist_fixture();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        soksak_store::store::init_base(&conn).unwrap();
        init_collection(&conn);

        let hub = ActivityHub::default();
        let signal = admit(&hub, "command.executed", "ui", json!({ "command": "x" }));
        let low = admit(
            &hub,
            "command.executed",
            "remote",
            json!({ "command": "y", "origin": "schedule" }),
        );
        assert!(persist(&conn, &signal));
        assert!(persist(&conn, &low));

        let rows = |scope: &str| {
            soksak_store::store::query(
                &conn,
                NS,
                COLL,
                Some(scope),
                None,
                Some("seq"),
                false,
                Some(10),
                None,
                None,
            )
            .unwrap()
        };
        let hi = rows(SCOPE);
        assert_eq!(hi.len(), 1);
        assert_eq!(hi[0]["seq"], 1);
        let lo = rows(SCOPE_LOW);
        assert_eq!(lo.len(), 1, "저신호는 별도 scope — 신호의 캡을 다투지 않는다");
        assert_eq!(lo[0]["seq"], 2);
    }

}


