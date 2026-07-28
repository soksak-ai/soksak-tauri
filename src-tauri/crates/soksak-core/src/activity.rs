//! 활동 원장의 규칙 — 항목 도장(seq·ts)과 보관 축 판정.
//!
//! 발행은 셋으로 갈라져 있다: 적재 · 부채질 · 영속. 여기 있는 것은 그중 **적재의 규칙**과
//! 영속이 쓰는 **보관 축 판정**뿐이다. 부채질은 창을 가진 쪽의 것이고 영속은 저장소를 쥔
//! 쪽의 것이라, 둘 다 프로세스를 넘지 못한다.
//!
//! seq 할당자는 **원장 하나에 하나**여야 한다. seq 는 `since` 백필 커서이자 소비자의 영속
//! 읽음 커서라, 두 프로세스가 각자 매기면 같은 번호가 서로 다른 두 항목을 가리키고 소비자는
//! 그 사실을 모른 채 한쪽을 건너뛴다. 그래서 이 모듈은 **규칙**만 갖고 할당자 인스턴스
//! (`Ledger`)는 원장을 지는 쪽이 하나만 소유한다 — 전역을 여기 두면 첫 호출자가 원장을
//! 정하게 되고, 그건 프로세스마다 다른 답이다.

use serde_json::{json, Value};

/// 보관 2계층. 저신호(payload.origin 보유: 스케줄·internal)가 신호(사람 유래·환경 사실)의
/// 보관 캡을 다투지 않는다.
pub const SCOPE: &str = "app";
pub const SCOPE_LOW: &str = "app-low";

/// 항목 하나의 모양. 순수 — 같은 인자면 어느 프로세스에서든 같은 값이다.
///
/// 시계는 인자다. `SystemTime::now()` 를 여기서 읽으면 "언제"가 규칙의 일부가 되고,
/// 같은 항목을 두 번 만들 수 없어 두 경로가 같은 답을 내는지 확인할 길이 사라진다.
pub fn stamp(seq: u64, ts_ms: u64, kind: &str, source: &str, payload: Value) -> Value {
    json!({
        "seq": seq,
        "ts": ts_ms,
        "kind": kind,
        "source": source,
        "payload": payload,
    })
}

/// seq 할당자 하나. 뒤로 가지 않는다.
#[derive(Debug, Default)]
pub struct Ledger {
    seq: u64,
}

impl Ledger {
    /// 지금까지 매긴 마지막 번호. 아직 아무것도 안 매겼으면 0.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// 영속 최댓값에서 재개 — 앱 재시작을 넘는 단조. 더 낮은 값은 무시한다.
    pub fn resume_from(&mut self, last: u64) {
        if last > self.seq {
            self.seq = last;
        }
    }

    /// 다음 번호를 매겨 항목을 만든다. 부채질도 영속도 하지 않는다 — 적재가 그 둘까지
    /// 하면 셋은 다시 한 몸이 되고, 창 없는 프로세스는 적재조차 못 한다.
    pub fn admit(&mut self, ts_ms: u64, kind: &str, source: &str, payload: Value) -> Value {
        self.seq += 1;
        stamp(self.seq, ts_ms, kind, source, payload)
    }
}

