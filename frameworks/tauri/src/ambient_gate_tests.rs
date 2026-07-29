// 앰비언트 등재 게이트의 검사 — 규칙은 ambient_gate.rs 가, 그 증명은 여기가 진다.
//
// 이 파일 안의 키 리터럴은 픽스처다. 게이트는 `_tests.rs` 를 스캔에서 빼므로 여기의
// 리터럴이 실행 경로로 세어지지 않는다 — 안 빼면 고칠 수 없는 위반이 생긴다.
use super::*;


/// 로그인 셸을 읽는 자리는 하나다.
///
/// 여럿이면 폴백이 갈린다 — 실제로 갈려 있었다(pty.rs `/bin/bash` vs 나머지 `/bin/sh`).
/// 같은 프로세스가 같은 질문에 두 답을 갖는다. 더 비싼 것은 그 다음이다: 읽은 값이 읽은
/// 함수 밖으로 흐르지 않아 명령의 몸이 프로세스 env 에 묶이고, 그래서 cored 로 이식할 수
/// 없다. 한 자리가 읽어 인자로 흘리면 폴백 분기와 이식 차단이 함께 풀린다.
#[test]
fn the_login_shell_has_one_reader() {
    let readers = login_shell_readers();
    assert_eq!(
        readers.len(),
        1,
        "로그인 셸을 {}곳에서 읽는다 {readers:?} — 한 자리가 읽고 나머지는 인자로 받아라",
        readers.len()
    );
}

/// 오라클 생존 — 스캔이 죽으면 위 검사는 아무것도 지키지 않는다("0"의 두 얼굴).
#[test]
fn the_login_shell_scan_actually_finds_a_reader() {
    assert!(
        !login_shell_readers().is_empty(),
        "스캐너가 아무것도 못 찾았다 — 검사가 통과한 것이 아니라 죽은 것이다"
    );
}

#[test]
fn every_ambient_read_is_registered() {
    let missing = unregistered();
    assert_eq!(
        missing,
        Vec::<String>::new(),
        "env 를 읽는 새 자리가 생겼다 — ambient_gate.rs 의 ALLOWED 에 \
         '왜 이 프로세스여야 하는가'와 '프로세스가 갈리면 무엇이 오는가'를 적어라"
    );
}

#[test]
fn every_entry_answers_both_questions() {
    // 이유 없는 등재는 등재가 아니다 — 표를 통과 도구로 쓰는 것을 막는다.
    let empty: Vec<String> = ALLOWED
        .iter()
        .filter(|a| a.why.trim().is_empty() || a.after_split.trim().is_empty())
        .map(|a| format!("{}:{}", a.file, a.key))
        .collect();
    assert_eq!(empty, Vec::<String>::new(), "이유·대체 경로가 빈 등재");
}

#[test]
fn the_scan_actually_reads_the_source() {
    // 오라클 생존 단언 — 스캔이 죽으면 이 게이트는 아무것도 지키지 않는다("0"의 두 얼굴).
    let base = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    collect_rs(std::path::Path::new(&base), &mut files);
    assert!(files.len() > 20, "소스를 못 읽었다: {}", files.len());
    assert!(
        ALLOWED.len() >= 10,
        "등재표가 비었다 — 스캔이 통과로 위장한다"
    );
}

// ── 실행 경로 추림 ─────────────────────────────────────────────────────────────

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
    assert!(!is_test_file("identity.rs"));
}
