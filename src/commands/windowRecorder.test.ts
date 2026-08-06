// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { createStream, invoke } from "../framework";
import { recordWindowFrames } from "./windowRecorder";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../framework", () => ({
  invoke: vi.fn(),
  createStream: vi.fn(),
}));

const readyStream = { onmessage: (_message: number) => {} };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
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
    onFrame: readyStream,
  });
});

it("호출자는 공통 recorder만 사용하고 프레임워크 record를 직접 부르지 않는다", () => {
  for (const file of ["catalog.ts", "catalogCapture.ts", "catalogDom.ts", "catalogSettings.ts"]) {
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(source, file).not.toContain("plugin:webview-capture|record");
  }
});
