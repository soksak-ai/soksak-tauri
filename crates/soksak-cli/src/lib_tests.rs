// CLI 의 검사 — 규칙은 lib.rs 가, 그 증명은 여기가 진다.
//
// 전송·포맷만 하는 도구지만 어긋나면 조용하다: 잘못 해석한 인자는 **다른 명령**이 되고,
// 잘못 고른 소켓은 **다른 홈의 앱**에 붙는다. 그래서 인자 해석·요청 봉투·소켓 핀·환경
// 대조를 값으로 고정한다.
use super::*;

#[test]
fn generated_core_reference_has_separators_between_commands_but_no_blank_eof() {
    let command = |name: &str| serde_json::json!({
        "name": name,
        "description": "d",
        "params": {},
        "returns": "{}",
        "examples": [name],
    });
    let md = format_command_list(&[command("a"), command("b")], false);
    assert!(md.contains("```\n\n## `b`"), "commands keep one blank separator");
    assert!(md.ends_with("```\n"));
    assert!(!md.ends_with("```\n\n"), "generated file must not gain a blank EOF line");
}

// SKILL.md frontmatter name 추출 — 설치 디렉토리명(dir==name 관례).
#[test]
fn skill_frontmatter_name_parses() {
    assert_eq!(
        skill_frontmatter_name("---\nname: soksak-erd\ndescription: x\n---\nbody"),
        Some("soksak-erd".to_string())
    );
    // 따옴표·공백 허용
    assert_eq!(
        skill_frontmatter_name("---\nname:  \"my-skill\" \n---\n"),
        Some("my-skill".to_string())
    );
    // frontmatter 없음 → None
    assert_eq!(skill_frontmatter_name("# 제목\nname: x"), None);
    // 안전하지 않은 문자(경로 주입) 거부
    assert_eq!(skill_frontmatter_name("---\nname: ../evil\n---\n"), None);
}

// help/docs/usage 의 예제 프리픽스는 호출된 바이너리 이름이어야 한다 — sok-dev 로 실행했는데
// `sok …` 예제를 보여주면 복붙이 다른(또는 없는) 환경 바이너리로 간다. 이름은 argv0 추론이
// 아니라 컴파일 타임 env 에서 파생한다(P9와 동일 원천).
#[test]
fn example_prefix_follows_binary_identity() {
    assert_eq!(bin_name_for_env("dev"), "sok-dev");
    assert_eq!(bin_name_for_env("debug"), "sok-debug");
    assert_eq!(bin_name_for_env("app"), "sok");
    // 카탈로그 예제는 명령 형태만 담는다(프리픽스 없음) — format_command_md 가 이 바이너리 이름을
    // 붙여 렌더한다. 프리픽스는 데이터가 아니라 표시자의 정체성이므로, 렌더 산물엔 bin 이 정확히
    // 한 번(이중 프리픽스 없이) 붙는다.
    let spec = json!({
        "name": "window.snapshot",
        "description": "capture the window",
        "examples": ["window.snapshot '{\"path\":\"<local-evidence>/s.png\"}'"],
    });
    let md = format_command_md(&spec);
    let bin = bin_name_for_env(default_env());
    assert!(
        md.contains(&format!("{bin} window.snapshot '{{\"path\":\"<local-evidence>/s.png\"}}'")),
        "예제에 이 바이너리 프리픽스가 붙어야 한다: {md}"
    );
    // 데이터가 형태-only 라 이중 프리픽스(bin bin)가 생기지 않는다.
    assert!(!md.contains(&format!("{bin} {bin}")), "이중 프리픽스: {md}");
}

// 기본 환경은 이름별 실물 바이너리가 컴파일 타임에 주입한다(P9) — argv0 추론은 폐기.
#[test]
fn 기본_환경은_컴파일_타임_주입이다() {
    let _ = DEFAULT_ENV.set("debug");
    assert_eq!(default_env(), "debug");
}

#[test]
fn 저작_조각_분해와_이름_강제() {
    let (fm, body) = split_directives("---\nname: x\ndescription: d\n---\n\n본문");
    assert_eq!(fm.as_deref(), Some("name: x\ndescription: d"));
    assert_eq!(body, "본문");
    let out = skill_frontmatter("soksak-dev", "dev", fm.as_deref());
    assert!(out.contains("name: soksak-dev"));
    assert!(out.contains("description: d"));
    let (fm2, body2) = split_directives("frontmatter 없는 본문");
    assert!(fm2.is_none());
    assert_eq!(body2, "frontmatter 없는 본문");
}

