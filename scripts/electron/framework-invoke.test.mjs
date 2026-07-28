// @vitest-environment node
// 프레임워크의 실제 경로 — 렌더러가 부르는 `framework:invoke` 가 소켓까지 가고, 요구 원장이 파일로 남는가.
//
// Electron 은 띄우지 않는다. electron 모듈을 스텁으로 갈아끼우고 main.cjs 를 적재하면 배선
// 그대로가 손에 잡힌다(창은 만들지 않는다 — whenReady 를 풀지 않는다). 다리 단위 검증
// (backend-socket.test.mjs)은 다리가 옳음을 말하고, 이 파일은 프레임워크가 그 다리를 실제로 쓰는지와
// 원장의 실물 형식을 말한다.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "../../electron/main.cjs");
const BACKEND = join(HERE, "../../electron/backend.cjs");
const ELECTRON = requireCjs.resolve("electron");
const osModule = requireCjs("node:os");

let root;
let servers;
let realHomedir;
let realSocketEnv;
let realHelperEnv;

/** 제어면 배선(등록·창 사실 갱신)을 뺀 것 — 다리가 나른 명령만. 그 둘은 같은 소켓을 쓰지만
 *  다른 일이다: 등록은 "창은 내가 갖고 있다"이고, 다리는 UI 가 부른 명령이다. */
const CONTROL_WIRING = new Set([
  "control_host_attach", // 창은 내가 갖고 있다
  "control_windows", // 창 사실이 바뀌었다
  "control_bridge_attach", // 이 연결은 창의 다리다
]);
const commands = (mock) => mock.seen.filter((r) => !CONTROL_WIRING.has(r.method));

/** 목 백엔드 — 한 줄 JSON 요청에 handler 가 답한다. */
function startMock(name, handler) {
  const socketPath = join(root, name);
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        seen.push(req);
        handler(req, sock);
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, seen })));
}

/** 프레임워크를 적재하고 ipcMain 에 걸린 핸들러를 돌려준다 — 렌더러가 잡는 그 손잡이다. */
function loadFramework(socketPath) {
  const handlers = new Map();
  const stub = {
    app: {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다.
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => new Promise(() => {}), // 창을 만들지 않는다
      on: () => {},
      getName: () => "soksak-electron-spike",
      getVersion: () => "0.0.0",
    },
    BrowserWindow: class {
      static fromWebContents() {
        return null;
      }
    },
    dialog: {},
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    screen: {},
  };
  requireCjs.cache[ELECTRON] = {
    id: ELECTRON,
    filename: ELECTRON,
    loaded: true,
    exports: stub,
  };
  if (socketPath) process.env.SOKSAK_SOCKET = socketPath;
  else delete process.env.SOKSAK_SOCKET;
  // 소켓을 안 주면 프레임워크는 자기 cored를 띄운다(cored-spawn.test.mjs 가 그쪽). 이 파일이 재는 것은
  // 다리와 원장이므로 cored 자리를 없는 경로로 고정한다 — 안 그러면 빌드 산출물이 있는 체크아웃
  // 에서만 진짜 프로세스가 뜨고, 검증 결과가 빌드 상태에 따라 갈린다.
  process.env.SOKSAK_CORED_BIN = join(root, "no-such-helper");
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  requireCjs(MAIN);
  return handlers;
}

const invoke = (handlers, cmd, args) => handlers.get("framework:invoke")(null, { cmd, args });

/** 원장 실물 — 프레임워크가 홈에 떨구는 jsonl 을 그대로 읽는다. */
function ledger() {
  const p = join(root, ".soksak-electron-spike", "invoke-demand.jsonl");
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-framework-"));
  servers = [];
  realHomedir = osModule.homedir;
  realSocketEnv = process.env.SOKSAK_SOCKET;
  realHelperEnv = process.env.SOKSAK_CORED_BIN;
  // 프레임워크는 원장을 홈에 떨군다 — 검증이 사용자 홈을 건드리지 않게 홈을 픽스처로 돌린다.
  osModule.homedir = () => root;
});

