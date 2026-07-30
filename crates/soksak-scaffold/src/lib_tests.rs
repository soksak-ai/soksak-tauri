// 스캐폴드 규칙의 검사 — 재는 것이 전부 이 크레이트의 함수라 여기 산다.
//
// 몸만 옮기고 검사를 껍데기에 두면 그 검사는 다음 이동에서 조용히 사라진다. 그리고 파일을
// 가르는 이유가 하나 더 있다: 검사가 몸과 한 파일에 있으면 특정 플러그인 이름이 코어 본문에
// 섞인 것으로 세어진다(core-decoupling 게이트).

use super::*;
use std::fs;

#[test]
fn sidecar_scaffold_shape() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!("sc-scaffold-{}-{nanos}", std::process::id()));
    let r = sidecar_dev_new_in(&base, "widget", None).expect("scaffold");
    assert_eq!(r.dir_name, "soksak-sidecar-widget");
    let dir = std::path::PathBuf::from(&r.dir);

    // IDENTITY: Cargo publish=false + bin name, NO build.rs (a service sidecar has no engine).
    let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
    assert!(cargo.contains("publish = false"));
    assert!(cargo.contains("name = \"soksak-sidecar-widget\""));
    assert!(cargo.contains(SIDECAR_SPEC_PIN));
    assert!(!dir.join("build.rs").exists());

    // unit.json — releaseTag/repository derive from id, interface.version === version.
    let unit: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("release/unit.json")).unwrap()).unwrap();
    assert_eq!(unit["id"], "soksak-sidecar-widget");
    assert_eq!(unit["releaseTag"], "v0.0.1");
    assert_eq!(unit["repository"], "https://github.com/soksak-ai/soksak-sidecar-widget");
    assert_eq!(unit["interface"]["id"], "soksak-spec-sidecar-widget");
    assert_eq!(unit["interface"]["version"], "0.0.1");

    // STATIC pins present; spec-validator carries the shared commit.
    assert!(dir.join("release/targets.json").exists());
    let pin: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("validation/spec-validator.json")).unwrap()).unwrap();
    assert_eq!(pin["commit"], SIDECAR_SPEC_PIN);

    // git initialized; vendors ZERO release scripts (logic lives in soksak-spec).
    assert!(dir.join(".git").exists());
    assert!(!dir.join("scripts").exists());
    assert!(dir.join(".github/workflows/release.yml").exists());
    assert!(dir.join("src/service.rs").exists());

    // custom interface honored.
    let r2 = sidecar_dev_new_in(&base, "gauge", Some("soksak-spec-sidecar-metrics")).expect("scaffold2");
    let unit2: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(&r2.dir).join("release/unit.json")).unwrap()).unwrap();
    assert_eq!(unit2["interface"]["id"], "soksak-spec-sidecar-metrics");

    // refusals: existing dir, bad name, interface outside the sidecar namespace.
    assert!(sidecar_dev_new_in(&base, "widget", None).is_err());
    assert!(sidecar_dev_new_in(&base, "Bad", None).is_err());
    assert!(sidecar_dev_new_in(&base, "ok", Some("soksak-browser-spec")).is_err());

    std::fs::remove_dir_all(&base).ok();
}
// Releasable plugin scaffold — mirrors sidecar_scaffold_shape. name-addressed (plugin.new) and
// id-addressed (plugin.dev.create) emit the identical releasable shape; closed-key manifests, the
// single-source discovery marker + THIN workflows, git init, and refusals.
#[test]
fn plugin_scaffold_shape() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!("pl-scaffold-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);

    // name-addressed (plugin.new): id = soksak-plugin-<name>.
    let r = plugin_dev_new2_in(&base, "widget").expect("scaffold");
    assert_eq!(r.dir_name, "soksak-plugin-widget");
    let dir = std::path::PathBuf::from(&r.dir);

    // package.json — the private product boundary the single-source build-release enforces.
    let pkg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
            .unwrap();
    assert_eq!(pkg["name"], "soksak-plugin-widget");
    assert_eq!(pkg["private"], true);
    assert_eq!(pkg["type"], "module");
    assert_eq!(pkg["license"], "Apache-2.0");
    assert_eq!(pkg["soksakRelease"]["kind"], "plugin");
    assert_eq!(pkg["soksakRelease"]["id"], "soksak-plugin-widget");
    assert_eq!(pkg["soksakRelease"]["manifest"], "release.json");
    assert_eq!(
        pkg["soksakRelease"]["repository"],
        "https://github.com/soksak-ai/soksak-plugin-widget"
    );
    // no publishConfig, no language-registry publish script (build-release forbids both).
    assert!(pkg.get("publishConfig").is_none());
    assert!(pkg["scripts"]
        .as_object()
        .unwrap()
        .keys()
        .all(|k| !k.to_lowercase().contains("publish")));

    // plugin.json — public plugin boundary + C2: a content view declares status (blocking rule),
    // a "ui"/"commands" permission pair, a hello command, and a wired <id>-root node.
    let plugin: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).unwrap())
            .unwrap();
    assert_eq!(plugin["spec"], "soksak-spec-plugin@0.0.1");
    assert_eq!(plugin["id"], "soksak-plugin-widget");
    assert_eq!(plugin["version"], "0.0.1");
    assert_eq!(plugin["version"], pkg["version"]);
    assert_eq!(plugin["entry"], "main.js");
    assert!(plugin.get("repo").is_none());
    let perms: Vec<&str> = plugin["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert!(perms.contains(&"ui") && perms.contains(&"commands"));
    assert_eq!(plugin["contributes"]["views"][0]["placements"][0], "content");
    // content-view-status (blocking) satisfied — status declared even if empty.
    assert!(plugin["contributes"]["views"][0]["status"].is_array());
    assert_eq!(plugin["contributes"]["commands"][0]["name"], "hello");
    assert_eq!(
        plugin["contributes"]["nodes"][0]["id"],
        "soksak-plugin-widget-root"
    );

    // release-files.json — discovery marker + declared shipped set; plugin.json + main.js present.
    let files: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("release-files.json")).unwrap())
            .unwrap();
    assert!(
        files.contains(&"plugin.json".to_string()) && files.contains(&"main.js".to_string())
    );

    // declared ≡ wired — the node id declared in plugin.json is wired in the tracked entry (main.js),
    // and the SDK module shape (controller/commands, activate) survives.
    let main_js = std::fs::read_to_string(dir.join("main.js")).unwrap();
    assert!(
        main_js.contains("soksak-plugin-widget-root"),
        "node not wired in main.js: {main_js}"
    );
    assert!(main_js.contains("controller:") && main_js.contains("commands:"));
    assert!(main_js.contains("async activate("), "{main_js}");

    // conformance test + tsconfig ship; workflows are THIN single-source (vendor ZERO scripts).
    assert!(dir.join("src/conformance.test.ts").exists());
    assert!(dir.join("tsconfig.json").exists());
    assert!(!dir.join("scripts").exists());
    let rel = std::fs::read_to_string(dir.join(".github/workflows/release.yml")).unwrap();
    assert!(rel.contains(SIDECAR_SPEC_PIN), "release.yml pins soksak-spec");
    assert!(rel.contains("release-template/build-release.mjs"));
    assert!(rel.contains("release-template/publish-release.mjs"));
    assert!(dir.join(".github/workflows/test.yml").exists());

    // git initialized; the workspace carries no install marker (source lives in the identity
    // home's development-units.json, not inside the workspace).
    assert!(dir.join(".git").exists());
    assert!(!dir.join(".soksak.json").exists());

    // id-addressed dev scaffolder (plugin.dev.create) emits the SAME releasable shape.
    let r2 = plugin_dev_new_in(&base, "my-plugin").expect("id scaffold");
    let dir2 = std::path::Path::new(&r2.dir);
    assert!(dir2.join("package.json").exists() && dir2.join("release-files.json").exists());
    let plugin2: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir2.join("plugin.json")).unwrap())
            .unwrap();
    assert_eq!(plugin2["contributes"]["nodes"][0]["id"], "my-plugin-root");

    // refusals: existing dir, prefixed/uppercase/empty name, existing id, bad id.
    assert!(plugin_dev_new2_in(&base, "widget").is_err());
    assert!(plugin_dev_new2_in(&base, "Bad").is_err());
    assert!(plugin_dev_new2_in(&base, "-x").is_err());
    assert!(plugin_dev_new2_in(&base, "").is_err());
    assert!(plugin_dev_new_in(&base, "my-plugin").is_err());
    assert!(plugin_dev_new_in(&base, "Bad").is_err());

    let _ = std::fs::remove_dir_all(&base);
}
// Acid test (opt-in — runs node): the emitted plugin actually passes the pinned public validator
// and its own conformance test on vitest. Discovers the repo-root validator + vitest binary by a
// declared rule (CARGO_MANIFEST_DIR's parent), never cwd guessing. Run explicitly:
//   cargo test --lib "plugins::tests::plugin_scaffold_acid" -- --ignored
#[test]
#[ignore = "runs node: the pinned public validator + vitest against a real scaffold"]
fn plugin_scaffold_acid() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let validator = repo.join("packages/plugin-spec/bin/validate.mjs");
    let vitest = repo.join("node_modules/.bin/vitest");
    assert!(validator.exists(), "validator missing: {}", validator.display());
    assert!(
        vitest.exists(),
        "vitest missing (run pnpm install at repo root): {}",
        vitest.display()
    );

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!("pl-acid-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let r = plugin_dev_new2_in(&base, "widget").expect("scaffold");
    let dir = std::path::PathBuf::from(&r.dir);

    // ① the emitted manifest passes the pinned public validator (soksak-validate plugin).
    let v = std::process::Command::new("node")
        .arg(&validator)
        .arg("plugin")
        .arg(dir.join("plugin.json"))
        .output()
        .expect("run validator");
    assert!(
        v.status.success(),
        "validator rejected the scaffold:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&v.stdout),
        String::from_utf8_lossy(&v.stderr)
    );

    // ② the shipped conformance test (declared ≡ wired nodes) passes on vitest, run with the
    // scaffold as the vitest root so the repo's own vitest config does not bleed in.
    let t = std::process::Command::new(&vitest)
        .arg("run")
        .arg("--root")
        .arg(&dir)
        .env("CI", "1")
        .output()
        .expect("run vitest");
    assert!(
        t.status.success(),
        "conformance test failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&t.stdout),
        String::from_utf8_lossy(&t.stderr)
    );

    let _ = std::fs::remove_dir_all(&base);
}
