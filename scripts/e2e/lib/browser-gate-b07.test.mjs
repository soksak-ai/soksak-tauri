// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB07MachineEvidence } from "./browser-gate-b07.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

// 호스트 1020px, 레일 20px, 두 판 500px — station 은 레일의 왼쪽 변 px 이다.
const railLeftPx = (station) => ((1020 - 20) * station) / 100;

function cells() {
  return [
    { id: "left", rect: { left: 0, top: 0, width: 50, height: 100 } },
    { id: "right", rect: { left: 50, top: 0, width: 50, height: 100 } },
  ];
}

function snapshot(station) {
  return {
    station,
    switched: false,
    cells: cells(),
    rail: { domIdentity: "rail-dom", rect: { x: railLeftPx(station), y: 0, w: 20, h: 700 } },
    panes: [
      { paneId: "left", domIdentity: "pane-left-dom", rect: { x: 0, y: 0, w: 500, h: 700 } },
      { paneId: "right", domIdentity: "pane-right-dom", rect: { x: 520, y: 0, w: 500, h: 700 } },
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

// 실제로 그려진 두 상자. 선언이 아니라 이것이 "어느 변에 그렸나"의 유일한 수치 근거다.
function border(position, station) {
  const railBox = { x: railLeftPx(station), y: 0, w: 20, h: 700 };
  if (position === "left-adjacent") {
    return { railBox, paneBox: { x: 0, y: 0, w: railBox.x, h: 700 } };
  }
  if (position === "right-adjacent") {
    return { railBox, paneBox: { x: railBox.x + railBox.w, y: 0, w: 500, h: 700 } };
  }
  return { railBox, paneBox: { x: railBox.x + railBox.w + 500, y: 0, w: 500, h: 700 } };
}

function nativeBoundsWrites() {
  return [
    { label: "b-w-1-left", before: 3, after: 3 },
    { label: "b-w-1-right", before: 5, after: 5 },
  ];
}

function evidence(engine = "browser") {
  const pinCase = (position, station) => {
    const value = relation(position);
    return {
      position,
      requestedStation: station,
      layoutTransactions: 0,
      stateTreeRelation: structuredClone(value),
      paneListRelation: structuredClone(value),
      domRelation: structuredClone(value),
      border: border(position, station),
      nativeBoundsWrites: nativeBoundsWrites(),
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
        nativeChildWebview: true,
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

  // border 는 선언(borderMode/pathCount)으로만 판정되어 왔다. 선언이 맞아도 상자가 반대편에
  // 그려져 있으면 제품은 틀린 것이다 — 거리로 센다.
  it("선언이 옳아도 상자가 다른 변에 그려졌으면 RED다", () => {
    const flipped = evidence();
    // left-adjacent 인데 판이 레일의 오른쪽에 붙어 있다.
    flipped.cases[0].border.paneBox = { x: flipped.cases[0].border.railBox.x + 20, y: 0, w: 480, h: 700 };
    const verdict = judgeB07MachineEvidence(flipped);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("|")).toContain("border.drawnSide");

    const detachedButTouching = evidence();
    detachedButTouching.cases[2].border.paneBox = {
      x: detachedButTouching.cases[2].border.railBox.x + 20, y: 0, w: 500, h: 700,
    };
    expect(judgeB07MachineEvidence(detachedButTouching).status).toBe("red");

    const connectedButApart = evidence();
    connectedButApart.cases[1].border.paneBox.x += 4;
    expect(judgeB07MachineEvidence(connectedButApart).status).toBe("red");
  });

  it("그린 상자를 아예 내지 않으면 RED다 — 안 잰 것과 붙은 것은 다른 사실이다", () => {
    for (const key of ["railBox", "paneBox"]) {
      const value = evidence();
      value.cases[0].border[key] = null;
      expect(judgeB07MachineEvidence(value).status).toBe("red");
    }
  });

  it("명령한 station과 잰 station이 다르면 RED다", () => {
    const value = evidence();
    value.cases[0].before.station = 40;
    value.cases[0].after.station = 40;
    const verdict = judgeB07MachineEvidence(value);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("|")).toContain("requested");
  });

  it("PIN 클릭이 분할 배치나 layout transaction을 만들면 RED다", () => {
    const switched = evidence();
    switched.cases[0].after.switched = true;
    expect(judgeB07MachineEvidence(switched).status).toBe("red");

    const rearranged = evidence();
    rearranged.cases[1].after.cells[0].rect.width = 60;
    expect(judgeB07MachineEvidence(rearranged).status).toBe("red");

    const journalled = evidence();
    journalled.cases[2].layoutTransactions = 1;
    expect(judgeB07MachineEvidence(journalled).status).toBe("red");
  });

  it("PIN 클릭이 native bounds를 다시 쓰면 RED이고, 장부가 없는 실행물은 null로 답한다", () => {
    const rewritten = evidence();
    rewritten.cases[0].nativeBoundsWrites[1].after += 1;
    const verdict = judgeB07MachineEvidence(rewritten);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("|")).toContain("boundsWrites");

    const noLedger = evidence();
    for (const pinCase of noLedger.cases) pinCase.nativeBoundsWrites = null;
    expect(judgeB07MachineEvidence(noLedger).status).toBe("green");

    const emptyLedger = evidence();
    emptyLedger.cases[0].nativeBoundsWrites = [];
    expect(judgeB07MachineEvidence(emptyLedger).status).toBe("red");
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
