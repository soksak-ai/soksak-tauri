// @vitest-environment node
// 활동 부채질 — cored가 적재해 돌려준 항목을 셸이 자기 창에 뿌리는가.
//
// 발행은 세 단이다: 적재(도장·단조) · 부채질(창 emit) · 영속(records 쓰기). cored 프로세스엔
// 창이 없어 적재까지만 하고 도장 찍힌 항목을 답에 실어 준다. 부채질을 셸이 안 하면 프론트는
// 반환값을 버리므로(void invoke) 활동 구독자가 오류 한 줄 없이 굶는다 — 무증상이라 더 나쁘다.
// 이 파일이 세우는 기준이 그 무증상이다: 적재분이 창에 **사건으로** 도착해야 한다.
//
// Electron 은 띄우지 않는다. electron 모듈을 스텁으로 갈아끼우고 main.cjs 를 적재하면 배선
// 그대로가 손에 잡힌다(shell-invoke.test.mjs 와 같은 방식). 여기서는 whenReady 를 풀어 창까지
// 만든다 — 부채질의 대상 목록이 곧 셸의 창 레지스트리이기 때문이다.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "../../electron/main.cjs");
const BACKEND = join(HERE, "../../electron/backend.cjs");
const ACTIVITY = join(HERE, "../../electron/activity.cjs");
const PRELOAD = join(HERE, "../../electron/preload.cjs");
const ELECTRON = requireCjs.resolve("electron");
const osModule = requireCjs("node:os");

/** 프론트가 구독하는 사건 이름·채널 — 코어(activity.rs 의 broadcast)와 같아야 한다. */
const EVENT_CHANNEL = "shell:event";
const ACTIVITY_EVENT = "activity";

/** 도장 찍힌 항목 하나 — 코어의 stamp 가 내는 모양 그대로. */
const ENTRY = {
  seq: 41,
  ts: 1_700_000_000_000,
  kind: "command.executed",
  source: "ui",
  payload: { command: "window.snapshot", ok: true, window: "w-electron-1" },
};

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

/** 창 대역 — 셸이 미는 사건을 채널째 기록한다(렌더러가 preload 에서 받는 그 모양). */
function fakeWindow() {
  const sent = [];
  return {
    sent,
    webContents: { send: (channel, msg) => sent.push([channel, msg]) },
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    once: () => {},
    on: () => {},
    loadURL: () => {},
    show: () => {},
  };
}

/**
 * 셸을 적재한다. whenReady 를 풀어 셸이 자기 창을 만들게 한다 — 부채질 대상은 그 레지스트리다.
 * 돌려주는 created 는 셸이 만든 창들(만든 순서).
 */
