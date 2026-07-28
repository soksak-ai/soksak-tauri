//! 전용 저장소의 답 — 부재·실패·원문이 서로 다른 값으로 갈리는가.

use super::*;
use std::path::PathBuf;

fn test_base(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "soksak-core-plugin-data-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// 쓴 원문이 파싱 없이 그대로 돌아온다. 해석하면 저장한 것과 돌려받는 것이 달라지고
/// (키 순서·수 표기), 그 차이는 저장소를 쓰는 플러그인에게만 보인다.
#[test]
fn a_written_value_reads_back_verbatim() {
    let base = test_base("roundtrip");
    let raw = r#"{"b":1,"a":[2,3],"note":"한글 그대로"}"#;
    write(&base, "memo", "notes", raw).unwrap();
    assert_eq!(read(&base, "memo", "notes").unwrap().as_deref(), Some(raw));
    // 쓰기가 상위까지 만든다 — 미리 만들어 둔 배치에 기대지 않는다.
    assert!(base.join("memo").join("notes.json").is_file());
    let _ = std::fs::remove_dir_all(&base);
}

/// 목록은 확장자를 뗀 이름을 사전순으로 답한다 — 돌려준 이름이 그대로 read 의 인자다.
#[test]
fn the_listing_answers_stems_in_order() {
    let base = test_base("listing");
    write(&base, "memo", "notes", "{}").unwrap();
    write(&base, "memo", "config", "{}").unwrap();
    // json 이 아닌 파일은 key 가 아니다.
    std::fs::write(base.join("memo").join("stray.txt"), "x").unwrap();
    assert_eq!(list(&base, "memo").unwrap(), ["config", "notes"]);
    for key in list(&base, "memo").unwrap() {
        assert!(read(&base, "memo", &key).unwrap().is_some(), "{key}");
    }
    let _ = std::fs::remove_dir_all(&base);
}

/// 부재는 값이지 실패가 아니다 — 그리고 읽기는 디스크를 만들지 않는다.
#[test]
fn absence_is_a_value_and_reading_creates_nothing() {
    let base = test_base("absent");
    assert_eq!(read(&base, "memo", "notes").unwrap(), None);
    assert_eq!(read(&base, "memo", "missing").unwrap(), None);
    assert!(list(&base, "memo").unwrap().is_empty());
    assert!(!base.exists(), "읽기가 베이스를 만들었다: {}", base.display());
}

/// 자기 디렉터리 밖은 못 본다. 거부 문장은 앱이 쓰던 것 그대로다 — 프론트가 사유를 보고
/// 갈리는 자리라 문장이 갈리면 그 분기가 조용히 죽는다.
#[test]
fn an_escape_attempt_is_refused_with_the_apps_wording() {
    let base = test_base("escape");
    assert_eq!(
        read(&base, "memo", "../escape").unwrap_err(),
        "잘못된 저장소 key: \"../escape\""
    );
    assert_eq!(
        write(&base, "../memo", "k", "v").unwrap_err(),
        "잘못된 플러그인 id: \"../memo\""
    );
    assert_eq!(
        list(&base, "../memo").unwrap_err(),
        "잘못된 플러그인 id: \"../memo\""
    );
    assert!(!base.exists(), "거절이 디스크를 만졌다");
}

/// key 문자셋 — `.` 은 쓰이지만 `.`·`..` 단독은 경로 의미라 거부한다.
#[test]
fn the_key_charset_admits_dots_but_not_path_names() {
    assert!(sanitize_key("notes").is_ok());
    assert!(sanitize_key("a.b-c_d").is_ok());
    assert!(sanitize_key("").is_err());
    assert!(sanitize_key(".").is_err());
    assert!(sanitize_key("..").is_err());
    assert!(sanitize_key("a/b").is_err());
    assert!(sanitize_key("a\\b").is_err());
}

/// 없는 것과 못 읽은 것은 다른 답이다. 디렉터리 자리에 파일이 있으면 목록은 오류다 —
/// 빈 목록으로 접으면 "저장한 적 없음"과 구분되지 않는다.
#[test]
fn unreadable_stays_different_from_absent() {
    let base = test_base("unreadable");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::write(base.join("memo"), b"x").unwrap();
    assert!(list(&base, "memo").is_err(), "못 읽음은 빈 목록이 아니다");
    let _ = std::fs::remove_dir_all(&base);
}

/// 베이스가 답을 정한다 — 두 홈은 서로의 저장소를 보지 않는다.
#[test]
fn the_answer_follows_the_base_it_is_given() {
    let a = test_base("two-a");
    let b = test_base("two-b");
    write(&a, "memo", "notes", "{}").unwrap();
    assert_eq!(list(&a, "memo").unwrap(), ["notes"]);
    assert!(list(&b, "memo").unwrap().is_empty());
    assert_eq!(read(&b, "memo", "notes").unwrap(), None);
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}
