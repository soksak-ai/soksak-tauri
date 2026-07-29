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
