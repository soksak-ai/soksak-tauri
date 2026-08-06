// @vitest-environment node
// Electron WebContents는 frame subscription handle을 주지 않는다. 어댑터의 모든 소비자는
// 한 broker lease를 공유해야 하며, 한 소비자의 해제가 다른 소비자의 관측을 끊으면 안 된다.
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const { createFrameSubscriptionBroker } = require_(
  "../../frameworks/electron/frameSubscriptionBroker.cjs",
);

function fakeContents(id = 1) {
  const callbacks = [];
  return {
    id,
    callbacks,
    beginCount: 0,
    endCount: 0,
    beginFrameSubscription(onlyDirty, callback) {
      this.beginCount += 1;
      this.onlyDirty = onlyDirty;
      this.callback = callback;
      callbacks.push(callback);
    },
    endFrameSubscription() {
      this.endCount += 1;
      this.callback = null;
    },
    present(image = {}, dirtyRect = { x: 0, y: 0, width: 1, height: 1 }) {
      this.callback?.(image, dirtyRect);
    },
    isDestroyed: () => false,
  };
}

describe("Electron frame subscription broker", () => {
  it("WebContents 하나에는 native 구독 하나만 두고 lease들에 fan-out한다", () => {
    const broker = createFrameSubscriptionBroker();
    const contents = fakeContents(17);
    const first = vi.fn();
    const second = vi.fn();

    const leaseA = broker.acquire(contents, first);
    const leaseB = broker.acquire(contents, second);
    expect(contents.beginCount).toBe(1);
    expect(contents.onlyDirty).toBe(false);

    contents.present({ frame: 1 }, { x: 2, y: 3, width: 4, height: 5 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first.mock.calls[0][0]).toMatchObject({
      subscriptionGeneration: 1,
      sequence: 1,
      dirtyRect: { x: 2, y: 3, width: 4, height: 5 },
    });

    leaseA.release();
    expect(contents.endCount, "다른 lease가 살아 있는데 native 구독을 끝내면 안 된다").toBe(0);
    contents.present({ frame: 2 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);

    leaseB.release();
    leaseB.release();
    expect(contents.endCount, "마지막 lease 해제만 정확히 한 번 끝낸다").toBe(1);
  });

  it("재구독 세대를 올리고 끝난 세대의 늦은 callback을 새 lease로 보내지 않는다", () => {
    const broker = createFrameSubscriptionBroker();
    const contents = fakeContents(23);
    const oldSink = vi.fn();
    const nextSink = vi.fn();

    const oldLease = broker.acquire(contents, oldSink);
    const oldNativeCallback = contents.callbacks[0];
    oldLease.release();
    const nextLease = broker.acquire(contents, nextSink);

    oldNativeCallback({ stale: true }, { x: 0, y: 0, width: 1, height: 1 });
    expect(oldSink).not.toHaveBeenCalled();
    expect(nextSink).not.toHaveBeenCalled();

    contents.present({ fresh: true });
    expect(nextSink.mock.calls[0][0]).toMatchObject({
      subscriptionGeneration: 2,
      sequence: 1,
    });
    nextLease.release();
    expect(contents.beginCount).toBe(2);
    expect(contents.endCount).toBe(2);
  });
});
