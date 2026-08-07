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

// 호스트 1020px, 레일 20px, 두 판 500px.
const railBox = (station) => ({ x: ((1020 - 20) * station) / 100, y: 0, w: 20, h: 700 });

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

/** 선언한 변에 실제로 그려진 두 상자. left 는 판의 오른쪽 변이, right 는 판의 왼쪽 변이 레일에 닿는다. */
function border(side, station, paneWidth) {
  const rail = railBox(station);
  return side === "left"
    ? { railBox: rail, paneBox: { x: rail.x - paneWidth, y: 0, w: paneWidth, h: 700 } }
    : { railBox: rail, paneBox: { x: rail.x + rail.w, y: 0, w: paneWidth, h: 700 } };
}

const restingSurface = (paneId) => paneId === "left"
  ? { x: 0, y: 0, w: 500, h: 700 }
  : { x: 520, y: 0, w: 500, h: 700 };

function evidence(engine = "browser") {
  const baseline = {
    persistedPin: pin(),
    arrangement: { station: 50, cells: cells() },
    splitTree: splitTree(),
  };
  // 최대화 직전의 결부는 그 순간의 활성 판을 따른다 — case 2 의 시작 상태는 case 1 의 복원 상태다.
  const maximizeCase = (direction, targetPaneId, effectiveStation, restingSide) => ({
    direction,
    targetPaneId,
    maximized: {
      persistedPin: pin(),
      arrangementStation: effectiveStation,
      effectiveStation,
      maximizedPaneId: targetPaneId,
      cells: [{ id: targetPaneId, rect: { left: 0, top: 0, width: 100, height: 100 } }],
      splitTree: splitTree(),
    },
    restored: structuredClone(baseline),
    pinGeometry: {
      baseline: {
        surfaceRect: restingSurface(targetPaneId),
        relation: relation(restingSide, restingSide === "left" ? "left" : "right"),
        border: border(restingSide, 50, 500),
      },
      maximized: {
        surfaceRect: direction === "left"
          ? { x: 0, y: 0, w: 1000, h: 700 }
          : { x: 20, y: 0, w: 1000, h: 700 },
        relation: relation(direction, targetPaneId),
        border: border(direction, effectiveStation, 1000),
      },
      restored: {
        surfaceRect: restingSurface(targetPaneId),
        relation: relation(direction, targetPaneId),
        border: border(direction, 50, 500),
      },
    },
  });
  return {
    engine,
    baseline,
    cases: [
      maximizeCase("left", "left", 100, "left"),
      maximizeCase("right", "right", 0, "left"),
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
      (value) => { value.cases[0].maximized.arrangementStation = 50; },
      (value) => { value.cases[1].pinGeometry.maximized.relation.side = "left"; },
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

  // 지시서의 "restore 뒤 native surface 가 원래 geometry 로 돌아와야 한다"를 수치로 시행한다.
  it("restore가 native surface를 원래 자리로 되돌리지 않으면 RED다", () => {
    const drifted = evidence();
    drifted.cases[0].pinGeometry.restored.surfaceRect = { x: 0, y: 0, w: 998, h: 700 };
    const verdict = judgeB08MachineEvidence(drifted);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("|")).toContain("restored.surfaceRect");

    const rounding = evidence();
    rounding.cases[1].pinGeometry.restored.surfaceRect = { x: 521, y: 0, w: 499, h: 700 };
    expect(judgeB08MachineEvidence(rounding).status).toBe("green");

    const offByTwo = evidence();
    offByTwo.cases[1].pinGeometry.restored.surfaceRect = { x: 522, y: 0, w: 500, h: 700 };
    expect(judgeB08MachineEvidence(offByTwo).status).toBe("red");
  });

  it("최대화가 native surface를 실제로 키우지 않으면 RED다", () => {
    const unchanged = evidence();
    unchanged.cases[0].pinGeometry.maximized.surfaceRect = restingSurface("left");
    unchanged.cases[0].pinGeometry.maximized.border = border("left", 50, 500);
    expect(judgeB08MachineEvidence(unchanged).status).toBe("red");

    const shrunk = evidence();
    shrunk.cases[1].pinGeometry.maximized.surfaceRect = { x: 20, y: 0, w: 1000, h: 400 };
    expect(judgeB08MachineEvidence(shrunk).status).toBe("red");
  });

  it("세 시점의 보더가 선언한 변에 그려졌는지 거리로 판정한다", () => {
    const flippedRestore = evidence();
    const rail = flippedRestore.cases[0].pinGeometry.restored.border.railBox;
    flippedRestore.cases[0].pinGeometry.restored.border.paneBox = {
      x: rail.x + rail.w, y: 0, w: 500, h: 700,
    };
    const verdict = judgeB08MachineEvidence(flippedRestore);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("|")).toContain("drawnSide");

    const detachedMaximize = evidence();
    detachedMaximize.cases[1].pinGeometry.maximized.border.paneBox.x += 4;
    expect(judgeB08MachineEvidence(detachedMaximize).status).toBe("red");

    const missingBox = evidence();
    missingBox.cases[0].pinGeometry.baseline.border.railBox = null;
    expect(judgeB08MachineEvidence(missingBox).status).toBe("red");
  });

  it("restore가 최대화한 판에 결부를 남기지 않으면 RED다", () => {
    const rebound = evidence();
    rebound.cases[1].pinGeometry.restored.relation.boundPaneId = "left";
    expect(judgeB08MachineEvidence(rebound).status).toBe("red");

    const disconnected = evidence();
    disconnected.cases[0].pinGeometry.restored.relation.connected = false;
    expect(judgeB08MachineEvidence(disconnected).status).toBe("red");
  });

  it("픽셀 성공값을 machine schema에 섞으면 RED다", () => {
    const value = evidence();
    value.cases[0].screenshotPassed = true;
    expect(judgeB08MachineEvidence(value).status).toBe("red");
  });
});
