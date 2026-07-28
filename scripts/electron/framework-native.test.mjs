// @vitest-environment node
// 프레임워크의 것 — 창·웹뷰·네이티브 표면 명령. 이것들은 cored로 가지 않는다(다른 프로세스엔 창이 없다).
//
// 검증의 축은 둘이다.
//   ① 대응이 있는 것은 Electron 이 실제로 답하는가 — 소켓을 거치지 않고, 부른 창에.
//   ② 대응이 없는 것은 **없다고 말하는가** — 조용한 성공은 UI 에게 없는 기능을 있다고 믿게 하고,
//      UI 는 그 믿음대로 그린다. 거절은 이름(FRAMEWORK_CONCEPT_ABSENT)을 달고, 사유는 읽힌다.
//
// Electron 은 띄우지 않는다. electron 모듈을 스텁으로 갈아끼우고 main.cjs 를 적재하면 배선
// 그대로가 손에 잡힌다(framework-invoke.test.mjs 와 같은 방식).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "../../electron/main.cjs");
const BACKEND = join(HERE, "../../electron/backend.cjs");
const PRELOAD = join(HERE, "../../electron/preload.cjs");
const ELECTRON = requireCjs.resolve("electron");
const osModule = requireCjs("node:os");

const ABSENT = "FRAMEWORK_CONCEPT_ABSENT";
const LABEL_FLAG = "--soksak-window-label=";
/** 컨트롤 플레인 예약어. 부트스트랩 창은 이 라벨이어야 프론트의 컨트롤 플레인 분기가 돈다. */
const CONTROL_PLANE = "main";

let root;
let servers;
let realHomedir;
let realSocketEnv;
let realHelperEnv;

/** 목 백엔드 — 이 파일에서는 "여기로 오면 안 된다"를 증명하는 용도다(seen 이 비어야 한다).
 *  reply 를 주면 그 답을 돌려준다: 새는 명령이 무엇을 받는지까지 고정해야 ok:false 만 보는
 *  단언이 통과로 위장하는 것을 가른다(cored 는 모르는 이름에 UNKNOWN_COMMAND 로 답한다). */
function startMock(name, reply) {
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
        const body = reply
          ? reply(req)
          : { id: req.id, ok: true, data: "백엔드가 답했다" };
        sock.write(`${JSON.stringify({ id: req.id, ...body })}\n`);
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, seen })));
}

/** cored 가 모르는 이름에 답하는 그대로. 새면 이 코드가 돌아온다 — ABSENT 와 갈린다. */
const unknownCommand = (req) => ({
  ok: false,
  code: "UNKNOWN_COMMAND",
  message: `모르는 명령: ${req.method}`,
});

/** 창 대역 — 프레임워크가 만지는 자리를 그대로 기록한다. */
function fakeWindow() {
  const calls = [];
  return {
    calls,
    setBackgroundColor: (c) => calls.push(["setBackgroundColor", c]),
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    isDestroyed: () => false,
  };
}

/** 부팅 창 대역 — 프레임워크가 창을 만들 때 넘긴 것을 그대로 붙잡는다(라벨은 생성 인자에 실린다). */
function bootWindowClass(created) {
  return class {
    constructor(opts) {
      this.opts = opts;
      this.webContents = { send: () => {} };
      created.push(this);
    }
    once() {}
    on() {}
    show() {}
    isDestroyed() {
      return false;
    }
    getBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    loadURL() {
      return Promise.resolve();
    }
    setBackgroundColor() {}
    static fromWebContents(wc) {
      return (wc && wc.__win) || null;
    }
  };
}

/** 프레임워크를 적재하고 ipcMain 핸들러를 돌려준다 — 렌더러가 잡는 그 손잡이다.
 *  boot 를 주면 whenReady 를 풀어 부팅 창까지 만들게 하고, 만들어진 창을 boot.created 에 담는다. */
