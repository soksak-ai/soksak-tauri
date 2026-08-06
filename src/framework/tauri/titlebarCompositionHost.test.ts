import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTitlebarCompositionHostForTest,
  composeTitlebarComposition,
  currentTitlebarComposition,
  inspectTitlebarComposition,
  installTitlebarCompositionHost,
  readTitlebarComposition,
  syncTitlebarReservationSlots,
  TAURI_TITLEBAR_RESERVATION_NODE_PREFIX,
  TITLEBAR_NODE_ADDRESS,
  TITLEBAR_COMPOSITION_EVENT,
  type NativeTitlebarState,
} from "./titlebarCompositionHost";

const physicalButtons = [
  { role: "close", rect: { x: 24, y: 29, w: 28, h: 32 } },
  { role: "minimize", rect: { x: 64, y: 29, w: 28, h: 32 } },
  { role: "zoom", rect: { x: 104, y: 29, w: 28, h: 32 } },
] as const;

const nativeState = (sequence = 7): NativeTitlebarState => ({
  schemaVersion: 3,
  kind: "tauri-titlebar-native-state",
  window: "w-test",
  sequence,
  coordinateContract: "physical px, viewport top-left",
  cssToPhysicalScale: 2,
  viewportPhysical: { w: 1_600, h: 1_200 },
  buttons: physicalButtons,
  declaredButtons: physicalButtons,
  backings: physicalButtons.map((button) => ({
    ...button,
    hidden: true,
    expectedHidden: true,
    paintedByOwner: true,
    ownerBelowButtons: true,
    hiddenMatchesWindowKey: true,
  })),
  windowKey: true,
  backingHiddenContract: true,
  owner: {
    installed: true,
    identity: "0x1234",
    drawOwnerCount: 1,
    targetSequence: sequence,
    appliedTargetSequence: sequence,
    drawSequence: 10,
    mutationSequence: 3,
    applying: false,
    lastApplyOk: true,
    lastApplyError: null,
    windowVisible: true,
  },
});

function titlebar(): HTMLElement {
  const element = document.createElement("header");
  element.className = "arbitrary-shell-header";
  element.dataset.node = TITLEBAR_NODE_ADDRESS;
  document.body.appendChild(element);
  return element;
}

function reservations(root: ParentNode = document): Element[] {
  return Array.from(root.querySelectorAll(
    `[data-node^="${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}"]`,
  ));
}

function rectOf(element: Element): DOMRect {
  if (element.getAttribute("data-node") === TITLEBAR_NODE_ADDRESS) {
    return DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 45 });
  }
  const node = element as HTMLElement;
  return DOMRect.fromRect({
    x: Number.parseFloat(node.style.left),
    y: Number.parseFloat(node.style.top),
    width: Number.parseFloat(node.style.width),
    height: Number.parseFloat(node.style.height),
  });
}

