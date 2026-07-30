// 설치 규칙의 검사 — 재는 것이 전부 이 크레이트의 함수라 여기 산다.
//
// 껍데기에 두면 몸을 밖으로 뺄 때마다 그 파일의 재수출이 검사와 함께 흔들리고, 몸만 옮기고
// 검사를 두면 그 검사는 다음 이동에서 조용히 사라진다.

use super::*;
use sha2::{Digest, Sha256};
use std::io::Cursor;

fn home(name: &str) -> PathBuf {
    let base = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let path = base.join(format!("soksak-unit-installer-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

// 테스트 홈은 dev identity 로 쥔다 — 홈과 identifier 는 함께 다닌다(identity.rs).
fn installer(home: &Path) -> UnitInstallManager {
    UnitInstallManager::new(Identity::new(home, "com.soksak.dev")).unwrap()
}

fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for (path, body) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(body.len() as u64);
        header.set_cksum();
        builder.append_data(&mut header, path, Cursor::new(*body)).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn digest(body: &[u8]) -> String {
    Sha256::digest(body).iter().map(|value| format!("{value:02x}")).collect()
}

fn identity() -> UnitIdentity {
    UnitIdentity { kind: "plugin".into(), id: "weather-plugin".into(), version: "0.0.1".into() }
}

fn artifact(sha256: String) -> StageArtifact {
    StageArtifact {
        url: "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.tgz".into(),
        sha256,
        format: "tgz".into(),
        entrypoints: vec!["plugin.json".into()],
    }
}

fn verified(handle: String, sha256: String) -> VerifiedInstallUnit {
    VerifiedInstallUnit {
        kind: "plugin".into(),
        id: "weather-plugin".into(),
        version: "0.0.1".into(),
        registry_id: "fixture".into(),
        source_repository: "https://github.com/example/weather-plugin".into(),
        source_commit: "a".repeat(40),
        release_tag: "v0.0.1".into(),
        artifact_url: "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.tgz".into(),
        artifact_sha256: sha256,
        staged_handle: handle,
        providers: Vec::new(),
    }
}

fn second_identity() -> UnitIdentity {
    UnitIdentity { kind: "plugin".into(), id: "notes-plugin".into(), version: "0.0.1".into() }
}

fn second_artifact(sha256: String) -> StageArtifact {
    StageArtifact {
        url: "https://github.com/example/notes-plugin/releases/download/v0.0.1/notes-plugin-0.0.1.tgz".into(),
        sha256,
        format: "tgz".into(),
        entrypoints: vec!["plugin.json".into()],
    }
}

fn second_verified(handle: String, sha256: String) -> VerifiedInstallUnit {
    VerifiedInstallUnit {
        kind: "plugin".into(),
        id: "notes-plugin".into(),
        version: "0.0.1".into(),
        registry_id: "fixture".into(),
        source_repository: "https://github.com/example/notes-plugin".into(),
        source_commit: "b".repeat(40),
        release_tag: "v0.0.1".into(),
        artifact_url: "https://github.com/example/notes-plugin/releases/download/v0.0.1/notes-plugin-0.0.1.tgz".into(),
        artifact_sha256: sha256,
        staged_handle: handle,
        providers: Vec::new(),
    }
}

#[test]
fn the_installer_takes_an_identity_not_a_bare_home() {
    // 홈은 씨앗을 lib.rs 의 앰비언트 전역에서 받았고, 매니저 안에서는 join 으로 흩어졌다.
    // 정체성을 값으로 받으면 cored 프로세스가 인자 하나로 같은 홈을 쥔다.
    let root = home("identity");
    let id = soksak_core::identity::Identity::new(root.clone(), "com.soksak.dev");
    let manager = UnitInstallManager::new(id.clone()).unwrap();
    assert_eq!(manager.identity(), &id);
    // 원장·세대·스테이징·발행 경로는 전부 이 정체성 아래다 — 단일 쓰기자 계약의 범위.
    assert_eq!(manager.active_state_path(), root.join("installed-units.json"));
    assert_eq!(manager.staging_root(), root.join("install-staging"));
    assert_eq!(manager.generations_root(), root.join("unit-generations"));
    assert_eq!(manager.plugins_root(), root.join("plugins"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_relative_home_is_refused_before_any_directory_is_made() {
    // 상대 홈은 cwd 상대로 트리를 만든다 — 그 트리는 어느 identity 홈도 아니다.
    let error = UnitInstallManager::new(soksak_core::identity::Identity::new(
        "relative-home",
        "com.soksak.dev",
    ))
    .unwrap_err();
    assert!(error.contains("absolute"), "unexpected error: {error}");
    assert!(!Path::new("relative-home").exists());
}

#[test]
fn the_five_transaction_entries_run_without_tauri_state() {
    // 커맨드 다섯이 한 원장을 공유한다. 그 아래 로직이 State 를 요구하면 원장째
    // 앱 프로세스에 묶인다 — &UnitInstallManager 만으로 다섯을 다 걷는다.
    let root = home("stateless");
    let manager =
        UnitInstallManager::new(soksak_core::identity::Identity::new(root.clone(), "com.soksak.dev"))
            .unwrap();
    let transaction = install_begin(&manager, "fixture".into(), identity()).unwrap();
    let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#)]);
    let sha256 = digest(&body);
    let staged = install_stage_bytes(
        &manager,
        &transaction.transaction_id,
        "fixture",
        identity(),
        artifact(sha256.clone()),
        &body,
    )
    .unwrap();
    assert_eq!(
        install_read_utf8(&manager, &transaction.transaction_id, &staged.handle, "plugin.json")
            .unwrap(),
        r#"{"id":"weather-plugin"}"#
    );
    let committed = install_commit(
        &manager,
        &transaction.transaction_id,
        vec![verified(staged.handle, sha256)],
    )
    .unwrap();
    // 소비된 트랜잭션은 롤백할 것이 없다 — 원장이 하나임을 다섯 번째 입구로 확인한다.
    let error = install_rollback(&manager, &transaction.transaction_id).unwrap_err();
    assert!(error.contains("transaction not found"), "unexpected error: {error}");
    assert_eq!(
        read_active_state(&manager.active_state_path()).unwrap().unwrap().current,
        committed.generation
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn commits_one_verified_generation_and_declares_the_active_absolute_root() {
    let home = home("commit");
    let manager = installer(&home);
    let transaction = manager.begin("fixture".into(), identity()).unwrap();
    let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
    let sha256 = digest(&body);
    let staged = manager
        .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
        .unwrap();
    assert_eq!(
        manager.read_utf8(&transaction.transaction_id, &staged.handle, "plugin.json").unwrap(),
        r#"{"id":"weather-plugin"}"#
    );
    let committed = manager
        .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
        .unwrap();
    let active = read_active_state(&home.join("installed-units.json")).unwrap().unwrap();
    assert_eq!(active.current, committed.generation);
    assert!(home.join("unit-generations").join(&committed.generation).is_dir());
    assert!(!home.join("install-staging").join(&transaction.transaction_id).exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn publishes_the_committed_plugin_to_the_single_active_location() {
    let home = home("publish");
    let manager = installer(&home);
    let transaction = manager.begin("fixture".into(), identity()).unwrap();
    let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
    let sha256 = digest(&body);
    let staged = manager
        .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
        .unwrap();
    manager
        .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
        .unwrap();
    // The loader scans home/plugins/<id>; the release must be published there, not
    // left behind a generation UUID.
    let published = home.join("plugins").join("weather-plugin");
    assert_eq!(
        fs::read_to_string(published.join("plugin.json")).unwrap(),
        r#"{"id":"weather-plugin"}"#
    );
    let state: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(published.join(".soksak.json")).unwrap()).unwrap();
    assert_eq!(state.get("version").and_then(|v| v.as_str()), Some("0.0.1"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn refuses_to_publish_over_a_dev_working_copy() {
    let home = home("dev-guard");
    let manager = installer(&home);
    // A dev author owns home/plugins/<id>; a release install must not clobber it.
    let dev = home.join("plugins").join("weather-plugin");
    fs::create_dir_all(&dev).unwrap();
    fs::write(dev.join(".soksak.json"), r#"{"version":"dev"}"#).unwrap();
    fs::write(dev.join("plugin.json"), r#"{"id":"weather-plugin","unsaved":true}"#).unwrap();
    let transaction = manager.begin("fixture".into(), identity()).unwrap();
    let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
    let sha256 = digest(&body);
    let staged = manager
        .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
        .unwrap();
    let error = manager
        .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
        .unwrap_err();
    assert!(error.contains("dev working copy"), "unexpected error: {error}");
    // The dev copy is untouched and no active state was advertised.
    assert_eq!(
        fs::read_to_string(dev.join("plugin.json")).unwrap(),
        r#"{"id":"weather-plugin","unsaved":true}"#
    );
    assert!(read_active_state(&home.join("installed-units.json")).unwrap().is_none());
    // The transaction stays rollback-able after the refusal.
    manager.rollback(&transaction.transaction_id).unwrap();
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn digest_failure_leaves_no_staged_unit_and_transaction_can_roll_back() {
    let home = home("digest");
    let manager = installer(&home);
    let transaction = manager.begin("fixture".into(), identity()).unwrap();
    let body = archive(&[("plugin.json", b"{}")]);
    let error = manager
        .stage_bytes(
            &transaction.transaction_id,
            "fixture",
            identity(),
            artifact("0".repeat(64)),
            &body,
        )
        .unwrap_err();
    assert!(error.contains("sha256"));
    manager.rollback(&transaction.transaction_id).unwrap();
    assert!(!home.join("install-staging").join(&transaction.transaction_id).exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn commit_rejects_partial_evidence_without_consuming_the_transaction() {
    let home = home("partial");
    let manager = installer(&home);
    let transaction = manager.begin("fixture".into(), identity()).unwrap();
    let body = archive(&[("plugin.json", b"{}")]);
    let sha256 = digest(&body);
    manager
        .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256), &body)
        .unwrap();
    let error = manager.commit(&transaction.transaction_id, Vec::new()).unwrap_err();
    assert!(error.contains("closure"));
    manager.rollback(&transaction.transaction_id).unwrap();
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn independent_root_commits_preserve_both_verified_closures() {
    let home = home("multiple-roots");
    let manager = installer(&home);

    let first = manager.begin("fixture".into(), identity()).unwrap();
    let first_body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#)]);
    let first_sha = digest(&first_body);
    let first_staged = manager
        .stage_bytes(&first.transaction_id, "fixture", identity(), artifact(first_sha.clone()), &first_body)
        .unwrap();
    manager
        .commit(&first.transaction_id, vec![verified(first_staged.handle, first_sha)])
        .unwrap();

    let second = manager.begin("fixture".into(), second_identity()).unwrap();
    let second_body = archive(&[("plugin.json", br#"{"id":"notes-plugin"}"#)]);
    let second_sha = digest(&second_body);
    let second_staged = manager
        .stage_bytes(
            &second.transaction_id,
            "fixture",
            second_identity(),
            second_artifact(second_sha.clone()),
            &second_body,
        )
        .unwrap();
    manager
        .commit(
            &second.transaction_id,
            vec![second_verified(second_staged.handle, second_sha)],
        )
        .unwrap();

    let active = read_active_state(&home.join("installed-units.json")).unwrap().unwrap();
    let ids = active.units.iter().map(|unit| unit.release.id.as_str()).collect::<HashSet<_>>();
    assert_eq!(ids, HashSet::from(["notes-plugin", "weather-plugin"]));
    fs::remove_dir_all(home).unwrap();
}
