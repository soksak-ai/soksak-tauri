// 딥링크 URI 파싱의 검사 — 규칙은 deeplink.rs 가, 그 증명은 여기가 진다.
//
// 미치환 명령이 실행되지 않는 것이 이 표면의 핵심이다: 스킴·호스트·cmd 셋 중 하나라도
// 어긋나면 None 이고, None 은 "실행하지 않는다"는 뜻이다.
use super::*;

// (a) cmd + URL-인코딩 JSON params 파싱.
#[test]
fn parses_cmd_and_params() {
    // p = {"a":1,"b":"x"} URL-인코딩.
    let (cmd, params) = parse_command_url("soksak://cmd/plugin.x.foo?a=1&b=x").unwrap();
    assert_eq!(cmd, "plugin.x.foo");
    assert_eq!(params["a"], "1");
    assert_eq!(params["b"], "x");
}

// (b) params 없는 명령 → 빈 오브젝트.
#[test]
fn cmd_without_params() {
    let (cmd, params) = parse_command_url("soksak://cmd/state.context").unwrap();
    assert_eq!(cmd, "state.context");
    assert!(params.as_object().unwrap().is_empty());
}

// (c) 스킴/호스트 불일치 거부.
#[test]
fn wrong_scheme_or_host_rejected() {
    assert!(parse_command_url("https://cmd/x").is_none());
    assert!(parse_command_url("soksak://other/x").is_none());
    assert!(parse_command_url("not a url").is_none());
}

// (d) cmd 없음/빈값 거부(미치환 명령 실행 0).
#[test]
fn missing_or_empty_cmd_rejected() {
    assert!(parse_command_url("soksak://cmd/").is_none());
    assert!(parse_command_url("soksak://cmd").is_none());
}

// 스킴은 **정체성으로 갈린다** — 홈과 같은 축(env)이다.
//
// RED 근거(실측 2026-08-01): 한 스킴(`soksak`)을 모든 정체성이 주장하자, 이 기계의
// LaunchServices 에 그것을 주장하는 번들이 200 개가 넘었다(옛 dmg·옛 repo·워크트리). `open
// soksak://…` 이 도는 앱에 닿지 않았고, 그 부재는 오류가 아니라 "링크가 안 열린다"로만 났다.

#[test]
fn the_scheme_carries_the_identity() {
    assert_eq!(scheme_for("com.soksak.tauri.dev"), "soksak-dev");
    assert_eq!(scheme_for("com.soksak.electron.dev"), "soksak-dev");
    assert_eq!(scheme_for("com.soksak.tauri.debug"), "soksak-debug");
}

/// release 는 접미사가 없다 — 홈이 `~/.soksak` 인 것과 같은 규칙이다.
#[test]
fn release_has_no_suffix() {
    assert_eq!(scheme_for("com.soksak.app"), "soksak");
}

/// 한 홈에 선 두 프레임워크는 **같은 스킴**이다 — 홈을 가르는 축이 env 하나이기 때문이다.
#[test]
fn both_frameworks_share_one_scheme() {
    assert_eq!(
        scheme_for("com.soksak.tauri.dev"),
        scheme_for("com.soksak.electron.dev")
    );
}

/// 파싱은 어느 정체성으로 왔는지 가리지 않는다 — OS 가 이미 그 앱으로 넘긴 뒤다.
#[test]
fn any_identity_scheme_parses() {
    for raw in [
        "soksak://cmd/window.list",
        "soksak-dev://cmd/window.list",
        "soksak-debug://cmd/window.list",
    ] {
        assert!(parse_command_url(raw).is_some(), "{raw}");
    }
}

/// 남의 스킴은 받지 않는다.
#[test]
fn a_foreign_scheme_is_refused() {
    for raw in ["soksakx://cmd/x", "soksak-://cmd/x", "https://cmd/x"] {
        assert!(parse_command_url(raw).is_none(), "{raw}");
    }
}
