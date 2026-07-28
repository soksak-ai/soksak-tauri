// Electron 셸의 cored 프로세스 — 셸이 자기 백엔드를 스스로 세운다.
//
// 셸은 자기 정체성(홈·identifier)을 알고, 그것을 **부팅 인자로 넘겨** cored를 띄운다.
// cored 는 홈을 파생하지 않는다(src-tauri/crates/soksak-cored): 파생하는 순간 홈이 갈릴 때
// 조용히 다른 홈에 답하고, 그 오답은 오류가 아니라 빈 결과로 나타난다.
//
// electron 을 require 하지 않는다. 셸을 띄워야만 검증되는 코드는 사실상 검증되지 않으므로,
// 이 파일은 실제 프로세스를 상대로 그대로 몰 수 있어야 한다(scripts/electron/cored-spawn.test.mjs).
//
// 못 하는 것은 이름을 달고 실패한다. 바이너리를 못 찾으면 찾아본 자리를 전부 말하고,
// cored가 준비 완료를 알리지 않으면 그 사유를 실어 실패한다 — 조용한 실패는 "붙은 척"이 된다.

const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** 이 셸의 정체성이 오는 두 통로. 없으면 이 셸 자신의 identity 를 쓴다(남의 홈을 넘보지 않는다). */
const IDENTIFIER_ENV = "SOKSAK_IDENTIFIER";
const IDENTIFIER_ARG = "--soksak-identifier=";
const DEFAULT_IDENTIFIER = "com.soksak.electron-spike";

/** cored 바이너리를 지목하는 두 통로. */
const CORED_BIN_ENV = "SOKSAK_CORED_BIN";
const CORED_BIN_ARG = "--soksak-cored=";

/** 이 저장소가 cored를 빌드해 두는 자리(cargo 관례). 개발 중에는 debug 가 방금 만든 것이다. */
const BUILT_AT = ["debug", "release"].map((profile) =>
  path.join("src-tauri", "target", profile, "soksak-cored"),
);

/**
 * cored 소켓 파일명. 앱 소켓(`<home>/<identifier>.sock`)과 **다른 이름**이어야 한다:
 * 같은 이름을 쓰면 그 홈의 앱이 뜰 자리를 cored가 차지하고, 앱은 "다른 인스턴스"로 거절당한다.
 * 짧게 두는 이유도 있다 — 유닉스 소켓 경로에는 OS 상한이 있다(macOS ~104바이트).
 */
const SOCKET_FILE = "cored.sock";

/** 준비 완료 줄을 기다리는 상한. 넘기면 우리가 띄운 프로세스를 거두고 이름을 달고 실패한다. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** SIGTERM 뒤 이만큼도 안 죽으면 SIGKILL — 안 죽는 프로세스가 소켓을 쥔 채 남지 않게. */
const KILL_GRACE_MS = 2_000;

const BIN_NOT_FOUND = "CORED_BIN_NOT_FOUND";
const SPAWN_FAILED = "CORED_SPAWN_FAILED";

class CoredError extends Error {
  constructor(code, message, pid) {
    super(message);
    this.name = "CoredError";
    this.code = code;
    if (pid) this.pid = pid;
  }
}

/** `--flag=value` 를 argv 에서 읽는다. 빈 값은 값이 아니다. */
function argValue(argv, prefix) {
  const hit = (argv || []).find((a) => typeof a === "string" && a.startsWith(prefix));
  const value = hit ? hit.slice(prefix.length) : "";
  return value || null;
}

/**
 * 이 셸의 정체성 — identifier 와 그 홈, 그리고 cored 소켓 자리.
 *
 * 홈은 identifier 에서만 파생된다(app=무접미, 그 외=`-<마지막 세그먼트>`). 계약 정본은
 * docs/ARCHITECTURE.md 의 identity 홈 절이고, 독립 실행물은 각자 같은 계약을 구현한다
 * (코어 home.rs, sok CLI 의 home_for_env). runtime 으로 홈을 갈아끼우는 통로는 없다 —
 * 지목하는 것은 identifier 이고, 홈은 그 결과다.
 */
