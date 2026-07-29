// 두 프레임워크 앱을 **동시에** 띄운다.
//
// 이것이 이 이식의 목표다. 저장소를 쓰는 주인은 하나여야 하는데(단일 쓰기) 프레임워크는 둘이
// 돈다 — 둘이 각자 DB 를 열면 SQLite 는 막지 않고 직렬화만 한다. 그 조용한 이중 쓰기를 막는
// 것이 `store_lock` 이고, 이 하니스는 그 규칙 위에서 두 앱이 실제로 함께 사는지 잰다.
//
// 여기서 재는 것은 **프로세스가 함께 사는가**다:
//   · 둘 다 뜬다(둘째가 "이미 실행 중"으로 물러나지 않는다 — 제어 소켓이 identifier 별이다)
//   · 저장소 주인은 하나다(먼저 잡은 쪽. 나머지는 열지 않고 위임한다)
//   · 둘 다 자기 창을 갖는다
//
// ── 사용자 홈을 건드리지 않는다 ────────────────────────────────────────────────
// 저장소와 볼트만 임시 자리로 돌린다(SOKSAK_DATA_DIR·SOKSAK_VAULT_PATH — debug 빌드 전용).
// 홈 자체는 옮기지 않는다: 홈을 옮기면 플러그인·테마가 빈 트리가 되어 "두 앱이 한 홈을
// 공유한다"는 바로 그 명제를 안 재게 된다.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/** 두 앱이 공유하는 홈. 여기 플러그인이 산다 — 그것을 함께 보는 것이 요점이다. */
export const SHARED_HOME = join(homedir(), ".soksak-dev");

/** 저장소·볼트만 여기로 돌린다. 홈은 그대로 둔다. */
const ISOLATED = join(homedir(), ".soksak-e2e/two-apps");

const TAURI_BIN = join(REPO_ROOT, "target/debug/soksak-dev");
const ELECTRON_MAIN = join(REPO_ROOT, "frameworks/electron/main.cjs");
const CORED_BIN = join(REPO_ROOT, "target/debug/soksak-cored");

/** 한 앱이 뜰 때까지 기다리는 상한. 넘기면 이름을 달고 실패한다 — 조용히 넘어가지 않는다. */
const BOOT_LIMIT_MS = 40_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 띄운 채로 둘 것인가 — 사람이 화면을 볼 때. */
const KEEP = process.argv.includes("--keep");

/**
 * 띄운 채로 둘 때는 **파이프를 주지 않는다.**
 *
 * 실사고(2026-07-29): 파이프로 띄워 두고 하니스가 빠지자 그 파이프가 닫혔고, 다음 로그 한
 * 줄이 두 앱을 모두 죽였다(Electron 은 EPIPE 예외, Tauri 는 stderr 쓰기 실패 패닉).
 * 관측하려고 연 통로가 관측 대상을 죽인 것이다.
 *
 * 그래서 로그는 **파일로** 간다 — 부모가 없어져도 그 fd 는 살아 있다.
 */
function logTarget(name) {
  mkdirSync(ISOLATED, { recursive: true });
  const path = join(ISOLATED, `${name}.log`);
  return { path, fd: openSync(path, "w") };
}

/** 이 정체성의 제어 소켓 — 규칙은 코어가 소유한다(`<home>/<identifier>.sock`). */
export function controlSocket(identifier) {
  return join(SHARED_HOME, `${identifier}.sock`);
}

/** 소켓이 **응답하는가**. 파일 존재는 bind 완료가 아니다 — 죽은 소켓 파일은 남는다. */
export async function answers(socketPath) {
  const net = await import("node:net");
  return new Promise((done) => {
    const s = net.createConnection(socketPath);
    const settle = (v) => {
      s.removeAllListeners();
      s.destroy();
      done(v);
    };
    s.once("connect", () => settle(true));
    s.once("error", () => settle(false));
  });
}

/** 그 소켓이 답할 때까지 기다린다. 폴링이 아니라 부팅 확인이다 — 성공 즉시 끝난다. */
async function untilAnswers(socketPath, limitMs, what) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (await answers(socketPath)) return true;
    await sleep(200);
  }
  throw new Error(`${what} 가 ${limitMs}ms 안에 소켓에 답하지 않았다: ${socketPath}`);
}

const ISOLATION_ENV = {
  SOKSAK_DATA_DIR: join(ISOLATED, "data"),
  SOKSAK_VAULT_PATH: join(ISOLATED, "secrets.vault"),
  SOKSAK_E2E_KEK: "two-apps-fixed-kek",
  SOKSAK_CORED_BIN: CORED_BIN,
};

function launchTauri() {
  const out = KEEP ? logTarget("tauri") : null;
  const p = spawn(TAURI_BIN, [], {
    env: { ...process.env, ...ISOLATION_ENV },
    stdio: out ? ["ignore", out.fd, out.fd] : ["ignore", "pipe", "pipe"],
    detached: KEEP,
  });
  p.logPath = out?.path ?? null;
  return p;
}

function launchElectron() {
  const out = KEEP ? logTarget("electron") : null;
  const p = spawn("npx", ["electron", ELECTRON_MAIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...ISOLATION_ENV,
      SOKSAK_IDENTIFIER: "com.soksak.electron.dev",
    },
    stdio: out ? ["ignore", out.fd, out.fd] : ["ignore", "pipe", "pipe"],
    detached: KEEP,
  });
  p.logPath = out?.path ?? null;
  return p;
}