describe("Tauri titlebar composition host", () => {
  beforeEach(() => {
    __resetTitlebarCompositionHostForTest();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("consumes the public titlebar address instead of a framework-private CSS class", () => {
    const privateClassOnly = document.createElement("header");
    privateClassOnly.className = "titlebar";
    document.body.appendChild(privateClassOnly);

    expect(syncTitlebarReservationSlots(document, nativeState())).toEqual([]);
    expect(reservations()).toHaveLength(0);
  });

  it("projects three role-addressed AppKit rects to three transparent DOM reservation slots", () => {
    const bar = titlebar();
    const slots = syncTitlebarReservationSlots(document, nativeState());

    expect(slots.map((slot) => slot.getAttribute("data-node"))).toEqual([
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}close`,
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}minimize`,
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}zoom`,
    ]);
    expect(reservations(bar)).toHaveLength(3);
    expect(slots[0]?.style.cssText).toContain("left: 12px");
    expect(slots[0]?.style.cssText).toContain("top: 14.5px");
    expect(slots[0]?.style.pointerEvents).toBe("none");
    expect(slots[0]?.style.background).toBe("");
  });

  it("publishes the DOM slots and AppKit rects in one physical coordinate system", () => {
    titlebar();
    syncTitlebarReservationSlots(document, nativeState());
    const status = readTitlebarComposition(document, nativeState(), rectOf);

    expect(status.verdict).toBe("green");
    expect(status.kind).toBe("tauri-titlebar-composition");
    expect(status.coordinateContract.shared).toBe("physical px, viewport top-left");
    expect(status.reservations).toEqual(physicalButtons);
    expect(status.buttons).toEqual(physicalButtons);
    expect(status.checks).toMatchObject({ count: true, oneToOne: true, verticalCenter: true });
  });

  it("installs only when the macOS native state command exists and emits every committed status", async () => {
    titlebar();
    const publish = vi.fn();
    const readNative = vi.fn(async () => nativeState());
    const composeNative = vi.fn(async () => nativeState(8));
    const installed = await installTitlebarCompositionHost({
      document,
      readNative,
      composeNative,
      rectOf,
      publish,
      observeDom: false,
      observeWindow: false,
    });

    expect(installed).toBe(true);
    expect(readNative).toHaveBeenCalledTimes(1);
    expect(composeNative).toHaveBeenCalledWith({
      titlebarPhysical: { x: 0, y: 0, w: 1_600, h: 90 },
      cssToPhysicalScale: 2,
      expectedOwnerIdentity: "0x1234",
      expectedSequence: 7,
    });
    expect(publish).toHaveBeenCalledWith(TITLEBAR_COMPOSITION_EVENT, expect.objectContaining({
      verdict: "green",
      nativeSequence: 8,
    }));
  });

  it.each([
    "Command titlebar_native_state not found",
    "Command titlebar_native_state is not supported",
  ])("leaves no command/status/DOM surface only for an explicit unavailable native command: %s", async (message) => {
    titlebar();
    const publish = vi.fn();
    const installed = await installTitlebarCompositionHost({
      document,
      // Tauri invoke rejects an unregistered command as a string, not an Error instance.
      readNative: async () => { throw message; },
      composeNative: async () => nativeState(8),
      rectOf,
      publish,
      observeDom: false,
      observeWindow: false,
    });

    expect(installed).toBe(false);
    expect(reservations()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    "titlebar_native_state main-thread ACK timed out",
    "IPC transport disconnected while reading titlebar_native_state",
    "titlebar native owner is temporarily unavailable",
  ])("fails closed instead of misclassifying a native read failure as unsupported: %s", async (message) => {
    titlebar();
    const failure = new Error(message);
    const publish = vi.fn();

    await expect(installTitlebarCompositionHost({
      document,
      readNative: async () => { throw failure; },
      composeNative: async () => nativeState(8),
      rectOf,
      publish,
    })).rejects.toBe(failure);

    expect(currentTitlebarComposition()).toBeNull();
    expect(reservations()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects malformed native facts instead of guessing geometry", async () => {
    titlebar();
    const malformed = { ...nativeState(), cssToPhysicalScale: 0 } as NativeTitlebarState;

    await expect(installTitlebarCompositionHost({
      document,
      readNative: async () => malformed,
      composeNative: async () => nativeState(8),
      observeDom: false,
      observeWindow: false,
    })).rejects.toThrow("invalid contract");
    expect(reservations()).toHaveLength(0);
  });

  it("removes duplicate and stale slots rather than accepting a non-3:3 ledger", () => {
    const bar = titlebar();
    for (const role of ["close", "close", "foreign"]) {
      const slot = document.createElement("span");
      slot.setAttribute("data-node", `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}${role}`);
      bar.appendChild(slot);
    }

    syncTitlebarReservationSlots(document, nativeState());

    expect(reservations(bar).map((slot) => slot.getAttribute("data-node"))).toEqual([
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}close`,
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}minimize`,
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}zoom`,
    ]);
  });

  it("normalizes retained reservation nodes to the declared traffic-light order", () => {
    const bar = titlebar();
    for (const role of ["zoom", "minimize", "close"] as const) {
      const reservation = document.createElement("span");
      reservation.setAttribute("data-node", `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}${role}`);
      bar.appendChild(reservation);
    }

    syncTitlebarReservationSlots(document, nativeState());

    expect(reservations(bar).map((slot) => slot.getAttribute("data-node"))).toEqual([
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}close`,
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}minimize`,
      `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}zoom`,
    ]);
  });

  it("reprojects on titlebar attachment events without polling unrelated DOM churn", async () => {
    const readNative = vi.fn(async () => nativeState());
    const composeNative = vi.fn(async () => nativeState(8));
    await installTitlebarCompositionHost({
      document,
      readNative,
      composeNative,
      rectOf,
      observeWindow: false,
    });
    expect(readNative).toHaveBeenCalledTimes(1);
    expect(composeNative).toHaveBeenCalledTimes(0);

    document.body.appendChild(document.createElement("div"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(readNative).toHaveBeenCalledTimes(1);

    titlebar();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(readNative.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(composeNative).toHaveBeenCalled();
    expect(reservations()).toHaveLength(3);
  });

  it("recomposes from the titlebar ResizeObserver signal instead of a settle loop", async () => {
    let notifyResize: ResizeObserverCallback = () => {
      throw new Error("ResizeObserver callback was not installed");
    };
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    titlebar();
    const readNative = vi.fn(async () => nativeState());
    let sequence = 7;
    const composeNative = vi.fn(async () => nativeState(++sequence));
    await installTitlebarCompositionHost({
      document,
      readNative,
      composeNative,
      rectOf,
      observeDom: false,
    });
    expect(readNative).toHaveBeenCalledTimes(1);
    expect(composeNative).toHaveBeenCalledTimes(1);

    notifyResize([], {} as ResizeObserver);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(readNative).toHaveBeenCalledTimes(2);
    expect(composeNative).toHaveBeenCalledTimes(2);
  });

  it("serializes explicit compose receipts so each mutation returns its own generation", async () => {
    titlebar();
    let sequence = 0;
    const readNative = vi.fn(async () => nativeState(sequence));
    const composeNative = vi.fn(async () => nativeState(++sequence));
    await installTitlebarCompositionHost({
      document,
      readNative,
      composeNative,
      rectOf,
      observeDom: false,
      observeWindow: false,
    });

    const [first, second] = await Promise.all([
      composeTitlebarComposition(),
      composeTitlebarComposition(),
    ]);

    expect([first.nativeSequence, second.nativeSequence]).toEqual([2, 3]);
  });

  it("rejects a compose receipt that skips the exact next native transaction", async () => {
    titlebar();
    await expect(installTitlebarCompositionHost({
      document,
      readNative: async () => nativeState(7),
      composeNative: async () => nativeState(9),
      rectOf,
      observeDom: false,
      observeWindow: false,
    })).rejects.toThrow("exactly one transaction");
    expect(reservations()).toHaveLength(0);
  });

  it("coalesces concurrent installation into one native read, compose, and observer set", async () => {
    const mutationObservers: Array<{
      observe: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const resizeObservers: Array<{
      observe: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    class FakeMutationObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => [] as MutationRecord[]);

      constructor(_callback: MutationCallback) {
        mutationObservers.push(this);
      }
    }
    class FakeResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();

      constructor(_callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const addWindowObserver = vi.spyOn(window, "addEventListener");
    titlebar();
    let releaseRead!: (state: NativeTitlebarState) => void;
    const readNative = vi.fn(() => new Promise<NativeTitlebarState>((resolve) => {
      releaseRead = resolve;
    }));
    const composeNative = vi.fn(async () => nativeState(8));
    const options = {
      document,
      readNative,
      composeNative,
      rectOf,
    };

    const first = installTitlebarCompositionHost(options);
    const second = installTitlebarCompositionHost(options);
    expect(readNative).toHaveBeenCalledTimes(1);
    releaseRead(nativeState(7));

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(readNative).toHaveBeenCalledTimes(1);
    expect(composeNative).toHaveBeenCalledTimes(1);
    expect(mutationObservers).toHaveLength(1);
    expect(mutationObservers[0]?.observe).toHaveBeenCalledTimes(1);
    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0]?.observe).toHaveBeenCalledTimes(1);
    expect(addWindowObserver.mock.calls.filter(([event]) => event === "resize")).toHaveLength(1);
    expect(addWindowObserver.mock.calls.filter(([event]) => event === "fullscreenchange")).toHaveLength(1);
  });

  it("rejects a deferred compose from a reset generation without stale status or DOM writes", async () => {
    titlebar();
    let committed = nativeState(7);
    let releaseCompose!: (state: NativeTitlebarState) => void;
    const readNative = vi.fn(async () => committed);
    const composeNative = vi.fn(async () => {
      if (composeNative.mock.calls.length === 1) {
        committed = nativeState(8);
        return committed;
      }
      return new Promise<NativeTitlebarState>((resolve) => {
        releaseCompose = resolve;
      });
    });
    const publish = vi.fn();
    await installTitlebarCompositionHost({
      document,
      readNative,
      composeNative,
      rectOf,
      publish,
      observeDom: false,
      observeWindow: false,
    });
    expect(currentTitlebarComposition()?.nativeSequence).toBe(8);
    publish.mockClear();

    const deferred = composeTitlebarComposition();
    await vi.waitFor(() => expect(composeNative).toHaveBeenCalledTimes(2));
    __resetTitlebarCompositionHostForTest();
    releaseCompose(nativeState(9));

    await expect(deferred).rejects.toThrow("generation changed during compose");
    expect(currentTitlebarComposition()).toBeNull();
    expect(reservations()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("inspects current evidence without composing or repairing missing DOM reservations", async () => {
    titlebar();
    const readNative = vi.fn(async () => nativeState(8));
    const composeNative = vi.fn(async () => nativeState(9));
    await installTitlebarCompositionHost({
      document,
      readNative,
      composeNative,
      rectOf,
      observeDom: false,
      observeWindow: false,
    });
    reservations()[0]?.remove();
    readNative.mockClear();
    composeNative.mockClear();

    const status = await inspectTitlebarComposition();

    expect(readNative).toHaveBeenCalledTimes(1);
    expect(composeNative).not.toHaveBeenCalled();
    expect(reservations()).toHaveLength(2);
    expect(status.verdict).toBe("red");
    expect(status.issues).toContain("reservation-count");
  });
});