async function loadShell(socketPath) {
  const handlers = new Map();
  const created = [];
  const stub = {
    app: {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다.
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => Promise.resolve(),
      on: () => {},
      getName: () => "soksak-electron-spike",
      getVersion: () => "0.0.0",
    },
    BrowserWindow: class {
      constructor() {
        const w = fakeWindow();
        Object.assign(this, w);
        created.push(this);
      }
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
  delete requireCjs.cache[ACTIVITY];
  requireCjs(MAIN);
  // whenReady 는 마이크로태스크로 풀린다 — 창이 생긴 뒤에 손잡이를 넘긴다.
  await new Promise((r) => setImmediate(r));
  return { handlers, created };
}

/**
 * 프리로드를 적재한다 — 렌더러가 셸을 만나는 유일한 창구. 셸이 보낸 봉투를 여기가 풀지
 * 못하면 창까지 간 사건이 구독자에게 닿지 않는다(그 구간도 무증상이다).
 * 돌려주는 channels 는 프리로드가 ipcRenderer 에 건 손잡이들이다.
 */
function loadPreload() {
  const exposed = {};
  const channels = new Map();
  requireCjs.cache[ELECTRON] = {
    id: ELECTRON,
    filename: ELECTRON,
    loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
      ipcRenderer: { on: (ch, fn) => channels.set(ch, fn), invoke: () => Promise.resolve() },
    },
  };
  // 셸은 창을 만들 때 라벨을 주입한다 — 프리로드는 그것 없이는 적재되지 않는다(폴백 없음).
  const realArgv = process.argv;
  process.argv = [...realArgv, "--soksak-window-label=main"];
  try {
    delete requireCjs.cache[PRELOAD];
    requireCjs(PRELOAD);
  } finally {
    process.argv = realArgv;
  }
  return { bridge: exposed.__soksakFramework, channels };
}

/** 렌더러의 호출 — 발신 창까지 실어 보낸다. */
const invoke = (handlers, cmd, args, win) =>
  handlers.get("framework:invoke")({ sender: win ? { __win: win } : {} }, { cmd, args });

/** 이 창이 받은 활동 사건들. */
const activityEventsOf = (win) =>
  win.sent.filter(([ch, m]) => ch === EVENT_CHANNEL && m.event === ACTIVITY_EVENT).map(([, m]) => m);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-activity-"));
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
  delete requireCjs.cache[ACTIVITY];
  delete requireCjs.cache[PRELOAD];
  delete requireCjs.cache[ELECTRON];
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("적재분은 창에 사건으로 도착한다", () => {
  it("cored가 적재해 돌려준 항목을 셸이 자기 창에 뿌린다", async () => {
    // cored의 답 = 도장 찍힌 항목(적재는 됐다). 이것을 창에 안 뿌리면 프론트는 반환값을
    // 버리므로 listen("activity") 구독자가 오류 없이 굶는다.
    const mock = await startMock("publish.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: ENTRY })}\n`),
    );
    const { handlers, created } = await loadShell(mock.socketPath);
    expect(created).toHaveLength(1);
    const win = created[0];

    const r = await invoke(
      handlers,
      "activity_publish",
      { kind: ENTRY.kind, source: ENTRY.source, payload: ENTRY.payload },
      win,
    );

    // 소비자 ①: 호출자 — invoke 의 반환값. 코어와 같은 값이다.
    expect(r).toEqual({ ok: true, value: ENTRY });
    // 소비자 ②: 창 구독자 — 코어의 broadcast 와 같은 사건 이름·같은 페이로드 모양.
    expect(activityEventsOf(win)).toEqual([{ event: ACTIVITY_EVENT, payload: ENTRY }]);
  });

  it("부른 창도 딱 한 번 받는다 — 반환과 사건은 서로 다른 소비자다", async () => {
    const mock = await startMock("once.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: ENTRY })}\n`),
    );
    const { handlers, created } = await loadShell(mock.socketPath);
    const win = created[0];
    await invoke(handlers, "activity_publish", { kind: "k", source: "ui", payload: {} }, win);
    // 반환값을 사건으로 겸하지 않는다: 부른 창은 브로드캐스트로만 받고, 두 번 받지 않는다.
    expect(activityEventsOf(win)).toHaveLength(1);
  });

  it("발행이 아닌 명령의 답은 창에 뿌리지 않는다", async () => {
    const mock = await startMock("other.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: { theme: "dark" } })}\n`),
    );
    const { handlers, created } = await loadShell(mock.socketPath);
    const win = created[0];
    await invoke(handlers, "data_kv_get", { ns: "core", key: "theme" }, win);
    expect(win.sent).toEqual([]);
  });

  it("적재분이 아닌 답은 이름을 달고 거절한다 — 아닌 것을 창에 밀지 않는다", async () => {
    // 모양을 안 보고 밀면 프론트가 ev.payload.seq 로 가르는 백필 겹침이 조용히 어긋난다.
    const mock = await startMock("bad.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: { nope: 1 } })}\n`),
    );
    const { handlers, created } = await loadShell(mock.socketPath);
    const win = created[0];
    const r = await invoke(handlers, "activity_publish", { kind: "k", source: "ui", payload: {} }, win);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SHELL_ACTIVITY_NOT_AN_ENTRY");
    expect(r.command).toBe("activity_publish");
    expect(win.sent).toEqual([]);
  });
});

describe("봉투 — 셸이 보낸 것을 프리로드가 그대로 푼다", () => {
  it("구독자가 받는 것은 항목 그 자체다 — 코어의 listen(\"activity\") 와 같은 모양", async () => {
    // 셸이 창에 넣는 봉투와 프리로드가 푸는 봉투가 어긋나면 사건은 창까지 가고도 구독자에게
    // 닿지 않는다. 두 쪽을 실물로 이어 본다 — 셸도 렌더러도 띄우지 않고.
    const mock = await startMock("seam.sock", (req, sock) =>
      sock.write(`${JSON.stringify({ id: req.id, ok: true, data: ENTRY })}\n`),
    );
    const { handlers, created } = await loadShell(mock.socketPath);
    const win = created[0];
    await invoke(handlers, "activity_publish", { kind: "k", source: "ui", payload: {} }, win);
    const [channel, envelope] = win.sent[0];

    const { bridge, channels } = loadPreload();
    const got = [];
    bridge.onEvent(ACTIVITY_EVENT, (payload) => got.push(payload));
    channels.get(channel)(null, envelope);

    // 어댑터(src/platform/electron.ts)는 이 값을 { payload } 로 감싸 앱에 준다 — 그래서 앱이
    // 보는 것은 Tauri 의 emit 이 주는 것과 같은 항목이다.
    expect(got).toEqual([ENTRY]);
    expect(got[0].seq).toBe(ENTRY.seq);
  });
});

// 창이 여럿일 때의 규칙 — 셸은 whenReady 에서 창을 하나만 만들므로 배선 검증으로는 표현되지
// 않는다. 규칙 자체는 배달 모듈이 지므로 여기서 목록을 직접 준다(main.cjs 는 자기 레지스트리
// 전부를 그대로 넘긴다 — 위 배선 검증이 그 연결을 증언한다).
describe("누구에게 가는가 — 창 전부에, 창마다 한 번", () => {
  const load = () => {
    delete requireCjs.cache[ACTIVITY];
    return requireCjs(ACTIVITY);
  };

  it("살아 있는 창 전부가 같은 사건 이름·같은 페이로드를 받는다", () => {
    const { fanOut, ACTIVITY_EVENT: EVENT, EVENT_CHANNEL: CH } = load();
    const wins = [fakeWindow(), fakeWindow(), fakeWindow()];
    expect(fanOut(ENTRY, wins)).toBe(true);
    for (const w of wins) {
      // 라벨을 고르지 않는다 — 활동은 "누구에게"가 없는 사건이다(코어의 broadcast 와 같다).
      expect(w.sent).toEqual([[CH, { event: EVENT, payload: ENTRY }]]);
    }
  });

  it("닿지 못한 창이 있으면 거짓으로 돌아온다 — 유실을 성공으로 위장하지 않는다", () => {
    const { fanOut } = load();
    const live = fakeWindow();
    const dead = fakeWindow();
    dead.isDestroyed = () => true;
    expect(fanOut(ENTRY, [live, dead])).toBe(false);
    // 하나가 죽었다고 나머지를 포기하지 않는다.
    expect(live.sent).toHaveLength(1);
    expect(dead.sent).toEqual([]);
  });

  it("도장 축이 빠진 값은 항목이 아니다", () => {
    const { isActivityEntry } = load();
    expect(isActivityEntry(ENTRY)).toBe(true);
    for (const missing of ["seq", "ts", "kind", "source", "payload"]) {
      const broken = { ...ENTRY };
      delete broken[missing];
      expect(isActivityEntry(broken), `${missing} 없이도 항목으로 통과했다`).toBe(false);
    }
    for (const v of [null, undefined, 7, "entry", [ENTRY]]) {
      expect(isActivityEntry(v), `${JSON.stringify(v)} 가 항목으로 통과했다`).toBe(false);
    }
  });
});