// ── 프로토콜 협상(판 선언 + system.hello 판정) ───────────────────────────

// 모든 소켓 요청 봉투는 자기 판을 선언한다 — 앱 쪽 VERSION_SKEW 게이트의 재료.
// 라이브 실측 RED(2026-07-11): 현행 sok 요청에 protocol 필드가 없다(레거시=0 취급만 가능).
#[test]
fn every_request_declares_protocol() {
    let req = build_request("state.tree", Value::Null, None, None, None, None);
    assert_eq!(req["protocol"], soksak_spec_socket::SOCKET_PROTOCOL_VERSION);
    assert_eq!(req["method"], "state.tree");
    // 구독(장수 연결)도 같은 빌더를 지난다 — 게이트에 빠짐없이 걸린다.
    let sub = build_request(
        "events.subscribe",
        json!({"kinds":["command"]}),
        None,
        None,
        None,
        None,
    );
    assert_eq!(sub["protocol"], soksak_spec_socket::SOCKET_PROTOCOL_VERSION);
}

// 봉투 계약: 선택 필드는 값이 있을 때만 — 빌더 추출이 기존 배선을 보존함을 고정한다.
#[test]
fn envelope_optional_fields_only_when_present() {
    let bare = build_request("state.tree", Value::Null, None, None, None, None);
    for k in ["pane", "window", "parent", "timeoutMs"] {
        assert!(bare.get(k).is_none(), "{k} 는 값 없으면 실리지 않는다");
    }
    let full = build_request(
        "term.read",
        json!({"lines": 5}),
        Some("p1".into()),
        Some("w-abc".into()),
        Some("turn-7".into()),
        Some(30_000),
    );
    assert_eq!(full["pane"], "p1");
    assert_eq!(full["window"], "w-abc");
    assert_eq!(full["parent"], "turn-7");
    assert_eq!(full["timeoutMs"], 30_000);
}

// 같은 판은 호환. 협상 이전 앱(hello 를 프론트로 흘려 ok:false)은 판 0 — floor 0 인 동안 호환.
#[test]
fn hello_verdict_compatible_for_current_and_legacy() {
    use soksak_spec_socket::Lang;
    let modern = json!({"ok": true, "protocol": soksak_spec_socket::SOCKET_PROTOCOL_VERSION});
    let summary = judge_hello_reply(&modern, Lang::En).expect("같은 판은 호환");
    assert!(
        summary.contains("compatible"),
        "요약에 판정 명시: {summary}"
    );
    let legacy = json!({"ok": false, "code": "UNKNOWN_COMMAND", "message": "unknown"});
    let summary =
        judge_hello_reply(&legacy, Lang::En).expect("floor 0 인 동안 구세대 앱은 호환");
    assert!(summary.contains('0'), "구세대=판 0 명시: {summary}");
}

// 사람 표면: 요약 문장은 이 셸의 로케일로 해소한다 — ko 로케일이면 한국어.
// 판 숫자는 언어 독립(같은 자리에 그대로).
#[test]
fn hello_summary_resolves_to_shell_locale() {
    use soksak_spec_socket::{Lang, SOCKET_PROTOCOL_VERSION};
    let modern = json!({"ok": true, "protocol": SOCKET_PROTOCOL_VERSION});
    let ko = judge_hello_reply(&modern, Lang::Ko).expect("같은 판은 호환");
    assert!(ko.contains("호환됨"), "ko 로케일은 한국어로 해소: {ko}");
    assert!(
        !ko.contains("compatible"),
        "ko 로케일에 영어 문장이 새면 안 된다: {ko}"
    );
    assert!(
        ko.contains(&SOCKET_PROTOCOL_VERSION.to_string()),
        "판 숫자는 언어 독립: {ko}"
    );
    // 협상 이전 앱(ok:false)은 판 0 으로 판별 — 그 사실도 해소된 언어로 붙는다.
    let legacy = json!({"ok": false, "code": "UNKNOWN_COMMAND", "message": "unknown"});
    let ko = judge_hello_reply(&legacy, Lang::Ko).expect("floor 0 인 동안 구세대 앱은 호환");
    assert!(
        ko.contains("hello 이전 앱"),
        "구세대 앱 사실을 한국어로 고지: {ko}"
    );
}

