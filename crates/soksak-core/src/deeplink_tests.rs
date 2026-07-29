// 딥링크 URI 파싱의 검사 — 규칙은 deeplink.rs 가, 그 증명은 여기가 진다.
//
// 미치환 명령이 실행되지 않는 것이 이 표면의 핵심이다: 스킴·호스트·cmd 셋 중 하나라도
// 어긋나면 None 이고, None 은 "실행하지 않는다"는 뜻이다.
use super::*;

// (a) cmd + URL-인코딩 JSON params 파싱.
#[test]
fn parses_cmd_and_params() {
    // p = {"a":1,"b":"x"} URL-인코딩.
    let url = "soksak://run?cmd=plugin.x.foo&p=%7B%22a%22%3A1%2C%22b%22%3A%22x%22%7D";
    let (cmd, params) = parse_command_url(url).unwrap();
    assert_eq!(cmd, "plugin.x.foo");
    assert_eq!(params["a"], 1);
    assert_eq!(params["b"], "x");
}

// (b) params 없는 명령 → 빈 오브젝트.
#[test]
fn cmd_without_params() {
    let (cmd, params) = parse_command_url("soksak://run?cmd=state.context").unwrap();
    assert_eq!(cmd, "state.context");
    assert!(params.as_object().unwrap().is_empty());
}

// (c) 스킴/호스트 불일치 거부.
#[test]
fn wrong_scheme_or_host_rejected() {
    assert!(parse_command_url("https://run?cmd=x").is_none());
    assert!(parse_command_url("soksak://other?cmd=x").is_none());
    assert!(parse_command_url("not a url").is_none());
}

// (d) cmd 없음/빈값 거부(미치환 명령 실행 0).
#[test]
fn missing_or_empty_cmd_rejected() {
    assert!(parse_command_url("soksak://run?p=%7B%7D").is_none());
    assert!(parse_command_url("soksak://run?cmd=").is_none());
}
