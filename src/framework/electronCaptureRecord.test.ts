import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const capture = require("../../frameworks/electron/native/capture.cjs") as Record<
  string,
  { answer: (ctx: unknown, args: unknown) => Promise<unknown> }
>;
const owned: string[] = [];
const RECORD = "plugin:webview-capture|record";
const QUOTA_EXCEEDED = "FRAMEWORK_CAPTURE_QUOTA_EXCEEDED";

function frameWindow(frames: readonly Buffer[]) {
  let next = 0;
  const focus = vi.fn();
  const capturePage = vi.fn(async () => {
    const png = frames[next++];
    if (!png) throw new Error("test frame exhausted");
    return {
      isEmpty: () => false,
      toPNG: () => png,
    };
  });
  return { window: { focus, webContents: { capturePage } }, focus, capturePage };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("끝나지 않는 capturePage는 polling 없이 frameTimeoutMs에서 실패하고 늦은 완료를 격리한다", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-timeout-"));
  owned.push(dir);
  let resolveCapture!: (image: { isEmpty: () => boolean; toPNG: () => Buffer }) => void;
  const capturePage = vi.fn(() => new Promise((resolve) => { resolveCapture = resolve; }));
  const stream = vi.fn();

  const recording = capture[RECORD].answer(
    { window: { webContents: { capturePage } }, stream },
    { dir, frames: 1, intervalMs: 0, frameTimeoutMs: 5, onFrame: {} },
  );
  const rejected = expect(recording).rejects.toMatchObject({ code: "FRAMEWORK_CAPTURE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(5);
  await rejected;

  resolveCapture({ isEmpty: () => false, toPNG: () => Buffer.from("late") });
  await Promise.resolve();
  expect(existsSync(join(dir, "f0000.png"))).toBe(false);
  expect(stream).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, 60_001, Number.NaN, Number.POSITIVE_INFINITY])(
  "Electron도 잘못된 frameTimeoutMs %s를 캡처 전에 거부한다",
  async (frameTimeoutMs) => {
    const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-invalid-timeout-"));
    owned.push(dir);
    const host = frameWindow([Buffer.from("a")]);
    await expect(capture[RECORD].answer(
      { window: host.window },
      { dir, frames: 1, intervalMs: 0, frameTimeoutMs },
    )).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(host.capturePage).not.toHaveBeenCalled();
  },
);

it("Electron도 공통 record 계약을 포커스 없이 유한 PNG로 구현한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-"));
  owned.push(dir);
  const capturePage = vi.fn(async () => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png-frame"),
  }));
  const onReady = { __frameworkStream: "ready-1" };
  const stream = vi.fn(() => {
    expect(readFileSync(join(dir, "f0000.png"), "utf8")).toBe("png-frame");
  });

  const frames = await capture[RECORD].answer(
    { window: { webContents: { capturePage } }, stream },
    { dir, frames: 2, intervalMs: 0, onReady },
  );

  expect(frames).toBe(2);
  expect(capturePage).toHaveBeenCalledTimes(2);
  expect(stream).toHaveBeenCalledOnce();
  expect(stream).toHaveBeenCalledWith(onReady, 1);
  expect(readFileSync(join(dir, "f0000.png"), "utf8")).toBe("png-frame");
  expect(readFileSync(join(dir, "f0001.png"), "utf8")).toBe("png-frame");
});