// 앱이 더 새 판이면 sok 이 낡은 쪽 — 방향 명시 문장으로 거부.
#[test]
fn hello_verdict_rejects_newer_app() {
    use soksak_spec_socket::Lang;
    let reply = json!({"ok": true, "protocol": 999});
    let err = judge_hello_reply(&reply, Lang::En).expect_err("판이 앞선 앱은 거부");
    assert!(err.contains("999"), "앱 판 숫자: {err}");
    assert!(
        err.contains(&soksak_spec_socket::SOCKET_PROTOCOL_VERSION.to_string()),
        "sok 판 숫자: {err}"
    );
    assert!(err.contains("update this sok"), "낡은 쪽 명시: {err}");
}

// 스큐 거부 문장도 사람 표면 — ko 로케일이면 한국어로 해소한다(영어 골격 미누출).
#[test]
fn hello_skew_sentence_resolves_to_korean() {
    use soksak_spec_socket::Lang;
    let reply = json!({"ok": true, "protocol": 999});
    let err = judge_hello_reply(&reply, Lang::Ko).expect_err("판이 앞선 앱은 거부");
    assert!(err.contains("999"), "앱 판 숫자: {err}");
    assert!(err.contains("소켓 프로토콜"), "한국어 골격: {err}");
    assert!(
        err.contains("업데이트하세요"),
        "낡은 쪽을 한국어로 명시: {err}"
    );
    assert!(
        !err.contains("speaks socket protocol"),
        "영어 골격 미누출: {err}"
    );
}

// env 토큰 검증 — dev|debug|app 만.
#[test]
fn env_validation_rejects_unknown() {
    assert!(validate_env("dev").is_ok());
    assert!(validate_env("debug").is_ok());
    assert!(validate_env("app").is_ok());
    assert!(validate_env("prod").is_err());
    assert!(validate_env("release").is_err());
    assert!(validate_env("").is_err());
}

// 소켓 파일명은 env 를 따르지 않는다 — 홈이 이미 env 를 가른다(the_socket_is_one_per_home 참조).

#[test]
fn socket_peer_must_match_compiled_cli_identity() {
    assert_eq!(identity_for_env("app").unwrap(), "com.soksak.app");
    assert_eq!(identity_for_env("dev").unwrap(), "com.soksak.dev");
    assert_eq!(identity_for_env("debug").unwrap(), "com.soksak.debug");

    let app = json!({"ok": true, "identity": "com.soksak.app"});
    assert!(validate_peer_identity(&app, "com.soksak.app").is_ok());
    let err = validate_peer_identity(&app, "com.soksak.dev").unwrap_err();
    assert!(err.contains("ENVIRONMENT_MISMATCH"));
    assert!(err.contains("com.soksak.dev"));
    assert!(err.contains("com.soksak.app"));

    let unverified = json!({"ok": true});
    assert!(validate_peer_identity(&unverified, "com.soksak.app").is_err());
}

#[test]
fn a_framework_named_peer_is_the_same_environment() {
    // 이 CLI 는 env 도구다 — 이름이 `sok-dev` 인 것은 dev **홈**을 잡는다는 뜻이다.
    // 홈은 env 가 가르고 프레임워크는 이름만 가르므로(코어 identity.rs), 한 홈에 선
    // tauri/electron 을 남으로 보면 홈 하나를 두 CLI 로 나눠 잡아야 한다.
    for peer in ["com.soksak.tauri.dev", "com.soksak.electron.dev"] {
        let reply = json!({"ok": true, "identity": peer});
        assert!(
            validate_peer_identity(&reply, "com.soksak.dev").is_ok(),
            "{peer} 는 dev 홈의 앱이다"
        );
    }
    // env 가 다르면 프레임워크가 같아도 여전히 남이다 — 홈이 다르다.
    let other_env = json!({"ok": true, "identity": "com.soksak.tauri.debug"});
    let err = validate_peer_identity(&other_env, "com.soksak.dev").unwrap_err();
    assert!(err.contains("ENVIRONMENT_MISMATCH"));
}

