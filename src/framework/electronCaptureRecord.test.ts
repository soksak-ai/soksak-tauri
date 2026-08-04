import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const capture = require("../../frameworks/electron/native/capture.cjs") as Record<
  string,
  { answer: (ctx: unknown, args: unknown) => Promise<unknown> }
>;
const owned: string[] = [];

afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  const frames = await capture["plugin:webview-capture|record"].answer(
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
