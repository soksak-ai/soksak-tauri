import { describe, expect, it } from "vitest";
import { resizeCompositionViolations } from "../../lib/windowResizeProbe";
import {
  TauriSurfaceGenerations,
  countTauriResizeContinuity,
  tauriResizeObservation,
  type TauriResizeFacts,
} from "./resizeObservation";

const facts = (overrides: Partial<TauriResizeFacts> = {}): TauriResizeFacts => ({
  windowLabel: "w-1",
  scaleFactor: 2,
  eventGeneration: 5,
  eventGenerationBefore: 4,
  eventGenerationAfter: 5,
  transactionGeneration: 3,
  continuity: {
    countersBefore: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 },
    countersAfter: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 },
  },
  panes: [{
    nativeHostId: "pane-w-1-v1",
    viewId: "v1",
    domFrame: { x: 10, y: 20, w: 500, h: 300 },
    nativeFrame: { x: 10, y: 20, w: 500, h: 300 },
    members: [{
      label: "b-w-1-v1",
      topologyPath: "window/w-1/view/v1/content/b-w-1-v1",
      viewport: { w: 500, h: 300, revision: 9 },
      ok: true,
    }],
  }],
  surfaceGenerationOf: () => 1,
  ...overrides,
});

describe("Tauri resize 관측면", () => {
  it("세 평면을 각자 잰 곳에서 채우고 코어 계약을 지킨다", () => {
    const observation = tauriResizeObservation(facts());

    expect(resizeCompositionViolations(observation)).toEqual([]);
    expect(observation.visibleViewIds).toEqual(["v1"]);
    expect(observation.slots[0]).toMatchObject({
      id: "slot/pane-w-1-v1",
      viewId: "v1",
      topologyPath: "window/w-1/view/v1/content/b-w-1-v1",
      logicalFrame: { x: 10, y: 20, w: 500, h: 300 },
      physicalFrame: { x: 20, y: 40, w: 1_000, h: 600 },
    });
    expect(observation.surfaces[0].id).toBe("surface/pane-w-1-v1");
    expect(observation.presentations[0]).toMatchObject({
      viewId: "v1",
      surfaceId: "surface/pane-w-1-v1",
      surfaceGeneration: 1,
      revision: 9,
      live: true,
      presented: true,
    });
  });

  it("자식이 자기 루트를 답하지 않으면 렌더러 평면을 pane 자리로 메우지 않는다", () => {
    const observation = tauriResizeObservation(facts({
      panes: [{
        ...facts().panes[0],
        members: [{ ...facts().panes[0].members[0], viewport: null }],
      }],
    }));

    expect(observation.renderers).toEqual([]);
    expect(resizeCompositionViolations(observation)).toContain("renderers=non-empty-array/[]");
  });

  it("native frame 이 없으면 표면 평면과 표시 사실이 그 이름으로 빈다", () => {
    const observation = tauriResizeObservation(facts({
      panes: [{ ...facts().panes[0], nativeFrame: null }],
    }));

    expect(observation.surfaces).toEqual([]);
    expect(resizeCompositionViolations(observation)).toEqual(expect.arrayContaining([
      "surfaces=non-empty-array/[]",
      "presentations[0].live=true/false",
    ]));
  });

  it("신원 없는 native 호스트는 어느 평면에도 실리지 않는다", () => {
    const observation = tauriResizeObservation(facts({
      panes: [{ ...facts().panes[0], viewId: null }],
    }));

    expect(observation.visibleViewIds).toEqual([]);
    expect(observation.slots).toEqual([]);
  });

  it("표면 세대는 뷰가 다른 호스트로 옮겨갈 때만 오른다", () => {
    const generations = new TauriSurfaceGenerations();
    expect(generations.of("v1", "pane-a")).toBe(1);
    expect(generations.of("v1", "pane-a")).toBe(1);
    expect(generations.of("v1", "pane-b")).toBe(2);
    expect(generations.of("v2", "pane-a")).toBe(1);
  });

  it("사라짐·교체·표시 실패를 누적 원장으로 센다", () => {
    const before = tauriResizeObservation(facts());
    const replaced = tauriResizeObservation(facts({
      surfaceGenerationOf: () => 2,
      panes: [{
        ...facts().panes[0],
        members: [{ ...facts().panes[0].members[0], viewport: { w: 500, h: 300, revision: 9 }, ok: false }],
      }],
    }));
    const zero = { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 };

    expect(countTauriResizeContinuity(before, replaced, zero)).toEqual({
      replacements: 1, gaps: 1, disappearances: 0, unpresented: 1,
    });
    expect(countTauriResizeContinuity(
      before,
      tauriResizeObservation(facts({ panes: [] })),
      zero,
    )).toMatchObject({ disappearances: 1 });
    // 첫 관측에는 이전 거래가 없다 — 없던 거래를 실패로 세지 않는다.
    expect(countTauriResizeContinuity(null, before, zero)).toEqual(zero);
  });
});
