import { describe, expect, it, vi } from "vitest";
import { runWindowResizeSequence } from "./windowResizeSequence";

describe("window resize sequence", () => {
  it("녹화를 먼저 연 뒤 모든 물리 크기를 순서대로 적용하고 마지막 크기에 착지한다", async () => {
    const order: string[] = [];
    let finishRecording!: (frames: number) => void;
    let markReady!: () => void;
    const finished = new Promise<number>((resolve) => { finishRecording = resolve; });
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const recording = Object.assign(finished, { ready });
    const record = vi.fn(() => {
      order.push("record:start");
      return recording;
    });
    const setSize = vi.fn(async (w: number, h: number) => {
      order.push(`size:${w}x${h}`);
      if (w === 1200) finishRecording(12);
    });

    const resultPromise = runWindowResizeSequence({
      sizes: [{ w: 800, h: 600 }, { w: 1500, h: 700 }, { w: 1200, h: 900 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 12, intervalMs: 16 },
      setSize,
      recordFrames: record,
    });

    await Promise.resolve();
    expect(order).toEqual(["record:start"]);
    order.push("record:ready");
    markReady();
    const result = await resultPromise;

    expect(order).toEqual([
      "record:start",
      "record:ready",
      "size:800x600",
      "size:1500x700",
      "size:1200x900",
    ]);
    expect(result).toMatchObject({
      steps: 3,
      frames: 12,
      resizeElapsedMs: expect.any(Number),
      final: { w: 1200, h: 900 },
    });
  });

  it("빈 시퀀스와 무한 반복을 허용하지 않는다", async () => {
    await expect(runWindowResizeSequence({
      sizes: [], intervalMs: 0,
      setSize: vi.fn(), recordFrames: vi.fn() as never,
    })).rejects.toThrow("sizes");
    await expect(runWindowResizeSequence({
      sizes: Array.from({ length: 121 }, () => ({ w: 800, h: 600 })), intervalMs: 0,
      setSize: vi.fn(), recordFrames: vi.fn() as never,
    })).rejects.toThrow("120");
  });

  it("각 native resize 응답 직후 같은 단계의 공개 수치 사실을 누락 없이 기록한다", async () => {
    let current = "";
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1500, h: 900 }],
      intervalMs: 0,
      setSize: vi.fn(async (w, h) => { current = `${w}x${h}`; }),
      observe: vi.fn(async (step) => ({ step, current })),
      recordFrames: vi.fn() as never,
    });
    expect(result.samples).toEqual([
      { step: 0, size: { w: 900, h: 700 }, observation: { step: 0, current: "900x700" } },
      { step: 1, size: { w: 1500, h: 900 }, observation: { step: 1, current: "1500x900" } },
    ]);
  });
});
