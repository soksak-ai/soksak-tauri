// @vitest-environment node
// Electron B10 — resize는 요청 echo가 아니라 native 사건과 실제 presentation 기하의 거래다.
// 픽셀 내용은 판정하지 않는다. NativeImage 크기·dirtyRect·post-resize 실제 기하만 사용한다.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const { createResizeSettlementLedger } = require_(
  "../../frameworks/electron/resizeSettlement.cjs",
);
const { createFrameSubscriptionBroker } = require_(
  "../../frameworks/electron/frameSubscriptionBroker.cjs",
);
const { createDisplayGeometry } = require_("../../frameworks/electron/displayGeometry.cjs");

function frame(width, height) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
  };
}

class FakeContents extends EventEmitter {
  constructor(id, viewport = { width: 300, height: 200 }) {
    super();
    this.id = id;
    this.viewport = viewport;
    this.pixelRatio = 1;
    this.subscription = null;
    this.beginCount = 0;
    this.ended = 0;
    this.invalidated = 0;
  }

  beginFrameSubscription(_onlyDirty, callback) {
    if (this.subscription) throw new Error(`duplicate frame subscription: ${this.id}`);
    this.beginCount += 1;
    this.subscription = callback;
  }

  endFrameSubscription() {
    this.subscription = null;
    this.ended += 1;
  }

  present({ width, height, dirtyRect } = {}) {
    const expected = typeof this.viewport === "function" ? this.viewport() : this.viewport;
    const actualWidth = width ?? Math.round(expected.width * this.pixelRatio);
    const actualHeight = height ?? Math.round(expected.height * this.pixelRatio);
    this.subscription?.(
      frame(actualWidth, actualHeight),
      dirtyRect ?? { x: 0, y: 0, width: actualWidth, height: actualHeight },
    );
  }

  invalidate() {
    this.invalidated += 1;
  }

  async executeJavaScript() {
    const value = typeof this.viewport === "function" ? this.viewport() : this.viewport;
    return {
      innerWidth: value.width,
      innerHeight: value.height,
      clientWidth: value.width,
      clientHeight: value.height,
      devicePixelRatio: this.pixelRatio,
    };
  }

  isDestroyed() {
    return false;
  }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.bounds = { x: 10, y: 20, width: 800, height: 600 };
    this.contentBounds = { x: 10, y: 48, width: 800, height: 572 };
    this.webContents = new FakeContents(1, () => ({
      width: this.contentBounds.width,
      height: this.contentBounds.height,
    }));
  }

  getBounds() {
    return { ...this.bounds };
  }

  getContentBounds() {
    return { ...this.contentBounds };
  }

  setSize(width, height) {
    this.bounds.width = width;
    this.bounds.height = height;
    this.contentBounds.width = width;
    this.contentBounds.height = height - 28;
    this.emit("resize");
  }

  isDestroyed() {
    return false;
  }
}

function fixedScreen(scaleFactor = 1, id = 1) {
  const display = {
    id,
    scaleFactor,
    bounds: { x: 0, y: 0, width: 4_000, height: 3_000 },
  };
  return { getDisplayMatching: () => display };
}