/** 이 홈의 저장소 잠금을 누가 들고 있는가 — 없으면 null. */
export function lockHolder() {
  const lock = join(ISOLATION_ENV.SOKSAK_DATA_DIR, "soksak.db.writelock");
  if (!existsSync(lock)) return null;
  try {
    const out = execFileSync("lsof", ["-t", lock], { encoding: "utf8" }).trim();
    return out ? out.split("\n").map(Number) : [];
  } catch {
    return [];
  }
}

const alive = (p) => p && p.exitCode === null && p.signalCode === null;

/**
 * 그 프로세스가 자기 부팅을 말할 때까지 기다린다.
 *
 * 시간으로 기다리지 않는다 — 느린 기계에서 지나가고 빠른 기계에서 낭비한다. 프로세스가
 * 죽으면 즉시 그 사실로 끝난다(상한까지 기다리면 "왜 안 뜨지"가 40초 뒤에야 보인다).
 */
async function untilSays(proc, pattern, limitMs, what) {
  // 파이프가 없으면(띄운 채로 두는 모드) 로그 파일이 그 프로세스가 말하는 자리다.
  if (proc.logPath) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      if (!alive(proc)) throw new Error(`${what} 가 뜨기 전에 끝났다 — ${proc.logPath}`);
      const seen = existsSync(proc.logPath) ? readFileSync(proc.logPath, "utf8") : "";
      if (pattern.test(seen)) return true;
      await sleep(200);
    }
    throw new Error(`${what} 가 ${limitMs}ms 안에 부팅을 알리지 않았다 — ${proc.logPath}`);
  }
  return new Promise((resolve, reject) => {
    let seen = "";
    const done = (fn, v) => {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("exit", onExit);
      fn(v);
    };
    const onData = (buf) => {
      seen += String(buf);
      if (pattern.test(seen)) done(resolve, true);
    };
    const onExit = (code) =>
      done(reject, new Error(`${what} 가 뜨기 전에 끝났다(코드 ${code})\n${seen.slice(-600)}`));
    const timer = setTimeout(
      () => done(reject, new Error(`${what} 가 ${limitMs}ms 안에 부팅을 알리지 않았다\n${seen.slice(-600)}`)),
      limitMs,
    );
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", onExit);
  });
}

async function main() {
  const results = [];
  const check = (ok, what) => {
    results.push({ ok, what });
    console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  };

  for (const [what, p] of [["Tauri 실행물", TAURI_BIN], ["cored 실행물", CORED_BIN]]) {
    if (!existsSync(p)) {
      console.log(`✗ ${what}이 없다: ${p}\n  먼저: cargo build -p soksak-dev -p soksak-cored`);
      process.exit(1);
    }
  }
  // 공유 홈의 플러그인 — 두 앱이 이것을 함께 본다는 것이 이 하니스의 명제다.
  const plugins = existsSync(join(SHARED_HOME, "plugins"))
    ? readdirSync(join(SHARED_HOME, "plugins")).length
    : 0;
  console.log(`두 앱 동시 기동 — 공유 홈 ${SHARED_HOME} (플러그인 ${plugins}개)`);
  console.log(`저장소·볼트만 격리: ${ISOLATED}\n`);

  rmSync(ISOLATED, { recursive: true, force: true });
  mkdirSync(join(ISOLATED, "data"), { recursive: true });

  let tauri = null;
  let electron = null;
  try {
    tauri = launchTauri();
    await untilAnswers(controlSocket("com.soksak.tauri.dev"), BOOT_LIMIT_MS, "Tauri");
    check(alive(tauri), "Tauri 가 떴다");
    const first = lockHolder();
    check(Array.isArray(first) && first.length > 0, `저장소 주인이 하나 섰다(pid ${first})`);

    // Electron 은 **자기 제어 소켓을 열지 않는다.** cored 소켓에 창 호스트로 붙는다 —
    // 소켓 하나가 제어면이라는 설계 그대로다. 그래서 그쪽은 소켓이 아니라 자기 로그로
    // 부팅을 알린다. 파일 존재나 시간이 아니라 **그 프로세스가 말한 사실**로 기다린다.
    electron = launchElectron();
    await untilSays(electron, /정체성:|제어면:/, BOOT_LIMIT_MS, "Electron");

    // 여기가 이 하니스의 전부다: 둘째가 뜬 **뒤에도 첫째가 살아 있는가.**
    check(alive(electron), "Electron 이 떴다");
    check(alive(tauri), "그 뒤에도 Tauri 가 살아 있다 — 동시 기동");

    const both = lockHolder();
    check(
      Array.isArray(both) && both.length === 1,
      `저장소를 쓰는 주인은 여전히 하나다(${both?.length ?? "?"}) — 둘이면 조용한 이중 쓰기다`,
    );
  } catch (e) {
    check(false, String(e.message || e));
  } finally {
    // `--keep` — 띄운 채로 둔다. 사람이 화면을 보고 확인하는 자리다(R3: UI 는 눈으로 본다).
    // 기본은 거둔다: 검사가 프로세스를 남기면 다음 실행이 자기 앞의 것과 경쟁한다.
    if (KEEP) {
      console.log(
        `\n띄운 채로 둔다 — Tauri pid ${tauri?.pid ?? "?"} · Electron pid ${electron?.pid ?? "?"}`,
      );
      console.log(`거두려면: kill ${tauri?.pid ?? ""} ${electron?.pid ?? ""}`);
      for (const p of [electron, tauri]) p?.unref?.();
      const bad0 = results.filter((r) => !r.ok).length;
      process.exit(bad0 === 0 ? 0 : 1);
    }
    for (const p of [electron, tauri]) {
      if (alive(p)) {
        p.kill();
        await sleep(300);
        if (alive(p)) p.kill("SIGKILL");
      }
    }
  }

  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n결과: ${results.length - bad} pass / ${bad} fail`);
  process.exit(bad === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
