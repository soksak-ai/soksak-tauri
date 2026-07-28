// @vitest-environment node
// 셸의 것 — 창·웹뷰·네이티브 표면 명령. 이것들은 cored 로 가지 않는다(다른 프로세스엔 창이 없다).
//
// 검증의 축은 둘이다.
//   ① 대응이 있는 것은 Electron 이 실제로 답하는가 — 소켓을 거치지 않고, 부른 창에.
//   ② 대응이 없는 것은 **없다고 말하는가** — 조용한 성공은 UI 에게 없는 기능을 있다고 믿게 하고,
//      UI 는 그 믿음대로 그린다. 거절은 이름(SHELL_CONCEPT_ABSENT)을 달고, 사유는 읽힌다.
//
// Electron 은 띄우지 않는다. electron 모듈을 스텁으로 갈아끼우고 main.cjs 를 적재하면 배선
// 그대로가 손에 잡힌다(shell-invoke.test.mjs 와 같은 방식).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const ABSENT = "SHELL_CONCEPT_ABSENT";

let root;
let servers;
let realHomedir;
let realSocketEnv;

/** 목 백엔드 — 이 파일에서는 "여기로 오면 안 된다"를 증명하는 용도다(seen 이 비어야 한다). */
function startMock(name) {
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
        sock.write(`${JSON.stringify({ id: req.id, ok: true, data: "백엔드가 답했다" })}\n`);
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, seen })));
}

/** 창 대역 — 셸이 만지는 자리를 그대로 기록한다. */
function fakeWindow() {
  const calls = [];
  return {
    calls,
    setBackgroundColor: (c) => calls.push(["setBackgroundColor", c]),
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    isDestroyed: () => false,
  };
}

/** 셸을 적재하고 ipcMain 핸들러를 돌려준다 — 렌더러가 잡는 그 손잡이다. */
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
      // 발신 웹콘텐츠 → 창. 렌더러가 부른 창을 셸이 어떻게 짚는지가 그대로 드러난다.
      static fromWebContents(wc) {
        return (wc && wc.__win) || null;
      }
    },
    dialog: {},
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
  };
  requireCjs.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: stub };
  if (socketPath) process.env.SOKSAK_SOCKET = socketPath;
  else delete process.env.SOKSAK_SOCKET;
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  requireCjs(MAIN);
  return handlers;
}

/** 렌더러의 호출 — 발신 창까지 실어 보낸다(셸은 부른 창을 알아야 한다). */
const invoke = (handlers, cmd, args, win) =>
  handlers.get("shell:invoke")({ sender: win ? { __win: win } : {} }, { cmd, args });