#[test]
fn identity_preflight_and_command_use_one_session() {
    let request = build_request("state.tree", Value::Null, None, None, None, None);
    let mut methods = Vec::new();
    let reply = authenticated_exchange("com.soksak.app", "state.tree", &request, |message| {
        let method = message["method"].as_str().unwrap().to_string();
        methods.push(method.clone());
        match method.as_str() {
            "system.hello" => Ok(json!({"ok": true, "identity": "com.soksak.app"})),
            "state.tree" => Ok(json!({"ok": true, "data": {"tree": []}})),
            _ => Err(format!("unexpected method: {method}")),
        }
    })
    .expect("authenticated command");
    assert_eq!(reply["ok"], true);
    assert_eq!(methods, ["system.hello", "state.tree"]);
}

// 소켓 위치는 주입값 또는 컴파일 identity 홈에서 결정한다. 주입값도 identity 검증을 우회하지 못한다.
#[test]
fn 환경은_정체성이다() {
    // 앱이 주입한 SOKSAK_SOCKET은 위치 힌트다. 실제 권위는 뒤따르는 hello identity 검증이다.
    match resolve_target(Some("/x.sock".into())) {
        SockTarget::Explicit(p) => assert_eq!(p, "/x.sock"),
        _ => panic!("앱 주입 소켓 위치가 선택되어야"),
    }
    // 주입이 없으면 컴파일된 자기 환경(테스트 프로세스의 설정값).
    match resolve_target(None) {
        SockTarget::Env(e) => assert_eq!(e, default_env()),
        _ => panic!("컴파일 환경이어야"),
    }
    // 빈 문자열 주입은 무시.
    match resolve_target(Some(String::new())) {
        SockTarget::Env(e) => assert_eq!(e, default_env()),
        _ => panic!("빈 값 무시여야"),
    }
}

// 도메인 지도: 도메인별 1줄, 플러그인 collapse, per-command params 미포함(P5).
#[test]
fn domain_map_groups_and_collapses() {
    let cmds = vec![
        json!({"name":"panel.split","params":{"side":{"type":"string"}}}),
        json!({"name":"panel.merge"}),
        json!({"name":"browser.navigate"}),
        json!({"name":"browser.dom.click"}),
        json!({"name":"plugin.soksak-plugin-clip.clip.capture"}),
        json!({"name":"plugin.soksak-plugin-clip.clip.list"}),
    ];
    let map = domain_map(&cmds);
    assert!(map.contains("- panel (2): merge, split"), "{map}");
    assert!(map.contains("- browser (1): navigate"), "{map}");
    assert!(map.contains("- browser.dom (1): click"), "{map}");
    assert!(map.contains("- plugin (2): dynamic"), "{map}");
    assert!(
        !map.contains("clip.capture"),
        "플러그인 per-command 가 새면 안 됨: {map}"
    );
    assert!(
        !map.contains("\"type\""),
        "params 가 지도에 포함되면 안 됨: {map}"
    );
}

// skill_doc_with: frontmatter(name+description) + 주입된 도메인 지도. per-command 카탈로그 없음.
#[test]
fn skill_doc_has_frontmatter_and_map_no_catalog() {
    let doc = skill_doc_with("- panel (2): merge, split\n", "dev", None);
    assert!(
        doc.starts_with("---\nname: soksak-dev\n"),
        "frontmatter 누락(환경 이름)"
    );
    assert!(doc.contains("description:"), "description 트리거 누락");
    assert!(doc.contains("Environment: **dev**"), "환경 핀 블록 누락");
    assert!(
        doc.contains("- panel (2): merge, split"),
        "도메인 지도 주입 누락"
    );
    assert!(doc.contains("AUTO-GENERATED"), "생성 헤더 누락(P10)");
    assert!(doc.contains("`sok commands`"), "발견 명령 안내 누락(P5)");
    assert!(
        !doc.contains("\"params\""),
        "per-command params 가 스킬에 새면 안 됨"
    );
}

// env 토큰 → MCP 서버 이름(세 환경 공존).
#[test]
fn server_name_per_env() {
    assert_eq!(server_name_for_env("app"), "soksak");
    assert_eq!(server_name_for_env("dev"), "soksak-dev");
    assert_eq!(server_name_for_env("debug"), "soksak-debug");
}

