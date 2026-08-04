//! 유닛 스캐폴드 — 새 플러그인·사이드카 하나를 디스크에 앉힌다.
//!
//! 규칙이 껍데기에 살면 두 껍데기가 서로 다른 뼈대를 낳는다. 그 차이는 만드는 순간이 아니라
//! **발행할 때** 드러난다.
//!
//! 이 자리가 `git init` 을 스폰한다. 그것은 git **기능 표면**이 아니라 플러그인 플랫폼의 단일
//! 배포 메커니즘이고, 그래서 core-git-scan 의 명시 allowlist 에 자리 이름으로
//! 등재한다 — 봉인을 푸는 것이 아니라 그 자리를 밝히는 것이다.
//!
//! 트랜잭션은 하나다: 스테이징 → git init → 원자 rename. 어느 하나가 실패하면 디렉터리를
//! 지운다. 반쪽을 남기면 답은 성공인데 유닛은 아무도 적재하지 않는다.

use std::path::Path;

use serde::Serialize;

use soksak_core::plugin_dir::sanitize_id;

// git 서브프로세스 1회 실행. 비정상 종료 시 stderr 를 그대로 에러 메시지로(원인 노출).
pub fn git_run(cmd: &mut std::process::Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
// 설치 디렉토리 쓰기 잠금/해제 — 설치본은 git 미러(사용자 작업공간 아님)다. 개발은 개발
// 폴더(소스)에서 하고 설치본은 직접 수정하면 안 된다(다음 update 의 reset --hard 가 날린다).
// chmod 로 한 겹 더 막아 앱의 git 경로(update 가 잠시 해제)만 통과시킨다. best-effort —
// 실패해도 설치/갱신 자체를 막지 않는다(데이터는 분리된 plugins-data 라 영향 없음).
pub fn set_tree_writable(dir: &Path, writable: bool) {
    let mode = if writable { "u+w" } else { "a-w" };
    let _ = std::process::Command::new("chmod")
        .arg("-R")
        .arg(mode)
        .arg(dir)
        .output();
}
#[derive(Serialize, Debug)]
pub struct PluginInstallResult {
    pub dir: String,
    pub dir_name: String,
    pub manifest: String,
}
// 개발 스캐폴드 — <identity-home>/workspaces/plugins/<id>/ 에 RELEASABLE 플러그인 생성 + git init.
// 사이드카 스캐폴드(sidecar_dev_new_in)와 대칭: 신원(package.json·plugin.json·main.js) + 선언한
// 배포 파일집합(release-files.json — 단일소스 빌더의 discovery 마커) + conformance 테스트 + THIN
// release.yml/test.yml(soksak-spec 를 pin 으로 체크아웃해 단일소스 build-release/publish 를 돈다 —
// 릴리즈 스크립트 vendor 0). 개발 source 상태는 workspace 안의 version 마커가 아니라 identity 홈의
// 선언적 development-units.json 이 소유한다. 공식 설치본(~/.soksak*/plugins)과 작업물을 섞지 않는다.
pub fn plugin_dev_new_in(base: &Path, id: &str) -> Result<PluginInstallResult, String> {
    sanitize_id(id)?;
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let dir = base.join(id);
    if dir.exists() {
        return Err(format!("이미 존재하는 플러그인 폴더: {id}"));
    }
    // 노드 주소 = "<id>-root". plugin.json contributes.nodes 가 선언하고 main.js 가 data-node 로
    // 배선한다 — conformance 테스트가 이 둘의 1:1(선언≡배선)을 검사한다.
    let node = format!("{id}-root");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(".tmp-{id}-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let manifest = render_plugin(PLUGIN_PLUGIN_JSON, id, &node);
    let staged = (|| {
        let write = |rel: &str, body: String| -> Result<(), String> {
            let p = staging.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, body).map_err(|e| e.to_string())
        };
        // package.json — private product boundary(단일소스 build-release 가 강제: name===id,
        // private:true, license Apache-2.0, publish* 스크립트 금지) + soksakRelease 소유 블록.
        write("package.json", render_plugin(PLUGIN_PACKAGE_JSON, id, &node))?;
        write("plugin.json", manifest.clone())?;
        write("main.js", render_plugin(PLUGIN_MAIN_JS, id, &node))?;
        // release-files.json — 선언한 배포 파일집합 + discovery 마커(build-release.mjs 가 읽는다).
        write("release-files.json", PLUGIN_RELEASE_FILES_JSON.to_string())?;
        write("src/conformance.test.ts", PLUGIN_CONFORMANCE_TEST_TS.to_string())?;
        write("tsconfig.json", PLUGIN_TSCONFIG_JSON.to_string())?;
        write("README.md", render_plugin(PLUGIN_README, id, &node))?;
        write(".gitignore", PLUGIN_GITIGNORE.to_string())?;
        // THIN 워크플로 — 릴리즈 로직 vendor 0. release.yml 이 soksak-spec 를 pin 으로 체크아웃해
        // 단일소스 release-template(build-release + publish) 를 discovery(=--unit-root 없음)로 돈다.
        write(".github/workflows/release.yml", render_plugin(PLUGIN_RELEASE_YML, id, &node))?;
        write(".github/workflows/test.yml", PLUGIN_TEST_YML.to_string())?;
        git_run(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&staging),
        )?;
        std::fs::rename(&staging, &dir).map_err(|e| format!("workspace 원자 교체 실패: {e}"))?;
        Ok::<(), String>(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(PluginInstallResult {
        dir: dir.to_string_lossy().to_string(),
        dir_name: id.to_string(),
        manifest,
    })
}
// ── sidecar.new — releasable service-sidecar scaffold ────────────────────────
// Mirrors plugin_dev_new_in's atomic-stage → git init → rename → set_source transaction, but emits
// the sidecar shape: IDENTITY (Cargo.toml, release/unit.json) + STATIC pins (targets.json,
// spec-validator.json — byte-verbatim, never templated) + a serve skeleton + the THIN release.yml
// that references the single-source release-template in soksak-spec. It vendors ZERO release scripts
// (the logic lives once in packages/plugin-spec/release-template). The pin below is the one commit
// the soksak-spec-service Cargo dep, the validator checkout, and spec-validator.json all share.
const SIDECAR_SPEC_PIN: &str = "24ff193f6f2c49cc76b610a58f5dbadabbdf639f";
const SIDECAR_TARGETS_JSON: &str = r#"[
  {
    "target": "aarch64-apple-darwin",
    "runner": "macos-15"
  },
  {
    "target": "aarch64-unknown-linux-gnu",
    "runner": "ubuntu-24.04-arm"
  },
  {
    "target": "x86_64-apple-darwin",
    "runner": "macos-15-intel"
  },
  {
    "target": "x86_64-pc-windows-msvc",
    "runner": "windows-2025"
  },
  {
    "target": "x86_64-unknown-linux-gnu",
    "runner": "ubuntu-24.04"
  }
]
"#;
const SIDECAR_SERVICE_RS: &str = r#"//! Service handler skeleton — replace the `echo` op with the real ones. The wire framing (hello,
//! req/res, idempotency, the mutation mutex) lives in the shared serve harness; this only
//! implements op handlers (PS17).
use serde_json::{json, Value};
use soksak_spec_service::{serve_stdio, Emit, ErrCode, OpCtx, Outcome, ServiceHandler};

pub struct Service;

impl Service {
    pub fn new() -> Self {
        Service
    }
}

impl Default for Service {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceHandler for Service {
    fn ops(&self) -> Vec<String> {
        vec!["echo".to_string()]
    }

    fn read_only(&self, op: &str) -> bool {
        op == "echo"
    }

    fn handle(&self, op: &str, params: Value, _ctx: &OpCtx, _emit: &Emit) -> Outcome {
        match op {
            "echo" => Outcome::ok(json!({ "echo": params })),
            other => Outcome::err(ErrCode::UnknownOp, format!("unknown op: {other}")),
        }
    }
}

pub fn run_serve() {
    serve_stdio(Service::new());
}
"#;
const SIDECAR_CARGO_TOML: &str = r#"[package]
name = "__ID__"
version = "0.0.1"
edition = "2021"
publish = false
repository = "https://github.com/soksak-ai/__ID__"

[lib]
name = "__CRATE__"

[[bin]]
name = "__ID__"
path = "src/main.rs"

[dependencies]
serde_json = "1"
soksak-spec-service = { git = "https://github.com/soksak-ai/soksak-spec.git", rev = "__PIN__", package = "soksak-spec-service" }
"#;
const SIDECAR_UNIT_JSON: &str = r#"{
  "id": "__ID__",
  "version": "0.0.1",
  "releaseTag": "v0.0.1",
  "repository": "https://github.com/soksak-ai/__ID__",
  "interface": { "id": "__INTERFACE__", "version": "0.0.1" }
}
"#;
const SIDECAR_SPEC_VALIDATOR_JSON: &str = r#"{
  "repository": "https://github.com/soksak-ai/soksak-spec",
  "commit": "__PIN__",
  "validator": "packages/plugin-spec/bin/validate.mjs"
}
"#;
const SIDECAR_MAIN_RS: &str = r#"//! __ID__ service sidecar. Spawned by the core ServiceManager with the `serve` subcommand; speaks
//! the soksak-spec-service NDJSON wire over stdio.
pub fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("serve") | None => __CRATE__::run_serve(),
        Some(other) => {
            eprintln!("__ID__: unknown subcommand '{other}' (expected: serve)");
            std::process::exit(2);
        }
    }
}
"#;
const SIDECAR_LIB_RS: &str = r#"//! __ID__ service sidecar library. Op handlers + the serve entry point.
pub mod service;

