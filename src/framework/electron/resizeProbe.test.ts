import { describe, expect, it, vi } from "vitest";
import {
  createElectronResizeProbe,
  type ElectronNativeResizeReceipt,
} from "./resizeProbe";

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x, y, width, height, left: x, top: y, right: x + width, bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function nativeReceipt({
  changed = true,
  scaleFactor = 2,
  outer = { x: 0, y: 0, width: 600, height: 400 },
  content = { x: 0, y: 28, width: 600, height: 372 },
} = {}): ElectronNativeResizeReceipt {
  const display = {
    id: 1,
    scaleFactor,
    boundsDip: { x: 0, y: 0, width: 2_000, height: 1_200 },
  };
  return {
    framework: "electron",
    label: "w-a",
    transaction: 7,
    status: "settled",
    changed,
    requested: {
      dip: { width: outer.width, height: outer.height },
      physical: {
        width: Math.round(outer.width * scaleFactor),
        height: Math.round(outer.height * scaleFactor),
      },
      display,
    },
    native: {
      resizeRevision: 4,
      display: { pre: display, post: display },
      outerDip: outer,
      outerPhysicalSpace: "display-local-physical",
      outerPhysicalMethod: "display-local-edge-rounding",
      outerPhysical: {
        x: Math.round(outer.x * scaleFactor),
        y: Math.round(outer.y * scaleFactor),
        width: Math.round((outer.x + outer.width) * scaleFactor) - Math.round(outer.x * scaleFactor),
        height: Math.round((outer.y + outer.height) * scaleFactor) - Math.round(outer.y * scaleFactor),
      },
      contentDip: content,
      contentPhysicalSpace: "display-local-physical",
      contentPhysicalMethod: "display-local-edge-rounding",
      contentPhysical: {
        x: Math.round(content.x * scaleFactor),
        y: Math.round(content.y * scaleFactor),
        width: Math.round((content.x + content.width) * scaleFactor) - Math.round(content.x * scaleFactor),
        height: Math.round((content.y + content.height) * scaleFactor) - Math.round(content.y * scaleFactor),
      },
    },
    renderer: {
      webContentsId: 1,
      presentationRevision: 9,
      proof: {
        transactionGeneration: 7,
        subscriptionGeneration: 2,
        sequence: 4,
        frameSize: {
          width: Math.round(content.width * scaleFactor),
          height: Math.round(content.height * scaleFactor),
        },
        dirtyRect: {
          x: 0,
          y: 0,
          width: Math.round(content.width * scaleFactor),
          height: Math.round(content.height * scaleFactor),
        },
        expectedDip: { width: content.width, height: content.height },
        expectedPhysical: {
          width: Math.round(content.width * scaleFactor),
          height: Math.round(content.height * scaleFactor),
        },
        devicePixelRatio: scaleFactor,
      },
    },
    surfaces: [{
      webContentsId: 17,
      presentationRevision: 8,
      proof: {
        transactionGeneration: 7,
        subscriptionGeneration: 3,
        sequence: 2,
        frameSize: { width: 1_000, height: 520 },
        dirtyRect: { x: 0, y: 0, width: 1_000, height: 520 },
        expectedDip: { width: 500, height: 260 },
        expectedPhysical: { width: 1_000, height: 520 },
        devicePixelRatio: 2,
      },
    }],
    settledRevision: 6,
  };
}

function exposeSurface(value: DOMRect, guest = { width: value.width, height: value.height }) {
  document.body.innerHTML = '<div data-content-view-body="b-1"><webview data-content-view="b-1"></webview></div>';
  const slot = document.querySelector<HTMLElement>("[data-content-view-body]")!;
  const surface = document.querySelector<HTMLElement>("[data-content-view]")!;
  slot.getBoundingClientRect = () => value;
  surface.getBoundingClientRect = () => value;
  const executeJavaScript = vi.fn(async () => ({
    innerWidth: guest.width,
    innerHeight: guest.height,
    clientWidth: guest.width,
    clientHeight: guest.height,
    devicePixelRatio: 2,
  }));
  Object.assign(surface, { getWebContentsId: () => 17, executeJavaScript });
  return { slot, surface, executeJavaScript };
}

