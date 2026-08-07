// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  observeFrameSequence,
  observeFullCapture,
  snapshotScaleForVisualEvidence,
} from "./browser-visual-evidence.mjs";

describe("배율은 창의 사실이지 캡처의 산출물이 아니다", () => {
  it("PNG를 못 읽어도 배율은 창이 말한 값이며 1로 대체되지 않는다", () => {
    const evidence = snapshotScaleForVisualEvidence("/definitely/missing/frame.png", {
      w: 2400, h: 1600, scale: 2,
    });
    expect(evidence.scale).toBe(2);
    expect(evidence.capturedScale).toBe(null);
    expect(evidence.errors).toEqual([expect.any(String)]);
  });

  it("캡처에서 잰 배율이 창의 사실과 어긋나면 대체하지 않고 사람에게 이름으로 남긴다", () => {
    const evidence = snapshotScaleForVisualEvidence("/definitely/missing/frame.png", {
      w: 1200, h: 800, scale: 1,
    });
    expect(evidence.scale).toBe(1);
    expect(evidence.kind).toBe("human-visual-evidence");
    expect(evidence.automatedVerdict).toBe(false);
  });

  it("창이 배율을 말하지 않으면 측정 불가로 던진다 — 못 읽음을 1로 적지 않는다", () => {
    expect(() => snapshotScaleForVisualEvidence("/definitely/missing/frame.png", { w: 1200, h: 800 }))
      .toThrow(/scale/);
    expect(() => snapshotScaleForVisualEvidence("/definitely/missing/frame.png", null))
      .toThrow(/window\.info/);
  });

  it("쓸 수 없는 배율로 프레임을 재려 하면 조용히 0을 만들지 않고 사유를 남긴다", () => {
    const report = observeFrameSequence(["/definitely/missing/frame.png"], "missing", null);
    expect(report.frames[0].errors.some((error) => /scale/.test(error))).toBe(true);
  });
});

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
