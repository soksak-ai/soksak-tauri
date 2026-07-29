// @vitest-environment node
// window_* — 창 자체를 다루는 여섯. 이 갈래는 cored 로 가지 않는다(그 프로세스엔 창이 없다).
//
// 콘텐츠 뷰와 다른 점이 여기 있다. 콘텐츠는 <webview> 로 DOM 안에 살 수 있어 프레임워크를
// 건널 필요가 없지만(src/lib/contentViews.ts), **창은 DOM 이 만들 수 없다.** 그래서 이 여섯은
// 프레임워크가 실제로 답해야 하고, 답하지 못하면 프로젝트를 여는 경로가 거기서 멈춘다.
//
// 이름과 반환 모양은 앱의 것과 같아야 한다 — 번역하면 프론트가 프레임워크마다 다른 것을 보고
// 그 차이는 오류가 아니라 "이 프레임워크에서는 창 배치가 안 됨"으로 나타난다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join, sep } from "node:path";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const root = join(HERE, "../..");
const MAIN = join(root, "electron/main.cjs");
const BACKEND = join(root, "electron/backend.cjs");
const ELECTRON = requireCjs.resolve("electron");
const LABEL_FLAG = "--soksak-window-label=";

/** 창 하나 — 프레임워크가 실제로 부르는 메서드만 갖는다. 없는 것을 부르면 여기서 터진다. */
function fakeWindow(opts) {
  const wc = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
  const win = {
    opts,
    webContents: wc,
    closed: false,
    focused: false,
    // 실물 BrowserWindow 는 생성 인자의 x·y·width·height 로 시작한다. 픽스처가 그것을
    // 무시하면 "생성 인자로 놓는다"는 검사가 아무것도 증명하지 못한다.
    bounds: {
      x: opts?.x ?? 0,
      y: opts?.y ?? 0,
      width: opts?.width ?? 800,
      height: opts?.height ?? 600,
    },
    title: "soksak",
    loadURL: () => {},
    loadFile: () => {},
    once: (_e, cb) => (_e === "ready-to-show" ? cb() : undefined),
    on: () => {},
    show: () => {},
    focus() { win.focused = true; },
    close() { win.closed = true; },
    isDestroyed: () => win.closed,
    isFocused: () => win.focused,
    isAlwaysOnTop: () => false,
    getTitle: () => win.title,
    getBounds: () => ({ ...win.bounds }),
    setBounds(b) { Object.assign(win.bounds, b); },
    setBackgroundColor: () => {},
  };
  wc.__win = win;
  return win;
}

function loadFramework(created) {
  const handlers = new Map();
  class W {
    constructor(opts) {
      const w = fakeWindow(opts);
      created.push(w);
      return w;
    }
    static fromWebContents(wc) { return (wc && wc.__win) || null; }
    static getAllWindows() { return created.filter((w) => !w.closed); }
  }
  const stub = {
    app: {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다.
      setPath: () => {},
      setName: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => Promise.resolve(),
      on: () => {},
      getName: () => "soksak-electron-dev",
      getVersion: () => "0.0.0",
    },
    BrowserWindow: W,
    dialog: {},
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    screen: {
      getDisplayMatching: () => ({ scaleFactor: 1 }),
      getAllDisplays: () => [
        { id: 1, label: "built-in", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
        { id: 2, label: "side", bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1 },
      ],
    },
  };
  requireCjs.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: stub };
  delete process.env.SOKSAK_SOCKET;
  process.env.SOKSAK_CORED_BIN = join(root, "no-such-helper");
  delete requireCjs.cache[MAIN];
  delete requireCjs.cache[BACKEND];
  for (const p of Object.keys(requireCjs.cache)) {
    if (p.includes(`${sep}electron${sep}native${sep}`)) delete requireCjs.cache[p];
  }
  requireCjs(MAIN);
  return handlers;
}

function labelOf(win) {
  const a = (win.opts?.webPreferences?.additionalArguments ?? []).find((x) =>
    String(x).startsWith(LABEL_FLAG),
  );
  return a ? String(a).slice(LABEL_FLAG.length) : null;
}

let created;
let call;

beforeEach(async () => {
  created = [];
  const handlers = loadFramework(created);
  await new Promise((r) => setImmediate(r)); // 부팅 창이 서기를 기다린다
  const invoke = handlers.get("framework:invoke");
  const boot = created[0];
  call = (cmd, args = {}) =>
    invoke({ sender: boot.webContents }, { cmd, args });
});

