import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
  registerLayoutTransitionHost,
} from "./layoutTransitionHost";
import {
  __resetLayoutTransitionJournalForTest,
  layoutTransitionJournal,
  onLayoutTransitionJournal,
} from "./layoutTransitionJournal";

describe("layout transition public journal", () => {
  beforeEach(() => {
    __resetLayoutTransitionHostForTest();
    __resetLayoutTransitionJournalForTest();
  });

  it("DOM-only 거래도 id·move·prepare·commit을 공개한다", async () => {
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 320 }]);
    expect(layoutTransitionJournal()).toEqual([
      expect.objectContaining({
        transactionId: "layout-1",
        mode: "glide",
        phase: "prepared",
        moves: [{ viewId: "v1", dx: 320 }],
      }),
    ]);
    await prepared.commit();
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({ phase: "committed" }));
  });

  it("glide 거래는 검증기가 같은 궤적을 재현할 선언 duration을 공개한다", async () => {
    registerLayoutTransitionHost({
      prepareMove: async () => ({
        mode: "glide",
        startAtUnixMs: 1_000,
        durationMs: 340,
        commit: async () => {},
        cancel: vi.fn(),
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);
    expect(prepared.durationMs).toBe(340);
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({ durationMs: 340 }));
  });

  it("어댑터 commit/cancel을 정확히 한 번만 닫고 순서를 남긴다", async () => {
    const commit = vi.fn(async () => {});
    const cancel = vi.fn();
    registerLayoutTransitionHost({
      prepareMove: async () => ({ mode: "snap", commit, cancel }),
    });
    const first = await prepareLayoutMove([{ viewId: "v1", dx: -100 }]);
    const second = await prepareLayoutMove([{ viewId: "v2", dx: 100 }]);
    expect(layoutTransitionJournal().map((row) => row.transactionId)).toEqual(["layout-1", "layout-2"]);
    await first.commit();
    await first.commit();
    second.cancel();
    second.cancel();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(layoutTransitionJournal().map((row) => row.phase)).toEqual(["committed", "cancelled"]);
  });

  it("DOM commit 사건을 transaction과 함께 surface ACK보다 먼저 동기 발행한다", async () => {
    let releaseSurfaceAck!: () => void;
    const surfaceAck = new Promise<void>((resolve) => { releaseSurfaceAck = resolve; });
    const commit = vi.fn(() => surfaceAck);
    registerLayoutTransitionHost({
      prepareMove: async () => ({ mode: "snap", commit, cancel: vi.fn() }),
    });
    const events: unknown[] = [];
    const unsubscribe = onLayoutTransitionJournal((event) => events.push(event));
    try {
      const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);
      const committing = prepared.commit();

      expect(commit).toHaveBeenCalledOnce();
      expect(events).toEqual([expect.objectContaining({
        type: "dom-committed",
        transactionId: "layout-1",
        sequence: 1,
        domCommittedAtUnixMs: expect.any(Number),
      })]);
      expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
        phase: "prepared",
        domCommittedAtUnixMs: (events[0] as { domCommittedAtUnixMs: number }).domCommittedAtUnixMs,
      }));

      releaseSurfaceAck();
      await committing;
      expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
        phase: "committed",
        domCommittedAtUnixMs: expect.any(Number),
        closedAtUnixMs: expect.any(Number),
      }));
    } finally {
      unsubscribe();
    }
  });

  it("surface ACK reject를 prepared에 방치하지 않고 failed terminal 사실로 닫는다", async () => {
    registerLayoutTransitionHost({
      prepareMove: async () => ({
        mode: "snap",
        commit: async () => { throw new Error("surface ACK rejected"); },
        cancel: vi.fn(),
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);

    await expect(prepared.commit()).rejects.toThrow("surface ACK rejected");
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      phase: "failed",
      domCommittedAtUnixMs: expect.any(Number),
      closedAtUnixMs: expect.any(Number),
      failure: "surface ACK rejected",
    }));
  });
});
