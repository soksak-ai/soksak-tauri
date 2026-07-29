// 경로 규칙의 검사 — 규칙은 pathx.rs 가, 그 증명은 여기가 진다.
//
// macOS 의 /tmp·/var 는 그 자체가 심링크다. 실측 경로를 쓰지 않으면 이 검사들이
// 자기 함정에 빠진다(두 번 밟았다).
use super::*;

// ── tests ──
use super::*;

#[test]
fn tilde_alone_is_the_home() {
    assert_eq!(expand_tilde("~", Path::new("/u/max")), Path::new("/u/max"));
}

#[test]
fn tilde_slash_joins_under_the_home() {
    assert_eq!(
        expand_tilde("~/.claude/projects", Path::new("/u/max")),
        Path::new("/u/max/.claude/projects")
    );
}

#[test]
fn a_plain_path_is_untouched() {
    assert_eq!(expand_tilde("/etc/hosts", Path::new("/u/max")), Path::new("/etc/hosts"));
    assert_eq!(expand_tilde("rel/x", Path::new("/u/max")), Path::new("rel/x"));
}

#[test]
fn another_users_home_is_not_expanded() {
    // "~other" 는 사용자 데이터베이스를 읽어야 풀린다 — 그건 프로세스 의존이다.
    // 확장하지 않고 그대로 둔다(셸이 아니라는 선언).
    assert_eq!(expand_tilde("~other/x", Path::new("/u/max")), Path::new("~other/x"));
}

#[test]
fn the_same_input_with_two_homes_gives_two_answers() {
    // 홈이 인자라는 것의 요점 — 답이 프로세스가 아니라 입력으로 결정된다.
    let a = expand_tilde("~/x", Path::new("/home/a"));
    let b = expand_tilde("~/x", Path::new("/home/b"));
    assert_ne!(a, b);
}

#[test]
fn the_home_itself_is_not_a_project_root() {
    let home = Path::new("/u/max");
    assert!(project_root_verdict(home, home).is_err());
    assert!(project_root_verdict(Path::new("/u/max/work"), home).is_ok());
}

#[test]
fn the_filesystem_root_is_not_a_project_root() {
    assert!(project_root_verdict(Path::new("/"), Path::new("/u/max")).is_err());
}

/// 걸음 규칙 — 같은 디렉터리부터, 조상으로, 상한까지. 상한 밖은 못 찾는다.
#[test]
fn the_walk_finds_the_holder_within_the_limit_and_not_beyond() {
    let root = std::env::temp_dir().join(format!("pathx-walk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let deep = root.join("a").join("b").join("c");
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(root.join("sok"), b"#!/bin/sh\n").unwrap();

    // exe 옆(0 걸음)과 조상(3 걸음) 둘 다 같은 규칙이다.
    assert_eq!(find_dir_holding(&root, "sok", 6), Some(root.clone()));
    assert_eq!(find_dir_holding(&deep, "sok", 6), Some(root.clone()));
    // 상한이 모자라면 못 찾는다 — 무한히 올라가 남의 트리를 집지 않는다.
    assert_eq!(find_dir_holding(&deep, "sok", 2), None);
    // 이름이 다르면 못 찾는다.
    assert_eq!(find_dir_holding(&deep, "sok-dev", 6), None);

    // 디렉터리는 답이 아니다 — 실행할 파일을 찾는 것이다.
    let dir_named_like_the_binary = root.join("a").join("b").join("tool");
    std::fs::create_dir_all(&dir_named_like_the_binary).unwrap();
    assert_eq!(find_dir_holding(&deep, "tool", 6), None);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_verdict_follows_the_home_it_is_given() {
    // 홈이 인자라는 것의 요점 — 같은 경로가 홈에 따라 다르게 판정된다.
    let p = Path::new("/u/a");
    assert!(project_root_verdict(p, Path::new("/u/a")).is_err());
    assert!(project_root_verdict(p, Path::new("/u/b")).is_ok());
}

// ── symlink_tests ──
use super::*;

#[test]
fn a_parent_component_is_refused_outright() {
    assert!(reject_symlink_components(Path::new("/tmp/../etc")).is_err());
}

#[test]
fn a_plain_path_passes() {
    // macOS 의 /tmp·/var 는 그 자체가 심링크다 — 실측 경로를 쓴다(이 함정을 두 번 밟았다).
    let d = std::env::temp_dir()
        .canonicalize()
        .expect("실측 경로")
        .join(format!("pathx-plain-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    assert!(reject_symlink_components(&d).is_ok());
    let _ = std::fs::remove_dir_all(&d);
}

/// 아직 없는 경로는 통과한다 — 부재는 링크가 아니다.
#[test]
fn a_missing_path_is_not_a_link() {
    assert!(reject_symlink_components(Path::new("/nonexistent-xyz/a/b")).is_ok());
}

/// **중간** 컴포넌트가 링크여도 잡는다 — 마지막만 보면 뚫린다.
#[cfg(unix)]
#[test]
fn a_link_in_the_middle_is_caught() {
    let base = std::env::temp_dir().join(format!("pathx-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("real")).unwrap();
    let link = base.join("link");
    std::os::unix::fs::symlink(base.join("real"), &link).unwrap();
    let why = reject_symlink_components(&link.join("child")).expect_err("링크를 지나야 한다");
    assert!(why.contains("심링크"), "{why}");
    let _ = std::fs::remove_dir_all(&base);
}

/// **끊어진 링크**도 링크다 — 가리키는 곳이 없어도 거부한다.
///
/// `a_missing_path_is_not_a_link` 와 경계를 이룬다: 부재는 통과하고 링크는 거부하는데,
/// 끊어진 링크는 그 둘 사이에 있다. `symlink_metadata` 는 대상을 따라가지 않으므로 링크로
/// 보이지만, `metadata` 를 쓰면 "없는 경로"로 보여 통과한다 — 그 차이가 곧 뚫린 자리다.
#[cfg(unix)]
#[test]
fn a_dangling_link_is_still_a_link() {
    let base = std::env::temp_dir()
        .canonicalize()
        .expect("실측 경로")
        .join(format!("pathx-dangling-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let link = base.join("dangling");
    std::os::unix::fs::symlink(base.join("no-such-target"), &link).unwrap();

    let why = reject_symlink_components(&link.join("child")).expect_err("끊어진 링크를 지나야 한다");
    assert!(why.contains("심링크"), "{why}");
    let _ = std::fs::remove_dir_all(&base);
}