afterEach(() => {
  osModule.homedir = realHomedir;
  if (realSocketEnv === undefined) delete process.env.SOKSAK_SOCKET;
  else process.env.SOKSAK_SOCKET = realSocketEnv;
  if (realHelperEnv === undefined) delete process.env.SOKSAK_CORED_BIN;
  else process.env.SOKSAK_CORED_BIN = realHelperEnv;
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  delete requireCjs.cache[ELECTRON];
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("framework:invoke — 렌더러가 보는 답", () => {
  it("백엔드가 있으면 값이 돌아오고 원장에 served:true 로 남는다", async () => {
    const mock = await startMock("live.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: { theme: "dark" } })}\n`),
    );
    const handlers = loadFramework(mock.socketPath);
    await expect(invoke(handlers, "themes_scan", { dir: "x" })).resolves.toEqual({
      ok: true,
      value: { theme: "dark" },
    });
    // 제어면 배선도 같은 소켓으로 간다 — 창은 이 프레임워크의 것이므로 외부 지목 소켓의
    // cored 에도 등록하고, 다리는 자기가 창의 것임을 밝힌다. 다리가 나른 명령만 골라 본다.
    expect(commands(mock)[0]).toMatchObject({ method: "themes_scan", params: { dir: "x" } });
    expect(ledger()).toEqual([
      { t: expect.any(Number), cmd: "themes_scan", served: true },
    ]);
  });

  it("백엔드가 명령을 모르면 그 이름 그대로 실패하고 사유가 원장에 남는다", async () => {
    const mock = await startMock("unknown.sock", (req, sock) =>
      sock.write(
        `${JSON.stringify({
          id: req.id,
          ok: false,
          code: "UNKNOWN_COMMAND",
          message: `모르는 명령: ${req.method}`,
        })}\n`,
      ),
    );
    const handlers = loadFramework(mock.socketPath);
    // 표본은 백엔드가 져야 할 명령이어야 한다 — 프레임워크가 스스로 답하는 것(webview_*·engine_* 등)은
    // 애초에 소켓으로 가지 않으므로 백엔드의 답을 증언하지 못한다(framework-native.test.mjs 가 그쪽).
    const r = await invoke(handlers, "themes_scan", {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
    expect(r.command).toBe("themes_scan");
    expect(ledger()).toEqual([
      { t: expect.any(Number), cmd: "themes_scan", served: false, code: "UNKNOWN_COMMAND" },
    ]);
  });

  it("cored를 세우지 못하면 무엇이 없어서인지까지 이름을 달고 실패한다", async () => {
    // 소켓 지목이 없으면 프레임워크가 cored를 띄운다. 그것마저 못 하면 실패는 남되, 사유는 더
    // 구체적이어야 한다 — "백엔드가 없다"는 무엇을 고쳐야 하는지 말해 주지 않는다.
    const handlers = loadFramework(null);
    const r = await invoke(handlers, "activity_publish", {});
    expect(r).toMatchObject({
      ok: false,
      code: "CORED_BIN_NOT_FOUND",
      command: "activity_publish",
    });
    expect(r.message).toContain("no-such-helper");
    expect(ledger()).toEqual([
      {
        t: expect.any(Number),
        cmd: "activity_publish",
        served: false,
        code: "CORED_BIN_NOT_FOUND",
      },
    ]);
  });

  it("프레임워크 갈래가 아닌 이름은 여전히 다리를 탄다 — 갈래 규칙이 백엔드의 것을 삼키지 않는다", async () => {
    // 프레임워크 갈래(window_·webview_·engine_·titlebar_·panel_)는 소켓 앞에서 걸린다. 그 규칙이
    // 넓으면 백엔드의 명령까지 FRAMEWORK_CONCEPT_ABSENT 로 죽고, 증상은 "백엔드가 답을 안 한다"로
    // 보인다. 근처 이름까지 실제로 다리를 타는지 본다.
    const mock = await startMock("through.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: req.method })}\n`),
    );
    const handlers = loadFramework(mock.socketPath);
    // 갈래 접두사와 **닮았지만 아닌** 이름들 — 그물이 이름 앞부분만 보고 삼키면 안 된다.
    const through = ["themes_scan", "windows_list", "webviews_scan", "enginex_stats", "panels"];
    for (const cmd of through) {
      await expect(invoke(handlers, cmd, {})).resolves.toEqual({ ok: true, value: cmd });
    }
    expect(commands(mock).map((r) => r.method)).toEqual(through);
  });

  it("원장은 서빙된 것과 못 한 것을 한 파일에서 가른다", async () => {
    // cored가 무엇을 더 져야 하는가 = 못 한 것들의 목록이다. 둘이 섞이면 그 목록이 안 나온다.
    const mock = await startMock("mixed.sock", (req, sock) => {
      const known = req.method === "data_kv_get";
      sock.write(
        `${JSON.stringify(
          known
            ? { id: req.id, ok: true, data: "값" }
            : { id: req.id, ok: false, code: "UNKNOWN_COMMAND", message: "모름" },
        )}\n`,
      );
    });
    const handlers = loadFramework(mock.socketPath);
    await invoke(handlers, "data_kv_get", { key: "a" });
    await invoke(handlers, "plugin_scan", {});
    await invoke(handlers, "data_kv_get", { key: "b" });
    const lines = ledger();
    expect(lines.map((l) => [l.cmd, l.served])).toEqual([
      ["data_kv_get", true],
      ["plugin_scan", false],
      ["data_kv_get", true],
    ]);
    expect(lines.filter((l) => !l.served).map((l) => l.code)).toEqual(["UNKNOWN_COMMAND"]);
  });
});
