import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

export function profileFromEnv(env) {
  if (env.TAURI_ENV_DEBUG === "true") return "debug";
  if (env.TAURI_ENV_DEBUG === "false") return "release";
  throw new Error("TAURI_ENV_DEBUG가 없다 — Tauri의 beforeDevCommand/beforeBuildCommand에서 실행해야 한다");
}

export function hostTriple(rustcVersion) {
  const line = rustcVersion.split(/\r?\n/).find((entry) => entry.startsWith("host: "));
  if (!line) throw new Error("rustc -vV에서 host triple을 찾지 못했다");
  return line.slice("host: ".length).trim();
}

export function cargoBuildArgs(profile, targetTriple, explicitTarget) {
  const args = ["build", "-p", "soksak-cored", "--bin", "soksak-cored"];
  if (profile === "release") args.push("--release");
  if (explicitTarget) args.push("--target", targetTriple);
  return args;
}

export function builtBinaryPath(targetDir, profile, targetTriple, explicitTarget) {
  return explicitTarget
    ? join(targetDir, targetTriple, profile, "soksak-cored")
    : join(targetDir, profile, "soksak-cored");
}

export function stagedBinaryPath(repoRoot, targetTriple) {
  return join(repoRoot, "frameworks", "tauri", "binaries", `soksak-cored-${targetTriple}`);
}

export function prepare({ env = process.env, stage }) {
  const profile = profileFromEnv(env);
  const rustc = execFileSync("rustc", ["-vV"], { cwd: REPO_ROOT, encoding: "utf8" });
  const host = hostTriple(rustc);
  const declaredTarget = env.TAURI_ENV_TARGET_TRIPLE || env.CARGO_BUILD_TARGET;
  const targetTriple = declaredTarget || host;
  const explicitTarget = Boolean(declaredTarget);
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }),
  );

  execFileSync("cargo", cargoBuildArgs(profile, targetTriple, explicitTarget), {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  const source = builtBinaryPath(metadata.target_directory, profile, targetTriple, explicitTarget);
  if (!stage) {
    process.stdout.write(`cored 개발 실행물 준비: ${source}\n`);
    return;
  }

  // externalBin은 `<이름>-<target-triple>`인 실파일을 입력으로 요구한다. 이 사본은 번들
  // 스테이징 산출물이고 버전관리되지 않으며, 최종 앱에는 `soksak-cored` 하나로 들어간다.
  const destination = stagedBinaryPath(REPO_ROOT, targetTriple);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  process.stdout.write(`cored 번들 입력 준비: ${source} -> ${destination}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode !== "--build-only" && mode !== "--stage") {
    throw new Error("사용법: prepare-cored-sidecar.mjs --build-only|--stage");
  }
  prepare({ stage: mode === "--stage" });
}
