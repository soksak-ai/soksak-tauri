// 이 프레임워크의 콘텐츠 뷰 구현 — 콘텐츠가 **문서 밖**에 산다.
//
// 이름과 인자를 번역하지 않는 것이 이 구현의 전부다. 번역하면 새 드리프트 면이 생기고,
// 그 드리프트는 "이 프레임워크에서만 안 되는 기능"으로 나타난다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
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
  invoke.mockResolvedValue(undefined);
  const module = await import("./contentViews");
  module.__resetNativeContentViewCompositionForTest();
  return module;
}

describe("네이티브 자식 뷰 구현", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("확정 텍스트를 child 웹뷰의 네이티브 입력자로 보낸다", async () => {
    const { nativeHost } = await load();
    await (nativeHost as unknown as { typeText(label: string, text: string): Promise<void> })
      .typeText("b-1", "한글 입력");
    expect(invoke).toHaveBeenCalledWith("webview_type_text", {
      label: "b-1",
      text: "한글 입력",
    });
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

  it("창 resize는 같은 최종 DOM rect여도 native child에 권위 frame을 다시 쓴다", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-resize");
    slot.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200,
    }) as DOMRect;
    document.body.appendChild(slot);

    const { installNativeContentViewComposition, nativeHost } = await load();
    installNativeContentViewComposition();
    await nativeHost.open("b-resize", { url: "https://x" });
    invoke.mockClear();

    // AppKit은 부모 창의 중간 resize에서 child 내부 frame을 바꿀 수 있다. DOM rect가 처음과
    // 같은 크기로 돌아와도 JS lastRect는 그 네이티브 변화를 관측하지 못하므로 캐시 hit가
    // 최종 정착의 증거가 될 수 없다.
    window.dispatchEvent(new Event("resize"));
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith("webview_bounds", expect.anything());
    frames.shift()?.(0);
    expect(invoke).not.toHaveBeenCalledWith("webview_bounds", expect.anything());
    frames.shift()?.(16);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("webview_bounds", {
      label: "b-resize", x: 10, y: 20, w: 300, h: 200,
    }));
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

  it("native surface 배치는 z-order를 왕복하지 않고 목표 bounds로 한 번 정착한다", async () => {
    const frame = document.createElement("div");
    frame.className = "tab-body";
    frame.dataset.node = "layout/tab/v1";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "browser--v1");
    slot.getBoundingClientRect = () => ({
      x: 620, y: 112, left: 620, top: 112, right: 832, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    const { nativeHost, prepareNativeContentViewMove } = await load();
    await nativeHost.open("browser--v1", { url: "https://x" });
    invoke.mockClear();

    const prepared = await prepareNativeContentViewMove([{ viewId: "v1", dx: 410 }]);
    expect(prepared.mode).toBe("snap");
    expect(invoke).not.toHaveBeenCalled();

    slot.getBoundingClientRect = () => ({
      x: 210, y: 112, left: 210, top: 112, right: 422, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    await prepared.commit();
    expect(invoke).toHaveBeenCalledWith("webview_bounds", {
      label: "browser--v1",
      x: 210,
      y: 112,
      w: 212,
      h: 458,
    });
    expect(invoke).not.toHaveBeenCalledWith("webview_surface_handoff", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("webview_animate_bounds", expect.anything());
    expect(vi.isMockFunction(globalThis.requestAnimationFrame)).toBe(false);
  });

  it("공개 DOM 슬롯의 외부 표면 claim을 snap 거래로 묶고 최종 rect ACK를 기다린다", async () => {
    const frame = document.createElement("div");
    frame.dataset.node = "layout/tab/v-external";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "engine-v-external");
    let x = 620;
    slot.getBoundingClientRect = () => ({
      x, y: 112, left: x, top: 112, right: x + 212, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    let releaseAck!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => { releaseAck = resolve; }));
    const cancel = vi.fn();
    slot.addEventListener("soksak:external-surface-layout-transition", ((event: CustomEvent) => {
      event.detail.claim({ commit, cancel });
    }) as EventListener);

    const { prepareNativeContentViewMove } = await load();
    const prepared = await prepareNativeContentViewMove([{ viewId: "v-external", dx: 410 }]);
    expect(prepared.mode).toBe("snap");
    expect(commit).not.toHaveBeenCalled();

    x = 210;
    let settled = false;
    const committing = prepared.commit().then(() => { settled = true; });
    await Promise.resolve();
    expect(commit).toHaveBeenCalledWith({ x: 210, y: 112, w: 212, h: 458 });
    expect(settled).toBe(false);
    releaseAck();
    await committing;
    expect(settled).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("폐기된 외부 표면 거래는 cancel로 잠금을 해제한다", async () => {
    const frame = document.createElement("div");
    frame.dataset.node = "layout/tab/v-external";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "engine-v-external");
    slot.getBoundingClientRect = () => ({
      x: 620, y: 112, left: 620, top: 112, right: 832, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);
    const cancel = vi.fn();
    slot.addEventListener("soksak:external-surface-layout-transition", ((event: CustomEvent) => {
      event.detail.claim({ commit: async () => {}, cancel });
    }) as EventListener);

    const { prepareNativeContentViewMove } = await load();
    const prepared = await prepareNativeContentViewMove([{ viewId: "v-external", dx: 410 }]);
    prepared.cancel();
    prepared.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("연속 여정의 목표는 stale native frame이 아니라 현재 DOM 슬롯에서 계산한다", async () => {
    let x = 620;
    const frame = document.createElement("div");
    frame.dataset.node = "layout/tab/v1";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "browser--v1");
    slot.getBoundingClientRect = () => ({
      x, y: 112, left: x, top: 112, right: x + 212, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    const { nativeHost, prepareNativeContentViewMove } = await load();
    await nativeHost.open("browser--v1", { url: "https://x" });
    // 직전 여정이 남긴 native 장부는 DOM 출발점과 다르다. 다음 목표는 이 값에 기대면 안 된다.
    await nativeHost.bounds("browser--v1", 800, 112, 212, 458);
    invoke.mockClear();

    const prepared = await prepareNativeContentViewMove([{ viewId: "v1", dx: 410 }]);
    x = 210;
    await prepared.commit();
    expect(invoke).toHaveBeenCalledWith("webview_bounds", {
      label: "browser--v1", x: 210, y: 112, w: 212, h: 458,
    });
  });

  it("DOM 재배치 mutation 뒤 공개 슬롯의 최종 위치로 native bounds를 대조한다", async () => {
    let x = 620;
    const frame = document.createElement("div");
    frame.className = "tab-body";
    frame.dataset.node = "layout/tab/v1";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "browser--v1");
    slot.getBoundingClientRect = () => ({
      x, y: 112, left: x, top: 112, right: x + 212, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    const { installNativeContentViewComposition, nativeHost } = await load();
    installNativeContentViewComposition();
    await nativeHost.open("browser--v1", { url: "https://x" });
    invoke.mockClear();

    x = 210;
    frame.classList.add("layout-committed");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("webview_bounds", {
      label: "browser--v1", x: 210, y: 112, w: 212, h: 458,
    }));
  });

  it("precommit 표면은 목표 DOM이 도착할 때까지 중간 mutation을 native에 쓰지 않는다", async () => {
    let x = 620;
    const frame = document.createElement("div");
    frame.className = "tab-body";
    frame.dataset.node = "layout/tab/v1";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "browser--v1");
    slot.getBoundingClientRect = () => ({
      x, y: 112, left: x, top: 112, right: x + 212, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    const {
      installNativeContentViewComposition,
      nativeContentViewCompositionStatus,
      nativeHost,
      prepareNativeContentViewMove,
    } = await load();
    installNativeContentViewComposition();
    await nativeHost.open("browser--v1", { url: "https://x" });
    const prepared = await prepareNativeContentViewMove([{ viewId: "v1", dx: 410 }]);
    invoke.mockClear();

    // 커밋 전 중간 좌표는 잠금이 막는다.
    x = 500;
    frame.classList.add("layout-midpoint");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalled();

    // pane 이동량 밖에서 sidebar flow도 함께 바뀐다. 예측치(620-410=210)가 아니라
    // 커밋된 공개 슬롯의 실제 rect가 최종 좌표의 단일 진실이다.
    x = 50;
    await prepared.commit();
    expect(invoke).toHaveBeenCalledWith("webview_bounds", expect.objectContaining({
      label: "browser--v1", x: 50,
    }));
    invoke.mockClear();
    expect(nativeContentViewCompositionStatus()[0].precommitPending).toBe(false);

    x = 220;
    frame.classList.add("layout-after-finished");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("webview_bounds", {
      label: "browser--v1", x: 220, y: 112, w: 212, h: 458,
    }));
  });

  it("커밋 rect가 사건 경로에서 이미 적용됐으면 같은 bounds를 다시 쓰지 않는다", async () => {
    let x = 620;
    const frame = document.createElement("div");
    frame.dataset.node = "layout/tab/v1";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "browser--v1");
    slot.getBoundingClientRect = () => ({
      x, y: 112, left: x, top: 112, right: x + 212, bottom: 570, width: 212, height: 458,
    }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    const { nativeHost, prepareNativeContentViewMove } = await load();
    await nativeHost.open("browser--v1", { url: "https://x" });
    const prepared = await prepareNativeContentViewMove([{ viewId: "v1", dx: 410 }]);
    x = 50;
    invoke.mockClear();
    await nativeHost.bounds("browser--v1", 50, 112, 212, 458);
    await prepared.commit();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "webview_bounds")).toHaveLength(1);
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
