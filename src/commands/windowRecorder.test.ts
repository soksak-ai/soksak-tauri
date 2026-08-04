// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "../framework";
import { recordWindowFrames } from "./windowRecorder";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../framework", () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "plugin:webview-capture|snapshot_region" ? "cG5n" : undefined,
  );
});

it("프레임워크 전용 record 없이 공통 단일 캡처를 유한 시퀀스로 저장한다", async () => {
  const frames = await recordWindowFrames({
    dir: "/tmp/framework-neutral-record",
    frames: 2,
    intervalMs: 0,
  });

  expect(frames).toBe(2);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["plugin:webview-capture|snapshot_region", {}],
    ["write_file_base64", {
      path: "/tmp/framework-neutral-record/f0000.png",
      base64: "cG5n",
    }],
    ["plugin:webview-capture|snapshot_region", {}],
    ["write_file_base64", {
      path: "/tmp/framework-neutral-record/f0001.png",
      base64: "cG5n",
    }],
  ]);
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
    "plugin:webview-capture|record",
    expect.anything(),
  );
});

it("공통 명령 소스 어디에도 프레임워크 전용 record 호출이 남지 않는다", () => {
  for (const file of ["catalog.ts", "catalogCapture.ts", "catalogDom.ts", "catalogSettings.ts"]) {
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(source, file).not.toContain("plugin:webview-capture|record");
  }
});