afterEach(() => {
  delete requireCjs.cache[ELECTRON];
});

describe("window_* — 프레임워크가 답한다", () => {
  it("부팅 창이 서 있다 — 오라클 생존", () => {
    expect(created.length).toBeGreaterThan(0);
    expect(labelOf(created[0])).toBe("main");
  });

  it("window_list 는 살아 있는 라벨을 답한다", async () => {
    const r = await call("window_list");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(["main"]);
  });

  it("window_create 는 라벨로 만들고 같은 라벨엔 멱등이다", async () => {
    const a = await call("window_create", { label: "w-2" });
    expect(a.ok).toBe(true);
    expect(a.value).toBe("w-2");
    expect((await call("window_list")).value.sort()).toEqual(["main", "w-2"]);

    // 두 번째 호출은 새 창을 만들지 않는다 — 리스폰 재호출이 창을 늘리면 복원이 창을 뿌린다.
    const before = created.length;
    const b = await call("window_create", { label: "w-2" });
    expect(b.value).toBe("w-2");
    expect(created.length).toBe(before);
  });

  it("window_create 는 rect 를 그대로 놓는다", async () => {
    await call("window_create", { label: "w-3", rect: { x: 10, y: 20, w: 300, h: 200 } });
    const w = created.find((c) => labelOf(c) === "w-3");
    expect(w.getBounds()).toMatchObject({ x: 10, y: 20, width: 300, height: 200 });
  });

  it("window_focus·window_close 는 라벨로 짚는다", async () => {
    await call("window_create", { label: "w-4" });
    const w = created.find((c) => labelOf(c) === "w-4");

    expect((await call("window_focus", { label: "w-4" })).ok).toBe(true);
    expect(w.isFocused()).toBe(true);

    expect((await call("window_close", { label: "w-4" })).ok).toBe(true);
    expect(w.closed).toBe(true);
    expect((await call("window_list")).value).toEqual(["main"]);
  });

  it("없는 라벨은 이름을 달고 실패한다 — 아무 창이나 건드리지 않는다", async () => {
    for (const cmd of ["window_focus", "window_close", "window_place"]) {
      const r = await call(cmd, { label: "nope", x: 0, y: 0, w: 1, h: 1 });
      expect(r.ok).toBe(false);
      expect(String(r.message)).toContain("nope");
    }
    // 그 사이 부팅 창은 무사하다.
    expect(created[0].closed).toBe(false);
  });

  it("window_place 는 물리 rect 를 놓는다", async () => {
    const r = await call("window_place", { label: "main", x: 5, y: 6, w: 700, h: 500 });
    expect(r.ok).toBe(true);
    expect(created[0].getBounds()).toMatchObject({ x: 5, y: 6, width: 700, height: 500 });
  });

  it("window_monitors 는 모니터와 창을 사실로 답한다 — 소속 모니터까지", async () => {
    await call("window_place", { label: "main", x: 2000, y: 100, w: 400, h: 300 });
    const r = await call("window_monitors");
    expect(r.ok).toBe(true);

    expect(r.value.monitors).toHaveLength(2);
    expect(r.value.monitors[0]).toMatchObject({ index: 0, x: 0, y: 0, w: 1920, h: 1080, scale: 2 });

    const main = r.value.windows.find((w) => w.label === "main");
    expect(main).toMatchObject({ x: 2000, y: 100, w: 400, h: 300, focused: false });
    // 중심(2200,250)이 두 번째 모니터(1920..3200) 안이다 — 판단이 아니라 기하다.
    expect(main.monitor).toBe(1);
  });

  // 프론트는 라벨 없이 부른다(사용자가 "새 창"을 열 때 그 창의 이름을 알 리 없다). 그때
  // 프레임워크가 짓는다 — 라이브 실측에서 이 자리가 INVALID_LABEL 로 막혀 있었다.
  it("라벨 없이 부르면 프레임워크가 짓는다", async () => {
    const r = await call("window_create", {});
    expect(r.ok).toBe(true);
    // w-<uuid4> — 불투명하고 재사용되지 않는다. 코어와 같은 규칙이라야 복원 manifest 가
    // 두 프레임워크에서 같은 모양을 갖는다.
    expect(r.value).toMatch(/^w-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await call("window_list")).value).toContain(r.value);

    // 두 번 부르면 두 창이다 — 라벨이 없으면 멱등할 대상이 없다.
    const second = await call("window_create", {});
    expect(second.value).not.toBe(r.value);
  });
});
