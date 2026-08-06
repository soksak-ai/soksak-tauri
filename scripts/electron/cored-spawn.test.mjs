// @vitest-environment node
// 프레임워크가 자기 백엔드를 스스로 띄운다 — 정체성·바이너리·준비 완료·수명.
//
// 오늘까지 이 프레임워크는 SOKSAK_SOCKET 을 받아야만 백엔드에 닿았고, 없으면 모든 호출이
// BACKEND_NOT_CONNECTED 였다. 여기서 고정하는 것은 넷이다.
//   ① 홈은 프레임워크가 **지목한다** — 자기 정체성을 알고 그것을 cored에게 **넘긴다**(cored는 파생하지 않는다).
//   ② 바이너리 경로는 추측하지 않는다 — 선언이 이기고, 못 찾으면 찾아본 자리를 전부 말한다.
//   ③ 준비 완료는 stdout 첫 줄이다 — 폴링 없이 블로킹 read, 먼저 죽으면 EOF 로 즉시 드러난다.
//   ④ 거두는 것은 내 것뿐이다 — 이미 서빙 중인 소켓과 외부에서 준 소켓은 남의 것이다.
//
// Electron 은 띄우지 않는다. 스폰 로직은 electron 을 require 하지 않는 모듈(electron/cored.cjs)이라
// 그대로 몰 수 있고, 프레임워크 배선은 electron 스텁으로 적재해 본다(framework-invoke.test.mjs 와 같은 방식).
// 가짜 cored도 진짜 프로세스다 — spawn·파이프·EOF·종료 코드를 실물로 겪어야 검증이다.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "../../frameworks/electron/main.cjs");
const BACKEND = join(HERE, "../../frameworks/electron/backend.cjs");
const HELPER = join(HERE, "../../frameworks/electron/cored.cjs");
const ELECTRON = requireCjs.resolve("electron");
const osModule = requireCjs("node:os");

const {
  frameworkIdentity,
  coredBinary,
  ensureCored,
  CORED_BIN_ENV,
  CORED_BIN_ARG,
  IDENTIFIER_ENV,
  IDENTIFIER_ARG,
  BIN_NOT_FOUND,
  SPAWN_FAILED,
} = requireCjs(HELPER);
const { createBackendClient } = requireCjs(BACKEND);

// 픽스처 루트는 홈 아래 짧은 고정 경로다. 유닉스 소켓 경로에는 OS 상한이 있어(macOS ~104바이트)
// mkdtemp 의 /var/folders/... 아래에서는 bind 자체가 실패한다 — 검증이 경로 길이에 걸리면
// 무엇을 재는 시험인지 흐려진다.
const FIXTURES = join(homedir(), ".soksak-electron-test");

let root;
let live;
let handles;
let realSocketEnv;
let realBinEnv;
let realHomedir;

function fixture(name) {
  const dir = join(FIXTURES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 가짜 cored 한 벌 — 실 cored의 계약(부팅 인자·준비 완료 줄·NDJSON)만 흉내낸다. */
function fakeHelper(name, body) {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** 준비 완료를 알리고 실제로 서빙하는 cored. 받은 부팅 인자를 파일로 남긴다. */
const SERVING = `
const net = require("node:net");
const fs = require("node:fs");
const args = process.argv.slice(2);
const val = (f) => args[args.indexOf(f) + 1];
const socket = val("--socket");
fs.writeFileSync(socket + ".argv", JSON.stringify(args));
fs.writeFileSync(socket + ".pid", String(process.pid));
const server = net.createServer((c) => {
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line);
      c.write(JSON.stringify({
        id: req.id,
        ok: true,
        data: { method: req.method, home: val("--home"), identifier: val("--identifier") },
      }) + "\\n");
    }
  });
  c.on("error", () => {});
});
server.listen(socket, () => console.log("soksak-cored: listening " + socket));
`;

/** 스폰 사실만 남기고 정해진 대로 끝나는 cored — "띄우지 않았다"를 증명할 때 쓴다. */
const marker = (extra) => `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.SOKSAK_TEST_MARKER, JSON.stringify(args));
${extra}
`;

/** 소켓 하나를 실제로 서빙한다 — "이미 살아 있다"를 만드는 쪽. */
function startServer(socketPath) {
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        sock.write(`${JSON.stringify({ id: req.id, ok: true, data: "이미 살아 있던 쪽" })}\n`);
      }
    });
    sock.on("error", () => {});
  });
  live.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 검증 중 만든 cored는 반드시 거둔다 — 고아 프로세스는 다음 시험을 오염시킨다. */
