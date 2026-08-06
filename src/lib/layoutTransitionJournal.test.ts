import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
  registerLayoutTransitionHost,
} from "./layoutTransitionHost";
import {
  __resetLayoutTransitionJournalForTest,
  layoutTransitionJournal,
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
});
