import { describe, expect, it, vi } from "vitest";
import { runWindowResizeSequence } from "./windowResizeSequence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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
      resizeElapsedMs: expect.any(Number),
      final: { w: 1200, h: 900 },
      recording: {
        status: "complete",
        mode: "realtime",
        dir: "/evidence/resize",
        requestedFrames: 12,
        frames: 12,
      },
    });
  });

  it("녹화를 요청하지 않은 거래도 명시적인 recording 상태를 공개한다", async () => {
    const recordFrames = vi.fn();
    const result = await runWindowResizeSequence({
      sizes: [{ w: 800, h: 600 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      recordFrames: recordFrames as never,
    });

    expect(recordFrames).not.toHaveBeenCalled();
    expect(result.recording).toEqual({ status: "not-requested", mode: "realtime" });
    expect(result).not.toHaveProperty("frames");
  });

  it("녹화 readiness가 실패해도 즉시 모든 resize와 관측을 순서대로 완수한다", async () => {
    const finished = deferred<number>();
    const readinessError = new Error("baseline capture failed");
    const recording = Object.assign(finished.promise, {
      ready: Promise.reject(readinessError),
    });
    const order: string[] = [];

    const result = await runWindowResizeSequence({
      sizes: [{ w: 800, h: 600 }, { w: 1400, h: 900 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 20, intervalMs: 16 },
      recordFrames: vi.fn(() => recording),
      setSize: vi.fn(async (w, h) => { order.push(`size:${w}x${h}`); }),
      observe: vi.fn(async (request) => {
        order.push(request.kind === "baseline" ? "observe:baseline" : `observe:${request.step}`);
        return { request };
      }),
    });

    expect(order).toEqual([
      "observe:baseline",
      "size:800x600",
      "observe:0",
      "size:1400x900",
      "observe:1",
    ]);
    expect(result.recording).toEqual({
      status: "failed",
      mode: "realtime",
      dir: "/evidence/resize",
      requestedFrames: 20,
      frames: 0,
      reason: "baseline capture failed",
    });
    finished.reject(readinessError);
    await Promise.resolve();
  });

  it("baseline 뒤 final recording이 실패해도 모든 resize와 관측 결과를 반환한다", async () => {
    const finished = deferred<number>();
    const recording = Object.assign(finished.promise, { ready: Promise.resolve() });
    const setSize = vi.fn(async (w: number) => {
      if (w === 1200) finished.reject(new Error("disk budget exhausted"));
    });

    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1200, h: 800 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 30, intervalMs: 10 },
      recordFrames: vi.fn(() => recording),
      setSize,
      observe: vi.fn(async (step) => ({ step })),
    });

    expect(setSize).toHaveBeenCalledTimes(2);
    expect(result.samples).toHaveLength(2);
    expect(result.recording).toEqual({
      status: "failed",
      mode: "realtime",
      dir: "/evidence/resize",
      requestedFrames: 30,
      frames: 0,
      reason: "disk budget exhausted",
    });
  });

  it("recorder 시작 호출이 동기 실패해도 resize 거래를 취소하지 않는다", async () => {
    const setSize = vi.fn(async () => {});
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1300, h: 800 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 10, intervalMs: 16 },
      recordFrames: vi.fn(() => { throw new Error("recorder unavailable"); }),
      setSize,
    });

    expect(setSize).toHaveBeenCalledTimes(2);
    expect(result.recording).toEqual({
      status: "failed",
      mode: "realtime",
      dir: "/evidence/resize",
      requestedFrames: 10,
      frames: 0,
      reason: "recorder unavailable",
    });
  });

  it.each([0, -1, 1.5, 1_073_741_825, Number.NaN, Number.POSITIVE_INFINITY])(
    "잘못된 녹화 byte budget %s는 recorder와 resize 전에 거부한다",
    async (maxBytes) => {
      const recordFrames = vi.fn();
      const setSize = vi.fn();
      await expect(runWindowResizeSequence({
        sizes: [{ w: 800, h: 600 }],
        intervalMs: 0,
        record: { dir: "/evidence/resize", frames: 10, intervalMs: 16, maxBytes },
        setSize,
        recordFrames: recordFrames as never,
      })).rejects.toThrow("maxBytes");
      expect(recordFrames).not.toHaveBeenCalled();
      expect(setSize).not.toHaveBeenCalled();
    },
  );

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
      observe: vi.fn(async (request) => ({ request, current })),
      recordFrames: vi.fn() as never,
    });
    expect(result.samples).toEqual([
      {
        step: 0,
        size: { w: 900, h: 700 },
        observation: { request: { kind: "step", step: 0, size: { w: 900, h: 700 } }, current: "900x700" },
      },
      {
        step: 1,
        size: { w: 1500, h: 900 },
        observation: { request: { kind: "step", step: 1, size: { w: 1500, h: 900 } }, current: "1500x900" },
      },
    ]);
  });

  it("첫 native resize 전에 같은 관측면으로 baseline을 세운다", async () => {
    const order: string[] = [];
    let current = "pre-resize";
    const observe = vi.fn(async (request: { kind: string; step?: number }) => {
      order.push(request.kind === "baseline" ? "observe:baseline" : `observe:${request.step}`);
      return { current };
    });

    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1500, h: 900 }],
      intervalMs: 0,
      setSize: vi.fn(async (w, h) => { current = `${w}x${h}`; order.push(`size:${w}x${h}`); }),
      observe,
      recordFrames: vi.fn() as never,
    });

    expect(order).toEqual([
      "observe:baseline",
      "size:900x700",
      "observe:0",
      "size:1500x900",
      "observe:1",
    ]);
    expect(result.baseline).toEqual({ current: "pre-resize" });
  });

  it("baseline 요청은 어떤 요청 크기도 관측면에 넘기지 않는다", async () => {
    const observe = vi.fn(async () => ({}));
    await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      observe,
      recordFrames: vi.fn() as never,
    });
    expect(observe).toHaveBeenNthCalledWith(1, { kind: "baseline" });
  });

  it("관측면이 없으면 baseline을 지어내지 않고 null로 남긴다", async () => {
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      recordFrames: vi.fn() as never,
    });
    expect(result.baseline).toBeNull();
    expect(result.samples).toEqual([]);
  });
});