it("maxBytes 정확한 경계는 허용하고 onReady/onFrame은 각 파일 저장 뒤에만 발행한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-cap-"));
  owned.push(dir);
  const first = Buffer.from("abc");
  const second = Buffer.from("defgh");
  const host = frameWindow([first, second]);
  const onReady = { __frameworkStream: "ready-cap" };
  const onFrame = { __frameworkStream: "frame-cap" };
  const events: string[] = [];
  const stream = vi.fn((target, value) => {
    if (target === onReady) {
      expect(existsSync(join(dir, "f0000.png"))).toBe(true);
      events.push(`ready:${value}`);
      return;
    }
    expect(target).toBe(onFrame);
    expect(existsSync(join(dir, `f${String(value).padStart(4, "0")}.png`))).toBe(true);
    events.push(`frame:${value}`);
  });

  await expect(capture[RECORD].answer(
    { window: host.window, stream },
    { dir, frames: 2, intervalMs: 0, maxBytes: first.length + second.length, onReady, onFrame },
  )).resolves.toBe(2);

  expect(readFileSync(join(dir, "f0000.png"))).toEqual(first);
  expect(readFileSync(join(dir, "f0001.png"))).toEqual(second);
  expect(events).toEqual(["ready:1", "frame:0", "frame:1"]);
});

it("첫 프레임이 maxBytes를 넘으면 파일과 stream 사건 없이 quota error로 중단한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-first-quota-"));
  owned.push(dir);
  const host = frameWindow([Buffer.from("abc")]);
  const stream = vi.fn();

  await expect(capture[RECORD].answer(
    { window: host.window, stream },
    { dir, frames: 1, intervalMs: 0, maxBytes: 2, onReady: {}, onFrame: {} },
  )).rejects.toMatchObject({ code: QUOTA_EXCEEDED });

  expect(host.capturePage).toHaveBeenCalledOnce();
  expect(existsSync(join(dir, "f0000.png"))).toBe(false);
  expect(stream).not.toHaveBeenCalled();
});

it("둘째 프레임이 누적 maxBytes를 넘으면 첫 파일만 남고 초과 프레임은 쓰거나 발행하지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-second-quota-"));
  owned.push(dir);
  const first = Buffer.from("abc");
  const second = Buffer.from("defgh");
  const host = frameWindow([first, second]);
  const onReady = { __frameworkStream: "ready-second" };
  const onFrame = { __frameworkStream: "frame-second" };
  const events: Array<[unknown, unknown]> = [];
  const stream = vi.fn((target, value) => events.push([target, value]));

  await expect(capture[RECORD].answer(
    { window: host.window, stream },
    { dir, frames: 2, intervalMs: 0, maxBytes: 7, onReady, onFrame },
  )).rejects.toMatchObject({ code: QUOTA_EXCEEDED });

  expect(readFileSync(join(dir, "f0000.png"))).toEqual(first);
  expect(first.length).toBeLessThanOrEqual(7);
  expect(existsSync(join(dir, "f0001.png"))).toBe(false);
  expect(host.capturePage).toHaveBeenCalledTimes(2);
  expect(events).toEqual([[onReady, 1], [onFrame, 0]]);
});

it("maxBytes는 생략하거나 양의 safe integer만 허용한다", async () => {
  const invalid = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, "8"];
  for (const [index, maxBytes] of invalid.entries()) {
    const root = mkdtempSync(join(tmpdir(), "soksak-electron-record-invalid-cap-"));
    const dir = join(root, String(index));
    owned.push(root);
    const host = frameWindow([Buffer.from("a")]);
    await expect(capture[RECORD].answer(
      { window: host.window },
      { dir, frames: 1, intervalMs: 0, maxBytes },
    )).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(host.capturePage).not.toHaveBeenCalled();
  }
});

it("maxBytes 적용 record도 창을 포커스하지 않고 모든 프레임을 저장한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-electron-record-unfocused-"));
  owned.push(dir);
  const host = frameWindow([Buffer.from("a"), Buffer.from("bb")]);

  await expect(capture[RECORD].answer(
    { window: host.window },
    { dir, frames: 2, intervalMs: 0, maxBytes: 3 },
  )).resolves.toBe(2);

  expect(host.focus).not.toHaveBeenCalled();
  expect(host.capturePage).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(dir, "f0000.png"), "utf8")).toBe("a");
  expect(readFileSync(join(dir, "f0001.png"), "utf8")).toBe("bb");
});
