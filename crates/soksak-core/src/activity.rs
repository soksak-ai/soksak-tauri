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

use serde::Serialize;
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

/// 최근 항목 고르기 — `since` 보다 뒤인 것 중 마지막 `limit` 개.
///
/// 규칙이 순수하다: 어디서 읽어 왔든(프로세스 안 링이든 저장소든) 같은 입력에 같은 답이다.
/// 그래서 코어가 갖는다 — 두 프로세스가 각자 고르면 커서가 같은데 답이 달라지고, 그 차이는
/// 오류가 아니라 "안 온 활동"으로 나타난다.
///
/// `since` 는 **배타**다(그 seq 는 이미 봤다). 포함으로 바꾸면 소비자가 마지막 항목을 두 번
/// 받고, 그 중복은 화면에서 같은 줄이 두 번으로 보인다.
pub fn pick_recent(entries: Vec<Value>, since: Option<u64>, limit: usize) -> Vec<Value> {
    let kept: Vec<Value> = entries
        .into_iter()
        .filter(|e| since.is_none_or(|s| e.get("seq").and_then(Value::as_u64).unwrap_or(0) > s))
        .collect();
    let skip = kept.len().saturating_sub(limit);
    kept.into_iter().skip(skip).collect()
}

/// 원장에서 읽는 질의 — 앱과 cored 가 같은 문장을 쓴다.
///
/// id 가 `a{seq:016}` 이라 사전순이 곧 시간순이다(row_id). 그래서 정렬을 질의가 다시 하지
/// 않고 id 순으로 읽으면 된다.
pub const RECENT_SQL: &str = "\
    SELECT doc FROM records WHERE ns=?1 AND coll=?2 ORDER BY id";

/// 원장 무결성 감사 질의 — seq 와 ts 만 순서대로 읽는다(doc 전문은 필요 없다).
///
/// 이 원장은 **한 주인**을 전제한다: seq 는 단조 증가하고 id 가 `a{seq:016}` 이라 사전순이
/// 곧 시간순이다. 주인이 여럿이면 각자 1부터 매기고, 겹친 id 는 저장 질의가 덮어쓴다
/// (INSERT … ON CONFLICT DO UPDATE). 그 덮어쓰기는 오류를 내지 않으므로 조용하다.
///
/// 그래서 두 가지를 센다: **구멍**(기대 개수와 실제 개수의 차)과 **시간 역행**(seq 는 느는데
/// ts 가 줄어드는 자리). 역행은 다른 주인이 낮은 seq 로 끼어들어 과거를 덮은 흔적이다.
/// 원장 감사 결과 — 한 주인 전제가 지켜졌는가.
#[derive(Debug, Serialize, PartialEq)]
pub struct LedgerAudit {
    /// 실제 행 수.
    pub rows: usize,
    pub min_seq: u64,
    pub max_seq: u64,
    /// 기대 개수(max-min+1)와 실제의 차.
    ///
    /// **손상 신호가 아니다.** 보관이 2계층이라(SCOPE/SCOPE_LOW) 저신호가 먼저 잘리면 seq
    /// 중간에 구멍이 남는다 — 정상 동작이다. 이것을 손상으로 읽으면 잘 도는 원장이 매번
    /// 경보를 낸다(실측 2026-07-31: 구멍 1496, 시간 역행 0).
    pub gaps: u64,
    /// seq 는 느는데 ts 가 줄어든 자리 수 — 다른 주인이 낮은 seq 로 끼어든 흔적.
    pub time_regressions: usize,
    /// 역행이 처음 나타난 seq(없으면 0) — 겹친 구간의 시작점을 가리킨다.
    pub first_regression_seq: u64,
    /// 한 주인 전제가 지켜졌는가 — **판정은 시간 역행만 본다.**
    ///
    /// 덮어쓰기는 낮은 seq 자리에 나중 ts 를 밀어 넣으므로 seq 순서와 시간 순서가 어긋난다.
    /// 구멍은 보관 정책으로도 생기므로 증거가 못 된다.
    pub single_writer: bool,
}

