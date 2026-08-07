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
import { presentationNowUnixMs } from "./presentationClock";

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

  // 거래는 자기가 예약한 움직임보다 먼저 끝날 수 없다.
  //
  // glide 거래는 DOM과 문서 밖 표면이 함께 출발할 절대 epoch(startAtUnixMs)를 선언하고, 그
  // epoch는 surface ACK보다 뒤다(어댑터가 준비 왕복을 덮을 lead를 준다). 그 ACK 시각을 그대로
  // closedAtUnixMs로 찍으면 장부는 "닫혔다"고 답하면서 자기가 예약한 출발은 아직 미래에 둔다.
  // 그 사이 구간을 읽는 쪽은 이 재배치가 끝났는지 알 수 없다.
  it("선언한 출발 epoch 전에는 glide 거래를 닫지 않는다", async () => {
    const startAtUnixMs = presentationNowUnixMs() + 500;
    let releaseSurfaceAck!: () => void;
    const surfaceAck = new Promise<void>((resolve) => { releaseSurfaceAck = resolve; });
    registerLayoutTransitionHost({
      prepareMove: async () => ({
        mode: "glide",
        startAtUnixMs,
        durationMs: 340,
        commit: () => surfaceAck,
        cancel: vi.fn(),
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: -160 }]);
    const committing = prepared.commit();

    releaseSurfaceAck();
    await surfaceAck;
    await Promise.resolve();
    // 관측이 예약 전에 일어났다는 사실을 먼저 못 박는다 — 스케줄러가 밀려 예약을 지나
    // 관측했다면 그 사실이 이름으로 남아야지, 닫힘 판정을 대신하면 안 된다.
    expect(presentationNowUnixMs()).toBeLessThan(startAtUnixMs);
    // ACK는 끝났지만 예약한 출발은 아직 오지 않았다 — 거래는 열려 있어야 한다.
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      phase: "prepared",
      domCommittedAtUnixMs: expect.any(Number),
    }));
    expect(layoutTransitionJournal()[0]?.closedAtUnixMs).toBeUndefined();

    await committing;
    const entry = layoutTransitionJournal()[0]!;
    expect(entry.phase).toBe("committed");
    expect(entry.closedAtUnixMs).toBeGreaterThanOrEqual(startAtUnixMs);
  });

  it("이미 지난 출발 epoch는 기다리지 않는다 — 낡은 예약이 거래를 붙잡지 못한다", async () => {
    const startAtUnixMs = presentationNowUnixMs() - 1_000;
    registerLayoutTransitionHost({
      prepareMove: async () => ({
        mode: "glide",
        startAtUnixMs,
        durationMs: 340,
        commit: async () => {},
        cancel: vi.fn(),
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: -160 }]);
    const before = presentationNowUnixMs();
    await prepared.commit();
    const entry = layoutTransitionJournal()[0]!;
    expect(entry.phase).toBe("committed");
    expect(entry.closedAtUnixMs).toBeGreaterThanOrEqual(before);
    // 1,000ms 뒤처진 예약을 기다렸다면 이 상한을 넘는다. 여유는 스케줄러 지연 몫이다.
    expect(entry.closedAtUnixMs! - before).toBeLessThan(1_000);
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

  it("실패한 거래는 예약한 출발을 기다리지 않는다 — 움직이지 않을 거래에 미래가 없다", async () => {
    registerLayoutTransitionHost({
      prepareMove: async () => ({
        mode: "glide",
        startAtUnixMs: presentationNowUnixMs() + 5_000,
        durationMs: 340,
        commit: async () => { throw new Error("surface ACK rejected"); },
        cancel: vi.fn(),
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: -160 }]);
    const before = presentationNowUnixMs();

    await expect(prepared.commit()).rejects.toThrow("surface ACK rejected");
    const entry = layoutTransitionJournal()[0]!;
    expect(entry.phase).toBe("failed");
    // 5,000ms 뒤의 예약을 기다렸다면 이 상한을 넘는다.
    expect(entry.closedAtUnixMs! - before).toBeLessThan(1_000);
  });
});
