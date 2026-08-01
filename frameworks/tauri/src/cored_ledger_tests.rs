//! state-bound 갈래의 인구조사 — **아무 답도 없는 이름을 여기서도 센다.**
//!
//! 옆 파일의 완전성 검사는 open 갈래만 봤다. 그래서 `unanswered() == []` 가 통과하는 동안
//! state-bound 갈래는 한 번도 세어진 적이 없었다 — 그 갈래에는 서빙도 거절도 아닌 이름이
//! 수십 개 있었는데, 그 사실이 소스 어디에도 안 남아 사람 기억에만 살았다.
//!
//! 침묵이 통과로 읽히는 것을 막는 방법은 **수를 못 박는 것**뿐이다. 늘면 실패한다: 관리
//! 상태에 묶인 명령이 조사 없이 새로 생겼다는 뜻이고, 그 이름은 프레임워크 저자에게
//! UNKNOWN_COMMAND 한 줄로만 보인다. 줄어도 실패한다: 갚은 부채를 장부가 계속 들고 있으면
//! 그 수가 거짓이 되고, 거짓말하는 장부는 곧 무시된다.

use super::*;

/// 지금 이 트리의 state-bound 미답 수 — **래칫이다.**
///
/// 실측 2026-07-29: state-bound 갈래를 세는 자리가 없어 45건이 어디에도 안 적혀 있었다.
/// 그 뒤 cored 가 저장소 표면 18건을 서빙하면서 **27건**으로 내려왔다 — 앱이 자기 커넥션을
/// 놓을 수 있게 된 만큼이다.
///
/// 이 갈래는 "관리 상태·앱 핸들에 묶였다"는 1차 판정일 뿐이라, 계약(WindowOracle·
/// ActivitySink·CommandDispatch)이 풀면 open 이나 served 로 내려간다. 그때 이 수를 함께 내린다.
///
/// **2026-07-30 재입법 27 → 30.** `lane_of` 가 시그니처의 창 주입만 보고 framework 로 세던
/// 규칙을 걷어냈다. 그 규칙 아래에서는 가족 밖 이름이 "프레임워크가 답할 몫"으로 세어져
/// 이식 대상에서 빠졌는데, 두 번째 프레임워크는 **이름**으로 자기 몫을 고르므로 그 이름을
/// 받지 않는다 — 아무도 안 가진 채로 다 옮긴 것처럼 세어졌다. 돌아온 셋은
/// `daemon_start`·`project_claim`·`project_release` 다.
///
/// 수가 오른 것은 기준을 낮춘 것이 아니라 숨어 있던 셋을 세기 시작한 것이다.
///
/// **2026-07-30 축소 30 → 27.** ws_connect·ws_send·ws_close 를 cored 가 진다. 벽으로 적혀
/// 있던 "전송기가 런타임을 끌고 온다"는 이제 사실이 아니다 — tokio 는 그 금지 목록 자신의
/// 기준에 걸리지 않아 풀렸고(download_verify 커밋), 몸은 soksak-net 으로 갔다. 스트림은
/// cored 가 이미 지고 있던 토큰 통로를 탄다.
///
/// **2026-07-30 축소 27 → 18.** 데몬 여섯(start·stop·status·logs·reap·run_once)과 저장소
/// 여덟(backup·restore·export·import·canary·repair·ns_remove·migrate_ns)이 답을 얻었다.
/// 데몬은 관리 상태에 묶여 보였지만 그 상태는 **장부 하나**였고, 장부는 프로세스의 것이지
/// 프레임워크의 것이 아니었다 — cored 가 지면 껍데기를 갈아도 자식이 안 죽는다. 저장소 쪽은
/// 능력이 아니라 배선이 없었다: 갈림을 모으는 자리(store_op)는 이미 있었고 여덟이 그 자리를
/// 지나지 않고 커넥션을 직접 잡고 있었다.
///
/// **2026-07-30 축소 18 → 13.** 상주 서비스 넷과 예약 다섯. 벽으로 적혀 있던 "매니저가
/// 요구하는 호스트 능력에 대응하는 계약이 코어에 없다"는 사실이 아니게 됐다 — 계약
/// (ServiceHost)은 크레이트에 있었고, 그 다섯 중 넷을 cored 가 이미 진다(활동 발행·예약
/// 깨우기·시크릿 둘). 다섯째(중개)는 그 프로세스의 단일 갈래 그 자체다.
///
/// **2026-07-31 축소 13 → 10.** 유닛 스캐폴드 셋과 데몬 파괴 둘, 그리고 이름으로 묻는 hello.
/// 스캐폴드의 벽은 git 봉인이었는데 그것은 봉인을 푸는 문제가 아니라 **자리를 밝히는** 문제였다
/// (ALLOWLIST 는 자리 이름으로 등재하는 장치다). 데몬 restart·upgrade 는 "파괴적이라 어느
/// 프로세스가 할지는 별개 결정"으로 남아 있었는데, 데몬을 지는 쪽이 정해진 뒤로 그 결정은
/// 이미 내려져 있었다.
// 2026-08-01: 10 → 7. 클립보드 셋(read·write·watch_start/stop 중 미답이던 것)이 코어로 갔다 —
// 능력의 집을 가르는 축은 "창을 요구하는가"이고(A26), 클립보드는 창 없이 된다.
const STATE_BOUND_UNANSWERED: usize = 7;

