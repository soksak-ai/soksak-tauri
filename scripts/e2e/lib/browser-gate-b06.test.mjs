// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB06MachineEvidence } from "./browser-gate-b06.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

function evidence(engine = "browser") {
  const pane = (viewId, active) => ({
    viewId,
    active,
    level: active ? "clear" : "dimmed",
    styleDim: active ? 0 : 0.7,
    adapterAlpha: 1,
  });
  const exempt = (node) => ({ node, exempt: true, styleDim: 0, coveredByPlane: false });
  return {
    engine,
    checkpoints: [
      {
        phase: "active-left",
        activeViewId: "left",
        panes: [pane("left", true), pane("right", false)],
        lightingPlane: { count: 1, baseAmount: 0.7, apertureViewId: "left", apertureCount: 1 },
        rail: exempt("rail"),
        sidebar: exempt("sidebar"),
      },
      {
        phase: "active-right",
        activeViewId: "right",
        panes: [pane("left", false), pane("right", true)],
        lightingPlane: { count: 1, baseAmount: 0.7, apertureViewId: "right", apertureCount: 1 },
        rail: exempt("rail"),
        sidebar: exempt("sidebar"),
      },
    ],
  };
}

describe("B06 focus lighting judge", () => {
  it("세 engine 모두 양쪽 pane 활성화와 rail/sidebar 면제의 같은 값 계약을 통과한다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB06MachineEvidence(evidence(engine))).toMatchObject({ status: "green", reason: null });
      expect(judgeBrowserMachineGateEvidence({
        framework: "tauri",
        platform: "darwin",
        buildId: "b06-build",
        runId: "b06-run",
        engine,
        gate: "B06",
        evidence: evidence(engine),
      })).toMatchObject({ status: "green", judgeId: "B06-machine-v1" });
    }
    expect(judgeB06MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
  });

  it("active 감광, inactive 무감광, adapter 이중감광, plane 중복, rail/sidebar 포함, 단방향만 검증을 RED로 만든다", () => {
    const cases = [
      (value) => { value.checkpoints[0].panes[0].styleDim = 0.2; },
      (value) => { value.checkpoints[0].panes[1].styleDim = 0; },
      (value) => { value.checkpoints[0].panes[1].adapterAlpha = 0.3; },
      (value) => { value.checkpoints[0].lightingPlane.count = 2; },
      (value) => { value.checkpoints[0].lightingPlane.apertureViewId = "right"; },
      (value) => { value.checkpoints[0].rail.styleDim = 0.4; },
      (value) => { value.checkpoints[1].sidebar.coveredByPlane = true; },
      (value) => { value.checkpoints[1].activeViewId = "left"; value.checkpoints[1].panes[0] = value.checkpoints[0].panes[0]; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB06MachineEvidence(value).status).toBe("red");
    }
  });

  it("픽셀·프레임 판정값을 machine schema에 섞으면 RED다", () => {
    const value = evidence();
    value.checkpoints[0].brightnessPixels = [42, 84];
    expect(judgeB06MachineEvidence(value).status).toBe("red");
  });
});
