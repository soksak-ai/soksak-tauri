// 개발 선언 규칙의 검사 — 재는 것이 전부 이 크레이트의 함수라 여기 산다.
//
// 몸만 옮기고 검사를 껍데기에 두면 그 검사는 다음 이동에서 조용히 사라진다.

use super::*;
use std::path::PathBuf;

#[test]
fn dev_source_ops_are_dev_identity_only() {
    assert!(ensure_dev_identity_build("dev").is_ok());
    assert!(ensure_dev_identity_build("debug").is_err());
    assert!(ensure_dev_identity_build("release").is_err());
}

#[test]
fn non_dev_identity_rejects_every_dev_source_at_read() {
    let root = test_root("identity-read");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join(".soksak-debug");
    let src = root.join("worktree-plugin");
    std::fs::create_dir_all(&src).unwrap();
    let path = config_path(&home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!(
            r#"{{"version":1,"units":[{{"kind":"plugin","id":"x","source":"{}"}}]}}"#,
            src.display()
        ),
    )
    .unwrap();
    assert!(list_in_for(&home, "debug").unwrap().is_empty());
    assert_eq!(rejected_in(&home, "debug").unwrap().len(), 1);
    assert_eq!(list_in_for(&home, "dev").unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn foreign_home_entries_are_rejected_at_read() {
    let root = test_root("foreign-read");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join(".soksak-debug");
    let foreign_src = root.join(".soksak-dev").join("plugins").join("x");
    std::fs::create_dir_all(&foreign_src).unwrap();
    let path = config_path(&home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!(
            r#"{{"version":1,"units":[{{"kind":"plugin","id":"x","source":"{}"}}]}}"#,
            foreign_src.display()
        ),
    )
    .unwrap();
    assert!(list_in_for(&home, "dev").unwrap().is_empty());
    let rejected = rejected_in(&home, "dev").unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0].id, "x");
    let _ = std::fs::remove_dir_all(&root);
}

fn test_root(name: &str) -> PathBuf {
    let temp = std::env::temp_dir();
    // macOS의 /var는 /private/var symlink다. 제품 기준을 낮추지 않고 테스트 fixture만
    // 물리 경로에 둬서 "source 경로에 symlink 0"을 그대로 검증한다.
    temp.canonicalize()
        .unwrap_or(temp)
        .join(format!("soksak-unit-dev-{name}-{}", std::process::id()))
}

#[test]
fn source_selection_is_identity_home_local_and_atomic() {
    let root = test_root("roundtrip");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let source = root.join("weather");
    std::fs::create_dir_all(&source).unwrap();

    let selected = set_in(&home, "plugin", "weather", &source).unwrap();
    assert_eq!(selected.source, source.to_string_lossy());
    assert_eq!(list_in_for(&home, "dev").unwrap(), vec![selected]);
    assert!(config_path(&home).is_file());
    assert!(remove_in(&home, "plugin", "weather").unwrap());
    assert!(list_in_for(&home, "dev").unwrap().is_empty());
    assert!(!remove_in(&home, "plugin", "weather").unwrap());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn relative_and_missing_sources_are_rejected() {
    let root = test_root("invalid");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    assert!(set_in(&root, "plugin", "weather", Path::new("relative/plugin")).is_err());
    assert!(set_in(&root, "plugin", "weather", &root.join("missing")).is_err());
    assert!(set_in(&root, "unknown", "weather", &root).is_err());
    assert!(set_in(&root, "plugin", "weather.dev", &root).is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn config_rejects_unknown_fields_and_duplicate_unit_keys() {
    let root = test_root("strict-config");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let source = root.join("weather");
    std::fs::create_dir_all(&source).unwrap();
    let path = config_path(&home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();

    std::fs::write(
        &path,
        format!(
            r#"{{"version":1,"units":[{{"kind":"plugin","id":"weather","source":"{}","unexpected":true}}]}}"#,
            source.display()
        ),
    )
    .unwrap();
    assert!(
        read_config_in(&home).is_err(),
        "알 수 없는 필드는 계약 위반이어야 한다"
    );

    std::fs::write(
        &path,
        format!(
            r#"{{"version":1,"units":[{{"kind":"plugin","id":"weather","source":"{}"}},{{"kind":"plugin","id":"weather","source":"{}"}}]}}"#,
            source.display(),
            source.display()
        ),
    )
    .unwrap();
    assert!(
        read_config_in(&home).is_err(),
        "같은 unit key 중복은 모호성이므로 거부해야 한다"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn selected_source_that_later_disappears_remains_discoverable() {
    let root = test_root("disappeared");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let source = root.join("weather");
    std::fs::create_dir_all(&source).unwrap();
    set_in(&home, "plugin", "weather", &source).unwrap();
    std::fs::remove_dir_all(&source).unwrap();

    let units = list_in_for(&home, "dev").unwrap();
    assert_eq!(
        units.len(),
        1,
        "깨진 선택도 상태면에 남아 loader가 loud하게 보고해야 한다"
    );
    assert_eq!(units[0].source, source.to_string_lossy());

    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn symlink_source_or_parent_is_rejected() {
    use std::os::unix::fs::symlink;

    let root = test_root("symlink");
    let _ = std::fs::remove_dir_all(&root);
    let real = root.join("real");
    let child = real.join("plugin");
    std::fs::create_dir_all(&child).unwrap();
    let link = root.join("link");
    symlink(&real, &link).unwrap();

    assert!(set_in(
        &root.join("home"),
        "plugin",
        "weather",
        &link.join("plugin")
    )
    .is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rejects_a_source_inside_another_identity_home() {
    // home.rs 불변식: identity 홈은 완전 독립이고 플러그인은 경계를 넘지 않는다.
    // 다른 홈의 plugins/<id> 를 이 홈의 개발 source 로 선언하면 debug 앱이 dev 홈의
    // 작업 트리를 실행하게 된다(동의 게이트도 dev source 예외로 우회).
    let root = test_root("foreign-home");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join(".soksak-debug");
    let foreign = root.join(".soksak-dev").join("plugins").join("weather");
    let own = home.join("workspaces").join("plugins").join("weather");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::create_dir_all(&own).unwrap();

    assert!(validate_source_path_in(&foreign, &home).is_err());
    assert!(validate_source_path_in(&own, &home).is_ok());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn allows_a_source_outside_every_identity_home() {
    let root = test_root("outside-home");
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join(".soksak-debug");
    let checkout = root.join("work").join("my-plugin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&checkout).unwrap();

    assert!(validate_source_path_in(&checkout, &home).is_ok());
    let _ = std::fs::remove_dir_all(&root);
}
