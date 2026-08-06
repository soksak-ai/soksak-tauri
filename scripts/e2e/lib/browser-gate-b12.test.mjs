// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import {
  TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX,
  judgeB12MachineEvidence,
} from "./browser-gate-b12.mjs";
import {
  createBrowserGateReport,
  judgeBrowserMachineGateEvidence,
  setMachineGateStatus,
} from "./browser-gates.mjs";

const ROLES = Object.freeze(["close", "minimize", "zoom"]);
const SCALE_FACTOR = 2;
const NODE_IDENTITY = "dom-titlebar-instance-1";

const identity = (framework) => ({
  framework,
  platform: "darwin",
  buildId: `b12-${framework}-build`,
  runId: `b12-${framework}-run`,
});

function rectsFor(heightCssPx) {
  const titlebarHeight = heightCssPx * SCALE_FACTOR;
  const buttonSize = 28;
  const y = (titlebarHeight - buttonSize) / 2;
  return {
    titlebar: { x: 0, y: 0, w: 1_600, h: titlebarHeight },
    elements: ROLES.map((role, index) => ({
      role,
      rect: { x: 24 + index * 40, y, w: buttonSize, h: buttonSize },
    })),
  };
}

function sample({
  framework,
  stage,
  revision,
  heightCssPx,
  requestedHeightCssPx = null,
  inlineStyle,
}) {
  const rects = rectsFor(heightCssPx);
  return {
    stage,
    presentationRevision: revision,
    presented: true,
    requestedHeightCssPx,
    dom: {
      nodeIdentity: NODE_IDENTITY,
      inlineStyle: { ...inlineStyle },
    },
    titlebarPhysical: { ...rects.titlebar },
    reservations: structuredClone(rects.elements),
    buttons: structuredClone(rects.elements),
    backings: framework === "tauri" ? structuredClone(rects.elements) : null,
  };
}