/// 보관 축 판정 — `payload.origin` 을 가진 항목은 저신호다. 빈 문자열은 origin 이 아니다.
///
/// 판정이 영속 코드 안에 파묻혀 있으면 저장소를 가진 프로세스에서만 물을 수 있다. 규칙은
/// 항목만 보면 서는 것이므로 여기 산다.
pub fn retention_scope(entry: &Value) -> &'static str {
    if entry
        .get("payload")
        .and_then(|p| p.get("origin"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        SCOPE_LOW
    } else {
        SCOPE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_is_the_same_value_in_any_process() {
        // 순수의 뜻 — 인자가 같으면 값이 같다. 두 경로가 같은 답을 내는지 확인할 수 있는
        // 근거가 이것이다.
        let a = stamp(3, 1_700_000_000_000, "k", "core", json!({ "x": 1 }));
        let b = stamp(3, 1_700_000_000_000, "k", "core", json!({ "x": 1 }));
        assert_eq!(a, b);
        assert_eq!(a["seq"], 3);
        assert_eq!(a["ts"], 1_700_000_000_000_u64);
        assert_eq!(a["kind"], "k");
        assert_eq!(a["source"], "core");
        assert_eq!(a["payload"]["x"], 1);
    }

    #[test]
    fn numbers_are_handed_out_one_at_a_time() {
        let mut led = Ledger::default();
        for i in 1..=5 {
            assert_eq!(led.admit(0, "k", "core", json!({}))["seq"], i);
        }
        assert_eq!(led.seq(), 5);
    }

    #[test]
    fn resuming_never_goes_backwards() {
        let mut led = Ledger::default();
        led.resume_from(500);
        assert_eq!(led.admit(0, "k", "core", json!({}))["seq"], 501);
        led.resume_from(10); // 뒤로는 절대 안 간다
        assert_eq!(led.admit(0, "k", "core", json!({}))["seq"], 502);
    }

    #[test]
    fn two_ledgers_do_not_share_numbers() {
        // 원장이 둘이면 번호도 둘이다 — 하나의 전역이었다면 첫 호출자가 둘 다 정했다.
        let mut a = Ledger::default();
        let mut b = Ledger::default();
        a.resume_from(100);
        assert_eq!(a.admit(0, "k", "core", json!({}))["seq"], 101);
        assert_eq!(b.admit(0, "k", "core", json!({}))["seq"], 1);
    }

    #[test]
    fn the_retention_axis_follows_payload_origin() {
        assert_eq!(retention_scope(&json!({"payload":{"origin":"schedule"}})), SCOPE_LOW);
        assert_eq!(
            retention_scope(&json!({"payload":{"origin":""}})),
            SCOPE,
            "빈 문자열은 origin 이 아니다"
        );
        assert_eq!(retention_scope(&json!({"payload":{"command":"c"}})), SCOPE);
        assert_eq!(retention_scope(&json!({})), SCOPE);
    }
}

/// 영속 행 하나의 상한. 초대형 행 하나가 json 파스에서 전체 목록을 죽이지 않게 한다.
pub const PERSIST_DOC_CAP: usize = 262_144;

/// 원장에 **남길 모양** — 관찰 요약이지 사본이 아니다.
///
/// 미디어 base64 를 떼어낸다(kind·mime 은 남는다 — 무엇이 오갔는지는 관찰이고 그 바이트는
/// 사본이다). 그러고도 상한을 넘으면 페이로드를 잘라내고 잘렸다는 사실을 남긴다: 조용히
/// 버리면 그 항목은 "작았던 것"으로 읽힌다.
pub fn summarize_for_persist(entry: &Value) -> Value {
    let mut doc = entry.clone();
    if let Some(media) = doc
        .get_mut("payload")
        .and_then(|p| p.get_mut("media"))
        .and_then(Value::as_object_mut)
    {
        media.remove("base64");
    }
    if serde_json::to_string(&doc).map(|s| s.len()).unwrap_or(0) > PERSIST_DOC_CAP {
        let seq = doc.get("seq").cloned().unwrap_or(Value::Null);
        let ts = doc.get("ts").cloned().unwrap_or(Value::Null);
        let kind = doc.get("kind").cloned().unwrap_or(Value::Null);
        let source = doc.get("source").cloned().unwrap_or(Value::Null);
        let payload = doc.get("payload").and_then(Value::as_object);
        let mut slim = serde_json::Map::new();
        // 강등해도 **상관·노출 축은 살린다.** parentId 는 어느 실행의 자식인지, origin 은
        // 낭독 후보에서 빼는 근거, window 는 어느 창의 일인지다. 이것들이 사라지면 그 항목은
        // 목록에는 남고 어디에도 안 걸리는 고아가 된다 — 잘렸다는 사실보다 나쁘다.
        for k in [
            "command", "title", "ok", "code", "message", "parentId", "origin", "window",
        ] {
            if let Some(v) = payload.and_then(|p| p.get(k)) {
                slim.insert(k.to_string(), v.clone());
            }
        }
        slim.insert("truncated".into(), Value::Bool(true));
        return serde_json::json!({ "seq": seq, "ts": ts, "kind": kind, "source": source, "payload": slim });
    }
    doc
}

/// 원장 행의 자리 — 앱과 cored 가 같은 곳에 쓴다. 갈리면 한쪽이 쓴 것을 다른 쪽이 못 읽는다.
pub const NS: &str = "core";
pub const COLL: &str = "activity";

/// 행 id — seq 를 0 채움해 사전순이 곧 시간순이다. 정렬을 질의가 다시 하지 않는다.
pub fn row_id(seq: u64) -> String {
    format!("a{seq:016}")
}

/// 원장 한 행을 쓰는 문장 — 앱과 cored 가 같은 문장을 쓴다.
///
/// 두 프로세스가 각자 SQL 을 적으면 컬럼 하나가 어긋나도 오류가 아니라 **다른 답**이 된다.
/// 같은 (ns,coll,id) 는 갱신이다: 도장 찍힌 seq 가 id 라 재적재는 없고, 회복 큐가 같은 행을
/// 다시 밀 때 중복이 아니라 같은 자리에 앉는다.
///
/// 순서: ns · coll · scope · id · doc · now · enc · keyId
pub const PERSIST_SQL: &str = "\
    INSERT INTO records(ns,coll,scope,id,doc,created,updated,enc,keyId) \
    VALUES(?1,?2,?3,?4,?5,?6,?6,?7,?8) \
    ON CONFLICT(ns,coll,id) DO UPDATE SET \
      scope=excluded.scope, doc=excluded.doc, updated=excluded.updated, \
      enc=excluded.enc, keyId=excluded.keyId";