async function ensure(options) {
  const handle = await ensureCored(options);
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  root = fixture("spawn");
  live = [];
  handles = [];
  realSocketEnv = process.env.SOKSAK_SOCKET;
  realBinEnv = process.env.SOKSAK_CORED_BIN;
  realHomedir = osModule.homedir;
});

afterEach(async () => {
  for (const h of handles) await h.stop();
  for (const s of live) s.close();
  osModule.homedir = realHomedir;
  for (const [key, was] of [
    ["SOKSAK_SOCKET", realSocketEnv],
    ["SOKSAK_CORED_BIN", realBinEnv],
  ]) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  delete process.env.SOKSAK_TEST_MARKER;
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  delete requireCjs.cache[ELECTRON];
  rmSync(root, { recursive: true, force: true });
});

describe("프레임워크의 정체성 — 홈은 사용자의 것이다", () => {
  // 프레임워크는 자기 정체성을 알고 그것을 cored 에게 넘긴다. 다만 홈은 그 정체성의
  // **env 축**에서 나온다 — 홈에 든 것(플러그인·프로젝트)은 프레임워크의 것이 아니다.
  it("기본 identity 는 이 프레임워크의 것이고, 홈은 그 env 에서 나온다", () => {
    const id = frameworkIdentity({ env: {}, argv: [], homedir: "/u/max" });
    expect(id.identifier).toBe("com.soksak.electron.dev");
    expect(id.home).toBe("/u/max/.soksak-dev");
  });

  it("identity 를 지목하면 그 홈으로 간다 — 규칙은 코어와 같다", () => {
    const of = (identifier) =>
      frameworkIdentity({ env: { [IDENTIFIER_ENV]: identifier }, argv: [], homedir: "/u/max" }).home;
    expect(of("com.soksak.dev")).toBe("/u/max/.soksak-dev");
    expect(of("com.soksak.debug")).toBe("/u/max/.soksak-debug");
    // app 은 무접미 — 새 identity 는 목록 없이 자기 홈을 갖는다.
    expect(of("com.soksak.app")).toBe("/u/max/.soksak");
    expect(of("com.soksak.beta")).toBe("/u/max/.soksak-beta");
  });

  it("인자가 환경변수를 이긴다 — 더 구체적인 지목이 이긴다", () => {
    const id = frameworkIdentity({
      env: { [IDENTIFIER_ENV]: "com.soksak.dev" },
      argv: ["electron", ".", `${IDENTIFIER_ARG}com.soksak.debug`],
      homedir: "/u/max",
    });
    expect(id.identifier).toBe("com.soksak.debug");
    expect(id.home).toBe("/u/max/.soksak-debug");
  });

  it("cored 소켓은 그 홈 안에 산다 — 홈이 곧 정체성 경계다", () => {
    const id = frameworkIdentity({ env: {}, argv: [], homedir: "/u/max" });
    expect(id.socketPath.startsWith("/u/max/.soksak-dev/")).toBe(true);
    // 앱 소켓(<home>/<identifier>.sock)과 같은 이름을 쓰지 않는다 — 같은 홈의 앱을 밀어낸다.
    expect(id.socketPath.endsWith(`${id.identifier}.sock`)).toBe(false);
  });
});