pub use service::run_serve;
"#;
const SIDECAR_WIRE_RS: &str = r#"//! Wire smoke test — spawns the real binary, speaks the NDJSON wire, asserts hello + one op.
//! Extend as you add ops.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
pub fn hello_then_echo() {
    let mut child = Command::new(env!("CARGO_BIN_EXE___ID__"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn the sidecar");
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let hello = lines.next().expect("a hello frame").expect("read hello");
    assert!(hello.contains("\"t\":\"hello\""), "expected a hello frame, got: {hello}");
    writeln!(stdin, "{{\"t\":\"req\",\"id\":\"1\",\"op\":\"echo\",\"params\":{{\"x\":1}}}}").expect("write req");
    let res = lines.next().expect("a res frame").expect("read res");
    assert!(res.contains("\"echo\""), "expected an echo res, got: {res}");
    let _ = child.kill();
}
"#;
const SIDECAR_STAGE_SH: &str = r#"#!/usr/bin/env bash
# Build the sidecar and stage it into <dist>/ for local core-routed loading, or cross-build for a
# release target (the 5-platform CI matrix calls `./stage.sh dist <triple>`). No native engine —
# a service sidecar is a plain cargo build. Usage: stage.sh [<dist-dir>] [<target-triple>]
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

dist="${1:-dist}"
target="${2:-}"
name="__ID__"

ext=""
case "$target" in *windows*) ext=".exe" ;; esac

if [ -n "$target" ]; then
  cargo build --release --target "$target" --bin "$name"
  reldir="$target/release"
else
  cargo build --release --bin "$name"
  reldir="release"
fi

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
src="$TARGET_DIR/$reldir/$name$ext"
[ -f "$src" ] || { echo "release binary not found at $src" >&2; exit 1; }

mkdir -p "$dist"
tmp="$dist/.$name.tmp.$$"
cp "$src" "$tmp"
chmod +x "$tmp"
mv -f "$tmp" "$dist/$name$ext"
echo "staged: $dist/$name$ext"
"#;
const SIDECAR_README: &str = r#"# __ID__

A soksak service sidecar (interface `__INTERFACE__`). Spawned by the core ServiceManager; speaks the
soksak-spec-service NDJSON wire over stdio.

- `cargo test` — the wire smoke test.
- `./stage.sh` — build + stage into `dist/` for local core-routed loading.
- Release is driven by the single-source pipeline in `soksak-ai/soksak-spec`
  (`.github/workflows/release.yml` checks it out at the pin and runs it — this repo vendors zero
  release logic). Cut a release with the `release` workflow_dispatch on `main`.
"#;
const SIDECAR_GITIGNORE: &str = "/target\n/dist\n";
const SIDECAR_RELEASE_YML: &str = r#"# Release — five-platform native build, then the single-source publish pipeline from soksak-spec.
# This repo vendors NO release logic: the publish job checks out soksak-ai/soksak-spec at the pin
# and runs its release-template scripts against this unit's artifacts.
name: release
on:
  workflow_dispatch:
concurrency:
  group: release-${{ github.repository }}
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  build:
    if: github.ref == 'refs/heads/main'
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: aarch64-apple-darwin
            runner: macos-15
          - target: x86_64-apple-darwin
            runner: macos-15-intel
          - target: aarch64-unknown-linux-gnu
            runner: ubuntu-24.04-arm
          - target: x86_64-unknown-linux-gnu
            runner: ubuntu-24.04
          - target: x86_64-pc-windows-msvc
            runner: windows-2025
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30
        with:
          toolchain: "1.96.0"
          targets: ${{ matrix.target }}
      - name: Build and stage the release binary
        shell: bash
        run: ./stage.sh dist "${{ matrix.target }}"
      - id: archive
        shell: bash
        run: |
          ver="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
          out="__ID__-$ver-${{ matrix.target }}.tar.gz"
          tar -czf "$out" -C dist .
          if command -v sha256sum >/dev/null 2>&1; then sha256sum "$out" | tee "$out.sha256"; else shasum -a 256 "$out" | tee "$out.sha256"; fi
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: dist-${{ matrix.target }}
          path: |
            __ID__-*.tar.gz
            __ID__-*.tar.gz.sha256
          if-no-files-found: error
          compression-level: 0
  publish:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          repository: soksak-ai/soksak-spec
          ref: __PIN__
          path: .pipeline
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "22.12.0"
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
        with:
          version: "10.30.3"
      - id: identity
        run: |
          ver="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
          echo "tag=v$ver" >> "$GITHUB_OUTPUT"
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          pattern: dist-*
          path: dist
          merge-multiple: true
      - name: Build the pinned public validator
        working-directory: .pipeline
        run: |
          pnpm --config.node-linker=hoisted --config.symlink=false install --frozen-lockfile
          pnpm --filter @soksak-ai/plugin-spec build
      # The single-source scripts run at this checkout root and discover the unit by its
      # release/unit.json marker — no --unit-root argument, no cwd guessing (DEPLOY §1).
      - name: Build + validate the release documents (single-source scripts, unit discovered)
        run: |
          node .pipeline/packages/plugin-spec/release-template/sidecar/build-release.mjs --commit "${{ github.sha }}" --tag "${{ steps.identity.outputs.tag }}" --artifacts dist --out dist-release
          node .pipeline/packages/plugin-spec/release-template/sidecar/validate-with-spec.mjs --spec-root .pipeline --release-dir dist-release
      - name: Create least-privilege release token
        id: release-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1
        with:
          client-id: ${{ vars.SOKSAK_RELEASE_CLIENT_ID }}
          private-key: ${{ secrets.SOKSAK_RELEASE_PRIVATE_KEY }}
          permission-administration: read
          permission-contents: write
      - name: Publish through owner-enforced immutable releases
        env:
          GH_TOKEN: ${{ steps.release-token.outputs.token }}
        run: |
          enforced="$(gh api "repos/${{ github.repository }}/immutable-releases" --jq '.enabled and .enforced_by_owner')"
          test "$enforced" = "true" || { echo "owner-enforced immutable releases must be enabled before tagging" >&2; exit 1; }
          tag="${{ steps.identity.outputs.tag }}"
          assets="$(find dist dist-release -type f \( -name '*.tar.gz' -o -name '*.sha256' -o -name '*.json' \) | sort)"
          test "$(printf '%s\n' "$assets" | grep -c '\.tar\.gz$')" -eq 5 || { echo "expected 5 platform archives" >&2; exit 1; }
          test "$(printf '%s\n' "$assets" | grep -c '\.tar\.gz\.sha256$')" -eq 5 || { echo "expected 5 archive checksums" >&2; exit 1; }
          test "$(printf '%s\n' "$assets" | grep -c '/release\.json$')" -eq 1 || { echo "expected the owner release manifest" >&2; exit 1; }
          test "$(printf '%s\n' "$assets" | grep -c '/conformance-[a-z]*\.json$')" -eq 3 || { echo "expected 3 conformance reports" >&2; exit 1; }
          gh release create "$tag" --repo "${{ github.repository }}" --target "${{ github.sha }}" --title "$tag" --generate-notes $assets
"#;
/// Validate an unprefixed sidecar name (the id is `soksak-sidecar-<name>`).
pub fn sanitize_sidecar_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let head = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 사이드카 이름: {name:?} (소문자·숫자·- 만, 접두사 없이)"))
    }
}
pub fn render_sidecar(template: &str, id: &str, crate_name: &str, interface: &str) -> String {
    template
        .replace("__ID__", id)
        .replace("__CRATE__", crate_name)
        .replace("__INTERFACE__", interface)
        .replace("__PIN__", SIDECAR_SPEC_PIN)
}
/// Scaffold a releasable service sidecar under `base`. `name` is unprefixed; the id is
/// `soksak-sidecar-<name>`, the default interface `soksak-spec-sidecar-<name>`. Atomic: stages into
/// a temp dir, git-inits, then renames into place; any failure rolls back the staging dir.
pub fn sidecar_dev_new_in(
    base: &Path,
    name: &str,
    interface: Option<&str>,
) -> Result<PluginInstallResult, String> {
    sanitize_sidecar_name(name)?;
    let id = format!("soksak-sidecar-{name}");
    let interface = interface.map(str::to_string).unwrap_or_else(|| format!("soksak-spec-sidecar-{name}"));
    if !interface.strip_prefix("soksak-spec-sidecar-").is_some_and(|r| {
        !r.is_empty() && r.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    }) {
        return Err(format!("잘못된 interface id: {interface:?} (soksak-spec-sidecar-<...>)"));
    }
    let crate_name = id.replace('-', "_");

    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let dir = base.join(&id);
    if dir.exists() {
        return Err(format!("이미 존재하는 사이드카 폴더: {id}"));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(".tmp-{id}-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;

    let r = &render_sidecar;
    let staged = (|| {
        let write = |rel: &str, body: String| -> Result<(), String> {
            let p = staging.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, body).map_err(|e| e.to_string())
        };
        write("Cargo.toml", r(SIDECAR_CARGO_TOML, &id, &crate_name, &interface))?;
        write("release/unit.json", r(SIDECAR_UNIT_JSON, &id, &crate_name, &interface))?;
        // targets.json + spec-validator.json are STATIC pins — byte-verbatim, never templated.
        write("release/targets.json", SIDECAR_TARGETS_JSON.to_string())?;
        write("validation/spec-validator.json", render_sidecar(SIDECAR_SPEC_VALIDATOR_JSON, &id, &crate_name, &interface))?;
        write("src/main.rs", r(SIDECAR_MAIN_RS, &id, &crate_name, &interface))?;
        write("src/lib.rs", r(SIDECAR_LIB_RS, &id, &crate_name, &interface))?;
        write("src/service.rs", SIDECAR_SERVICE_RS.to_string())?;
        write("tests/wire.rs", r(SIDECAR_WIRE_RS, &id, &crate_name, &interface))?;
        write("stage.sh", r(SIDECAR_STAGE_SH, &id, &crate_name, &interface))?;
        write("README.md", r(SIDECAR_README, &id, &crate_name, &interface))?;
        write(".gitignore", SIDECAR_GITIGNORE.to_string())?;
        write(".github/workflows/release.yml", r(SIDECAR_RELEASE_YML, &id, &crate_name, &interface))?;
        // stage.sh executable bit — cosmetic on git but correct on disk.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(staging.join("stage.sh"), std::fs::Permissions::from_mode(0o755));
        }
        git_run(std::process::Command::new("git").args(["init", "-q"]).arg(&staging))?;
        std::fs::rename(&staging, &dir).map_err(|e| format!("workspace 원자 교체 실패: {e}"))?;
        Ok::<(), String>(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(PluginInstallResult {
        dir: dir.to_string_lossy().to_string(),
        dir_name: id,
        manifest: render_sidecar(SIDECAR_UNIT_JSON, "", "", &interface),
    })
}
const PLUGIN_PACKAGE_JSON: &str = r#"{
  "name": "__ID__",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "description": "A soksak plugin.",
  "soksakRelease": {
    "kind": "plugin",
    "id": "__ID__",
    "repository": "https://github.com/soksak-ai/__ID__",
    "manifest": "release.json"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "typescript": "~5.9.3",
    "vitest": "^2.1.8"
  }
}
"#;
const PLUGIN_PLUGIN_JSON: &str = r#"{
  "spec": "soksak-spec-plugin@0.0.1",
  "id": "__ID__",
  "name": { "ko": "__ID__", "en": "__ID__" },
  "version": "0.0.1",
  "description": { "ko": "새 soksak 플러그인", "en": "A new soksak plugin" },
  "entry": "main.js",
  "permissions": ["ui", "commands"],
  "contributes": {
    "views": [
      {
        "id": "main",
        "title": { "ko": "__ID__", "en": "__ID__" },
        "icon": "◆",
        "placements": ["content"],
        "status": []
      }
    ],
    "commands": [
      { "name": "hello", "title": { "ko": "Hello", "en": "Hello" } }
    ],
    "nodes": [
      { "id": "__NODE__", "description": { "ko": "루트 노드", "en": "Root node" } }
    ]
  }
}
"#;
// The tracked ESM entry — hand-written (no build step), the canonical minimal-plugin shape. Registers
// one content view that mounts a single operable root element wired via data-node (dataset.node) to
// the "__NODE__" address declared in plugin.json, plus a `hello` command. controller/commands is the
// SDK module shape the loader consumes; the view registration degrades gracefully without ui.
const PLUGIN_MAIN_JS: &str = r#"// __ID__ — a soksak plugin. One content view mounting an operable root node (C2: addressable via
// ui.tree / ui.input.click) plus a `hello` command. The SDK reminder-demo is the canonical author
// pattern; this seed is releasable as-is (release-files.json + .github/workflows).

// The view's operable root. Its data-node id is declared in plugin.json contributes.nodes and the
// conformance test asserts the two stay 1:1 (declared ≡ wired, both directions).
function mountView(container) {
  const root = document.createElement("div");
  root.dataset.node = "__NODE__";
  root.style.cssText = "display:flex;align-items:center;justify-content:center;height:100%;";
  root.textContent = "__ID__";
  container.replaceChildren(root);
  return () => container.replaceChildren();
}

export default {
  controller: {
    async activate(ctx) {
      const app = ctx.app;
      // Register the content view when the host exposes the ui surface (graceful without it).
      if (app.ui && app.ui.registerView) {
        const cleanups = new WeakMap();
        ctx.subscriptions.push(
          app.ui.registerView("main", {
            mount(container) {
              cleanups.set(container, mountView(container));
            },
            unmount(container) {
              const dispose = cleanups.get(container);
              if (dispose) dispose();
              cleanups.delete(container);
            },
          }),
        );
      }
    },
    async deactivate() {},
  },
  commands: {
    async hello() {
      return { ok: true };
    },
  },
};
"#;
// The unit's own declaration: the exact, ordered file set it ships (the archive input) AND the
// discovery marker build-release.mjs walks up to find. plugin.json + the tracked main.js entry.
const PLUGIN_RELEASE_FILES_JSON: &str = r#"["plugin.json", "main.js"]
"#;
// declared ≡ wired, both directions — mirrors the installed-plugin nodes conformance test, but the
// wiring source is the tracked entry (main.js) rather than a built bundle, since this plugin ships a
// hand-written main.js. Pure (reads files + string match); runs on vitest, no build step.
const PLUGIN_CONFORMANCE_TEST_TS: &str = r#"// C2 transparency — DOM axis. The view's operable nodes declared in plugin.json contributes.nodes
// must equal the data-node ids actually wired in the shipped entry (main.js), both directions.
// Neither side may lead: an undeclared data-node leaks a hidden control; a declared node with no
// wiring is a phantom.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8")) as {
  contributes?: { views?: unknown[]; nodes?: Array<{ id: string }> };
};
const entry = readFileSync(path.join(root, "main.js"), "utf8");

