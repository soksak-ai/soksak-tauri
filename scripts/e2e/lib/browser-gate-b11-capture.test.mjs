// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { measureCapturedImage } from "./browser-gate-b11-capture.mjs";
import { encodePng } from "./png.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "b11-capture-"));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function writePng(name, w, h) {
  const file = path.join(root, name);
  fs.writeFileSync(file, encodePng({ w, h, ch: 4, px: Buffer.alloc(w * h * 4, 0x20) }));
  return file;
}

describe("full capture 산출물 실측", () => {
  it("파일이 실제로 담은 크기를 읽는다", () => {
    expect(measureCapturedImage(writePng("full.png", 37, 121)))
      .toEqual({ capturedWidth: 37, capturedHeight: 121 });
  });

  it("못 읽은 크기를 0으로 지어내지 않는다", () => {
    expect(measureCapturedImage(path.join(root, "missing.png")))
      .toEqual({ capturedWidth: null, capturedHeight: null });

    const truncated = path.join(root, "truncated.png");
    fs.writeFileSync(truncated, fs.readFileSync(writePng("source.png", 8, 8)).subarray(0, 16));
    expect(measureCapturedImage(truncated)).toEqual({ capturedWidth: null, capturedHeight: null });

    const notPng = path.join(root, "not-a-png.bin");
    fs.writeFileSync(notPng, Buffer.alloc(64, 7));
    expect(measureCapturedImage(notPng)).toEqual({ capturedWidth: null, capturedHeight: null });
  });
});
