//! 방아쇠의 답 — 부재·고장·부를 것이 서로 다른 값으로 갈리는가.

use super::*;
use std::path::PathBuf;

fn test_home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "soksak-core-skillgen-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 매니페스트가 없는 홈은 **설치 전**이다 — 오류가 아니라 부를 것이 없음이다.
#[test]
fn an_absent_manifest_is_nothing_to_run_not_a_failure() {
    let home = test_home("absent");
    assert_eq!(skill_refresh_argv(&home).unwrap(), None);
    let _ = std::fs::remove_dir_all(&home);
}

/// 매니페스트가 지목한 실물과 고정 argv 가 그대로 나온다 — 부르는 모양은 한 벌이다.
#[test]
fn the_manifest_names_the_binary_and_the_argv_is_fixed() {
    let home = test_home("argv");
    std::fs::write(
        home.join(MANIFEST_FILE),
        r#"{"cli":"/opt/sok-dev","extra":"무시된다"}"#,
    )
    .unwrap();
    assert_eq!(
        skill_refresh_argv(&home).unwrap(),
        Some((
            "/opt/sok-dev".to_string(),
            vec!["skill".to_string(), "refresh".to_string()]
        ))
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// `cli` 가 없는 매니페스트는 **고장**이다. 부재의 `None` 과 같은 값이 되면 잘못 쓴
/// 매니페스트가 '설치 전'으로 보이고, 스킬은 영영 재생성되지 않는데도 조용하다.
#[test]
fn a_manifest_without_a_cli_is_broken_not_absent() {
    let home = test_home("no-cli");
    std::fs::write(home.join(MANIFEST_FILE), r#"{"note":"cli 가 없다"}"#).unwrap();
    assert_eq!(
        skill_refresh_argv(&home).unwrap_err(),
        "매니페스트에 cli 없음"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// JSON 이 아닌 매니페스트도 고장이고, 사유가 그대로 올라온다.
#[test]
fn a_manifest_that_is_not_json_carries_its_reason() {
    let home = test_home("broken-json");
    std::fs::write(home.join(MANIFEST_FILE), "{ cli: ").unwrap();
    let err = skill_refresh_argv(&home).unwrap_err();
    assert!(!err.is_empty(), "사유 없는 실패");
    assert_ne!(err, "매니페스트에 cli 없음", "다른 고장을 같은 사유로 답했다");
    let _ = std::fs::remove_dir_all(&home);
}

/// 답은 **받은 홈**을 따른다 — 스스로 홈을 구하면 그 순간 "이 프로세스가 앱이다"가 답의
/// 일부가 된다.
#[test]
fn the_answer_follows_the_home_it_is_given() {
    let a = test_home("two-a");
    let b = test_home("two-b");
    std::fs::write(a.join(MANIFEST_FILE), r#"{"cli":"/opt/sok-a"}"#).unwrap();
    assert_eq!(
        skill_refresh_argv(&a).unwrap().map(|(cli, _)| cli),
        Some("/opt/sok-a".to_string())
    );
    assert_eq!(skill_refresh_argv(&b).unwrap(), None);
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}