/// state-bound 갈래에서 아직 아무 답도 없는 이름들.
fn state_bound_unanswered() -> Vec<String> {
    unanswered_lane(Lane::StateBound)
}

/// **이 갈래도 세어진다.** 수가 움직이면 실패한다.
#[test]
fn the_state_bound_lane_is_counted_too() {
    // 오라클 생존 — 갈래를 못 읽으면 미답도 0 이 되어 통과로 위장한다("0 의 두 얼굴").
    let lane = ledger().remove(&Lane::StateBound).unwrap_or_default();
    assert!(
        !lane.is_empty(),
        "state-bound 갈래를 읽지 못했다 — 이 검사는 판정할 수 없다"
    );
    let names = state_bound_unanswered();
    assert_eq!(
        names.len(),
        STATE_BOUND_UNANSWERED,
        "state-bound 미답이 {}건이다(못 박은 수 {STATE_BOUND_UNANSWERED}). \
         늘었으면 조사 없이 들어온 이름이 있다 — 서빙하거나 UNSERVED 에 사유를 달아라. \
         줄었으면 이 수를 내려라: {names:?}",
        names.len(),
    );
}

/// open 이 깨끗해도 state-bound 는 아무것도 증명되지 않는다 — **갈래마다 따로 센다.**
///
/// 이것이 옆 파일 검사가 눈멀었던 자리다. 규칙은 하나인데 입력이 갈래마다 달라서, 한 갈래에
/// 건 판정이 다른 갈래에 대해 말해 주는 것은 없다. 심은 표로 그 차이를 못 박는다.
#[test]
fn a_clean_open_lane_says_nothing_about_the_state_bound_lane() {
    let open = vec!["fs_read".to_string()];
    let state_bound = vec!["daemon_start".to_string()];
    let served = ["fs_read"];
    let refused: [&str; 0] = [];
    // open 은 답이 있다 — 그쪽만 보면 통과다.
    assert_eq!(
        unanswered_in(&open, &served, &refused),
        Vec::<String>::new(),
    );
    // 같은 규칙을 state-bound 에 걸면 미답이 드러난다.
    assert_eq!(
        unanswered_in(&state_bound, &served, &refused),
        vec!["daemon_start".to_string()],
    );
}

/// 갈래를 인자로 받는다는 것이 값으로 확인된다 — open 과 state-bound 가 서로 다른 이름을 센다.
///
/// 두 갈래가 같은 목록을 답하면 `ledger()` 의 분류가 무너진 것이고, 그때 이 인구조사는
/// open 검사의 사본에 지나지 않는다.
#[test]
fn each_lane_is_read_from_its_own_names() {
    let l = ledger();
    let open = l.get(&Lane::Open).cloned().unwrap_or_default();
    let state_bound = l.get(&Lane::StateBound).cloned().unwrap_or_default();
    assert!(!open.is_empty() && !state_bound.is_empty(), "{:?}", summary());
    for n in &open {
        assert!(
            !state_bound.contains(n),
            "{n} 이 두 갈래에 함께 있다 — 분류가 무너졌다"
        );
    }
}
