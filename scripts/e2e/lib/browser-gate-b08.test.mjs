// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB08MachineEvidence } from "./browser-gate-b08.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

const splitTree = () => ({
  type: "split",
  id: "root",
  dir: "row",
  sizes: [0.5, 0.5],
  children: ["left", "right"],
});

const cells = () => [
  { id: "left", rect: { left: 0, top: 0, width: 50, height: 100 } },
  { id: "right", rect: { left: 50, top: 0, width: 50, height: 100 } },
];

const pin = () => ({ mode: "pin", station: 50 });

function relation(direction, paneId) {
  return {
    boundTabId: `tab-${paneId}`,
    boundPaneId: paneId,
    relationId: `rail-relation/space/${paneId}/tab-${paneId}`,
    placement: "pin",
    connected: true,
    side: direction,
    borderMode: "union",
    pathCount: 1,
  };
}

function evidence(engine = "browser") {
  const baseline = {
    persistedPin: pin(),
    arrangement: { station: 50, cells: cells() },
    splitTree: splitTree(),
  };
  const maximizeCase = (direction, targetPaneId, effectiveStation) => ({
    direction,
    targetPaneId,
    maximized: {
      persistedPin: pin(),
      effectiveStation,
      maximizedPaneId: targetPaneId,
      cells: [{ id: targetPaneId, rect: { left: 0, top: 0, width: 100, height: 100 } }],
      splitTree: splitTree(),
      relation: relation(direction, targetPaneId),
    },
    restored: structuredClone(baseline),
  });
  return {
    engine,
    baseline,
    cases: [
      maximizeCase("left", "left", 100),
      maximizeCase("right", "right", 0),
    ],
  };
}

describe("B08 PIN maximize/restore judge", () => {
  it("세 engine 모두 양방향 PIN·split 보존과 완전 restore를 통과한다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB08MachineEvidence(evidence(engine))).toMatchObject({ status: "green", reason: null });
      expect(judgeBrowserMachineGateEvidence({
        framework: "tauri",
        platform: "darwin",
        buildId: "b08-build",
        runId: "b08-run",
        engine,
        gate: "B08",
        evidence: evidence(engine),
      })).toMatchObject({ status: "green", judgeId: "B08-machine-v1" });
    }
    expect(judgeB08MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
  });

  it("PIN 변경, 방향/station 오류, full rect 오류, split 변경, restore 드리프트를 RED로 만든다", () => {
    const cases = [
      (value) => { value.cases[0].maximized.persistedPin.station = 100; },
      (value) => { value.cases[0].maximized.effectiveStation = 0; },
      (value) => { value.cases[1].maximized.relation.side = "left"; },
      (value) => { value.cases[0].maximized.cells[0].rect.width = 99; },
      (value) => { value.cases[1].maximized.splitTree.sizes = [0.4, 0.6]; },
      (value) => { value.cases[0].restored.arrangement.cells[0].rect.width = 49; },
      (value) => { value.cases[1].restored.splitTree.children.reverse(); },
      (value) => { value.cases.pop(); },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB08MachineEvidence(value).status).toBe("red");
    }
  });

  it("픽셀 성공값을 machine schema에 섞으면 RED다", () => {
    const value = evidence();
    value.cases[0].screenshotPassed = true;
    expect(judgeB08MachineEvidence(value).status).toBe("red");
  });
});
