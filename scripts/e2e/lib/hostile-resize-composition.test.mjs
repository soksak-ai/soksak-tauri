// @vitest-environment node
//
// 급격한 창 resize 한 거래에서 관측면이 스스로 red 라고 선언한 합성 사실은 B10 의 판정으로
// 남아야 한다. 하니스가 그 자리에서 던지면 같은 엔진의 뒤 게이트가 측정되지 않고, 위반한
// 수치는 어느 보고서에도 이름으로 남지 않는다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { judgeB10MachineEvidence } from "./browser-gate-b10.mjs";
import { mapB10LiveEvidence } from "./browser-gate-b10-evidence.mjs";

const scaleFactor = 2;
const physical = (frame) => ({
  x: Math.round(frame.x * scaleFactor),
  y: Math.round(frame.y * scaleFactor),
  w: Math.round((frame.x + frame.w) * scaleFactor) - Math.round(frame.x * scaleFactor),
  h: Math.round((frame.y + frame.h) * scaleFactor) - Math.round(frame.y * scaleFactor),
});
const zero = () => ({ replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 });

const PANE_ID = "pane-7f2c-tab-nkg5dc";
const MEMBER_LABEL = "chromium-tab-nkg5dc";
const OBSERVER_KIND = "tauri-resize-composition-sample";

function snapshot(windowGeometry, eventGeneration, transactionGeneration, revision) {
  const viewIds = ["left", "right"];
  const frames = viewIds.map((_, index) => ({
    x: windowGeometry.x + 20 + index * ((windowGeometry.w - 60) / 2 + 20),
    y: windowGeometry.y + 50,
    w: (windowGeometry.w - 60) / 2,
    h: windowGeometry.h - 80,
  }));
  const participants = (kind) => viewIds.map((viewId, index) => ({
    id: `${kind}-${viewId}`,
    viewId,
    topologyPath: `workspace/pane/${viewId}/browser`,
    visible: true,
    logicalFrame: frames[index],
    physicalFrame: physical(frames[index]),
  }));
  const surfaces = participants("surface");
  return {
    windowGeometry,
    eventGeneration,
    transactionGeneration,
    visibleViewIds: viewIds,
    slots: participants("slot"),
    renderers: participants("renderer"),
    surfaces,
    presentations: viewIds.map((viewId, index) => ({
      viewId,
      surfaceId: surfaces[index].id,
      surfaceGeneration: 1,
      revision,
      live: true,
      visible: true,
      presented: true,
    })),
  };
}

/** 관측면이 선언한 합성 표본 한 장. 프레임워크가 스스로 kind 와 verdict 를 싣는다. */
function compositionSample({ generation, memberDelta = null, autoresizingMask = 18 }) {
  const paneRed = memberDelta !== null;
  return {
    schemaVersion: 1,
    kind: OBSERVER_KIND,
    generation,
    sampledAtUnixMs: 1_770_000_000_000 + generation,
    direct: {
      verdict: { misplaced: [], stacked: [], missing: [], unowned: [] },
      surfaces: [{
        label: MEMBER_LABEL,
        pane: PANE_ID,
        autoresizingMask,
        layerContentsRedrawPolicy: 2,
        layerContentsPlacement: 11,
      }],
    },
    pane: {
      window: "w-1",
      tolerancePx: 1,
      matches: [{
        pane: PANE_ID,
        actual: { x: 0, y: 0, w: 960, h: 700 },
        expected: { x: 0, y: 0, w: 960, h: 700 },
        delta: { x: 0, y: 0, w: 0, h: 0 },
        members: [{
          label: MEMBER_LABEL,
          actual: { x: 0, y: 56, w: paneRed ? 910 : 960, h: 644 },
          expected: { x: 0, y: 56, w: 960, h: 644 },
          delta: memberDelta ?? { x: 0, y: 0, w: 0, h: 0 },
          ok: !paneRed,
        }],
        ok: !paneRed,
      }],
      matched: !paneRed,
      verdict: paneRed ? "red" : "green",
    },
    checks: { generation: true, direct: true, pane: !paneRed },
    issues: paneRed ? ["pane-red"] : [],
    verdict: paneRed ? "red" : "green",
  };
}

/**
 * 다른 모든 평면이 green 인 한 거래. 합성 선언만 바꿔 이 사실 하나가 판정을 움직이는지 본다.
 */