/// (seq, ts) 를 seq 순으로 받아 감사한다 — 저장소를 모르는 순수 판정이라 표로 검증된다.
pub fn audit_ledger(rows: &[(u64, u64)]) -> LedgerAudit {
    if rows.is_empty() {
        return LedgerAudit {
            rows: 0,
            min_seq: 0,
            max_seq: 0,
            gaps: 0,
            time_regressions: 0,
            first_regression_seq: 0,
            single_writer: true,
        };
    }
    let min_seq = rows[0].0;
    let max_seq = rows[rows.len() - 1].0;
    let expected = max_seq.saturating_sub(min_seq) + 1;
    let gaps = expected.saturating_sub(rows.len() as u64);
    let mut time_regressions = 0usize;
    let mut first_regression_seq = 0u64;
    for w in rows.windows(2) {
        if w[1].1 < w[0].1 {
            time_regressions += 1;
            if first_regression_seq == 0 {
                first_regression_seq = w[1].0;
            }
        }
    }
    LedgerAudit {
        rows: rows.len(),
        min_seq,
        max_seq,
        gaps,
        time_regressions,
        first_regression_seq,
        single_writer: time_regressions == 0,
    }
}

pub const AUDIT_SQL: &str = "\
    SELECT CAST(json_extract(doc,'$.seq') AS INTEGER), \
           CAST(json_extract(doc,'$.ts') AS INTEGER) \
    FROM records WHERE ns=?1 AND coll=?2 ORDER BY id";

#[cfg(test)]
#[path = "activity_recent_tests.rs"]
mod recent_tests;

#[cfg(test)]
mod audit_tests {
    use super::*;

    /// 한 주인이 쓴 원장 — 구멍도 역행도 없다.
    #[test]
    fn a_single_writer_leaves_no_trace() {
        let rows = vec![(1, 100), (2, 110), (3, 120)];
        let a = audit_ledger(&rows);
        assert!(a.single_writer, "{a:?}");
        assert_eq!((a.gaps, a.time_regressions), (0, 0));
    }

    /// 덮어쓰기의 흔적 — 겹친 id 는 저장 질의가 덮으므로 **행이 줄고**, 낮은 seq 에 새 ts 가
    /// 들어와 시간이 뒤로 간다. 오라클: 둘 중 하나만 봐도 놓치는 경우가 있어 함께 센다.
    #[test]
    fn overwriting_shows_up_as_gaps_and_time_going_backwards() {
        // 두 번째 주인이 seq 2 를 자기 것(더 나중 ts)으로 덮었고, seq 3 은 아직 옛것이다.
        let rows = vec![(1, 100), (2, 900), (3, 120)];
        let a = audit_ledger(&rows);
        assert_eq!(a.time_regressions, 1, "{a:?}");
        assert_eq!(a.gaps, 0);
        assert_eq!(a.first_regression_seq, 3);
        assert!(!a.single_writer);
    }

    /// 구멍은 세되 손상으로 읽지 않는다 — 보관 2계층에서 저신호가 먼저 잘리면 정상으로 생긴다.
    /// 이 경계를 못 박지 않으면 잘 도는 원장이 매번 손상으로 보고된다(실측: 구멍 1496·역행 0).
    #[test]
    fn gaps_are_counted_but_are_not_damage() {
        let rows = vec![(1, 100), (5, 110)];
        let a = audit_ledger(&rows);
        assert_eq!(a.gaps, 3, "{a:?}");
        assert!(a.single_writer, "구멍만으로 손상 판정하면 보관 정책이 경보가 된다");
    }

    /// 빈 원장은 손상이 아니다 — 0 을 결함으로 읽으면 새 홈이 매번 경보를 낸다.
    #[test]
    fn an_empty_ledger_is_not_damage() {
        assert!(audit_ledger(&[]).single_writer);
    }
}