function evidence(engine = "browser", framework = "tauri") {
  const baselineStyle = { height: "", flexBasis: "" };
  return {
    engine,
    coordinateSpace: {
      logical: "css-px",
      physical: "device-px",
      scaleFactor: SCALE_FACTOR,
    },
    baseline: sample({
      framework,
      stage: "baseline",
      revision: 10,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    heights: [
      sample({
        framework,
        stage: "height",
        revision: 11,
        heightCssPx: 36,
        requestedHeightCssPx: 36,
        inlineStyle: { height: "36px", flexBasis: "36px" },
      }),
      sample({
        framework,
        stage: "height",
        revision: 12,
        heightCssPx: 64,
        requestedHeightCssPx: 64,
        inlineStyle: { height: "64px", flexBasis: "64px" },
      }),
    ],
    reset: sample({
      framework,
      stage: "reset",
      revision: 13,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    final: sample({
      framework,
      stage: "final",
      revision: 13,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
  };
}

function allSamples(value) {
  return [value.baseline, ...value.heights, value.reset, value.final];
}

describe("B12 macOS traffic-light composition machine judge", () => {
  it("세 engine과 Tauri/Electron에 동일한 단계·중심·복원 계약을 적용한다", () => {
    expect(TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX).toBe(0.5);
    for (const framework of ["tauri", "electron"]) {
      for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
        const value = evidence(engine, framework);
        expect(judgeB12MachineEvidence(value, identity(framework))).toMatchObject({
          status: "green",
          reason: null,
        });
        const judgeReceipt = judgeBrowserMachineGateEvidence({
          ...identity(framework),
          engine,
          gate: "B12",
          evidence: value,
        });
        expect(judgeReceipt).toMatchObject({
          gate: "B12",
          engine,
          status: "green",
          judgeId: "B12-machine-v1",
        });
        expect(setMachineGateStatus(
          createBrowserGateReport(identity(framework)),
          { engine, gate: "B12", judgeReceipt },
        ).engines[engine].B12.machine.status).toBe("green");
      }
    }
    expect(judgeB12MachineEvidence(null, identity("tauri"))).toEqual({
      status: "not-run",
      evidence: [],
      reason: null,
    });
  });

  it("baseline → 복수 height → reset → final의 닫힌 단계를 모두 강제한다", () => {
    const cases = [
      (value) => { delete value.baseline; },
      (value) => { value.heights = [value.heights[0]]; },
      (value) => { value.heights[1].stage = "reset"; },
      (value) => { value.heights[1].requestedHeightCssPx = value.heights[0].requestedHeightCssPx; },
      (value) => { delete value.reset; },
      (value) => { value.final.stage = "baseline"; },
      (value) => { value.heights[1].presentationRevision = value.heights[0].presentationRevision; },
      (value) => { value.reset.presentationRevision = value.heights[1].presentationRevision; },
      (value) => { value.final.presentationRevision = value.reset.presentationRevision - 1; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }
  });

  it("모든 단계·세 role의 실제 rect 중심이 titlebar 중심에서 반올림 허용치만큼만 벗어난다", () => {
    const atBoundary = evidence();
    atBoundary.heights[0].buttons[2].rect.y += TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX;
    expect(judgeB12MachineEvidence(atBoundary, identity("tauri")).status).toBe("green");

    for (let sampleIndex = 0; sampleIndex < allSamples(evidence()).length; sampleIndex += 1) {
      for (let roleIndex = 0; roleIndex < ROLES.length; roleIndex += 1) {
        const value = evidence();
        allSamples(value)[sampleIndex].buttons[roleIndex].rect.y +=
          TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX + 0.001;
        expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
      }
    }
  });

  it("DOM reservation과 Tauri backing도 같은 중심·1:1 physical frame을 지켜야 한다", () => {
    const cases = [
      (value) => { value.heights[0].reservations[1].rect.y += 1; },
      (value) => { value.heights[1].reservations[0].rect.x += 1; },
      (value) => { value.reset.backings[2].rect.y += 1; },
      (value) => { value.final.backings = null; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }

    const electronBacking = evidence("browser", "electron");
    electronBacking.baseline.backings = structuredClone(electronBacking.baseline.buttons);
    expect(judgeB12MachineEvidence(electronBacking, identity("electron")).status).toBe("red");
  });

  it("같은 DOM 인스턴스와 exact inline height/flexBasis 복원을 강제한다", () => {
    const cases = [
      (value) => { value.heights[0].dom.nodeIdentity = "remounted-height"; },
      (value) => { value.reset.dom.nodeIdentity = "remounted-reset"; },
      (value) => { value.final.dom.nodeIdentity = "remounted-final"; },
      (value) => { value.heights[0].dom.inlineStyle.height = "35px"; },
      (value) => { value.heights[1].dom.inlineStyle.flexBasis = "63px"; },
      (value) => { value.reset.dom.inlineStyle.height = "45px"; },
      (value) => { value.reset.dom.inlineStyle.flexBasis = "auto"; },
      (value) => { value.final.dom.inlineStyle.height = "45px"; },
      (value) => { value.final.dom.inlineStyle.flexBasis = "auto"; },
      (value) => { value.final.titlebarPhysical.h += 1; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }
  });

  it("어느 단계든 presentation이 없으면 RED이며 screenshot/pixel 우회 필드는 거부한다", () => {
    for (let index = 0; index < allSamples(evidence()).length; index += 1) {
      const value = evidence();
      allSamples(value)[index].presented = false;
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }
    const extras = [
      (value) => { value.screenshot = "titlebar.png"; },
      (value) => { value.baseline.pixelCenters = [45, 45, 45]; },
      (value) => { value.heights[0].buttons[0].markerPixels = 28; },
    ];
    for (const mutate of extras) {
      const value = evidence();
      mutate(value);
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }
  });

  it("깨진 중첩 evidence와 framework 문맥은 예외 없이 RED가 된다", () => {
    const malformed = [
      17,
      {},
      { engine: "browser", coordinateSpace: null, baseline: null, heights: null, reset: null, final: null },
      (() => {
        const value = evidence();
        value.heights[0].buttons = [null, null, null];
        value.reset.dom = null;
        return value;
      })(),
    ];
    for (const value of malformed) {
      expect(() => judgeB12MachineEvidence(value, identity("tauri"))).not.toThrow();
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }
    expect(judgeB12MachineEvidence(evidence(), {}).status).toBe("red");
    expect(judgeB12MachineEvidence(evidence(), { framework: "unknown" }).status).toBe("red");
  });
});
