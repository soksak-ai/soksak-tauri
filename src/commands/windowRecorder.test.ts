// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { createStream, invoke } from "../framework";
import {
  recordWindowFrames,
  startWindowRecording,
  validWindowRecordFrameTimeoutMs,
  validWindowRecordFrames,
  validWindowRecordIntervalMs,
  WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
  WINDOW_RECORD_MAX_INTERVAL_MS,
  WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS,
} from "./windowRecorder";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(),
  createStream: vi.fn(),
}));

const readyStream = { onmessage: (_message: number) => {} };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(createStream).mockClear();
  vi.mocked(createStream).mockReturnValue(readyStream as never);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "plugin:webview-capture|record") return undefined;
    return args?.frames;
  });
});

it("공통 record 계약 한 번으로 유한 프레임 시퀀스를 저장한다", async () => {
  const observed: number[] = [];
  const recording = recordWindowFrames({
    dir: "/tmp/framework-neutral-record",
    frames: 2,
    intervalMs: 0,
    onFrame: (frame) => observed.push(frame),
  });
  readyStream.onmessage(0);
  readyStream.onmessage(1);
  await recording.ready;
  const frames = await recording;

  expect(frames).toBe(2);
  expect(observed).toEqual([0, 1]);
  expect(vi.mocked(invoke)).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("plugin:webview-capture|record", {
    dir: "/tmp/framework-neutral-record",
    frames: 2,
    intervalMs: 0,
    frameTimeoutMs: WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
    onFrame: readyStream,
  });
});

it("저장 budget을 프레임워크 분기 없이 producer에 그대로 전달하고 readiness를 보존한다", async () => {
  const recording = recordWindowFrames({
    dir: "/tmp/framework-neutral-budget-record",
    frames: 1,
    intervalMs: 0,
    maxBytes: 1_048_576,
  });

  readyStream.onmessage(0);
  await expect(recording.ready).resolves.toBeUndefined();
  await expect(recording).resolves.toBe(1);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("plugin:webview-capture|record", {
    dir: "/tmp/framework-neutral-budget-record",
    frames: 1,
    intervalMs: 0,
    maxBytes: 1_048_576,
    frameTimeoutMs: WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
    onFrame: readyStream,
  });
});

it("공통 producer deadline을 모든 프레임워크 호출에 명시한다", async () => {
  expect(validWindowRecordFrameTimeoutMs(1)).toBe(true);
  expect(validWindowRecordFrameTimeoutMs(WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS)).toBe(true);
  expect(validWindowRecordFrameTimeoutMs(0)).toBe(false);
  expect(validWindowRecordFrameTimeoutMs(WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS + 1)).toBe(false);

  const defaultRecording = recordWindowFrames({
    dir: "/tmp/framework-neutral-default-deadline",
    frames: 1,
    intervalMs: 0,
  });
  readyStream.onmessage(0);
  await defaultRecording;
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
    "plugin:webview-capture|record",
    expect.objectContaining({ frameTimeoutMs: WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS }),
  );

  const explicitRecording = recordWindowFrames({
    dir: "/tmp/framework-neutral-explicit-deadline",
    frames: 1,
    intervalMs: 0,
    frameTimeoutMs: 25,
  });
  readyStream.onmessage(0);
  await explicitRecording;
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
    "plugin:webview-capture|record",
    expect.objectContaining({ frameTimeoutMs: 25 }),
  );
});

