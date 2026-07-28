// @vitest-environment node
// 프로젝트 점유 — 이것이 없으면 프로젝트가 **조용히** 안 열린다.
//
// 실측(2026-07-28): ensure_project_dir 은 성공해 디렉터리가 만들어지는데 project_claim 이
// UNKNOWN_COMMAND 로 실패하고, 호출자가 그 실패를 값으로 바꿔(catch → {ok:false}) root 가
// 거부됨으로 분류되고, 그 프로젝트가 드롭되어 화면은 "프로젝트 없음"이 된다. 오류는 어디에도
// 안 남는다.
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

function fakeWindow(opts) {
  const wc = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
  const win = {
    opts, webContents: wc, closed: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    loadURL: () => {}, loadFile: () => {},
    once: (e, cb) => (e === "ready-to-show" ? cb() : undefined),
    on: () => {}, show: () => {}, focus: () => {},
    close() { win.closed = true; },
    isDestroyed: () => win.closed,
    isFocused: () => false, isAlwaysOnTop: () => false,
    getTitle: () => "t", getBounds: () => ({ ...win.bounds }),
    setBounds: (b) => Object.assign(win.bounds, b),
    setBackgroundColor: () => {},
  };
  wc.__win = win;
  return win;
}

function loadFramework(created) {
  const handlers = new Map();
  class W {
    constructor(opts) { const w = fakeWindow(opts); created.push(w); return w; }
    static fromWebContents(wc) { return (wc && wc.__win) || null; }
    static getAllWindows() { return created.filter((w) => !w.closed); }
  }
  requireCjs.cache[ELECTRON] = {
    id: ELECTRON, filename: ELECTRON, loaded: true,
    exports: {
      app: {
      // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다.
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {}, whenReady: () => Promise.resolve(), on: () => {}, getName: () => "s", getVersion: () => "0" },
      BrowserWindow: W, dialog: {},
      ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
      screen: { getDisplayMatching: () => ({ scaleFactor: 1 }), getAllDisplays: () => [] },
    },
  };
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

const labelOf = (w) =>
  (w.opts?.webPreferences?.additionalArguments ?? [])
    .find((a) => String(a).startsWith(LABEL_FLAG))?.slice(LABEL_FLAG.length) ?? null;

let created, invoke;
beforeEach(async () => {
  created = [];
  const handlers = loadFramework(created);
  await new Promise((r) => setImmediate(r));
  const h = handlers.get("framework:invoke");
  invoke = (win, cmd, args = {}) => h({ sender: win.webContents }, { cmd, args });
});
afterEach(() => delete requireCjs.cache[ELECTRON]);

describe("프로젝트 점유 — 창을 소유한 쪽이 진다", () => {
  it("빈 상태에서 점유가 선다", async () => {
    const r = await invoke(created[0], "project_claim", { root: "/p/a" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ ok: true });
    const list = await invoke(created[0], "project_owners");
    expect(list.value.owners).toEqual([{ root: "/p/a", window: "main" }]);
  });

  it("같은 창의 재점유는 무해하다 — 리스폰이 자기 점유에 막히면 안 된다", async () => {
    await invoke(created[0], "project_claim", { root: "/p/a" });
    const again = await invoke(created[0], "project_claim", { root: "/p/a" });
    expect(again.value).toEqual({ ok: true });
  });

  it("다른 창이 쥐고 있으면 그 창을 알려 준다 — 예외가 아니라 값이다", async () => {
    await invoke(created[0], "project_claim", { root: "/p/a" });
    await invoke(created[0], "window_create", { label: "w-2" });
    const second = created.find((c) => labelOf(c) === "w-2");
    const r = await invoke(second, "project_claim", { root: "/p/a" });
    expect(r.ok).toBe(true); // 명령은 성공했다
    expect(r.value).toEqual({ ok: false, ownedBy: "main" }); // 점유는 실패했다
  });

  it("해제는 소유 창만 한다", async () => {
    await invoke(created[0], "project_claim", { root: "/p/a" });
    await invoke(created[0], "window_create", { label: "w-2" });
    const second = created.find((c) => labelOf(c) === "w-2");

    expect((await invoke(second, "project_release", { root: "/p/a" })).value)
      .toEqual({ released: false });
    expect((await invoke(created[0], "project_release", { root: "/p/a" })).value)
      .toEqual({ released: true });
    expect((await invoke(created[0], "project_owners")).value.owners).toEqual([]);
  });

  // 여기가 cored 가 이것을 질 수 없는 이유다 — 수명이 창의 수명과 같아야 한다.
  it("창이 죽으면 그 점유도 죽는다", async () => {
    await invoke(created[0], "window_create", { label: "w-2" });
    const second = created.find((c) => labelOf(c) === "w-2");
    await invoke(second, "project_claim", { root: "/p/b" });
    expect((await invoke(created[0], "project_owners")).value.owners).toHaveLength(1);

    await invoke(created[0], "window_close", { label: "w-2" });
    expect((await invoke(created[0], "project_owners")).value.owners).toEqual([]);

    // 그래서 그 root 를 다시 열 수 있다 — 죽은 창의 점유가 남으면 영영 못 연다.
    expect((await invoke(created[0], "project_claim", { root: "/p/b" })).value)
      .toEqual({ ok: true });
  });

  it("root 없는 호출은 이름을 달고 실패한다", async () => {
    const r = await invoke(created[0], "project_claim", {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_ROOT");
  });
});
