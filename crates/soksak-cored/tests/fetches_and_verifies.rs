//! 내려받아 해시를 대조하고 앉히는 일은 이 프로세스의 것이다.
//!
//! 이 능력이 프레임워크에 있으면 두 번째 프레임워크는 런타임 의존을 스스로 내려받지 못한다 —
//! 그 앱에서는 사이드카 설치가 시작조차 안 된다. 창도 앱 핸들도 볼트도 안 쓰는 열 줄이
//! 프레임워크 이름 밑에 앉아 있었을 뿐이다.
//!
//! 내려받기 한 걸음은 네트워크라 이 검사가 지나가지 않는다. 그 걸음은 soksak-net 의 전송기가
//! 자기 검사로 지고, 여기서는 **이 프로세스가 그 이름을 진다**는 사실만 못 박는다.

use soksak_cored::registry;

#[test]
fn the_download_command_is_served_here() {
    // 오라클 생존 — 표를 못 읽으면 아래 단언은 아무것도 안 지킨다.
    assert!(!registry::COMMANDS.is_empty(), "명령 표가 비었다");
    assert!(
        registry::COMMANDS.iter().any(|c| c.name == "download_verify"),
        "download_verify 를 서빙하지 않는다 — 두 번째 프레임워크는 런타임 의존을 못 내려받는다"
    );
    // 한 이름이 서빙과 거절에 함께 있으면 어느 쪽이 진실인지 아무도 모른다.
    assert!(
        !registry::UNSERVED.iter().any(|u| u.name == "download_verify"),
        "서빙하면서 거절 사유도 달고 있다"
    );
}
