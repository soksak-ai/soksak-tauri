// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB07MachineEvidence } from "./browser-gate-b07.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

function snapshot(station) {
  return {
    station,
    rail: { domIdentity: "rail-dom", rect: { x: station, y: 0, w: 20, h: 700 } },
    panes: [
      { paneId: "left", domIdentity: "pane-left-dom", rect: { x: 0, y: 0, w: 500, h: 700 } },
      { paneId: "right", domIdentity: "pane-right-dom", rect: { x: 500, y: 0, w: 500, h: 700 } },
    ],
    splitTree: { type: "split", id: "root", dir: "row", sizes: [0.5, 0.5], children: ["left", "right"] },
  };
}

function relation(position) {
  const side = position === "left-adjacent" ? "left"
    : position === "right-adjacent" ? "right" : "detached";
  const connected = side !== "detached";
  return {
    boundTabId: side === "left" ? "tab-left" : "tab-right",
    boundPaneId: side === "left" ? "left" : "right",
    relationId: `rail-relation/space/${side === "left" ? "left/tab-left" : "right/tab-right"}`,
    placement: "pin",
    connected,
    side,
    borderMode: connected ? "union" : "independent",
    pathCount: connected ? 1 : 2,
  };
}

function evidence(engine = "browser") {
  const pinCase = (position, station) => {
    const value = relation(position);
    return {
      position,
      stateTreeRelation: structuredClone(value),
      paneListRelation: structuredClone(value),
      domRelation: structuredClone(value),
      before: snapshot(station),
      after: snapshot(station),
    };
  };
  return {
    engine,
    cases: [
      pinCase("left-adjacent", 50),
      pinCase("right-adjacent", 0),
      pinCase("detached", 0),
    ],
  };
}

describe("B07 PIN relation and layout invariance judge", () => {
  it("세 engine의 좌·우 인접·분리 관계와 불변 layout을 같은 기준으로 통과한다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB07MachineEvidence(evidence(engine))).toMatchObject({ status: "green", reason: null });
      expect(judgeBrowserMachineGateEvidence({
        framework: "tauri",
        platform: "darwin",
        buildId: "b07-build",
        runId: "b07-run",
        engine,
        gate: "B07",
        evidence: evidence(engine),
      })).toMatchObject({ status: "green", judgeId: "B07-machine-v1" });
    }
    expect(judgeB07MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
  });

  it("공개면 불일치, 잘못된 border/path, DOM·rect·split·station 변경, case 누락을 RED로 만든다", () => {
    const cases = [
      (value) => { value.cases[0].domRelation.relationId = "different"; },
      (value) => { value.cases[1].stateTreeRelation.borderMode = "independent"; },
      (value) => { value.cases[2].stateTreeRelation.pathCount = 1; },
      (value) => { value.cases[0].after.rail.domIdentity = "remounted"; },
      (value) => { value.cases[0].after.panes[0].rect.w -= 1; },
      (value) => { value.cases[1].after.splitTree.sizes = [0.4, 0.6]; },
      (value) => { value.cases[2].after.station = 50; },
      (value) => { value.cases.pop(); },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB07MachineEvidence(value).status).toBe("red");
    }
  });

  it("픽셀 판정을 machine schema에 섞으면 RED다", () => {
    const value = evidence();
    value.cases[0].borderPixels = [1, 2, 3];
    expect(judgeB07MachineEvidence(value).status).toBe("red");
  });

  it("깨진 중첩 evidence도 예외 대신 RED 영수증을 낸다", () => {
    const value = evidence();
    value.cases[0].before.panes = [null, null];
    expect(() => judgeB07MachineEvidence(value)).not.toThrow();
    expect(judgeB07MachineEvidence(value).status).toBe("red");
  });
});