function shellIdentity({ env = process.env, argv = process.argv, homedir = os.homedir() } = {}) {
  const identifier =
    argValue(argv, IDENTIFIER_ARG) || env[IDENTIFIER_ENV] || DEFAULT_IDENTIFIER;
  const segment = identifier.split(".").pop() || "app";
  const home = path.join(homedir, `.soksak${segment === "app" ? "" : `-${segment}`}`);
  return { identifier, home, socketPath: path.join(home, SOCKET_FILE) };
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * cored 바이너리 경로 — 지목이 이기고, 없으면 이 저장소의 빌드 자리를 본다.
 *
 * 어느 쪽도 못 찾으면 이름을 달고 실패한다. 지어낸 경로로 spawn 하면 실패 사유가
 * "ENOENT" 한 줄로 남고, 무엇을 어디서 찾았는지는 사라진다.
 */
function coredBinary({ env = process.env, argv = process.argv, root } = {}) {
  const declared = argValue(argv, CORED_BIN_ARG) || env[CORED_BIN_ENV] || null;
  if (declared) {
    // 지목한 것이 없으면 없는 것이다 — 발견 규칙으로 흘러내리면 지목과 다른 것을 실행한다.
    if (isFile(declared)) return declared;
    throw new CoredError(
      BIN_NOT_FOUND,
      `지목한 cored 바이너리가 없다: ${declared} (${CORED_BIN_ENV} 또는 ${CORED_BIN_ARG}<경로>)`,
    );
  }
  const searched = BUILT_AT.map((rel) => path.join(root, rel));
  const found = searched.find(isFile);
  if (found) return found;
  throw new CoredError(
    BIN_NOT_FOUND,
    `cored 바이너리를 못 찾았다 — 찾아본 자리: ${searched.join(", ")} ` +
      `(빌드: cargo build -p soksak-cored / 다른 곳이면 ${CORED_BIN_ENV}=<경로> 또는 ${CORED_BIN_ARG}<경로>)`,
  );
}

/** 그 소켓을 누가 서빙하고 있는가. 파일 존재가 아니라 **연결**로 판정한다(죽은 소켓 파일은 남는다). */
function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const settle = (answer) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(answer);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
  });
}

