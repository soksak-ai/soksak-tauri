// @vitest-environment node
import { describe, expect, it } from "vitest";
import { observeFrameSequence, observeFullCapture } from "./browser-visual-evidence.mjs";

describe("브라우저 시각 증거는 기계 판정과 분리된다", () => {
  it("읽을 수 없는 프레임도 throw 대신 human visual 진단으로 돌린다", () => {
    expect(observeFrameSequence(["/definitely/missing/frame.png"], "missing", 2)).toMatchObject({
      kind: "human-visual-evidence",
      automatedVerdict: false,
      frames: [{ frame: "frame.png", errors: [expect.any(String)] }],
    });
  });

  it("깨진 full PNG도 capture 영수증 판정을 바꾸지 않는 시각 진단이다", () => {
    expect(observeFullCapture("/definitely/missing/full.png", "full", {
      identityMarker: "#ff00ff",
      receipt: { viewId: "tab-1", bytes: 10, width: 600, height: 2000 },
    })).toMatchObject({
      kind: "human-visual-evidence",
      automatedVerdict: false,
      errors: [expect.any(String)],
    });
  });
});
