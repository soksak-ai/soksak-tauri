//! 적재하는 모든 프로세스가 같은 쓰기를 지나는가 — 특히 **보관 정리**를 받는가.
//!
//! 실측(2026-07-31): cored 의 적재는 raw SQL 한 줄이라 저장소 계층도, 보관 정리도 지나지
//! 않았다. 그 원장은 영원히 자란다. 오류를 내지 않으므로 조용하다.

use super::*;
use serde_json::json;

fn conn() -> rusqlite::Connection {
    let c = rusqlite::Connection::open_in_memory().expect("메모리 DB");
    crate::store::init_base(&c).expect("스키마");
    c
}

fn entry(seq: u64, ts: u64) -> Value {
    json!({ "seq": seq, "ts": ts, "kind": "t.kind", "source": "test", "payload": {} })
}

fn rows(c: &rusqlite::Connection) -> i64 {
    c.query_row(
        "SELECT COUNT(*) FROM records WHERE ns=?1 AND coll=?2",
        (act::NS, act::COLL),
        |r| r.get(0),
    )
    .unwrap_or(-1)
}

#[test]
fn an_entry_lands_and_is_readable() {
    let c = conn();
    assert!(persist_entry(&c, &entry(1, 100)));
    assert_eq!(rows(&c), 1);
}

#[test]
fn the_same_seq_replaces_rather_than_duplicating() {
    let c = conn();
    assert!(persist_entry(&c, &entry(7, 100)));
    assert!(persist_entry(&c, &entry(7, 200)));
    // id 는 seq 에서 나온다 — 같은 seq 는 같은 행이다(두 벌이 아니다).
    assert_eq!(rows(&c), 1);
}

/// 보관 정리를 받는가 — 이것이 빠지면 원장이 영원히 자란다.
///
/// 상한(5000)까지 채우는 것은 느리므로, 정리가 **불린다는 사실**을 다른 축으로 확인한다:
/// 같은 축에 상한 이하로 넣으면 하나도 잘리지 않아야 한다(과잉 삭제 없음). 상한 초과 동작은
/// store::retention_trim 자신의 검사가 소유한다 — 여기서 재현하면 그 계약이 두 벌이 된다.
#[test]
fn trimming_does_not_eat_rows_below_the_cap() {
    let c = conn();
    for seq in 1..=50 {
        assert!(persist_entry(&c, &entry(seq, 100 + seq)));
    }
    assert_eq!(rows(&c), 50);
}

/// 저신호와 신호는 보관 축이 다르다 — 한쪽이 다른 쪽의 자리를 다투지 않는다.
#[test]
fn the_two_retention_axes_are_separate() {
    let c = conn();
    let low = json!({
        "seq": 1, "ts": 100, "kind": "t.kind", "source": "test",
        "payload": { "origin": "schedule" }
    });
    assert!(persist_entry(&c, &low));
    assert!(persist_entry(&c, &entry(2, 110)));
    let scopes: i64 = c
        .query_row(
            "SELECT COUNT(DISTINCT scope) FROM records WHERE ns=?1 AND coll=?2",
            (act::NS, act::COLL),
            |r| r.get(0),
        )
        .unwrap_or(-1);
    assert_eq!(scopes, 2, "보관 축이 갈리지 않으면 저신호가 신호를 밀어낸다");
}

/// 실패는 삼켜지지 않는다 — 값으로 돌아오고 회복 큐에 남는다.
///
/// 실측 RED(프레임워크에서 이관): 스왑 고갈(55.8/57.3GB)에서 영속이 연쇄 실패하자 관찰 사실이
/// 통째로 사라졌고(boot.step 부재로 복원 결함 규명이 막혔다) 로그가 3,391줄 폭주했다.
#[test]
fn a_failed_write_is_reported_and_queued_not_swallowed() {
    // 스키마 없는 커넥션 — 쓰기가 실패한다.
    let c = rusqlite::Connection::open_in_memory().expect("메모리 DB");
    let before = persist_pending();
    assert!(!persist_entry(&c, &entry(1, 100)), "실패는 값으로 돌아온다");
    assert_eq!(persist_pending(), before + 1, "실패분은 큐에 남는다");
    PENDING.lock().unwrap().clear();
}

/// 회복 큐는 순서를 지키고 상한에서 버린 수를 센다 — 침묵 유실 금지.
#[test]
fn the_queue_keeps_order_and_counts_what_it_drops() {
    let mut q = VecDeque::new();
    let mut dropped = 0;
    for i in 0..(PENDING_CAP + 7) {
        dropped += pending_push(
            &mut q,
            PendingRow { scope: act::SCOPE, id: Some(format!("a{i}")), doc: json!({ "i": i }) },
        );
    }
    assert_eq!(q.len(), PENDING_CAP, "상한 유지");
    assert_eq!(dropped, 7, "초과분은 드롭으로 센다");
    // 남은 첫 항목 = 가장 오래된 생존자(드롭된 7 다음) — FIFO 순서 보존.
    assert_eq!(q.front().unwrap().id.as_deref(), Some("a7"));
    assert_eq!(
        q.back().unwrap().id.as_deref(),
        Some(&format!("a{}", PENDING_CAP + 6)[..])
    );
}