// `<tool> mcp add` argv 빌더(2026 공식문서 문법). env SOKSAK_SOCKET 핀.
#[test]
fn mcp_add_argv_per_tool() {
    let (p, a) = mcp_add_argv("claude", "soksak-dev", "/s.sock", "/bin/sok").unwrap();
    assert_eq!(p, "claude");
    assert_eq!(
        a,
        vec![
            "mcp",
            "add",
            "--scope",
            "user",
            "--env",
            "SOKSAK_SOCKET=/s.sock",
            "soksak-dev",
            "--",
            "/bin/sok",
            "mcp"
        ]
    );

    let (p, a) = mcp_add_argv("codex", "soksak", "/s.sock", "/bin/sok").unwrap();
    assert_eq!(p, "codex");
    assert_eq!(
        a,
        vec![
            "mcp",
            "add",
            "soksak",
            "--env",
            "SOKSAK_SOCKET=/s.sock",
            "--",
            "/bin/sok",
            "mcp"
        ]
    );

    let (p, a) = mcp_add_argv("gemini", "soksak-debug", "/s.sock", "/bin/sok").unwrap();
    assert_eq!(p, "gemini");
    assert_eq!(
        a,
        vec![
            "mcp",
            "add",
            "soksak-debug",
            "-e",
            "SOKSAK_SOCKET=/s.sock",
            "-s",
            "user",
            "/bin/sok",
            "mcp"
        ]
    );

    assert!(mcp_add_argv("unknown", "x", "y", "z").is_err());
}

// 전역 --env 플래그 추출(어느 위치든) + 제거.
#[test]
fn take_flag_extracts_and_removes() {
    let mut a = vec!["--env".to_string(), "dev".into(), "state.tree".into()];
    assert_eq!(take_flag_value(&mut a, "--env"), Some("dev".into()));
    assert_eq!(a, vec!["state.tree".to_string()]);

    // 명령 뒤에 와도 추출.
    let mut b = vec![
        "mcp".to_string(),
        "install".into(),
        "--env".into(),
        "debug".into(),
    ];
    assert_eq!(take_flag_value(&mut b, "--env"), Some("debug".into()));
    assert_eq!(b, vec!["mcp".to_string(), "install".into()]);

    // 없으면 None, 원본 보존.
    let mut c = vec!["state.tree".to_string()];
    assert_eq!(take_flag_value(&mut c, "--env"), None);
    assert_eq!(c, vec!["state.tree".to_string()]);

    // 값 없는 --env 는 제거하고 None.
    let mut d = vec!["state.tree".to_string(), "--env".into()];
    assert_eq!(take_flag_value(&mut d, "--env"), None);
    assert_eq!(d, vec!["state.tree".to_string()]);
}

/// 붙을 자리는 **홈 하나에 하나**다 — `<홈>/cored.sock`.
///
/// identifier 로 이름을 지으면 그 이름에 프레임워크 세그먼트가 들어가고, 한 홈에 tauri 와
/// electron 이 같이 서면 붙을 자리가 프레임워크 수만큼 생긴다. 그때 이 CLI 는 둘 중 하나만
/// 잡거나(운이 좋으면), 아무것도 못 잡는다(실측: `com.soksak.dev.sock` 을 손으로 지어서
/// 찾다가 "미실행"이라 답했다 — 앱은 그때 `com.soksak.tauri.dev.sock` 으로 떠 있었다).
///
/// 판정 축은 이미 env 하나로 고쳤다. 발견 축도 같은 자리를 봐야 그 고침이 끝난다.
#[test]
fn the_socket_is_one_per_home_not_one_per_identifier() {
    let name = socket_name_for_env("dev");
    assert_eq!(
        name,
        soksak_core::identity::CORED_SOCKET_FILE,
        "붙을 자리는 홈 하나에 하나다 — identifier 로 지으면 프레임워크마다 자리가 생긴다"
    );
    // env 가 달라도 파일명은 같다. 홈이 이미 env 를 가르기 때문이다(~/.soksak-dev vs -debug).
    assert_eq!(socket_name_for_env("debug"), name);
    assert_eq!(socket_name_for_env("app"), name);
}