/** 프로세스를 거둔다 — 종료를 확인할 때까지 기다린다(죽었다고 말만 하지 않는다). */
function reap(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * 이 정체성의 cored를 세운다. 돌려주는 것은 소켓 경로와 **그것이 누구 것인가**다.
 *
 *   origin "adopted" — 이미 살아 있던 cored. 우리 것이 아니므로 stop() 이 건드리지 않는다.
 *   origin "spawned" — 우리가 띄운 것. stop() 이 거둔다.
 *
 * 준비 완료 = cored의 stdout 첫 줄이다. 소켓 파일이 생겼는지 반복해 보는 폴링은 쓰지 않는다
 * (파일 존재는 bind 완료가 아니다). 블로킹 read 라 cored가 먼저 죽으면 EOF 로 즉시 드러난다.
 */
async function ensureCored({
  identity,
  binary,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probe = probeSocket,
  onLog = () => {},
} = {}) {
  const socketPath = identity.socketPath;
  const adopted = { socketPath, origin: "adopted", pid: null, stop: async () => {} };

  // 이미 서빙 중이면 띄우지 않는다 — 같은 소켓에 둘을 띄우면 나중 것이 남의 서빙을 끊거나
  // 조용히 물러난다(cored 자신의 싱글턴 프로브).
  if (await probe(socketPath)) return adopted;

  const child = spawn(
    binary,
    ["--socket", socketPath, "--home", identity.home, "--identifier", identity.identifier],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let out = "";
    let err = "";
    // 우리가 거두는 중이면 그 종료는 사유가 아니다 — 사유는 이미 정해졌다(상한·잘못된 줄).
    // 표시하지 않으면 close 가 먼저 도착해 "SIGTERM 으로 끝났다"가 진짜 사유를 덮는다.
    let reaping = false;

    /** 정해진 사유로 거두고 실패한다 — 거둔 뒤에 알린다(살아 있는 프로세스를 두고 실패를 말하지 않는다). */
    const reapAndFail = async (message) => {
      reaping = true;
      await reap(child);
      failWith(message);
    };

    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const ready = settle(resolve);
    const failed = settle(reject);

    const failWith = (message) =>
      failed(new CoredError(SPAWN_FAILED, message, child.pid));

    // 상한을 넘긴 것은 우리가 띄운 프로세스다 — 남기면 소켓을 쥔 고아가 된다.
    const timer = setTimeout(
      () =>
        void reapAndFail(
          `cored가 ${timeoutMs}ms 안에 준비 완료를 알리지 않았다: ${binary} (거둠) ${err.trim()}`,
        ),
      timeoutMs,
    );

    child.on("error", (e) =>
      failWith(`cored를 띄우지 못했다: ${binary} (${e.code || e.message})`),
    );

    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      const at = out.indexOf("\n");
      if (settled || at < 0) return;
      const line = out.slice(0, at).trim();
      // 준비 완료 줄은 **그 소켓**을 말해야 한다. 다른 것을 말하면 우리가 부른 것이 cored가
      // 아니거나 다른 곳에 붙은 것이다 — 둘 다 붙은 척으로 넘어가면 안 된다.
      if (line.includes(socketPath)) {
        ready({
          socketPath,
          origin: "spawned",
          pid: child.pid,
          // 거둘 때도 표시한다 — 내가 끝낸 종료를 "혼자 죽었다"로 읽지 않게.
          stop: () => {
            reaping = true;
            return reap(child);
          },
        });
        return;
      }
      void reapAndFail(`준비 완료 줄이 소켓(${socketPath})을 말하지 않는다: ${line}`);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      err = `${err}${text}`.slice(-4000);
      onLog(text.trimEnd());
    });

    // close 는 stdio 까지 닫힌 뒤다 — cored가 마지막에 말한 사유가 빠지지 않는다.
    child.on("close", async (code, signal) => {
      if (reaping) return;
      if (settled) {
        // 준비 완료 뒤에 혼자 내려갔다. 다음 호출은 다리에서 이름을 달고 실패하지만,
        // 언제 끊겼는지는 여기서만 보인다 — 조용히 사라지면 원인이 호출 실패로만 남는다.
        onLog(
          `cored가 내려갔다(${signal ? `시그널 ${signal}` : `종료 코드 ${code}`}) — ${socketPath}`,
        );
        return;
      }
      // cored는 남이 그 소켓을 서빙하면 스스로 물러난다(exit 0, 준비 완료 줄 없음). 그때는
      // 서빙되는 소켓을 버릴 이유가 없다 — 다만 정말 서빙되는지는 우리가 확인한다.
      if (code === 0 && (await probe(socketPath))) {
        ready(adopted);
        return;
      }
      const how = signal ? `시그널 ${signal}` : `종료 코드 ${code}`;
      failWith(
        code === 0
          ? `cored가 아무 말 없이 끝났고 ${socketPath} 를 서빙하는 것도 없다: ${binary}`
          : `cored가 준비 완료 전에 끝났다(${how}): ${binary} ${err.trim()}`,
      );
    });
  });
}

module.exports = {
  shellIdentity,
  coredBinary,
  ensureCored,
  probeSocket,
  CoredError,
  IDENTIFIER_ENV,
  IDENTIFIER_ARG,
  CORED_BIN_ENV,
  CORED_BIN_ARG,
  DEFAULT_IDENTIFIER,
  SOCKET_FILE,
  BIN_NOT_FOUND,
  SPAWN_FAILED,
};
