import { describe, expect, it } from "vitest";
import {
  compositionSampleVerdict,
  compositionTransactionVerdict,
  motionModeForClocks,
  type CompositionSample,
} from "../src/index";

const sample = (
  rendererX: number,
  surfaceX: number,
  scaleFactor = 2,
  overrides: Partial<CompositionSample> = {},
): CompositionSample => ({
  transactionId: "tx-1",
  sequence: 0,
  phase: "prepared",
  sampledAtUnixMs: 10,
  coordinateSpace: { logical: "css-px", scaleFactor },
  slot: { id: "slot", frame: { x: 100, y: 20, w: 300, h: 200 } },
  renderer: { id: "renderer", frame: { x: rendererX, y: 20, w: 300, h: 200 } },
  surface: { id: "surface", frame: { x: surfaceX, y: 20, w: 300, h: 200 } },
  ...overrides,
});

describe("DOM ↔ native webview composition contract", () => {
  it("1px rounding만 허용하고 renderer 또는 surface 분리를 RED로 만든다", () => {
    expect(compositionSampleVerdict(sample(101, 99)).ok).toBe(true);
    expect(compositionSampleVerdict(sample(102, 100))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("renderer=")],
    });
    expect(compositionSampleVerdict(sample(100, 420))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("surface=")],
    });
  });

  it("배율은 양수인 공개 좌표계 사실이어야 한다", () => {
    expect(compositionSampleVerdict(sample(100, 100, 0))).toMatchObject({
      ok: false,
      errors: ["scaleFactor=0"],
    });
  });

  it("공유 presentation clock이 없으면 snap을 선택한다", () => {
    expect(motionModeForClocks(true)).toBe("glide");
    expect(motionModeForClocks(false)).toBe("snap");
  });

  it("녹화 프레임 없이 거래 순서·종료·삼자 일치를 수치 RED로 판정한다", () => {
    const green = [
      sample(100, 100, 2, { sequence: 0, phase: "prepared" }),
      sample(420, 420, 2, {
        sequence: 1,
        phase: "committed",
        slot: { id: "slot", frame: { x: 420, y: 20, w: 300, h: 200 } },
      }),
    ];
    expect(compositionTransactionVerdict(green, { motionMode: "snap" })).toMatchObject({
      ok: true,
      samples: 2,
      committed: true,
    });
    expect(compositionTransactionVerdict([
      green[0],
      { ...green[1], surface: { id: "surface", frame: { x: 100, y: 20, w: 300, h: 200 } } },
    ], { motionMode: "snap" })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("surface=")],
    });
  });

  it("거래 id·sequence·commit이 분리되면 좌표가 맞아도 RED다", () => {
    const rows = [
      sample(100, 100, 2, { sequence: 0, phase: "prepared" }),
      sample(100, 100, 2, { transactionId: "tx-2", sequence: 2, phase: "presenting" }),
    ];
    const verdict = compositionTransactionVerdict(rows, { motionMode: "glide" });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(expect.arrayContaining([
      "transaction-ids=tx-1/tx-2",
      "s1:sequence=2/1",
      "commit-missing",
    ]));
  });
});
