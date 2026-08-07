// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB06MachineEvidence } from "./browser-gate-b06.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

function evidence(engine = "browser") {
  const pane = (paneId, active) => ({
    paneId,
    active,
    level: active ? "clear" : "dimmed",
    styleDim: active ? 0 : 0.7,
    adapterAlpha: 1,
    adapterBasis: "pane-host",
  });
  const exempt = (node) => ({ node, exempt: true, styleDim: 0, coveredByPlane: false });
  const plane = (aperturePaneId) => ({
    presented: 1,
    parked: 0,
    unreadable: 0,
    baseAmount: 0.7,
    aperturePaneId,
    apertureCount: 1,
  });
  return {
    engine,
    checkpoints: [
      {
        phase: "active-left",
        activePaneId: "left",
        panes: [pane("left", true), pane("right", false)],
        lightingPlane: plane("left"),
        rail: exempt("rail"),
        sidebar: exempt("sidebar"),
      },
      {
        phase: "active-right",
        activePaneId: "right",
        panes: [pane("left", false), pane("right", true)],
        lightingPlane: plane("right"),
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
      (value) => { value.checkpoints[0].lightingPlane.presented = 2; },
      (value) => { value.checkpoints[0].lightingPlane.unreadable = 1; },
      (value) => { value.checkpoints[0].lightingPlane.aperturePaneId = "right"; },
      (value) => { value.checkpoints[0].rail.styleDim = 0.4; },
      (value) => { value.checkpoints[1].sidebar.coveredByPlane = true; },
      (value) => { value.checkpoints[1].activePaneId = "left"; value.checkpoints[1].panes[0] = value.checkpoints[0].panes[0]; },
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

  // 값보다 먼저 근거를 묻는다. 어느 장부에서 왔는지 말하지 못하는 1 은 측정이 아니라 선언이고,
  // 선언은 무엇이 걸려 있어도 통과한다(실사고: 하니스가 paneOwned 아닌 경로에 1 을 써 넣었다).
  it("근거 장부 이름이 없는 adapter alpha 는 RED다", () => {
    const missing = evidence();
    delete missing.checkpoints[0].panes[0].adapterBasis;
    expect(judgeB06MachineEvidence(missing).evidence)
      .toContain("B06:checkpoints[0].panes[0].adapterBasis=missing");

    const unnamed = evidence();
    unnamed.checkpoints[0].panes[0].adapterBasis = null;
    expect(judgeB06MachineEvidence(unnamed).evidence)
      .toContain("B06:checkpoints[0].panes[0].adapterBasis=known/null");

    const unknown = evidence();
    unknown.checkpoints[0].panes[0].adapterBasis = "harness-constant";
    expect(judgeB06MachineEvidence(unknown).evidence)
      .toContain('B06:checkpoints[0].panes[0].adapterBasis=known/"harness-constant"');
  });

  // 파킹된 공간의 평면은 DOM 에 남지만 픽셀을 칠하지 않으므로 이중 감광이 될 수 없다.
  it("파킹된 평면은 세지 않고 장부에 남기며, 못 읽은 평면은 RED다", () => {
    const parked = evidence();
    for (const checkpoint of parked.checkpoints) checkpoint.lightingPlane.parked = 3;
    expect(judgeB06MachineEvidence(parked)).toMatchObject({ status: "green" });

    const unreadable = evidence();
    unreadable.checkpoints[0].lightingPlane.unreadable = 1;
    expect(judgeB06MachineEvidence(unreadable).evidence)
      .toContain("B06:checkpoints[0].lightingPlane.unreadable=0/1");

    const negative = evidence();
    negative.checkpoints[0].lightingPlane.parked = -1;
    expect(judgeB06MachineEvidence(negative).evidence)
      .toContain("B06:checkpoints[0].lightingPlane.parked=0..n/-1");
  });

  it("판정 문구가 잰 축의 이름을 든다", () => {
    expect(judgeB06MachineEvidence(evidence()).evidence).toEqual([
      "browser/B06:one-presented-plane;all-panes-active-once;"
        + "adapter-alpha=1-from-named-ledger;rail+sidebar=uncovered-in-paint-order",
    ]);
  });
});