function loadFramework(socketPath, boot) {
  const handlers = new Map();
  const stub = {
    app: {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다.
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
      // boot 가 없으면 창을 만들지 않는다(풀리지 않는 약속).
      whenReady: () => (boot ? Promise.resolve() : new Promise(() => {})),
      on: () => {},
      getName: () => "soksak-electron-spike",
      getVersion: () => "0.0.0",
    },
    BrowserWindow: boot
      ? bootWindowClass(boot.created)
      : class {
          // 발신 웹콘텐츠 → 창. 렌더러가 부른 창을 프레임워크가 어떻게 짚는지가 그대로 드러난다.
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
  // 소켓을 안 주면 프레임워크는 자기 cored를 띄운다(cored-spawn.test.mjs 가 그쪽). 이 파일이 재는 것은
  // 소켓 앞에 서는 네이티브 표이므로 cored 자리를 없는 경로로 고정한다 — 빌드 산출물이 있는
  // 체크아웃에서만 진짜 프로세스가 뜨는 일을 만들지 않는다.
  process.env.SOKSAK_CORED_BIN = join(root, "no-such-helper");
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  for (const m of nativeModules()) delete requireCjs.cache[m];
  requireCjs(MAIN);
  return handlers;
}

/** 이미 적재된 native/*.cjs — 표는 여러 파일에서 합쳐지므로 캐시도 전부 비워야 재적재된다. */
function nativeModules() {
  return Object.keys(requireCjs.cache).filter((p) => p.includes(`${sep}electron${sep}native${sep}`));
}

/** 창 라벨은 생성 인자로 프리로드에 실린다 — 프레임워크가 부여한 라벨의 실물이다. */
function labelOf(win) {
  const args = win.opts?.webPreferences?.additionalArguments ?? [];
  const arg = args.find((a) => String(a).startsWith(LABEL_FLAG));
  return arg ? String(arg).slice(LABEL_FLAG.length) : null;
}

/** 렌더러의 호출 — 발신 창까지 실어 보낸다(프레임워크는 부른 창을 알아야 한다). */
const invoke = (handlers, cmd, args, win) =>
  handlers.get("framework:invoke")({ sender: win ? { __win: win } : {} }, { cmd, args });

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
  realHelperEnv = process.env.SOKSAK_CORED_BIN;
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
  for (const m of nativeModules()) delete requireCjs.cache[m];
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("대응이 있는 것 — Electron 이 실제로 답한다", () => {
  it("window_set_background 는 부른 창을 직접 칠한다 — 소켓으로 가지 않는다", async () => {
    const mock = await startMock("bg.sock");
    const handlers = loadFramework(mock.socketPath);
    const win = fakeWindow();
    await expect(invoke(handlers, "window_set_background", { color: "#1e2430" }, win)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(win.calls).toEqual([["setBackgroundColor", "#1e2430"]]);
    expect(mock.seen).toEqual([]); // 프레임워크의 것은 cored로 가지 않는다
  });

  it("window_set_background 는 hex 가 아니면 Tauri 와 같은 기준으로 거절한다", async () => {
    const handlers = loadFramework(null);
    const win = fakeWindow();
    const r = await invoke(handlers, "window_set_background", { color: "rgb(1,2,3)" }, win);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_COLOR");
    expect(win.calls).toEqual([]); // 거절했으면 칠하지도 않는다
  });

  it("window_set_background 는 부른 창을 못 찾으면 아무 창도 칠하지 않는다", async () => {
    const handlers = loadFramework(null);
    const r = await invoke(handlers, "window_set_background", { color: "#000000" }, null);
    expect(r).toMatchObject({ ok: false, code: "NO_WINDOW", command: "window_set_background" });
  });

  it("webview_list 는 프레임워크 표면 레지스트리에서 답한다 — 이 프레임워크엔 자식 뷰가 없어 빈 목록", async () => {
    const mock = await startMock("list.sock");
    const handlers = loadFramework(mock.socketPath);
    await expect(invoke(handlers, "webview_list", {}, fakeWindow())).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(mock.seen).toEqual([]);
  });

  it("webview_recovery_consume 은 false — 이 프레임워크가 증명할 수 있는 부재다", async () => {
    const mock = await startMock("recover.sock");
    const handlers = loadFramework(mock.socketPath);
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
    const handlers = loadFramework(mock.socketPath);
    for (const [cmd, args] of ABSENT_CALLS) {
      const r = await invoke(handlers, cmd, args, fakeWindow());
      expect(r.ok, `${cmd} 가 성공으로 위장했다`).toBe(false);
      expect(r.code, cmd).toBe(ABSENT);
      expect(r.command, cmd).toBe(cmd);
      expect(String(r.message).length, `${cmd} 사유 없음`).toBeGreaterThan(10);
    }
    expect(mock.seen).toEqual([]); // 못 하는 것을 cored에게 떠넘기지 않는다
  });

  it("engine_surface_stats 는 0 을 지어내지 않는다 — 재지 않은 것을 쟀다고 말하지 않는다", async () => {
    const handlers = loadFramework(null);
    const r = await invoke(handlers, "engine_surface_stats", {}, fakeWindow());
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
  });
});

describe("표 — UI 가 읽을 수 있는 능력면", () => {
  // 표는 갈래마다 한 파일이다(electron/native/*.cjs). 파일이 갈려도 UI 가 보는 키 집합은
  // 하나여야 한다 — 한 파일이 조립에서 빠지면 그 갈래가 통째로 사라지고, UI 는 없는 줄도 모른다.
  // 표에서 직접 읽는다 — 손으로 적은 목록은 표가 늘 때마다 낡고, 그 낡음이 곧 거짓 GREEN 이다.
  const DECLARED = [
    ...Object.keys(requireCjs(join(HERE, "../../electron/native/window.cjs"))),
    ...Object.keys(requireCjs(join(HERE, "../../electron/native/webview.cjs"))),
    ...Object.keys(requireCjs(join(HERE, "../../electron/native/engine.cjs"))),
    ...Object.keys(requireCjs(join(HERE, "../../electron/native/titlebar.cjs"))),
    ...Object.keys(requireCjs(join(HERE, "../../electron/native/project.cjs"))),
    "framework_capabilities",
  ];

  it("갈래 파일로 갈라도 키 집합은 그대로다", async () => {
    const handlers = loadFramework(null);
    const r = await invoke(handlers, "framework_capabilities", {}, fakeWindow());
    expect(Object.keys(r.value.commands).sort()).toEqual([...DECLARED].sort());
  });

  it("framework_capabilities 가 명령별 지원 여부와 사유를 값으로 준다", async () => {
    const handlers = loadFramework(null);
    const r = await invoke(handlers, "framework_capabilities", {}, fakeWindow());
    expect(r.ok).toBe(true);
    expect(r.value.framework).toBe("electron");
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
    const handlers = loadFramework(null);
    const table = (await invoke(handlers, "framework_capabilities", {}, fakeWindow())).value.commands;
    const args = Object.fromEntries(ABSENT_CALLS);
    for (const [cmd, cap] of Object.entries(table)) {
      const r = await invoke(handlers, cmd, args[cmd] ?? {}, fakeWindow());
      if (cap.supported) expect(r.code, `${cmd} 는 지원한다고 선언했다`).not.toBe(ABSENT);
      else expect(r.code, `${cmd} 는 미지원이라 선언했다`).toBe(ABSENT);
    }
  });
});

describe("부팅 창 — 라벨은 컨트롤 플레인 예약어다", () => {
  it("첫 창의 라벨이 main 이다 — 프론트의 컨트롤 플레인 분기가 이 이름 하나에 걸려 있다", async () => {
    const created = [];
    loadFramework(null, { created });
    await new Promise((r) => setTimeout(r, 0)); // whenReady 뒤 마이크로태스크
    expect(created.length, "부팅 창이 만들어지지 않았다").toBe(1);
    expect(labelOf(created[0])).toBe(CONTROL_PLANE);
  });

  it("부팅 창은 프리로드에 라벨을 주입한다 — 주입 없이는 렌더러가 자기 이름을 모른다", async () => {
    const created = [];
    loadFramework(null, { created });
    await new Promise((r) => setTimeout(r, 0));
    const args = created[0].opts.webPreferences.additionalArguments;
    expect(args.filter((a) => String(a).startsWith(LABEL_FLAG))).toHaveLength(1);
  });
});

describe("프리로드 — 라벨 주입 부재는 실패다", () => {
  /** 프리로드를 적재하고 렌더러에 노출된 것을 돌려준다. argv 는 프레임워크가 넘기는 그 모양이다. */
  function loadPreload(argv) {
    const exposed = {};
    requireCjs.cache[ELECTRON] = {
      id: ELECTRON,
      filename: ELECTRON,
      loaded: true,
      exports: {
        contextBridge: { exposeInMainWorld: (k, v) => (exposed[k] = v) },
        ipcRenderer: { on: () => {}, invoke: () => Promise.resolve() },
      },
    };
    const realArgv = process.argv;
    process.argv = argv;
    try {
      delete requireCjs.cache[PRELOAD];
      requireCjs(PRELOAD);
    } finally {
      process.argv = realArgv;
      delete requireCjs.cache[PRELOAD];
    }
    return exposed.__soksakFramework;
  }

  it("주입된 라벨을 그대로 쓴다", () => {
    const framework = loadPreload(["electron", ".", `${LABEL_FLAG}w-abc`]);
    expect(framework.label).toBe("w-abc");
  });

  it("라벨 주입이 없으면 적재가 실패한다 — 조용한 main 폴백은 없다", () => {
    // 폴백하면 라벨을 못 받은 창이 컨트롤 플레인 행세를 하고, 두 창이 같은 이름으로 산다.
    expect(() => loadPreload(["electron", "."])).toThrow(/soksak-window-label/);
  });

  it("빈 라벨도 실패다 — 이름 없는 창은 창 명령의 대상이 될 수 없다", () => {
    expect(() => loadPreload(["electron", ".", LABEL_FLAG])).toThrow(/soksak-window-label/);
  });
});

describe("프레임워크-갈래 미등재 — 소켓으로 새지 않는다", () => {
  // 창·웹뷰·엔진·타이틀바는 프레임워크의 영역이다. 표에 없다고 소켓으로 흘려보내면 cored 가
  // UNKNOWN_COMMAND 로 답하고, 그 이름은 "cored 가 더 져야 할 것"으로 요구 원장에 실린다 —
  // 영영 옮길 수 없는 것(다른 프로세스엔 창이 없다)을 할 일 목록에 세우게 된다.
  const UNLISTED = [
    ["webview_holes", {}],
    ["webview_resize_gesture", { active: true }],
    ["engine_surface_hide", {}],
    ["titlebar_backing", {}],
  ];

  it("이름을 달고 거절한다 — 소켓에 닿지 않는다", async () => {
    // 백엔드는 모르는 이름에 UNKNOWN_COMMAND 로 답한다. ok:false 만 보면 새는 것도 통과한다 —
    // 그래서 code 까지 본다.
    const mock = await startMock("unlisted.sock", unknownCommand);
    const handlers = loadFramework(mock.socketPath);
    for (const [cmd, args] of UNLISTED) {
      const r = await invoke(handlers, cmd, args, fakeWindow());
      expect(r.ok, `${cmd} 가 성공으로 위장했다`).toBe(false);
      expect(r.code, cmd).toBe(ABSENT);
      expect(r.command, cmd).toBe(cmd);
    }
    expect(mock.seen).toEqual([]);
  });

  it("요구 원장에 프레임워크의 것으로 남는다 — cored 목록을 오염시키지 않는다", async () => {
    const mock = await startMock("unlisted-ledger.sock", unknownCommand);
    const handlers = loadFramework(mock.socketPath);
    // 진짜 부재로 잰다 — webview_visible 은 렌더러가 소유해 위임 코드로 답한다.
    await invoke(handlers, "webview_holes", {}, fakeWindow());
    expect(ledger().map((l) => [l.cmd, l.served, l.by, l.code])).toEqual([
      ["webview_holes", false, "framework", ABSENT],
    ]);
  });
});

describe("요구 원장 — cored가 져야 할 목록을 오염시키지 않는다", () => {
  it("네이티브 명령은 프레임워크의 것으로 표시된다", async () => {
    const mock = await startMock("ledger.sock");
    const handlers = loadFramework(mock.socketPath);
    await invoke(handlers, "webview_list", {}, fakeWindow());
    await invoke(handlers, "engine_surface_stats", {}, fakeWindow());
    await invoke(handlers, "themes_scan", {}, fakeWindow()); // cored의 것
    const lines = ledger();
    expect(lines.map((l) => [l.cmd, l.served, l.by])).toEqual([
      ["webview_list", true, "framework"],
      ["engine_surface_stats", false, "framework"],
      ["themes_scan", true, undefined],
    ]);
    // cored 요구 목록 = 프레임워크의 것이 아닌 줄들. 프레임워크의 것은 절대 여기 섞이지 않는다.
    expect(lines.filter((l) => l.by !== "framework").map((l) => l.cmd)).toEqual(["themes_scan"]);
    expect(lines.find((l) => l.cmd === "engine_surface_stats").code).toBe(ABSENT);
  });
});