describe("cored 바이너리 — 추측하지 않는다", () => {
  it("선언한 경로가 이긴다(인자 > 환경변수)", () => {
    const declared = fakeHelper("declared", SERVING);
    const other = fakeHelper("other", SERVING);
    expect(coredBinary({ env: { [CORED_BIN_ENV]: other }, argv: [], root })).toBe(other);
    expect(
      coredBinary({
        env: { [CORED_BIN_ENV]: other },
        argv: [`${CORED_BIN_ARG}${declared}`],
        root,
      }),
    ).toBe(declared);
  });

  it("선언한 경로에 없으면 그 경로를 달고 실패한다 — 조용히 다른 것을 고르지 않는다", () => {
    const missing = join(root, "no-such-helper");
    const built = join(root, "target/debug/soksak-cored");
    mkdirSync(dirname(built), { recursive: true });
    writeFileSync(built, "#!/bin/sh\n");
    chmodSync(built, 0o755);
    const err = (() => {
      try {
        coredBinary({ env: { [CORED_BIN_ENV]: missing }, argv: [], root });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err, "없는 선언을 조용히 넘어갔다").not.toBe(null);
    expect(err.code).toBe(BIN_NOT_FOUND);
    expect(err.message).toContain(missing);
    // 선언이 있으면 발견 규칙으로 흘러내리지 않는다 — 지목한 것이 없으면 없는 것이다.
    expect(err.message).not.toContain(built);
  });

  it("선언이 없으면 이 저장소의 빌드 자리를 본다", () => {
    const built = join(root, "target/debug/soksak-cored");
    mkdirSync(dirname(built), { recursive: true });
    writeFileSync(built, "#!/bin/sh\n");
    chmodSync(built, 0o755);
    expect(coredBinary({ env: {}, argv: [], root })).toBe(built);
  });

  it("아무 데도 없으면 찾아본 자리를 전부 말하고 선언하는 법까지 말한다", () => {
    const err = (() => {
      try {
        coredBinary({ env: {}, argv: [], root });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err, "없는데 무엇인가를 골랐다").not.toBe(null);
    expect(err.code).toBe(BIN_NOT_FOUND);
    expect(err.message).toContain("target/debug/soksak-cored");
    expect(err.message).toContain("target/release/soksak-cored");
    expect(err.message).toContain(CORED_BIN_ENV);
  });
});

describe("띄우기 — 준비 완료는 stdout 첫 줄", () => {
  const identityAt = (dir) => ({
    identifier: "com.soksak.electron.dev",
    home: join(dir, "home"),
    socketPath: join(dir, "h.sock"),
  });

  it("cored를 띄우고 그 소켓으로 실제 왕복이 된다", async () => {
    const identity = identityAt(root);
    const handle = await ensure({ identity, binary: fakeHelper("serving", SERVING) });
    expect(handle.origin).toBe("spawned");
    expect(handle.socketPath).toBe(identity.socketPath);
    expect(alive(handle.pid)).toBe(true);

    const client = createBackendClient({ socketPath: handle.socketPath });
    await expect(client.call("app_environment", {})).resolves.toMatchObject({
      method: "app_environment",
    });
    client.close();
  });

  it("정체성을 부팅 인자로 넘긴다 — cored 는 홈을 파생하지 않는다", async () => {
    const identity = identityAt(root);
    await ensure({ identity, binary: fakeHelper("serving", SERVING) });
    const argv = JSON.parse(readFileSync(`${identity.socketPath}.argv`, "utf8"));
    // 자리는 프레임워크가 지목한 값 그대로다. 다만 **이름은 홈의 것**이다 — cored 는 홈당
    // 하나라, 띄운 프레임워크의 이름으로 부르면 그 이름이 공용 자원에 박힌다(실측 2026-08-01:
    // cored 가 `com.soksak.tauri.dev` 로 떠 있었고, 붙는 쪽마다 그것을 우회로 가려야 했다).
    expect(argv.slice(0, 6)).toEqual([
      "--socket",
      identity.socketPath,
      "--home",
      identity.home,
      "--identifier",
      "com.soksak.dev",
    ]);
    expect(identity.identifier).not.toEqual("com.soksak.dev");
    // 앰비언트 사실도 전부 인자로 간다 — cored 는 자기 환경에서 읽지 않는다. 값은 이
    // 프로세스가 읽은 것과 같아야 한다: 다르면 cored 가 다른 사용자의 답을 낸다.
    const pair = (flag) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("--user-home");
    expect(pair("--user-home")).toBe(homedir());
    if (process.env.SHELL) {
      expect(argv).toContain("--login-shell");
      expect(pair("--login-shell")).toBe(process.env.SHELL);
    }
  });

  it("준비 완료 전에 죽으면 EOF 로 즉시 이름을 달고 실패한다", async () => {
    const identity = identityAt(root);
    const binary = fakeHelper(
      "dies",
      `console.error("soksak-cored: --home <path> 가 필요합니다");\nprocess.exit(2);\n`,
    );
    const err = await ensureCored({ identity, binary }).catch((e) => e);
    expect(err.code).toBe(SPAWN_FAILED);
    expect(err.message).toContain("2"); // 종료 코드
    expect(err.message).toContain("--home"); // cored가 말한 사유가 그대로 실린다
  });

  it("준비 완료 줄이 그 소켓을 말하지 않으면 받아들이지 않는다", async () => {
    const identity = identityAt(root);
    const binary = fakeHelper(
      "wrong-line",
      `console.log("hello from somewhere else");\nsetInterval(() => {}, 1000);\n`,
    );
    const err = await ensureCored({ identity, binary, timeoutMs: 4000 }).catch((e) => e);
    expect(err.code).toBe(SPAWN_FAILED);
    expect(err.message).toContain("hello from somewhere else");
  });

  it("답이 없으면 상한에서 이름을 달고 실패하고 띄운 프로세스를 거둔다", async () => {
    const identity = identityAt(root);
    process.env.SOKSAK_TEST_MARKER = join(root, "silent.json");
    const binary = fakeHelper("silent", marker("setInterval(() => {}, 1000);"));
    const err = await ensureCored({ identity, binary, timeoutMs: 250 }).catch((e) => e);
    expect(err.code).toBe(SPAWN_FAILED);
    expect(err.message).toContain("250");
    expect(err.pid, "거둘 프로세스의 이름이 없다").toBeTypeOf("number");
    expect(alive(err.pid), "상한을 넘긴 프로세스를 남겼다").toBe(false);
  });
});

describe("이미 살아 있으면 띄우지 않는다", () => {
  it("그 소켓을 서빙 중이면 스폰 자체가 없다", async () => {
    const identity = {
      identifier: "com.soksak.electron.dev",
      home: join(root, "home"),
      socketPath: join(root, "taken.sock"),
    };
    await startServer(identity.socketPath);
    process.env.SOKSAK_TEST_MARKER = join(root, "ran.json");
    const binary = fakeHelper("must-not-run", marker("process.exit(0);"));

    const handle = await ensure({ identity, binary });
    expect(handle.origin).toBe("adopted");
    expect(handle.pid).toBe(null);
    expect(existsSync(process.env.SOKSAK_TEST_MARKER), "남의 소켓 위에 또 띄웠다").toBe(false);

    // 받아들인 소켓은 그대로 답한다.
    const client = createBackendClient({ socketPath: handle.socketPath });
    await expect(client.call("plugin_scan", {})).resolves.toBe("이미 살아 있던 쪽");
    client.close();
  });

  it("경쟁에서 cored가 스스로 물러나면(exit 0) 그 소켓을 받아들인다", async () => {
    // cored 자신도 싱글턴 프로브를 한다 — 우리 프로브 뒤에 남이 먼저 붙으면 cored는 조용히
    // exit 0 한다. 준비 완료 줄이 없다고 실패로 치면 멀쩡히 서빙되는 소켓을 버리게 된다.
    const identity = {
      identifier: "com.soksak.electron.dev",
      home: join(root, "home"),
      socketPath: join(root, "race.sock"),
    };
    await startServer(identity.socketPath);
    let asked = 0;
    const handle = await ensure({
      identity,
      binary: fakeHelper("steps-aside", "process.exit(0);"),
      // 첫 프로브(스폰 전)에는 아무도 없었고, cored가 물러난 뒤에는 남이 서빙 중이다.
      probe: async () => ++asked > 1,
    });
    expect(handle.origin).toBe("adopted");
    expect(handle.pid).toBe(null);
    expect(asked).toBe(2);
  });

  it("exit 0 인데 아무도 서빙하지 않으면 이름을 달고 실패한다", async () => {
    const identity = {
      identifier: "com.soksak.electron.dev",
      home: join(root, "home"),
      socketPath: join(root, "gone.sock"),
    };
    const err = await ensureCored({
      identity,
      binary: fakeHelper("quiet-exit", "process.exit(0);"),
    }).catch((e) => e);
    expect(err.code).toBe(SPAWN_FAILED);
    expect(err.message).toContain(identity.socketPath);
  });
});

describe("거두기 — 내 것만", () => {
  it("stop() 은 내가 띄운 cored를 거둔다", async () => {
    const identity = {
      identifier: "com.soksak.electron.dev",
      home: join(root, "home"),
      socketPath: join(root, "mine.sock"),
    };
    const handle = await ensure({ identity, binary: fakeHelper("mine", SERVING) });
    const pid = handle.pid;
    expect(alive(pid)).toBe(true);
    await handle.stop();
    expect(alive(pid)).toBe(false);
  });

  it("받아들인 소켓은 stop() 이 건드리지 않는다 — 남의 것이다", async () => {
    const identity = {
      identifier: "com.soksak.electron.dev",
      home: join(root, "home"),
      socketPath: join(root, "theirs.sock"),
    };
    await startServer(identity.socketPath);
    const handle = await ensure({ identity, binary: fakeHelper("unused", SERVING) });
    await handle.stop();
    const client = createBackendClient({ socketPath: handle.socketPath });
    await expect(client.call("themes_scan", {})).resolves.toBe("이미 살아 있던 쪽");
    client.close();
  });
});

// ── 프레임워크 배선 — 렌더러가 보는 답까지 ────────────────────────────────────

/** 프레임워크를 적재하고 ipcMain 핸들러와 app 이벤트를 돌려준다. */
function loadFramework({ socket, binary }) {
  const handlers = new Map();
  const appEvents = new Map();
  const stub = {
    app: {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다.
      setPath: () => {},
      setName: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => new Promise(() => {}), // 창을 만들지 않는다
      on: (name, fn) => appEvents.set(name, fn),
      getName: () => "soksak-electron-dev",
      getVersion: () => "0.0.0",
    },
    BrowserWindow: class {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다. 창이 나면
      // 프레임워크가 렌더러 사건(오류·종료·적재 실패)을 구독한다.
      constructor() {
        this.webContents = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
      }
      once() {}
      on() {}
      loadURL() {}
      focus() {}
      show() {}
      isDestroyed() {
        return false;
      }
      static fromWebContents() {
        return null;
      }
    },
    dialog: {},
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    screen: {
      getDisplayMatching: () => ({
        id: 1,
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
  };
  requireCjs.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: stub };
  if (socket) process.env.SOKSAK_SOCKET = socket;
  else delete process.env.SOKSAK_SOCKET;
  if (binary) process.env.SOKSAK_CORED_BIN = binary;
  else delete process.env.SOKSAK_CORED_BIN;
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  requireCjs(MAIN);
  return { handlers, appEvents };
}

const invoke = (framework, cmd, args) => framework.handlers.get("framework:invoke")(null, { cmd, args });

function ledger(home) {
  const p = join(home, "invoke-demand.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("프레임워크 배선 — 소켓을 안 주면 스스로 띄운다", () => {
  it("framework:invoke 가 프레임워크가 띄운 cored까지 가고 원장에 served:true 로 남는다", async () => {
    osModule.homedir = () => root;
    const framework = loadFramework({ socket: null, binary: fakeHelper("wired", SERVING) });
    const home = join(root, ".soksak-dev");

    const r = await invoke(framework, "app_environment", {});
    expect(r.ok, `프레임워크가 백엔드에 닿지 못했다: ${JSON.stringify(r)}`).toBe(true);
    // cored는 프레임워크가 준 값으로 답한다 — 스스로 파생한 홈이 아니다. 이름은 **홈의 것**
    // 이다: cored 는 홈당 하나라 띄운 프레임워크의 이름을 달면 그것이 공용 자원에 박힌다.
    expect(r.value).toMatchObject({ home, identifier: "com.soksak.dev" });
    expect(ledger(home)).toEqual([{ t: expect.any(Number), cmd: "app_environment", served: true }]);

    await framework.appEvents.get("will-quit")();
  });

  it("will-quit 이 자기가 띄운 cored를 거둔다", async () => {
    osModule.homedir = () => root;
    const framework = loadFramework({ socket: null, binary: fakeHelper("reaped", SERVING) });
    await invoke(framework, "app_environment", {});
    const { socketPath } = frameworkIdentity({ env: {}, argv: [], homedir: root });
    const pid = Number(readFileSync(`${socketPath}.pid`, "utf8"));
    expect(alive(pid)).toBe(true);
    await framework.appEvents.get("will-quit")();
    expect(alive(pid), "프레임워크가 내려가며 자기 cored를 남겼다").toBe(false);
  });

  it("외부에서 SOKSAK_SOCKET 을 주면 그대로 존중한다 — 띄우지 않는다", async () => {
    osModule.homedir = () => root;
    const external = join(root, "external.sock");
    await startServer(external);
    process.env.SOKSAK_TEST_MARKER = join(root, "external-ran.json");
    const framework = loadFramework({
      socket: external,
      binary: fakeHelper("must-not-run", marker("process.exit(0);")),
    });
    const r = await invoke(framework, "plugin_scan", {});
    expect(r).toEqual({ ok: true, value: "이미 살아 있던 쪽" });
    expect(existsSync(process.env.SOKSAK_TEST_MARKER), "남의 소켓을 주었는데 또 띄웠다").toBe(false);

    // 남의 소켓은 거두지 않는다.
    await framework.appEvents.get("will-quit")();
    const client = createBackendClient({ socketPath: external });
    await expect(client.call("themes_scan", {})).resolves.toBe("이미 살아 있던 쪽");
    client.close();
  });

  it("cored를 못 세우면 모든 호출이 이름을 달고 실패하고 원장에 사유가 남는다", async () => {
    osModule.homedir = () => root;
    const framework = loadFramework({ socket: null, binary: join(root, "no-such-helper") });
    const home = join(root, ".soksak-dev");

    const r = await invoke(framework, "app_environment", {});
    expect(r.ok, "cored가 없는데 성공을 돌려줬다").toBe(false);
    expect(r.code).toBe(BIN_NOT_FOUND);
    expect(r.message).toContain("no-such-helper");
    expect(r.command).toBe("app_environment");
    expect(ledger(home)).toEqual([
      { t: expect.any(Number), cmd: "app_environment", served: false, code: BIN_NOT_FOUND },
    ]);
  });
});
