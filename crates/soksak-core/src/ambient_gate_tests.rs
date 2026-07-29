// 앰비언트 등재 게이트의 **판정** 검사 — 규칙은 ambient_gate.rs 가, 그 증명은 여기가 진다.
//
// 이 파일 안의 키 리터럴은 픽스처다. 게이트는 `_tests.rs` 를 스캔에서 빼므로 여기의
// 리터럴이 실행 경로로 세어지지 않는다 — 안 빼면 고칠 수 없는 위반이 생긴다.
//
// 저장소를 실제로 훑는 검사는 tests/ambient_gate.rs 에 있다. 나뉜 이유는 뿌리다: 규칙은
// 뿌리를 인자로 받으므로 "이 저장소의 뿌리가 어디인가"를 아는 쪽이 그 검사를 진다.
use super::*;

#[test]
fn every_entry_answers_both_questions() {
    // 이유 없는 등재는 등재가 아니다 — 표를 통과 도구로 쓰는 것을 막는다.
    let empty: Vec<String> = ALLOWED
        .iter()
        .filter(|a| a.why.trim().is_empty() || a.after_split.trim().is_empty())
        .map(|a| format!("{}:{}", a.path, a.key))
        .collect();
    assert_eq!(empty, Vec::<String>::new(), "이유·대체 경로가 빈 등재");
}

/// 키는 뿌리-상대 경로다. basename 으로 되돌아가면 사면 하나가 여러 트리를 함께 덮는다 —
/// `pty.rs` 한 줄이 프레임워크의 것과 cored 의 것을 같이 사면하고, 둘 다 같은 키를 읽는다.
#[test]
fn every_entry_is_keyed_by_a_path_not_a_basename() {
    let flat: Vec<&str> = ALLOWED
        .iter()
        .filter(|a| !a.path.contains('/'))
        .map(|a| a.path)
        .collect();
    assert_eq!(flat, Vec::<&str>::new(), "basename 키 — 뿌리-상대 경로로 올려라");
}

/// 표가 경로로 적혀 있어도 **대조하는 쪽**이 basename 으로 되돌아가면 같은 구멍이 돌아온다.
/// 표의 모양만 재면 그 회귀가 안 잡힌다 — 대조를 직접 잰다.
///
/// 지금 실제로 `pty.rs` 는 두 자리에 있고 둘 다 같은 키를 읽는다(프레임워크의 것 · cored 의 것).
#[test]
fn an_entry_amnesties_one_tree_not_every_file_with_that_name() {
    let allowed = &[AmbientRead {
        path: "frameworks/tauri/src/pty.rs",
        key: "SOKSAK_PTYD_BIN",
        why: "픽스처",
        after_split: "픽스처",
    }];
    let src = "fn f() { let _ = std::env::var(\"SOKSAK_PTYD_BIN\"); }\n";
    assert!(
        unregistered_in("frameworks/tauri/src/pty.rs", src, allowed).is_empty(),
        "등재된 자리는 사면된다"
    );
    assert_eq!(
        unregistered_in("crates/soksak-cored/src/pty.rs", src, allowed).len(),
        1,
        "이름이 같을 뿐인 다른 트리까지 사면되면, 답 없는 자리가 신호 없이 남는다"
    );
}

// ── 무엇을 읽기로 세는가 ───────────────────────────────────────────────────────

#[test]
fn a_literal_key_is_a_read_in_both_languages() {
    let rust = "fn f() { let _ = std::env::var(\"SOKSAK_HOME\"); }\n";
    let js_dot = "const u = process.env.SOKSAK_ELECTRON_URL || \"\";\n";
    let js_index = "const s = process.env[\"SHELL\"];\n";
    assert_eq!(ambient_reads(rust), vec![(0, "SOKSAK_HOME".to_string())]);
    assert_eq!(ambient_reads(js_dot), vec![(0, "SOKSAK_ELECTRON_URL".to_string())]);
    assert_eq!(ambient_reads(js_index), vec![(0, "SHELL".to_string())]);
}

/// 키를 호출자에게서 받는 자리는 이 프로세스의 환경을 캐는 자리가 아니다 — 답을 호출자가 정한다.
#[test]
fn an_injected_key_or_environment_is_not_a_read() {
    let rust = "fn f(k: &str) { let _ = std::env::var(k); }\n";
    let js = "function g({ env = process.env } = {}) { return env; }\n";
    assert!(ambient_reads(rust).is_empty(), "{:?}", ambient_reads(rust));
    assert!(ambient_reads(js).is_empty(), "{:?}", ambient_reads(js));
}

