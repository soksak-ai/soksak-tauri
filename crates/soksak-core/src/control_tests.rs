// 타겟 해소 규칙 — 이 표가 그 규칙의 정의다. Tauri·cored 가 같은 함수를 부르므로 한 벌이다.
use super::*;

fn live(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_focused_window_wins_when_it_is_alive() {
    assert_eq!(
        resolve_target("project.open", "w-1", None, &live(&["main", "w-1", "w-2"])),
        Ok("w-1".into())
    );
}

#[test]
fn a_dead_focus_falls_to_the_control_plane() {
    assert_eq!(
        resolve_target("project.open", "w-dead", None, &live(&["main", "w-1"])),
        Ok("main".into())
    );
}

#[test]
fn without_main_a_sole_workspace_takes_it() {
    assert_eq!(
        resolve_target("project.open", "w-dead", None, &live(&["w-1"])),
        Ok("w-1".into())
    );
}

/// 아무 창에나 보내면 남의 창에서 명령이 돌고 성공을 답한다 — 그 오답은 오류로 보이지 않는다.
#[test]
fn two_workspaces_with_no_ground_are_ambiguous() {
    let e = resolve_target("project.open", "w-dead", None, &live(&["w-2", "w-1"])).unwrap_err();
    assert_eq!(e.code(), "AMBIGUOUS_WINDOW");
    // 목록은 정렬돼 있다 — 같은 상황에 같은 메시지가 나가야 한다.
    assert_eq!(e, NoTarget::Ambiguous(vec!["w-1".into(), "w-2".into()]));
}

#[test]
fn no_window_at_all_is_its_own_reason() {
    assert_eq!(
        resolve_target("project.open", "x", None, &[]).unwrap_err().code(),
        "NO_WINDOW"
    );
}

/// plugin.* 은 컨트롤 플레인으로 가지 않는다 — 거기엔 플러그인 호스트가 없어 상한까지
/// 기다리고, 그 침묵은 "명령이 없다"와 구분되지 않는다.
#[test]
fn a_plugin_command_never_goes_to_the_control_plane() {
    assert_eq!(
        resolve_target("plugin.foo.bar", "main", None, &live(&["main", "w-1"])),
        Ok("w-1".into())
    );
    assert_eq!(
        resolve_target("plugin.foo.bar", "main", Some("w-2"), &live(&["main", "w-1", "w-2"])),
        Ok("w-2".into())
    );
}

/// 워크스페이스가 없는 것은 창이 없는 것과 **다른 사실**이다.
#[test]
fn a_plugin_command_without_a_workspace_says_so() {
    assert_eq!(
        resolve_target("plugin.foo.bar", "main", None, &live(&["main"]))
            .unwrap_err()
            .code(),
        "NO_WORKSPACE"
    );
}

#[test]
fn a_broken_line_is_a_reason_not_a_dropped_connection() {
    assert!(parse("{ 아니다").unwrap_err().contains("JSON"));
    assert!(parse(r#"{"params":{}}"#).unwrap_err().contains("method"));
}

#[test]
fn a_request_carries_the_harness_field_names() {
    let r = parse(r#"{"id":7,"method":"project.open","params":{"root":"/p"},"window":"w-1","timeoutMs":50}"#)
        .expect("정상");
    assert_eq!(r.method, "project.open");
    assert_eq!(r.window.as_deref(), Some("w-1"));
    assert_eq!(r.timeout_ms, Some(50));
    assert_eq!(r.params["root"], "/p");
}

/// 규칙 — 배달은 **몇에게 갔는지** 싣는다.
///
/// 같은 라벨을 두 프레임워크가 들면 명령은 둘 다에게 간다(고를 수 없으면 전부에게 — 그것이
/// 옳다). 그런데 받는 쪽은 자기가 유일한 수행자인지 모른다. 부작용이 부르는 쪽이 지정한 한
/// 자리에 남는 명령이면 그 무지가 **조용한 손실**이 된다 — 실측 2026-08-08:
/// `window.snapshot {path}` 를 두 호스트가 수행해 둘 다 `OK` 를 답했고, 파일은 하나만 남았다.
/// 나중에 쓴 쪽이 먼저 쓴 쪽을 덮었는데 어느 답에도 그 사실이 없다.
///
/// 수를 실으면 받는 쪽이 판단할 수 있다. 싣지 않으면 그 판단 자체가 불가능하다.
#[test]
fn 배달_봉투는_수행자_수를_싣는다() {
    let req = Request {
        method: "window.snapshot".to_string(),
        ..Request::default()
    };
    let envelope = deliver_envelope(7, &req, "main", 2);
    assert_eq!(
        envelope["deliver"]["hosts"],
        serde_json::json!(2),
        "몇에게 갔는지 없으면 받는 쪽은 자기가 유일한 수행자인 줄 안다"
    );
}
