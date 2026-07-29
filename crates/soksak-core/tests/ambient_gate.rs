//! 이 저장소의 앰비언트 등재 — 규칙(`soksak_core::ambient_gate`)에 **이 저장소의 뿌리**를 먹인다.
//!
//! 규칙은 뿌리를 모른다(알면 그 크레이트 안에 산다는 전제가 규칙에 박힌다). 뿌리를 아는 쪽은
//! 저장소이고, 저장소를 아는 자리가 여기다.
//!
//! 뿌리는 `frameworks/` 아래를 **발견**해서 정한다. 목록을 손으로 적으면 세 번째 프레임워크가
//! 생기는 날 그 폴더만 규칙 밖에 남고, 그 상태는 위반 0건으로 보인다.

use soksak_core::ambient_gate::{
    login_shell_readers, stale_entries, unregistered, ALLOWED,
};
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/<crate> 아래에 있다")
        .to_path_buf()
}

/// 훑을 뿌리 — 프레임워크 폴더 전부.
fn framework_roots() -> Vec<PathBuf> {
    let base = repo_root().join("frameworks");
    let mut out: Vec<PathBuf> = std::fs::read_dir(&base)
        .unwrap_or_else(|e| panic!("프레임워크 뿌리를 못 읽었다: {} ({e})", base.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

/// 0의 두 얼굴 — 훑을 것이 없으면 통과가 아니라 실패다.
#[test]
fn the_scan_actually_reads_this_repository() {
    let roots = framework_roots();
    assert!(roots.len() >= 2, "프레임워크 뿌리가 {}개다 — 규칙이 한쪽만 받고 있다", roots.len());
    let base = repo_root();
    for root in &roots {
        let files = soksak_core::ambient_gate::scan(&base, std::slice::from_ref(root));
        assert!(
            files.len() >= 5,
            "{} 아래 소스를 못 읽었다: {}건 — 확장자·건너뛰기 규칙이 낡았다",
            root.display(),
            files.len()
        );
    }
    assert!(ALLOWED.len() >= 10, "등재표가 비었다 — 스캔이 통과로 위장한다");
}

#[test]
fn every_ambient_read_is_registered() {
    let missing = unregistered(&repo_root(), &framework_roots(), ALLOWED);
    assert_eq!(
        missing,
        Vec::<String>::new(),
        "환경을 읽는 새 자리가 생겼다 — ambient_gate.rs 의 ALLOWED 에 \
         '왜 이 프로세스여야 하는가'와 '프로세스가 갈리면 무엇이 오는가'를 적어라"
    );
}

/// 죽은 사면은 실패다 — 읽기가 다른 크레이트로 나간 뒤 항목만 남으면, 그 파일에 새로 생긴
/// 같은 키의 읽기가 답 없이 통과한다.
#[test]
fn no_registration_outlives_the_read_it_describes() {
    let stale = stale_entries(&repo_root(), &framework_roots(), ALLOWED);
    assert_eq!(
        stale,
        Vec::<String>::new(),
        "등재는 있는데 그 자리에 읽기가 없다 — 옮겼으면 목적지로 옮겨 적고, 사라졌으면 지워라"
    );
}

/// 로그인 셸을 읽는 자리는 **프레임워크마다 하나**다.
///
/// 여럿이면 폴백이 갈린다 — 실제로 갈려 있었다(pty.rs `/bin/bash` vs 나머지 `/bin/sh`).
/// 같은 프로세스가 같은 질문에 두 답을 갖는다. 더 비싼 것은 그 다음이다: 읽은 값이 읽은
/// 함수 밖으로 흐르지 않아 명령의 몸이 프로세스 env 에 묶이고, 그래서 cored 로 이식할 수
/// 없다. 한 자리가 읽어 인자로 흘리면 폴백 분기와 이식 차단이 함께 풀린다.
///
/// 프레임워크마다 세는 이유: 프로세스가 둘이면 각자 자기 몫으로 한 자리씩 읽는 것이 옳다.
#[test]
fn each_framework_has_exactly_one_login_shell_reader() {
    let base = repo_root();
    for root in framework_roots() {
        let readers = login_shell_readers(&base, &root);
        assert_eq!(
            readers.len(),
            1,
            "{} 에서 로그인 셸을 {}곳이 읽는다 {readers:?} — 한 자리가 읽고 나머지는 인자로 받아라",
            root.display(),
            readers.len()
        );
    }
}
