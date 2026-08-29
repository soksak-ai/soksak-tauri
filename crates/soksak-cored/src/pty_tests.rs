// 터미널 서빙 — 데몬 없이도 판정되는 것들.
//
// 여기서 고정하는 것은 **거절의 모양**이다. 실제 셸이 뜨는지는 데몬이 있어야 알 수 있고
// (tests/serves_over_socket.rs 가 그 자리다), 없는 자리에 성공을 답하지 않는 것은 여기서 진다.

use super::*;
use serde_json::json;
use soksak_core::identity::Identity;

fn ctx() -> Ctx {
    Ctx::new(Identity::new("/tmp/soksak-cored-pty-test", "com.soksak.dev"))
}

/// 출력이 갈 곳 없는 터미널은 "떴는데 아무것도 안 나온다"가 된다 — 그 증상은 오류로 보이지 않는다.
#[test]
fn a_spawn_without_a_stream_token_is_refused_by_name() {
    let params = json!({ "cols": 80, "rows": 24 });
    let args: SpawnArgs = serde_json::from_value(params.clone()).unwrap();
    let e = spawn(&ctx(), &params, args).unwrap_err();
    assert!(e.contains("토큰"), "{e}");
    assert!(e.contains("onOutput"), "조치가 없는 거절은 거절이 아니다: {e}");
}

/// 셸을 모르면 추측하지 않는다. 추측하면 사용자 계정과 다른 셸이 뜨고, 그 차이는
/// "내 설정이 안 먹는다"로만 나타난다.
#[test]
fn an_unknown_shell_is_refused_instead_of_guessed() {
    let params = json!({ "cols": 80, "rows": 24, "onOutput": { "__frameworkStream": "t-1" } });
    let args: SpawnArgs = serde_json::from_value(json!({ "cols": 80, "rows": 24 })).unwrap();
    let e = spawn(&ctx(), &params, args).unwrap_err();
    assert!(e.contains("셸"), "{e}");
    assert!(e.contains("--login-shell"), "조치가 없는 거절은 거절이 아니다: {e}");
}

/// 없는 세션에 쓰고 성공을 답하면 부르는 쪽은 "입력이 삼켜진다"만 본다.
#[test]
fn an_unknown_session_is_named_not_silently_accepted() {
    let c = ctx();
    for e in [
        write(&c, 9_999, "hi").unwrap_err(),
        resize(&c, 9_999, 80, 24).unwrap_err(),
        ack(&c, 9_999, 10).unwrap_err(),
        close(&c, 9_999).unwrap_err(),
    ] {
        assert!(e.contains("세션 없음"), "{e}");
        assert!(e.contains("9999"), "어느 세션인지 말해야 한다: {e}");
    }
}

/// 이 pane 의 세션을 모르면 데몬에 묻지도 않는다 — 없는 것은 없는 것이다.
#[test]
fn a_pane_we_never_spawned_is_not_alive() {
    assert_eq!(pane_alive(&ctx(), "tab-never").unwrap(), false);
}

/// 인자 모양은 앱 명령과 같다 — UI 는 누가 답하는지 모른다. camelCase 로 온다.
#[test]
fn the_arguments_arrive_in_the_shape_the_app_uses() {
    let a: SpawnArgs = serde_json::from_value(json!({
        "cols": 100, "rows": 30, "cwd": "/p", "shell": "/bin/zsh",
        "paneId": "tab-1", "windowLabel": "w-1", "replay": "none"
    }))
    .expect("앱과 같은 모양");
    assert_eq!(a.cols, 100);
    assert_eq!(a.pane_id.as_deref(), Some("tab-1"));
    assert_eq!(a.window_label.as_deref(), Some("w-1"));
}