function raw({ redStep = null, autoresizingMask = 18 } = {}) {
  const baselineGeometry = { x: 0, y: 0, w: 800, h: 600 };
  const requests = [
    ["shrink", { x: 10, y: 10, w: 620, h: 480 }],
    ["wide", { x: 0, y: 20, w: 980, h: 520 }],
    ["tall", { x: 20, y: 0, w: 640, h: 760 }],
    ["restore", baselineGeometry],
  ];
  const baseline = snapshot(baselineGeometry, 10, 20, 30);
  let generation = baseline.eventGeneration;
  return {
    engine: "browser",
    scaleFactor,
    resizeSequence: {
      baseline: {
        status: "observed",
        observation: { snapshot: baseline, ...compositionSample({ generation: 0 }) },
      },
      samples: requests.map(([phase, requestedWindowGeometry], sequence) => {
        const eventGenerationBefore = generation;
        generation += 1;
        const transactionGeneration = baseline.transactionGeneration + sequence + 1;
        return {
          step: sequence,
          size: { w: requestedWindowGeometry.w, h: requestedWindowGeometry.h },
          observation: {
            phase,
            requestedWindowGeometry,
            eventGenerationBefore,
            eventGenerationAfter: generation,
            transactionGeneration,
            continuity: { countersBefore: zero(), countersAfter: zero() },
            snapshot: snapshot(
              requestedWindowGeometry,
              generation,
              transactionGeneration,
              baseline.presentations[0].revision + sequence + 1,
            ),
            ...compositionSample({
              generation: sequence + 1,
              memberDelta: sequence === redStep ? { x: 0, y: 0, w: 50, h: 0 } : null,
              autoresizingMask,
            }),
          },
        };
      }),
    },
  };
}

const verdictOf = (value) => judgeB10MachineEvidence(mapB10LiveEvidence(value));

describe("hostile resize acknowledged composition", () => {
  it("keeps the sequence green when every step's observer acknowledges green", () => {
    expect(verdictOf(raw()).status).toBe("green");
  });

  it("names the recorded member delta as a B10 red instead of ending the run", () => {
    const receipt = verdictOf(raw({ redStep: 2 }));
    expect(receipt.status).toBe("red");
    const named = receipt.evidence.join(" | ");
    expect(named).toContain("acknowledgedComposition.steps[2]");
    expect(named).toContain(MEMBER_LABEL);
    expect(named).toContain("w=50");
  });

  it("names the bounds owner of a step whose observer declared red", () => {
    const receipt = verdictOf(raw({ redStep: 2, autoresizingMask: 0 }));
    expect(receipt.status).toBe("red");
    expect(receipt.evidence.join(" | ")).toContain("autoresizing=0/18");
  });

  it("names an observation that declares no composition verdict", () => {
    const value = raw();
    for (const sample of value.resizeSequence.samples) {
      delete sample.observation.verdict;
      delete sample.observation.kind;
    }
    const receipt = verdictOf(value);
    expect(receipt.status).toBe("red");
    expect(receipt.evidence.join(" | ")).toContain("acknowledgedComposition.observer=declared");
  });
});

describe("slot-freeze rapid resize block", () => {
  const source = readFileSync(new URL("../slot-freeze.mjs", import.meta.url), "utf8");
  const block = source
    .split('if (SCENARIOS.has("resize")) {')[1]
    ?.split('if (SCENARIOS.has("overlay")) {')[0] ?? "";

  it("has a resize block", () => {
    expect(block.length).toBeGreaterThan(0);
  });

  // 계약 위반은 게이트가 판정한다. 여기서 던지면 B02·B10·B11 이 blocked 로 닫혀 그 위반의
  // 수치가 어느 보고서에도 남지 않는다.
  it("does not end the run on an acknowledged composition verdict", () => {
    expect(block).not.toContain("affine 거래 RED");
    expect(block).not.toMatch(/frameworkName === "tauri"/);
  });

  // 측정 불가는 반대다. 명령이 답하지 않은 것을 red 로 적으면 보고서가 관측하지 않은 사실을
  // 관측했다고 말한다.
  it("still ends the run when the step ledger itself is unmeasurable", () => {
    expect(block).toContain("hostileResizeObservationGaps");
  });
});