function fakeRendererWindow(width = 600, height = 372, dpr = 2) {
  const listeners = new Map<string, Set<EventListener>>();
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  class FakeResizeObserver {
    callback: ResizeObserverCallback;
    targets = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    visualViewport: { width, height, scale: 1 },
    ResizeObserver: FakeResizeObserver,
    addEventListener(name: string, listener: EventListener) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener);
    },
    removeEventListener(name: string, listener: EventListener) {
      listeners.get(name)?.delete(listener);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    cancelAnimationFrame: vi.fn(),
    requestAnimationFrame: vi.fn(() => { throw new Error("fixed rAF settle을 사용하면 안 된다"); }),
  } as unknown as Window;
  Object.defineProperties(document.documentElement, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  return {
    win,
    emitResize() {
      for (const listener of listeners.get("resize") ?? []) listener(new Event("resize"));
    },
    emitObservedRoot(observedWidth = width, observedHeight = height) {
      for (const observer of observers) {
        if (!observer.targets.has(document.documentElement)) continue;
        observer.callback(
          [{
            target: document.documentElement,
            contentRect: rect(0, 0, observedWidth, observedHeight),
          } as unknown as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        );
      }
    },
  };
}

describe("Electron resize public probe", () => {
  it("ResizeObserver 세대와 실제 renderer/slot/surface/guest 기하를 같은 settlement로 공개한다", async () => {
    const { executeJavaScript } = exposeSurface(rect(20, 80, 500, 260));
    const renderer = fakeRendererWindow();
    const probe = createElectronResizeProbe(renderer.win, document, { timeoutMs: 1_000 });
    const setNative = vi.fn(async (args: unknown) => {
      expect(args).toEqual({ width: 1_200, height: 800, surfaceIds: [17] });
      renderer.emitResize();
      renderer.emitObservedRoot();
      return nativeReceipt();
    });

    await probe.setPhysicalSize(1_200, 800, setNative);
    const fact = await probe.sample();

    expect(fact).toMatchObject({
      framework: "electron",
      transaction: 7,
      settled: true,
      layout: { eventRevision: 1, observerRevision: 1, settledRevision: 1 },
      rendererViewport: {
        innerWidth: 600,
        innerHeight: 372,
        clientWidth: 600,
        clientHeight: 372,
        devicePixelRatio: 2,
      },
      surfaces: [{
        label: "b-1",
        webContentsId: 17,
        connected: true,
        visible: true,
        slotRect: { x: 20, y: 80, width: 500, height: 260 },
        surfaceRect: { x: 20, y: 80, width: 500, height: 260 },
        physicalCoordinateSpace: "content-local-physical",
        guestViewport: { innerWidth: 500, innerHeight: 260 },
        presentationRevision: 8,
      }],
      violations: [],
    });
    expect(executeJavaScript).toHaveBeenCalled();
    expect(renderer.win.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("이전 root 크기의 ResizeObserver callback은 새 세대를 settle하지 않는다", async () => {
    vi.useFakeTimers();
    exposeSurface(rect(20, 80, 500, 260));
    const renderer = fakeRendererWindow();
    const probe = createElectronResizeProbe(renderer.win, document, { timeoutMs: 50 });
    const pending = probe.setPhysicalSize(1_200, 800, vi.fn(async () => {
      renderer.emitResize();
      renderer.emitObservedRoot(800, 572);
      return nativeReceipt();
    }));
    const rejected = expect(pending).rejects.toMatchObject({
      code: "ELECTRON_RESIZE_SETTLEMENT_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(51);
    await rejected;
  });

  it("native changed인데 renderer resize 사건이 없으면 요청 echo로 통과시키지 않는다", async () => {
    vi.useFakeTimers();
    exposeSurface(rect(20, 80, 500, 260));
    const renderer = fakeRendererWindow();
    const probe = createElectronResizeProbe(renderer.win, document, { timeoutMs: 50 });
    const pending = probe.setPhysicalSize(1_200, 800, vi.fn(async () => {
      renderer.emitObservedRoot();
      return nativeReceipt();
    }));
    const rejected = expect(pending).rejects.toMatchObject({
      code: "ELECTRON_RESIZE_SETTLEMENT_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
  });

  it("slot과 surface가 1px라도 다르면 실제 native proof가 있어도 이름 있는 실패다", async () => {
    const { slot } = exposeSurface(rect(20, 80, 500, 260));
    slot.getBoundingClientRect = () => rect(20, 80, 499, 260);
    const renderer = fakeRendererWindow();
    const probe = createElectronResizeProbe(renderer.win, document, { timeoutMs: 1_000 });
    const pending = probe.setPhysicalSize(1_200, 800, vi.fn(async () => {
      renderer.emitResize();
      renderer.emitObservedRoot();
      return nativeReceipt();
    }));

    await expect(pending).rejects.toMatchObject({ code: "ELECTRON_RESIZE_GEOMETRY_MISMATCH" });
  });

  it("분수 DOM 원점과 비정수 배율은 content-local 양쪽 물리 모서리로 계산한다", async () => {
    exposeSurface(rect(0.48, 0.48, 502, 402));
    const renderer = fakeRendererWindow(502, 402, 1.25);
    const receipt = nativeReceipt({
      changed: false,
      scaleFactor: 1.25,
      outer: { x: 0, y: 0, width: 502, height: 430 },
      content: { x: 0, y: 28, width: 502, height: 402 },
    });
    receipt.surfaces[0].proof = {
      ...receipt.surfaces[0].proof,
      frameSize: { width: 628, height: 503 },
      dirtyRect: { x: 0, y: 0, width: 628, height: 503 },
      expectedDip: { width: 502, height: 402 },
      expectedPhysical: { width: 628, height: 503 },
      devicePixelRatio: 1.25,
    };
    const probe = createElectronResizeProbe(renderer.win, document, { timeoutMs: 1_000 });

    await probe.setPhysicalSize(628, 538, vi.fn(async () => receipt));
    const fact = await probe.sample() as {
      surfaces: Array<{ slotPhysicalRect: unknown; surfacePhysicalRect: unknown }>;
    };
    expect(fact.surfaces[0]).toMatchObject({
      slotPhysicalRect: { x: 1, y: 1, width: 627, height: 502 },
      surfacePhysicalRect: { x: 1, y: 1, width: 627, height: 502 },
    });
  });
});