function harness({ timeoutMs = 1_000, screen = fixedScreen(), platform = "darwin", broker } = {}) {
  const frameSubscriptions = broker ?? createFrameSubscriptionBroker();
  const displayGeometry = createDisplayGeometry({ screen, platform });
  return {
    frameSubscriptions,
    ledger: createResizeSettlementLedger({ timeoutMs, frameSubscriptions, displayGeometry }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Electron native resize settlement", () => {
  it("실제 resize와 모든 기하 일치 presentation 뒤에만 영수증을 확정한다", async () => {
    const { ledger } = harness({ screen: fixedScreen(2) });
    const win = new FakeWindow();
    const guest = new FakeContents(17);
    win.webContents.pixelRatio = 2;
    guest.pixelRatio = 2;
    let resolved = false;

    const receiptPromise = ledger.resize({
      label: "w-a",
      win,
      requestedPhysical: { width: 1_000, height: 700 },
      surfaces: [guest],
    }).then((receipt) => {
      resolved = true;
      return receipt;
    });

    await Promise.resolve();
    expect(resolved, "setSize/resize 사건만으로 합성이 끝난 척하면 안 된다").toBe(false);
    win.webContents.present();
    await Promise.resolve();
    expect(resolved, "guest presentation을 빼먹으면 안 된다").toBe(false);
    guest.present();

    const receipt = await receiptPromise;
    expect(receipt).toMatchObject({
      framework: "electron",
      label: "w-a",
      transaction: 1,
      status: "settled",
      changed: true,
      requested: {
        dip: { width: 500, height: 350 },
        physical: { width: 1_000, height: 700 },
        display: { id: 1, scaleFactor: 2 },
      },
      native: {
        resizeRevision: 1,
        display: {
          pre: { id: 1, scaleFactor: 2 },
          post: { id: 1, scaleFactor: 2 },
        },
        outerDip: { x: 10, y: 20, width: 500, height: 350 },
        outerPhysicalSpace: "display-local-physical",
        outerPhysical: { x: 20, y: 40, width: 1_000, height: 700 },
        contentDip: { x: 10, y: 48, width: 500, height: 322 },
        contentPhysical: { x: 20, y: 96, width: 1_000, height: 644 },
      },
      renderer: {
        webContentsId: 1,
        presentationRevision: 1,
        proof: {
          transactionGeneration: 1,
          frameSize: { width: 1_000, height: 644 },
          expectedDip: { width: 500, height: 322 },
          expectedPhysical: { width: 1_000, height: 644 },
        },
      },
      surfaces: [{
        webContentsId: 17,
        presentationRevision: 1,
        proof: {
          transactionGeneration: 1,
          frameSize: { width: 600, height: 400 },
          expectedDip: { width: 300, height: 200 },
          expectedPhysical: { width: 600, height: 400 },
        },
      }],
      settledRevision: 1,
    });
    expect(win.webContents.ended).toBe(1);
    expect(guest.ended).toBe(1);
  });

  it("크기나 dirtyRect가 실제 post-resize 기하와 다른 callback은 세대 proof가 아니다", async () => {
    const { ledger } = harness();
    const win = new FakeWindow();
    let resolved = false;
    const pending = ledger.resize({
      label: "w-frame-proof",
      win,
      requestedPhysical: { width: 500, height: 350 },
      surfaces: [],
    }).then((receipt) => {
      resolved = true;
      return receipt;
    });

    win.webContents.present({ width: 800, height: 572 });
    await Promise.resolve();
    expect(resolved, "이전 크기의 늦은 frame은 새 거래를 증명하지 못한다").toBe(false);
    win.webContents.present({
      width: 500,
      height: 322,
      dirtyRect: { x: 499, y: 321, width: 2, height: 2 },
    });
    await Promise.resolve();
    expect(resolved, "frame 밖 dirtyRect는 presentation proof가 아니다").toBe(false);
    win.webContents.present();

    expect((await pending).renderer.proof).toMatchObject({
      frameSize: { width: 500, height: 322 },
      dirtyRect: { x: 0, y: 0, width: 500, height: 322 },
    });
  });

  it("broker의 기존 lease와 settlement가 native 구독 하나를 공유한다", async () => {
    const broker = createFrameSubscriptionBroker();
    const { ledger } = harness({ broker });
    const win = new FakeWindow();
    const otherConsumer = vi.fn();
    const externalLease = broker.acquire(win.webContents, otherConsumer);

    const pending = ledger.resize({
      label: "w-shared-subscription",
      win,
      requestedPhysical: { width: 500, height: 350 },
      surfaces: [],
    });
    expect(win.webContents.beginCount).toBe(1);
    win.webContents.present();
    await pending;

    expect(otherConsumer).toHaveBeenCalledOnce();
    expect(win.webContents.ended, "settlement lease가 기존 소비자의 구독을 끊으면 안 된다").toBe(0);
    externalLease.release();
    expect(win.webContents.ended).toBe(1);
  });

  it("최초 no-op도 invalidate 뒤 실제 presentation proof 없이는 green이 아니다", async () => {
    const { ledger } = harness();
    const win = new FakeWindow();
    let resolved = false;
    const pending = ledger.resize({
      label: "w-same",
      win,
      requestedPhysical: { width: 800, height: 600 },
      surfaces: [],
    }).then((receipt) => {
      resolved = true;
      return receipt;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(win.webContents.invalidated).toBe(1);
    win.webContents.present();
    const receipt = await pending;
    expect(receipt.changed).toBe(false);
    expect(receipt.renderer.presentationRevision).toBeGreaterThan(0);
    expect(receipt.renderer.proof.transactionGeneration).toBe(1);
  });

  it("no-op에 새 guest가 합류하면 이전 host proof를 재사용하지 않고 둘 다 다시 증명한다", async () => {
    const { ledger } = harness();
    const win = new FakeWindow();
    const first = ledger.resize({
      label: "w-new-guest",
      win,
      requestedPhysical: { width: 800, height: 600 },
      surfaces: [],
    });
    win.webContents.present();
    await first;

    const guest = new FakeContents(17);
    let resolved = false;
    const second = ledger.resize({
      label: "w-new-guest",
      win,
      requestedPhysical: { width: 800, height: 600 },
      surfaces: [guest],
    }).then((receipt) => {
      resolved = true;
      return receipt;
    });
    win.webContents.present();
    await Promise.resolve();
    expect(resolved).toBe(false);
    guest.present();

    const receipt = await second;
    expect(receipt.renderer.presentationRevision).toBe(2);
    expect(receipt.surfaces[0].presentationRevision).toBe(1);
  });

  it("동시에 온 적대 resize를 유한 직렬 큐로 모두 보존한다", async () => {
    const { ledger } = harness();
    const win = new FakeWindow();
    const first = ledger.resize({
      label: "w-queue",
      win,
      requestedPhysical: { width: 500, height: 350 },
      surfaces: [],
    });
    const second = ledger.resize({
      label: "w-queue",
      win,
      requestedPhysical: { width: 900, height: 700 },
      surfaces: [],
    });

    expect(win.bounds).toMatchObject({ width: 500, height: 350 });
    win.webContents.present();
    const firstReceipt = await first;
    await Promise.resolve();
    expect(win.bounds).toMatchObject({ width: 900, height: 700 });
    win.webContents.present();
    const secondReceipt = await second;

    expect([firstReceipt.transaction, secondReceipt.transaction]).toEqual([1, 2]);
    expect([firstReceipt.native.resizeRevision, secondReceipt.native.resizeRevision]).toEqual([1, 2]);
    expect([firstReceipt.native.outerDip.width, secondReceipt.native.outerDip.width]).toEqual([500, 900]);
  });

  it("거래 밖 수동 resize는 transaction을 지어내지 않고 native revision으로 노출한다", async () => {
    const { ledger } = harness();
    const win = new FakeWindow();
    ledger.register("w-manual", win);
    win.bounds.width = 810;
    win.contentBounds.width = 810;
    win.emit("resize");

    expect(ledger.observation("w-manual", win)).toMatchObject({
      resizeRevision: 1,
      pendingTransaction: null,
      lastResize: { revision: 1, source: "external", outerDip: { width: 810 } },
    });

    const pending = ledger.resize({
      label: "w-manual",
      win,
      requestedPhysical: { width: 900, height: 700 },
      surfaces: [],
    });
    win.webContents.present();
    expect((await pending).native.resizeRevision).toBe(2);
  });

  it("mixed-DPI 이동은 요청 전 display와 착지 후 display를 갈라 공개한다", async () => {
    const displays = [
      { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 2_000, height: 1_200 } },
      { id: 2, scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 2_000, height: 1_200 } },
    ];
    const screen = { getDisplayMatching: (bounds) => displays[bounds.width < 1_000 ? 0 : 1] };
    const { ledger } = harness({ screen });
    const win = new FakeWindow();
    win.webContents.pixelRatio = 1.5;
    const pending = ledger.resize({
      label: "w-mixed-dpi",
      win,
      requestedPhysical: { width: 1_200, height: 900 },
      surfaces: [],
    });
    win.webContents.present();
    const receipt = await pending;

    expect(receipt.requested).toMatchObject({
      dip: { width: 1_200, height: 900 },
      display: { id: 1, scaleFactor: 1 },
    });
    expect(receipt.native.display).toEqual({
      pre: { id: 1, scaleFactor: 1, boundsDip: displays[0].bounds },
      post: { id: 2, scaleFactor: 1.5, boundsDip: displays[1].bounds },
    });
    expect(receipt.native.outerPhysical).toMatchObject({ width: 1_800, height: 1_350 });
  });

  it("presentation이 오지 않으면 echo 성공 대신 유한한 이름 있는 실패를 낸다", async () => {
    vi.useFakeTimers();
    const { ledger } = harness({ timeoutMs: 50 });
    const win = new FakeWindow();
    const pending = ledger.resize({
      label: "w-timeout",
      win,
      requestedPhysical: { width: 900, height: 700 },
      surfaces: [],
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "RESIZE_SETTLEMENT_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(win.webContents.ended).toBe(1);
  });

  it("분수 원점과 비정수 배율은 양쪽 물리 모서리로 크기를 계산한다", async () => {
    const { ledger } = harness({ screen: fixedScreen(1.25) });
    const win = new FakeWindow();
    win.webContents.pixelRatio = 1.25;
    win.bounds.x = 0.48;
    win.bounds.y = 0.48;
    win.contentBounds.x = 0.48;
    win.contentBounds.y = 28.48;

    const pending = ledger.resize({
      label: "w-fractional",
      win,
      requestedPhysical: { width: 628, height: 503 },
      surfaces: [],
    });
    win.webContents.present();
    const receipt = await pending;

    expect(receipt.native.outerPhysical).toEqual({ x: 1, y: 1, width: 627, height: 502 });
    expect(receipt.native.contentPhysical).toEqual({ x: 1, y: 36, width: 627, height: 467 });
  });
});
