// 이 프레임워크의 콘텐츠 뷰 구현 — 콘텐츠가 **문서 밖**에 산다.
//
// 이름과 인자를 번역하지 않는 것이 이 구현의 전부다. 번역하면 새 드리프트 면이 생기고,
// 그 드리프트는 "이 프레임워크에서만 안 되는 기능"으로 나타난다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
const noteSurfaceWrite = vi.fn();
const listeners = new Map<string, (payload: Record<string, unknown>) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock("../../plugins/hooks", () => ({
  onPluginEvent: (event: string, fn: (payload: Record<string, unknown>) => void) => {
    listeners.set(event, fn);
    return { dispose: () => listeners.delete(event) };
  },
}));
vi.mock("./slotFreezeHost", () => ({
  invalidateSlotSnapshot: vi.fn(),
  noteSurfaceWrite: (...args: unknown[]) => noteSurfaceWrite(...args),
}));

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly callback: ResizeObserverCallback;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

async function load() {
  vi.resetModules();
  invoke.mockReset();
  noteSurfaceWrite.mockReset();
  invoke.mockResolvedValue(undefined);
  const module = await import("./contentViews");
  module.__resetNativeContentViewCompositionForTest();
  return module;
}

describe("네이티브 자식 뷰 구현", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    listeners.clear();
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("이름과 인자를 번역하지 않는다", async () => {
    const { nativeHost } = await load();
    await nativeHost.open("b-1", { url: "https://x", x: -20000, y: -20000, w: 1, h: 1 });
    expect(invoke).toHaveBeenCalledWith("webview_open", {
      label: "b-1", url: "https://x", x: -20000, y: -20000, w: 1, h: 1,
    });
    expect(invoke).toHaveBeenCalledWith("webview_visible", {
      label: "b-1", visible: true, focus: false,
    });
    await nativeHost.bounds("b-1", 1, 2, 3, 4);
    expect(invoke).toHaveBeenCalledWith("webview_bounds", { label: "b-1", x: 1, y: 2, w: 3, h: 4 });
  });

  // 없는 것을 있는 척하지 않는다 — 조용한 성공은 부른 쪽이 눌렀다고 믿게 만든다.
  it("입력 주입은 통로가 없음을 이름을 달고 밝힌다", async () => {
    const { nativeHost } = await load();
    await expect(nativeHost.sendInput("b-1", 1, 2)).rejects.toThrow("입력 주입 통로가 없습니다");
  });

  it("주입 해지가 no-op 임을 스스로 밝힌다", async () => {
    const { nativeHost } = await load();
    const off = nativeHost.injectScript("b-1", "1", "document-start");
    expect(invoke).toHaveBeenCalledWith("webview_inject_script", {
      label: "b-1",
      code: "1",
      phase: "document-start",
    });
    expect(() => off()).not.toThrow();
  });

  it("공개 슬롯의 현재 rect로 열고 사건·ResizeObserver로만 추종한다", async () => {
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-1");
    const hole = document.createElement("div");
    hole.setAttribute("data-tauri-hole", "content");
    hole.dataset.freezeSnapTry = "3";
    hole.dataset.freezeSnapFail = "2";
    hole.dataset.freezeSnapSkip = "inflight";
    hole.dataset.freezeGlide = "no:nosnap";
    hole.appendChild(slot);
    let rect = { left: 10.2, top: 20.4, right: 310.8, bottom: 220.9 };
    slot.getBoundingClientRect = () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }) as DOMRect;
    document.body.appendChild(hole);

    const {
      installNativeContentViewComposition,
      nativeContentViewCompositionStatus,
      nativeHost,
    } = await load();
    installNativeContentViewComposition();
    await nativeHost.open("b-1", { url: "https://x" });
    expect(invoke).toHaveBeenCalledWith("webview_open", {
      label: "b-1",
      url: "https://x",
      x: 11,
      y: 21,
      w: 299,
      h: 199,
    });
    expect(nativeContentViewCompositionStatus()).toEqual([
      expect.objectContaining({
        label: "b-1",
        opened: true,
        slotPresent: true,
        slotRect: { x: 11, y: 21, w: 299, h: 199 },
        appliedRect: "11,21,299,199",
        syncPending: false,
        freeze: {
          active: false,
          glide: "no:nosnap",
          pending: false,
          scope: null,
          snapAt: null,
          snapFail: 2,
          reject: null,
          snapSkip: "inflight",
          snapTry: 3,
          snapSize: null,
        },
      }),
    ]);

    invoke.mockClear();
    rect = { left: 40, top: 50, right: 440, bottom: 350 };
    listeners.get("layout.reflow")?.({ activeSpaceId: "c1" });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("webview_bounds", {
        label: "b-1", x: 40, y: 50, w: 400, h: 300,
      });
    });

    invoke.mockClear();
    rect = { left: 41, top: 50, right: 441, bottom: 350 };
    ResizeObserverMock.instances[0].fire();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "webview_bounds",
      { label: "b-1", x: 41, y: 50, w: 400, h: 300 },
    ));
    expect(vi.isMockFunction(globalThis.requestAnimationFrame)).toBe(false);
  });

  it("숨긴 표면은 기하 사건이 다시 표시하지 못하고 복귀 직전에만 최신 rect를 받는다", async () => {
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-hidden");
    let x = 10;
    slot.getBoundingClientRect = () => ({
      x, y: 20, left: x, top: 20, right: x + 300, bottom: 220, width: 300, height: 200,
    }) as DOMRect;
    document.body.appendChild(slot);

    const { installNativeContentViewComposition, nativeHost } = await load();
    installNativeContentViewComposition();
    await nativeHost.open("b-hidden", { url: "https://x" });
    await nativeHost.visible("b-hidden", false, false);
    invoke.mockClear();

    x = 120;
    listeners.get("layout.reflow")?.({ activeSpaceId: "c1" });
    ResizeObserverMock.instances[0].fire();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith("webview_bounds", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(
      "webview_visible",
      expect.objectContaining({ visible: true }),
    );

    await nativeHost.visible("b-hidden", true, false);
    expect(invoke.mock.calls).toEqual([
      ["webview_alive", { label: "b-hidden" }],
      ["webview_bounds", { label: "b-hidden", x: 120, y: 20, w: 300, h: 200 }],
      ["webview_visible", { label: "b-hidden", visible: true, focus: false }],
    ]);
  });

  it("veil은 제품 visibility를 건드리지 않고 해동에서 bounds→native veil 해제→표면 ack 순서를 지킨다", async () => {
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b--v1");
    let x = 10;
    slot.getBoundingClientRect = () => ({
      x, y: 20, left: x, top: 20, right: x + 300, bottom: 220, width: 300, height: 200,
    }) as DOMRect;
    document.body.appendChild(slot);

    const { installNativeContentViewComposition, nativeHost } = await load();
    installNativeContentViewComposition();
    await nativeHost.open("b--v1", { url: "https://x" });
    invoke.mockClear();

    listeners.get("content-view.veiled")?.({ label: "b--v1", veiled: true, hidden: true });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "webview_veil",
      { label: "b--v1", hidden: true },
    ));
    invoke.mockClear();
    x = 120;
    listeners.get("layout.reflow")?.({ activeSpaceId: "c1" });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith("webview_bounds", expect.anything());

    listeners.get("content-view.veiled")?.({ label: "b--v1", veiled: false, hidden: false });
    await vi.waitFor(() => expect(invoke.mock.calls).toEqual([
      ["webview_alive", { label: "b--v1" }],
      ["webview_bounds", { label: "b--v1", x: 120, y: 20, w: 300, h: 200 }],
      ["webview_veil", { label: "b--v1", hidden: false }],
    ]));
    expect(noteSurfaceWrite).toHaveBeenCalledWith("b--v1");
  });

  it("복귀 에지에서 떨어진 child를 플러그인 재마운트 없이 어댑터가 복구한다", async () => {
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-recover");
    slot.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200,
    }) as DOMRect;
    document.body.appendChild(slot);
    const { nativeHost } = await load();
    await nativeHost.open("b-recover", { url: "https://first" });
    await nativeHost.navigate("b-recover", "https://current");
    invoke.mockClear();
    invoke.mockImplementation(async (cmd: string) => cmd === "webview_alive" ? false : undefined);

    await nativeHost.visible("b-recover", true, false);
    expect(invoke.mock.calls).toEqual([
      ["webview_alive", { label: "b-recover" }],
      ["webview_open", {
        label: "b-recover", url: "https://current", x: 10, y: 20, w: 300, h: 200,
      }],
      ["webview_visible", { label: "b-recover", visible: true, focus: false }],
    ]);
  });
});
