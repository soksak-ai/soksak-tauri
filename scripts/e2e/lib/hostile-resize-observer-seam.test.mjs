// 관측면이 낸 합성 판정이 B10 판정면까지 같은 이름으로 도착하는지 본다.
//
// 이 자리는 픽스처가 아니라 **앱이 실제로 쓰는 코드**를 통과시킨다: 어댑터가 자기 판정을
// 선언하고(createTauriResizeProbe), 코어가 그것을 관측 기록에 실어 나르고
// (composeResizeObservation), 판정면이 그 기록에서 읽는다(hostileResizeCompositionPlane).
// 셋 중 한 곳만 다른 이름을 쓰면 게이트는 "선언 없음"으로 red 가 되고, 안 물어본 것이 통과한
// 것으로 보고된다 — 실측 2026-08-07: B10 이 두 엔진에서 observer=declared/null 로 red 였다.
import { describe, expect, it } from "vitest";

import { hostileResizeCompositionPlane } from "./hostile-resize-composition.mjs";
import { composeResizeObservation } from "../../../src/lib/windowResizeProbe.ts";
import { createTauriResizeProbe } from "../../../src/framework/tauri/resizeProbe.ts";

const PHASES = ["shrink", "wide", "tall", "restore"];

/** 자리·표면·게스트가 한 사각형을 가리키는 세계. 판정을 움직이는 것은 합성 선언뿐이다. */
function world({ paneRed = null } = {}) {
  let host = { w: 1_200, h: 800 };
  let step = -1;
  return {
    resizeTo(w, h) {
      host = { w, h };
      step += 1;
    },
    probe: createTauriResizeProbe({
      windowLabel: () => "w-1",
      scaleFactor: () => 2,
      eventGeneration: () => step + 1,
      settle: async () => {},
      readComposition: async () => ({
        matches: [{
          pane: "pane-w-1-v1",
          viewId: "v1",
          domFrame: { x: 0, y: 0, w: host.w, h: host.h },
          nativeFrame: { x: 0, y: 0, w: host.w, h: host.h },
          memberMatches: [{
            label: "b-w-1-v1",
            topologyPath: "window/w-1/view/v1/content/b-w-1-v1",
            viewport: { w: host.w, h: host.h, revision: step + 2 },
            ok: true,
          }],
        }],
      }),
      readDirect: async () => ({
        verdict: { misplaced: [], stacked: [], missing: [], unowned: [] },
        surfaces: [{
          label: "b-w-1-v1",
          pane: "pane-w-1-v1",
          autoresizingMask: 18,
          layerContentsRedrawPolicy: 2,
          layerContentsPlacement: 11,
        }],
      }),
      readPaneContract: async () => ({
        tolerancePx: 1,
        matches: [{
          pane: "pane-w-1-v1",
          actual: { x: 0, y: 0, w: host.w, h: host.h },
          expected: { x: 0, y: 0, w: host.w, h: host.h },
          delta: { x: 0, y: 0, w: 0, h: 0 },
          members: [{
            label: "b-w-1-v1",
            delta: step === paneRed ? { x: 0, y: 0, w: 50, h: 0 } : { x: 0, y: 0, w: 0, h: 0 },
            ok: step !== paneRed,
          }],
          ok: step !== paneRed,
        }],
        matched: step !== paneRed,
        verdict: step === paneRed ? "red" : "green",
      }),
      // 같은 표본이 드는 세 번째 평면 — 안 주면 관측면이 titlebar-missing 으로 red 를 낸다.
      readTitlebar: async () => ({
        nativeSequence: 1,
        verdict: "green",
        checks: {
          count: true, order: true, nonOverlap: true, containment: true,
          oneToOne: true, verticalCenter: true, backingMatch: true,
        },
      }),
      now: () => 1_770_000_000_000,
    }),
  };
}

/** 코어가 나르는 그대로의 단계 원장. 하니스가 손으로 짓는 값은 하나도 없다. */
async function samplesOf(options) {
  const scene = world(options);
  const sizes = [
    { w: 620, h: 480 }, { w: 1_200, h: 520 }, { w: 640, h: 800 }, { w: 1_200, h: 800 },
  ];
  const samples = [];
  for (const [index, size] of sizes.entries()) {
    scene.resizeTo(size.w, size.h);
    samples.push({
      step: index,
      size,
      observation: composeResizeObservation({
        request: { kind: "step", step: index, size, phase: PHASES[index] },
        windowGeometry: { x: 0, y: 0, ...size },
        observed: await scene.probe({ kind: "step", step: index }),
      }),
    });
  }
  return samples;
}

describe("resize 관측면 → B10 판정면", () => {
  it("판정면이 관측면의 이름과 단계별 판정을 그대로 읽는다", async () => {
    const plane = hostileResizeCompositionPlane({ samples: await samplesOf() });

    expect(plane.observer).toBe("tauri-resize-composition-sample");
    expect(plane.steps.map((step) => step.acknowledged)).toEqual([true, true, true, true]);
    expect(plane.steps.flatMap((step) => step.violations)).toEqual([]);
  });

  it("어긋난 단계는 그 단계 이름과 수치로 남는다", async () => {
    const plane = hostileResizeCompositionPlane({ samples: await samplesOf({ paneRed: 2 }) });

    expect(plane.steps.map((step) => step.acknowledged)).toEqual([true, true, false, true]);
    const named = plane.steps[2].violations.join(" | ");
    expect(named).toContain("s2:verdict=green/red");
    expect(named).toContain("s2:issue=pane-red");
    expect(named).toContain("b-w-1-v1");
    expect(named).toContain("w=50");
  });
});
