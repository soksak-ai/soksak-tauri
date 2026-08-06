import { describe, expect, it } from "vitest";
import {
  compositionFrameComparisonVerdict,
  compositionInventoryVerdict,
  compositionSampleVerdict,
  compositionTimelineVerdict,
  compositionTransactionVerdict,
  logicalRectToPhysical,
  motionModeForClocks,
  type CompositionInventory,
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
  it("좌표 원점과 reference가 다른 frame의 직접 비교를 거부한다", () => {
    const frame = { x: 0, y: 28, w: 300, h: 200 };
    expect(compositionFrameComparisonVerdict({
      expected: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "presenter-local",
          referenceId: "pane-host-a",
        },
      },
      actual: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "window-absolute",
          referenceId: "window-a",
        },
      },
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "coordinate-origin=presenter-local/window-absolute",
        "coordinate-reference=pane-host-a/window-a",
      ]),
    });

    expect(compositionFrameComparisonVerdict({
      expected: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "presenter-local",
          referenceId: "pane-host-a",
        },
      },
      actual: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "presenter-local",
          referenceId: "pane-host-a",
        },
      },
    })).toMatchObject({ ok: true, errors: [] });
  });

  it("CSS 모서리를 물리 픽셀로 한 번만 반올림하고 임의 tolerance를 두지 않는다", () => {
    expect(logicalRectToPhysical({ x: 10.25, y: 20.5, w: 100.5, h: 40.25 }, 2)).toEqual({
      x: 21,
      y: 41,
      w: 201,
      h: 81,
    });
    expect(compositionSampleVerdict(sample(100.5, 100))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("renderer=")],
    });
    expect(compositionSampleVerdict(sample(100, 420))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("surface=")],
    });
  });

  it("독립 inventory의 slot·renderer·surface가 view/topology/양 좌표계에서 정확히 1:1이어야 한다", () => {
    const observed = (kind: string, viewId: string, x: number) => ({
      id: `${kind}-${viewId}`,
      viewId,
      topologyPath: `workspace/pane/${viewId}/content`,
      visible: true as const,
      logicalFrame: { x, y: 20.25, w: 300.5, h: 200.25 },
      physicalFrame: logicalRectToPhysical({ x, y: 20.25, w: 300.5, h: 200.25 }, 2),
    });
    const inventory: CompositionInventory = {
      coordinateSpace: { logical: "css-px", physical: "device-px", scaleFactor: 2 },
      visibleViewIds: ["left", "right"],
      slots: [observed("slot", "left", 100.25), observed("slot", "right", 420.25)],
      renderers: [observed("renderer", "left", 100.25), observed("renderer", "right", 420.25)],
      surfaces: [observed("surface", "left", 100.25), observed("surface", "right", 420.25)],
    };
    expect(compositionInventoryVerdict(inventory)).toMatchObject({
      ok: true,
      matched: 2,
      errors: [],
    });

    const missing = structuredClone(inventory);
    missing.surfaces.pop();
    expect(compositionInventoryVerdict(missing)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("owners=")]),
    });

    const topologyDrift = structuredClone(inventory);
    topologyDrift.renderers[0].topologyPath = "workspace/pane/wrong/content";
    expect(compositionInventoryVerdict(topologyDrift)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("topology=")]),
    });

    const physicalDrift = structuredClone(inventory);
    physicalDrift.surfaces[0].physicalFrame.x += 1;
    expect(compositionInventoryVerdict(physicalDrift)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("physical-rounding=")]),
    });

    const hiddenOmission = structuredClone(inventory);
    hiddenOmission.visibleViewIds.push("omitted-visible-view");
    expect(compositionInventoryVerdict(hiddenOmission)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("visible-owners=")]),
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

  it("서로 다른 display cadence는 각 실제 epoch의 한 궤적으로 판정하고 nearest sample로 붙이지 않는다", () => {
    const frame = (x: number) => ({ x, y: 20, w: 300, h: 200 });
    const timed = (times: number[], step: number) => times.map((sampledAtUnixMs, sequence) => ({
      sequence,
      sampledAtUnixMs,
      frame: frame(sequence * step),
    }));
    const input = {
      coordinateSpace: { logical: "css-px" as const, scaleFactor: 2 },
      startAtUnixMs: 0,
      durationMs: 32,
      timingFunction: [0, 0, 1, 1] as const,
      from: frame(0),
      to: frame(32),
      // DOM은 60Hz, native는 120Hz여도 한 샘플을 두 번 붙여 비교하지 않는다.
      slot: timed([0, 16, 32], 16),
      renderer: timed([0, 8, 16, 24, 32], 8),
      surface: timed([0, 8, 16, 24, 32], 8),
    };
    expect(compositionTimelineVerdict(input)).toMatchObject({ ok: true, errors: [] });

    const lagged = structuredClone(input);
    lagged.surface[2].frame.x = 8;
    expect(compositionTimelineVerdict(lagged)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("surface[2]")]),
    });

    const roundingOnly = structuredClone(input);
    roundingOnly.from.x = 0.24;
    roundingOnly.to.x = 32.24;
    for (const samples of [roundingOnly.slot, roundingOnly.renderer, roundingOnly.surface]) {
      for (const sample of samples) sample.frame.x += 0.24;
    }
    roundingOnly.slot[1].frame.x += 0.24; // 0.48 physical px: quantization-only
    expect(compositionTimelineVerdict(roundingOnly)).toMatchObject({ ok: true, errors: [] });

    roundingOnly.slot[1].frame.x += 0.02; // 0.52 physical px: rounding으로 설명 불가
    expect(compositionTimelineVerdict(roundingOnly)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("slot[1]")]),
    });
  });
});
