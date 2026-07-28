// @vitest-environment node
// 셸의 실제 경로 — 렌더러가 부르는 `shell:invoke` 가 소켓까지 가고, 요구 원장이 파일로 남는가.
//
// Electron 은 띄우지 않는다. electron 모듈을 스텁으로 갈아끼우고 main.cjs 를 적재하면 배선
// 그대로가 손에 잡힌다(창은 만들지 않는다 — whenReady 를 풀지 않는다). 다리 단위 검증
// (backend-socket.test.mjs)은 다리가 옳음을 말하고, 이 파일은 셸이 그 다리를 실제로 쓰는지와
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

/** 셸을 적재하고 ipcMain 에 걸린 핸들러를 돌려준다 — 렌더러가 잡는 그 손잡이다. */
function loadShell(socketPath) {
  const handlers = new Map();
  const stub = {
    app: {
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
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  requireCjs(MAIN);
  return handlers;
}

const invoke = (handlers, cmd, args) => handlers.get("shell:invoke")(null, { cmd, args });

/** 원장 실물 — 셸이 홈에 떨구는 jsonl 을 그대로 읽는다. */
function ledger() {
  const p = join(root, ".soksak-electron-spike", "invoke-demand.jsonl");
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-shell-"));
  servers = [];
  realHomedir = osModule.homedir;
  realSocketEnv = process.env.SOKSAK_SOCKET;
  // 셸은 원장을 홈에 떨군다 — 검증이 사용자 홈을 건드리지 않게 홈을 픽스처로 돌린다.
  osModule.homedir = () => root;
});

afterEach(() => {
  osModule.homedir = realHomedir;
  if (realSocketEnv === undefined) delete process.env.SOKSAK_SOCKET;
  else process.env.SOKSAK_SOCKET = realSocketEnv;
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  delete requireCjs.cache[ELECTRON];
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("shell:invoke — 렌더러가 보는 답", () => {
  it("백엔드가 있으면 값이 돌아오고 원장에 served:true 로 남는다", async () => {
    const mock = await startMock("live.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: { theme: "dark" } })}\n`),
    );
    const handlers = loadShell(mock.socketPath);
    await expect(invoke(handlers, "themes_scan", { dir: "x" })).resolves.toEqual({
      ok: true,
      value: { theme: "dark" },
    });
    expect(mock.seen[0]).toMatchObject({ method: "themes_scan", params: { dir: "x" } });
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
    const handlers = loadShell(mock.socketPath);
    // 표본은 백엔드가 져야 할 명령이어야 한다 — 셸이 스스로 답하는 것(webview_*·engine_* 등)은
    // 애초에 소켓으로 가지 않으므로 백엔드의 답을 증언하지 못한다(shell-native.test.mjs 가 그쪽).
    const r = await invoke(handlers, "project_owners", {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
    expect(r.command).toBe("project_owners");
    expect(ledger()).toEqual([
      { t: expect.any(Number), cmd: "project_owners", served: false, code: "UNKNOWN_COMMAND" },
    ]);
  });

  it("소켓 경로가 없으면 오늘과 같은 이름으로 실패한다 — 답이 달라지지 않는다", async () => {
    const handlers = loadShell(null);
    const r = await invoke(handlers, "activity_publish", {});
    expect(r).toMatchObject({ ok: false, code: "BACKEND_NOT_CONNECTED", command: "activity_publish" });
    expect(ledger()).toEqual([
      {
        t: expect.any(Number),
        cmd: "activity_publish",
        served: false,
        code: "BACKEND_NOT_CONNECTED",
      },
    ]);
  });

  it("원장은 서빙된 것과 못 한 것을 한 파일에서 가른다", async () => {
    // 헬퍼가 무엇을 더 져야 하는가 = 못 한 것들의 목록이다. 둘이 섞이면 그 목록이 안 나온다.
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
    const handlers = loadShell(mock.socketPath);
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