function ledger() {
  const p = join(root, ".soksak-electron-spike", "invoke-demand.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 대응 개념이 없는 명령들 — 부르는 인자까지 실제 호출부와 같은 모양으로. */
const ABSENT_CALLS = [
  ["titlebar_backing", { r: 0.1, g: 0.1, b: 0.1 }],
  ["webview_overlay_active", { active: true }],
  ["webview_dom_holes", { holes: [{ x: 0, y: 0, w: 10, h: 10 }] }],
  ["webview_divider_highlight", { rect: { x: 1, y: 2, w: 3, h: 4 } }],
  ["engine_host_visible", { visible: true }],
  ["engine_surface_stats", {}],
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-native-"));
  servers = [];
  realHomedir = osModule.homedir;
  realSocketEnv = process.env.SOKSAK_SOCKET;
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

describe("대응이 있는 것 — Electron 이 실제로 답한다", () => {
  it("window_set_background 는 부른 창을 직접 칠한다 — 소켓으로 가지 않는다", async () => {
    const mock = await startMock("bg.sock");
    const handlers = loadShell(mock.socketPath);
    const win = fakeWindow();
    await expect(invoke(handlers, "window_set_background", { color: "#1e2430" }, win)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(win.calls).toEqual([["setBackgroundColor", "#1e2430"]]);
    expect(mock.seen).toEqual([]); // 셸의 것은 cored 로 가지 않는다
  });

  it("window_set_background 는 hex 가 아니면 Tauri 와 같은 기준으로 거절한다", async () => {
    const handlers = loadShell(null);
    const win = fakeWindow();
    const r = await invoke(handlers, "window_set_background", { color: "rgb(1,2,3)" }, win);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_COLOR");
    expect(win.calls).toEqual([]); // 거절했으면 칠하지도 않는다
  });

  it("window_set_background 는 부른 창을 못 찾으면 아무 창도 칠하지 않는다", async () => {
    const handlers = loadShell(null);
    const r = await invoke(handlers, "window_set_background", { color: "#000000" }, null);
    expect(r).toMatchObject({ ok: false, code: "NO_WINDOW", command: "window_set_background" });
  });

  it("webview_list 는 셸 표면 레지스트리에서 답한다 — 이 셸엔 자식 뷰가 없어 빈 목록", async () => {
    const mock = await startMock("list.sock");
    const handlers = loadShell(mock.socketPath);
    await expect(invoke(handlers, "webview_list", {}, fakeWindow())).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(mock.seen).toEqual([]);
  });

  it("webview_recovery_consume 은 false — 이 셸이 증명할 수 있는 부재다", async () => {
    const mock = await startMock("recover.sock");
    const handlers = loadShell(mock.socketPath);
    await expect(invoke(handlers, "webview_recovery_consume", {}, fakeWindow())).resolves.toEqual({
      ok: true,
      value: false,
    });
    expect(mock.seen).toEqual([]);
  });
});

describe("대응이 없는 것 — 없다고 값으로 말한다", () => {
  it("이름을 달고 거절한다 — 조용한 성공이 아니다", async () => {
    const mock = await startMock("absent.sock");
    const handlers = loadShell(mock.socketPath);
    for (const [cmd, args] of ABSENT_CALLS) {
      const r = await invoke(handlers, cmd, args, fakeWindow());
      expect(r.ok, `${cmd} 가 성공으로 위장했다`).toBe(false);
      expect(r.code, cmd).toBe(ABSENT);
      expect(r.command, cmd).toBe(cmd);
      expect(String(r.message).length, `${cmd} 사유 없음`).toBeGreaterThan(10);
    }
    expect(mock.seen).toEqual([]); // 못 하는 것을 cored 에게 떠넘기지 않는다
  });

  it("engine_surface_stats 는 0 을 지어내지 않는다 — 재지 않은 것을 쟀다고 말하지 않는다", async () => {
    const handlers = loadShell(null);
    const r = await invoke(handlers, "engine_surface_stats", {}, fakeWindow());
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
  });
});

describe("표 — UI 가 읽을 수 있는 능력면", () => {
  it("shell_capabilities 가 명령별 지원 여부와 사유를 값으로 준다", async () => {
    const handlers = loadShell(null);
    const r = await invoke(handlers, "shell_capabilities", {}, fakeWindow());
    expect(r.ok).toBe(true);
    expect(r.value.shell).toBe("electron");
    const c = r.value.commands;
    expect(c.window_set_background).toMatchObject({ supported: true });
    expect(c.webview_list).toMatchObject({ supported: true });
    expect(c.webview_recovery_consume).toMatchObject({ supported: true });
    for (const [cmd] of ABSENT_CALLS) {
      expect(c[cmd], cmd).toMatchObject({ supported: false });
      expect(String(c[cmd].reason).length, `${cmd} 사유 없음`).toBeGreaterThan(10);
      expect(String(c[cmd].concept).length, `${cmd} 개념 이름 없음`).toBeGreaterThan(1);
    }
  });

  it("표와 실제 답이 어긋나지 않는다 — 선언이 곧 행동이다", async () => {
    const handlers = loadShell(null);
    const table = (await invoke(handlers, "shell_capabilities", {}, fakeWindow())).value.commands;
    const args = Object.fromEntries(ABSENT_CALLS);
    for (const [cmd, cap] of Object.entries(table)) {
      const r = await invoke(handlers, cmd, args[cmd] ?? {}, fakeWindow());
      if (cap.supported) expect(r.code, `${cmd} 는 지원한다고 선언했다`).not.toBe(ABSENT);
      else expect(r.code, `${cmd} 는 미지원이라 선언했다`).toBe(ABSENT);
    }
  });
});

describe("요구 원장 — cored 가 져야 할 목록을 오염시키지 않는다", () => {
  it("네이티브 명령은 셸의 것으로 표시된다", async () => {
    const mock = await startMock("ledger.sock");
    const handlers = loadShell(mock.socketPath);
    await invoke(handlers, "webview_list", {}, fakeWindow());
    await invoke(handlers, "engine_surface_stats", {}, fakeWindow());
    await invoke(handlers, "project_owners", {}, fakeWindow()); // cored 의 것
    const lines = ledger();
    expect(lines.map((l) => [l.cmd, l.served, l.by])).toEqual([
      ["webview_list", true, "shell"],
      ["engine_surface_stats", false, "shell"],
      ["project_owners", true, undefined],
    ]);
    // cored 요구 목록 = 셸의 것이 아닌 줄들. 셸의 것은 절대 여기 섞이지 않는다.
    expect(lines.filter((l) => l.by !== "shell").map((l) => l.cmd)).toEqual(["project_owners"]);
    expect(lines.find((l) => l.cmd === "engine_surface_stats").code).toBe(ABSENT);
  });
});
