// 덮어써도 지워도 직전 값이 남는다.
//
// RED 근거(실측 2026-08-01): 워크스페이스 스냅샷은 `DO UPDATE` 로 저장된다 — 쓰는 순간 이전
// 값이 그 자리에서 사라진다. 그날 사용자 워크스페이스가 네 번 사라졌고 원인은 매번 달랐다
// (복원 실패, 읽기 실패를 0 으로 적음, 연결을 못 갈아탐, 회수 도구). 원인마다 가드를 세우는
// 것으로는 다음 원인을 못 막는다. 그래서 저장소 층에 되돌릴 자리를 남긴다.

use super::*;
use crate::store::{drop_ns, init_base};
use serde_json::json;

fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_base(&conn).unwrap();
    conn
}

// ── 덮어써도 지워도 직전 값이 남는다 ───────────────────────────────────
//
// RED 근거(실측 2026-08-01): 워크스페이스 스냅샷은 `DO UPDATE` 로 저장된다 — 쓰는 순간
// 이전 값이 그 자리에서 사라진다. 그날 사용자 워크스페이스가 네 번 사라졌고, 원인은
// 매번 달랐다(복원 실패·읽기 실패를 0 으로 적음·연결 못 갈아탐·내 회수 도구). 원인마다
// 가드를 세우는 것으로는 다음 원인을 막지 못한다.
//
// 그래서 저장소 층에서 되돌릴 자리를 남긴다. 소비자가 무엇을 하든 직전 값은 남는다.

#[test]
fn overwriting_keeps_what_was_there() {
    let c = mem();
    kv_set(&c, "core", "window/w-1", &json!({ "projects": [1, 2, 3] })).unwrap();
    kv_set(&c, "core", "window/w-1", &json!({ "projects": [] })).unwrap();
    let past = kv_history(&c, "core", "window/w-1").unwrap();
    assert_eq!(past.len(), 1, "덮어쓰기가 직전 값을 안 남겼다");
    assert_eq!(past[0]["projects"], json!([1, 2, 3]));
}

#[test]
fn deleting_keeps_what_was_there() {
    let c = mem();
    kv_set(&c, "core", "window/w-1", &json!({ "projects": [1] })).unwrap();
    assert!(kv_delete(&c, "core", "window/w-1").unwrap());
    let past = kv_history(&c, "core", "window/w-1").unwrap();
    assert_eq!(past.len(), 1, "삭제가 직전 값을 안 남겼다");
    assert_eq!(past[0]["projects"], json!([1]));
}

#[test]
fn the_first_write_has_no_past() {
    let c = mem();
    kv_set(&c, "core", "window/w-1", &json!({ "projects": [1] })).unwrap();
    assert!(kv_history(&c, "core", "window/w-1").unwrap().is_empty(), "없던 값의 과거를 지어냈다");
}

#[test]
fn the_same_value_written_twice_is_not_a_generation() {
    // 안 바뀐 쓰기까지 세대를 만들면 링이 같은 값으로 차고, 진짜 직전 값이 그만큼 밀린다.
    let c = mem();
    let v = json!({ "projects": [1] });
    kv_set(&c, "core", "k", &v).unwrap();
    kv_set(&c, "core", "k", &v).unwrap();
    kv_set(&c, "core", "k", &v).unwrap();
    assert!(kv_history(&c, "core", "k").unwrap().is_empty());
}

#[test]
fn the_newest_generation_comes_first() {
    let c = mem();
    for n in 1..=3 {
        kv_set(&c, "core", "k", &json!({ "n": n })).unwrap();
    }
    let past = kv_history(&c, "core", "k").unwrap();
    assert_eq!(past[0]["n"], json!(2), "최신 직전 값이 앞에 오지 않는다");
    assert_eq!(past[1]["n"], json!(1));
}

#[test]
fn the_ring_is_bounded_and_drops_the_oldest() {
    let c = mem();
    for n in 0..(soksak_core::kv::PAST_DEPTH + 3) {
        kv_set(&c, "core", "k", &json!({ "n": n })).unwrap();
    }
    let past = kv_history(&c, "core", "k").unwrap();
    assert_eq!(past.len(), soksak_core::kv::PAST_DEPTH, "링이 무한히 자란다");
    // 가장 오래된 것이 밀려나야 한다 — 남은 것 중 최소가 0 이면 안 밀린 것이다.
    let oldest = past.last().unwrap()["n"].as_u64().unwrap();
    assert!(oldest > 0, "가장 오래된 세대가 안 밀렸다");
}

#[test]
fn one_key_history_is_not_another_keys() {
    let c = mem();
    kv_set(&c, "core", "a", &json!(1)).unwrap();
    kv_set(&c, "core", "a", &json!(2)).unwrap();
    kv_set(&c, "other", "a", &json!(9)).unwrap();
    kv_set(&c, "other", "a", &json!(8)).unwrap();
    assert_eq!(kv_history(&c, "core", "a").unwrap(), vec![json!(1)]);
    assert_eq!(kv_history(&c, "other", "a").unwrap(), vec![json!(9)]);
}

#[test]
fn dropping_a_ns_takes_its_history_too() {
    // ns 를 걷는데 과거만 남으면 그것이 곧 남의 저장소에 남긴 흔적이다.
    let c = mem();
    kv_set(&c, "tmp", "k", &json!(1)).unwrap();
    kv_set(&c, "tmp", "k", &json!(2)).unwrap();
    drop_ns(&c, "tmp").unwrap();
    assert!(kv_history(&c, "tmp", "k").unwrap().is_empty(), "ns 를 걷었는데 과거가 남았다");
}