it("공통 recorder는 frames와 intervalMs를 변조하지 않고 producer 전에 엄격히 거부한다", () => {
  expect(validWindowRecordFrames(1)).toBe(true);
  expect(validWindowRecordFrames(600)).toBe(true);
  expect(validWindowRecordIntervalMs(0)).toBe(true);
  expect(validWindowRecordIntervalMs(WINDOW_RECORD_MAX_INTERVAL_MS)).toBe(true);
  expect(validWindowRecordIntervalMs(WINDOW_RECORD_MAX_INTERVAL_MS + 1)).toBe(false);

  for (const frames of [0, -1, 1.5, 601, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => recordWindowFrames({
      dir: "/tmp/rejected-frames",
      frames,
      intervalMs: 0,
    })).toThrow("frames");
  }
  for (const intervalMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => recordWindowFrames({
      dir: "/tmp/rejected-interval",
      frames: 1,
      intervalMs,
    })).toThrow("intervalMs");
  }
  expect(createStream).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("호출자는 공통 recorder만 사용하고 프레임워크 record를 직접 부르지 않는다", () => {
  for (const file of ["catalog.ts", "catalogCapture.ts", "catalogDom.ts", "catalogSettings.ts"]) {
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(source, file).not.toContain("plugin:webview-capture|record");
  }
});

it("ready 실패는 끝나지 않는 final을 기다리지 않고 실패 상태로 닫으며 final rejection도 즉시 소비한다", async () => {
  let rejectFinal!: (reason: unknown) => void;
  const final = new Promise<number>((_resolve, reject) => { rejectFinal = reject; });
  const recorder = vi.fn(() => Object.assign(final, {
    ready: Promise.reject(new Error("baseline failed")),
  }));

  const transaction = startWindowRecording({
    dir: "/evidence/ready-failure",
    frames: 8,
    intervalMs: 16,
  }, recorder);

  await expect(transaction.ready).resolves.toBe(false);
  await expect(transaction.report).resolves.toEqual({
    status: "failed",
    mode: "realtime",
    dir: "/evidence/ready-failure",
    requestedFrames: 8,
    frames: 0,
    reason: "baseline failed",
  });
  rejectFinal(new Error("late final failure"));
  await Promise.resolve();
});

it("ready 성공 뒤 final 성공·실패를 같은 공개 상태 계약으로 닫는다", async () => {
  const complete = startWindowRecording({
    dir: "/evidence/complete",
    frames: 2,
    intervalMs: 0,
  }, (request) => {
    request.onFrame?.(0);
    request.onFrame?.(1);
    return Object.assign(Promise.resolve(2), { ready: Promise.resolve() });
  });
  await expect(complete.ready).resolves.toBe(true);
  await expect(complete.report).resolves.toMatchObject({
    status: "complete",
    frames: 2,
    requestedFrames: 2,
  });

  const failed = startWindowRecording({
    dir: "/evidence/final-failure",
    frames: 3,
    intervalMs: 0,
  }, (request) => {
    request.onFrame?.(0);
    return Object.assign(Promise.reject(new Error("disk failed")), { ready: Promise.resolve() });
  });
  await expect(failed.ready).resolves.toBe(true);
  await expect(failed.report).resolves.toMatchObject({
    status: "failed",
    frames: 1,
    reason: "disk failed",
  });
});

it("recorder 동기 실패와 frame observer 실패도 throw 대신 녹화 상태로 공개한다", async () => {
  const sync = startWindowRecording({
    dir: "/evidence/sync-failure",
    frames: 1,
    intervalMs: 0,
  }, () => { throw new Error("recorder unavailable"); });
  await expect(sync.ready).resolves.toBe(false);
  await expect(sync.report).resolves.toMatchObject({
    status: "failed",
    frames: 0,
    reason: "recorder unavailable",
  });

  const observer = startWindowRecording({
    dir: "/evidence/observer-failure",
    frames: 1,
    intervalMs: 0,
    onFrame: () => { throw new Error("observer failed"); },
  }, (request) => {
    request.onFrame?.(0);
    return Object.assign(Promise.resolve(1), { ready: Promise.resolve() });
  });
  await expect(observer.report).resolves.toMatchObject({
    status: "failed",
    frames: 1,
    reason: "observer failed",
  });
});

it("ready 계약이 없는 recorder를 baseline 성공으로 위장하지 않는다", async () => {
  const incomplete = Promise.resolve(1) as ReturnType<typeof recordWindowFrames>;
  const transaction = startWindowRecording({
    dir: "/evidence/missing-ready",
    frames: 1,
    intervalMs: 0,
  }, () => incomplete);

  await expect(transaction.ready).resolves.toBe(false);
  await expect(transaction.report).resolves.toMatchObject({
    status: "failed",
    mode: "realtime",
    dir: "/evidence/missing-ready",
    requestedFrames: 1,
    frames: 0,
    reason: expect.stringContaining("ready"),
  });
});

it("raw recorder도 반환 전에 final rejection 소비자를 붙인다", async () => {
  const source = Promise.reject(new Error("capture failed"));
  const sourceCatch = source.catch.bind(source);
  vi.spyOn(source, "catch").mockImplementation((onRejected) => {
    const finished = sourceCatch(onRejected);
    vi.spyOn(finished, "catch");
    return finished;
  });
  vi.mocked(invoke).mockReturnValueOnce(source as never);

  const recording = recordWindowFrames({
    dir: "/evidence/raw-rejection",
    frames: 1,
    intervalMs: 0,
  });

  expect(vi.mocked(recording.catch)).toHaveBeenCalledOnce();
  await expect(recording.ready).rejects.toThrow("capture failed");
  await expect(recording).rejects.toThrow("capture failed");
});