/// 문법 파편이 키가 되면 등재할 방법이 없는 위반이 생긴다 — 그런 위반은 고칠 수 없어서
/// 결국 게이트를 끄게 만든다.
#[test]
fn a_syntax_fragment_is_not_mistaken_for_a_key() {
    let scanner = "if !code.contains(\"env::var(\") { return; }\n";
    assert!(ambient_reads(scanner).is_empty(), "{:?}", ambient_reads(scanner));
}

/// 주석은 실행 경로가 아니다 — 규칙을 설명하는 문장이 위반이 되면 설명부터 사라진다.
#[test]
fn a_comment_is_not_a_read() {
    let src = "// std::env::var(\"HOME\") 을 여기서 읽으면 안 된다\n";
    assert!(ambient_reads(src).is_empty(), "{:?}", ambient_reads(src));
}

// ── 실행 경로 추림 ─────────────────────────────────────────────────────────────
//
// 아래 세 경우는 JS 짝(core-decoupling-scan.mjs 의 stripRustTestModule)과 **같은 세 경우**다.
// 한쪽에만 있는 경우가 생기면 그 순간부터 두 게이트의 답이 갈린다.

/// 중괄호 없는 `mod x;` 는 **선언 한 줄**이다. 블록으로 착각해 중괄호를 찾아 나서면 다음에
/// 나오는 아무 블록이나 삼키고, 그 안의 실행 경로가 스캔 밖으로 나간다 — 위반 0건은 그때도
/// 나오므로 **통과를 위장한다**.
#[test]
fn a_brace_less_test_module_declaration_does_not_swallow_the_next_block() {
    let src = concat!(
        "#[cfg(test)]\n",
        "mod only_a_declaration;\n",
        "\n",
        "fn live() {\n",
        "    let _ = std::env::var(\"LIVE_KEY\");\n",
        "}\n",
    );
    let kept: Vec<&str> = production_lines(src).into_iter().map(|(_, l)| l).collect();
    assert!(
        kept.iter().any(|l| l.contains("LIVE_KEY")),
        "선언 뒤의 실행 경로가 사라졌다: {kept:?}"
    );
    assert!(
        !kept.iter().any(|l| l.contains("only_a_declaration")),
        "선언 줄은 실행 경로가 아니다"
    );
}

/// `#[path]` 가 사이에 끼어도 같은 선언이다 — 검사를 형제 파일로 분리하면 이 모양이 된다.
#[test]
fn an_attribute_between_the_marker_and_the_module_is_still_a_declaration() {
    let src = concat!(
        "#[cfg(test)]\n",
        "#[path = \"x_tests.rs\"]\n",
        "mod tests;\n",
        "\n",
        "fn live() {\n",
        "    let _ = std::env::var(\"LIVE_KEY\");\n",
        "}\n",
    );
    let kept: Vec<&str> = production_lines(src).into_iter().map(|(_, l)| l).collect();
    assert!(kept.iter().any(|l| l.contains("LIVE_KEY")), "{kept:?}");
    assert!(!kept.iter().any(|l| l.contains("x_tests.rs")), "{kept:?}");
}

/// 블록 모양은 지금까지처럼 통째로 뺀다 — 고치면서 그것을 잃으면 안 된다.
#[test]
fn a_test_module_block_is_still_removed_whole() {
    let src = concat!(
        "fn before() { let _ = std::env::var(\"BEFORE\"); }\n",
        "#[cfg(test)]\n",
        "mod tests {\n",
        "    fn t() { let _ = std::env::var(\"INSIDE\"); }\n",
        "}\n",
        "fn after() { let _ = std::env::var(\"AFTER\"); }\n",
    );
    let kept: Vec<&str> = production_lines(src).into_iter().map(|(_, l)| l).collect();
    assert!(kept.iter().any(|l| l.contains("BEFORE")), "{kept:?}");
    assert!(!kept.iter().any(|l| l.contains("INSIDE")), "{kept:?}");
    assert!(kept.iter().any(|l| l.contains("AFTER")), "{kept:?}");
}

/// 줄 번호는 원본 그대로다 — 어긋나면 위반 보고가 다른 줄을 가리킨다.
#[test]
fn the_reported_line_numbers_stay_the_original_ones() {
    let src = "a\n#[cfg(test)]\nmod tests;\nb\n";
    let kept = production_lines(src);
    assert_eq!(kept.first().map(|(i, _)| *i), Some(0));
    assert_eq!(kept.last().map(|(i, l)| (*i, *l)), Some((3, "b")));
}

/// 형제 검사 파일은 규칙이 아니라 그 증명이다 — 픽스처의 키를 실행 경로로 세면 안 된다.
#[test]
fn a_sibling_test_file_is_not_scanned() {
    assert!(is_test_file("identity_tests.rs"));
    assert!(is_test_file("os_key_test.rs"));
    assert!(is_test_file("backend.test.cjs"));
    assert!(!is_test_file("identity.rs"));
    assert!(!is_test_file("backend.cjs"));
}