const declared = (manifest.contributes?.nodes ?? []).map((n) => n.id);
const wired = [...entry.matchAll(/dataset\.node\s*=\s*[`"']([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
const NODE_ID = /^[a-z][a-z0-9-]*$/;

describe("C2 DOM axis — the view's operable elements are exposed as nodes", () => {
  it("has a view → contributes.nodes is non-empty (view-nodes rule)", () => {
    expect((manifest.contributes?.views ?? []).length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("declared ≡ wired — plugin.json nodes ↔ main.js dataset.node (both directions)", () => {
    expect([...new Set(wired)].sort()).toEqual([...new Set(declared)].sort());
  });

  it("node ids follow the nodeScan contract (lowercase, hyphen)", () => {
    for (const id of declared) expect(id).toMatch(NODE_ID);
  });
});
"#;
const PLUGIN_TSCONFIG_JSON: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src"]
}
"#;
const PLUGIN_README: &str = r#"# __ID__

A soksak plugin. One content view (an operable root node addressable via `ui.tree` / `ui.input.click`)
plus a `hello` command.

- `npm test` — the C2 node conformance test (declared ≡ wired).
- `npm run typecheck` — `tsc --noEmit`.
- `main.js` is the tracked ESM entry (hand-written; no build step).
- Release is driven by the single-source pipeline in `soksak-ai/soksak-spec`
  (`.github/workflows/release.yml` checks it out at the pin and runs it — this repo vendors zero
  release logic). Cut a release with the `release` workflow_dispatch on `main`.
"#;
const PLUGIN_GITIGNORE: &str = "node_modules/\ndist/\n.soksak.json\n*.log\n";
const PLUGIN_TEST_YML: &str = r#"name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm install
      - run: npm run typecheck
      - run: npm test
"#;
const PLUGIN_RELEASE_YML: &str = r#"# Release — the plugin is platform-agnostic (one "any" artifact), so there is no build matrix. This
# repo vendors NO release logic: it checks out soksak-ai/soksak-spec at the pinned commit and runs the
# single-source plugin release-template (build-release + publish) + the pinned public validator.
name: release
on:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: release-${{ github.repository }}
  cancel-in-progress: false
jobs:
  release:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - name: Check out the exact source
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Check out the pinned single-source release pipeline
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          repository: soksak-ai/soksak-spec
          ref: __PIN__
          path: .pipeline
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "22.12.0"
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
        with:
          version: "10.30.3"
      - name: Install and test the plugin
        run: |
          npm install
          npm run typecheck
          npm test
      - name: Build the pinned public validator
        working-directory: .pipeline
        run: |
          pnpm --config.node-linker=hoisted --config.symlink=false install --frozen-lockfile
          pnpm --filter @soksak-ai/plugin-spec build
      # The single-source scripts run at this checkout root and discover the unit by its
      # release-files.json marker — no --unit-root argument, no cwd guessing (DEPLOY §1).
      - name: Build + validate the release documents (single-source, unit discovered)
        run: |
          node .pipeline/packages/plugin-spec/release-template/build-release.mjs --commit "${{ github.sha }}" --out dist
          node .pipeline/packages/plugin-spec/bin/validate.mjs release dist/release.json
          node .pipeline/packages/plugin-spec/bin/validate.mjs conformance dist/conformance-release.json dist/conformance-plugin.json --release dist/release.json --plugin-manifest plugin.json
          node .pipeline/packages/plugin-spec/bin/validate.mjs plugin plugin.json
      - name: Mint a least-privilege installation token
        id: release-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1
        with:
          client-id: ${{ vars.SOKSAK_RELEASE_CLIENT_ID }}
          private-key: ${{ secrets.SOKSAK_RELEASE_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: __ID__
          permission-administration: read
          permission-contents: write
      - name: Publish the verified owner manifest and assets (single-source)
        env:
          SOKSAK_RELEASE_TOKEN: ${{ steps.release-token.outputs.token }}
        run: >-
          node .pipeline/packages/plugin-spec/release-template/publish-release.mjs
          --repository "${{ github.repository }}"
          --commit "${{ github.sha }}"
          --artifacts "$GITHUB_WORKSPACE/dist"
          --manifest "$GITHUB_WORKSPACE/dist/release.json"
"#;
pub fn render_plugin(template: &str, id: &str, node: &str) -> String {
    template
        .replace("__ID__", id)
        .replace("__NODE__", node)
        .replace("__PIN__", SIDECAR_SPEC_PIN)
}
/// Validate an unprefixed plugin name (the id is `soksak-plugin-<name>`). Mirrors sanitize_sidecar_name.
pub fn sanitize_plugin_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!(
            "잘못된 플러그인 이름: {name:?} (소문자·숫자·- 만, 접두사 없이)"
        ))
    }
}
/// Scaffold a releasable plugin under `base` from an unprefixed name (id = soksak-plugin-<name>).
/// Mirrors sidecar_dev_new_in; the releasable emission itself lives in plugin_dev_new_in (shared with
/// the id-addressed dev scaffolder, so plugin.dev.create and plugin.new emit the identical shape).
pub fn plugin_dev_new2_in(base: &Path, name: &str) -> Result<PluginInstallResult, String> {
    sanitize_plugin_name(name)?;
    let id = format!("soksak-plugin-{name}");
    plugin_dev_new_in(base, &id)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod lib_tests;
