// 저장소를 여는 주인은 **하나**다.
//
// 앱과 cored 가 같은 홈에서 각자 DB 를 열면 쓰기자가 둘이 된다. SQLite 는 그것을 막지 않고
// 직렬화만 한다 — `soksak_core::store_lock` 이 시끄럽게 만들려던 바로 그 조용한 경우다.
//
// 그래서 이 프로세스는 부팅에서 소유권을 **잡아 본다**.
//   잡았으면  — 자기 커넥션으로 답한다(오늘의 단독 실행).
//   못 잡았으면 — 이미 그 홈의 주인이 있다는 뜻이다. 그쪽(cored)에 물어 답한다.
//
// 못 잡은 것은 실패가 아니다. 실패로 다루면 두 번째 프레임워크가 아예 못 뜬다 — 그것이
// "동시에 켠다"가 막히던 자리다.
use super::*;

#[test]
fn ownership_decides_who_opens_the_store() {
    // 잡았으면 자기가 연다.
    assert_eq!(StoreOwner::from_claim(true), StoreOwner::Local);
    // 못 잡았으면 남이 주인이다 — 실패가 아니라 위임이다.
    assert_eq!(StoreOwner::from_claim(false), StoreOwner::Remote);
}

/// 위임은 **거절이 아니다.** 거절로 만들면 둘째 프레임워크가 저장소를 통째로 못 쓴다.
#[test]
fn delegation_is_not_a_refusal() {
    assert!(!StoreOwner::Remote.is_error());
    assert!(StoreOwner::Remote.delegates());
    assert!(!StoreOwner::Local.delegates());
}

// ── 위임된 프로세스가 실제로 넘기는가 ────────────────────────────────────────
//
// 소유권 갈래만 세우고 명령이 그대로 자기 커넥션을 보면, 위임된 프로세스는 "DB 미초기화"로
// 전부 실패한다 — 조용히 안 되는 것보다 낫지만 여전히 못 켜는 것이다.

/// 위임 상태에서 명령이 무엇을 해야 하는지 이름으로 답한다.
#[test]
fn a_delegated_command_asks_the_owner_instead_of_failing() {
    assert_eq!(
        StoreRoute::for_owner(StoreOwner::Remote),
        StoreRoute::AskOwner,
        "위임인데 자기 커넥션을 보면 DB 미초기화로 전부 실패한다"
    );
    assert_eq!(StoreRoute::for_owner(StoreOwner::Local), StoreRoute::OwnConnection);
}

/// "DB 미초기화" 와 "남이 주인" 은 **다른 사실**이다. 한 오류로 뭉치면 둘째 프레임워크의
/// 정상 상태가 결함처럼 보이고, 사람이 없는 결함을 쫓는다.
#[test]
fn not_initialised_and_owned_elsewhere_are_different_facts() {
    assert_ne!(StoreRoute::AskOwner, StoreRoute::OwnConnection);
}

// ── 위임된 명령이 실제로 넘어가는가 ──────────────────────────────────────────
//
// 갈래를 세우고 명령이 여전히 "이 홈의 저장소는 다른 프로세스가 소유한다"로만 끝나면,
// 둘째 앱은 뜨지만 쓰지 못한다. 넘어가야 그 앱에서도 쓰기가 UI 로 이어진다.

/// 위임된 자리는 **묻는 봉투를 만든다.** 만들지 않으면 넘어갈 것이 없다.
#[test]
fn a_delegated_op_names_the_method_it_would_ask() {
    let (method, params) = super::commands::delegated_call("data_get", serde_json::json!({ "ns": "n" }));
    assert_eq!(method, "data_get");
    assert_eq!(params["ns"], "n");
}

/// 넘어간 답은 **그 명령의 타입**으로 돌아온다. JSON 그대로 두면 부른 쪽이 다시 조립하고,
/// 그 조립이 앱 경로와 갈리는 순간 같은 이름이 두 모양을 답하게 된다.
#[test]
fn a_delegated_answer_comes_back_typed() {
    let v = serde_json::json!(["a", "b"]);
    let out: Vec<String> = super::commands::from_owner(v).expect("타입으로 돌아온다");
    assert_eq!(out, vec!["a".to_string(), "b".to_string()]);
}

/// 주인이 답을 못 주면 그 사유가 그대로 온다 — 여기서 삼키면 "빈 결과"로 나타난다.
#[test]
fn a_delegated_failure_keeps_its_reason() {
    let e = super::commands::from_owner::<Vec<String>>(serde_json::json!("문자열은 배열이 아니다"))
        .expect_err("모양이 다르면 실패한다");
    assert!(!e.is_empty(), "사유가 비었다");
}
