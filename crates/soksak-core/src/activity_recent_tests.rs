// 최근 항목 고르기 — 규칙이 한 벌임을 못박는다.
use super::*;
use serde_json::json;

fn e(seq: u64) -> Value {
    json!({ "seq": seq, "kind": "k" })
}

#[test]
fn a_since_cursor_is_exclusive() {
    // 그 seq 는 이미 봤다 — 포함하면 소비자가 같은 줄을 두 번 받는다.
    let got = pick_recent(vec![e(1), e(2), e(3)], Some(2), 10);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["seq"], 3);
}

#[test]
fn the_limit_keeps_the_newest_not_the_oldest() {
    let got = pick_recent(vec![e(1), e(2), e(3), e(4)], None, 2);
    assert_eq!(
        got.iter().map(|v| v["seq"].as_u64().unwrap()).collect::<Vec<_>>(),
        vec![3, 4],
        "오래된 것을 남기면 피드가 과거에 멈춘다"
    );
}

#[test]
fn no_cursor_means_everything_up_to_the_limit() {
    assert_eq!(pick_recent(vec![e(1), e(2)], None, 10).len(), 2);
}

#[test]
fn an_entry_without_seq_is_treated_as_oldest() {
    // seq 가 없으면 0 으로 본다 — since 가 있으면 걸러진다. 지어낸 번호를 붙이지 않는다.
    let got = pick_recent(vec![json!({ "kind": "k" }), e(5)], Some(1), 10);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["seq"], 5);
}

#[test]
fn the_query_reads_in_id_order() {
    // id 가 a{seq:016} 이라 사전순이 곧 시간순이다 — 정렬을 다시 하지 않는다.
    assert!(RECENT_SQL.contains("ORDER BY id"));
    assert!(RECENT_SQL.contains("FROM records"));
}
