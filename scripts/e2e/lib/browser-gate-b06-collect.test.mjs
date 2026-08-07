// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB06MachineEvidence } from "./browser-gate-b06.mjs";
import { mapB06LiveEvidence } from "./browser-gate-b06-evidence.mjs";
import {
  collectB06Checkpoint,
  resolveBaseAmount,
  resolveCoveredByPlane,
  resolveExemptDim,
  resolvePresented,
} from "./browser-gate-b06-collect.mjs";

const WIN = "w-fixture";
const PANE_IDS = ["pan-left", "pan-right"];
const SPACE = "spc-1";

// 실측 기하 — 조명 평면은 space-body 전체를 덮고, 레일은 그 안의 복도에 선다.
// 따라서 rect 교차만으로는 레일이 "덮였다"가 되고, 덮이지 않는 사실은 칠하는 순서에서만 읽힌다.
const PLANE_RECT = { x: 0, y: 100, w: 1200, h: 700 };
const RAIL_RECT = { x: 0, y: 100, w: 240, h: 700 };
const CLOSED_SIDEBAR_RECT = { x: 1200, y: 100, w: 0, h: 700 };

// 실 DOM 의 사슬 — 베일은 .space-plane 안에 갇혀 있고 레일 평면은 그 바깥 형제다.
// 두 z(7,6)는 같은 문맥에서 만나지 않는다.
const ROOT = Object.freeze({
  identity: "root", node: "root", zIndex: null, positioned: false, order: [0],
});
const chain = (...entries) => [ROOT, ...entries];
const link = (identity, zIndex, order) => ({
  identity, node: identity, zIndex, positioned: true, order,
});

function treeNode(nodePath, rect, dataset = {}) {
  return {
    address: `win/${WIN}/chrome/node/${nodePath}`,
    nodePath,
    nodeIdentity: `id-${nodePath}`,
    dataset: { node: nodePath, ...dataset },
    rect,
  };
}

/** 실 DOM 을 본뜬 fixture — 한 공간의 조명 평면 하나, aperture 는 활성 pane 하나. */
function domFixture({
  activePaneId = PANE_IDS[0],
  planes = [SPACE],
  presentedPlanes = null,
  planeStyles = {},
  aperturePaneId = activePaneId,
  apertureCount = 1,
  railLayerZ = 7,
  spacePlaneZ = 1,
  railDim = "",
  railExempt = "exempt",
  baseFillOpacity = "0.5",
  sidebarRect = CLOSED_SIDEBAR_RECT,
  sidebarZ = 20,
  drop = [],
} = {}) {
  const presented = presentedPlanes ?? [planes[0]];
  const nodes = [];
  for (const scope of planes) {
    nodes.push(treeNode(`focus-lighting/${scope}`, PLANE_RECT));
    nodes.push(treeNode(`focus-lighting/${scope}/mask`, PLANE_RECT));
    nodes.push(treeNode(`focus-lighting/${scope}/base`, PLANE_RECT, { lightingBase: "idle" }));
  }
  for (let index = 0; index < apertureCount; index += 1) {
    const id = index === 0 ? aperturePaneId : `${aperturePaneId}-extra-${index}`;
    nodes.push(treeNode(
      `focus-lighting/${presented[0] ?? planes[0]}/aperture/${id}`,
      { x: 240, y: 110, w: 470, h: 680 },
      { lightingAperture: id },
    ));
  }
  nodes.push(treeNode("rail/plane", PLANE_RECT));
  nodes.push(treeNode("rail/left", RAIL_RECT, { focusLighting: railExempt, station: "0" }));
  nodes.push(treeNode("sidebar/right", sidebarRect, { focusLighting: "exempt" }));

  const veilChain = (scope) => chain(
    link(`space-plane-${scope}`, spacePlaneZ, [0, 0]),
    link(`veil-${scope}`, 6, [0, 0, 3]),
  );
  const measures = new Map();
  for (const scope of planes) {
    measures.set(`focus-lighting/${scope}/base`, {
      style: { fillOpacity: baseFillOpacity },
      stacking: veilChain(scope),
    });
  }
  measures.set("rail/plane", { stacking: chain(link("rail-plane", railLayerZ, [0, 1])) });
  measures.set("rail/left", {
    dataset: { focusLighting: railExempt },
    style: { "--dim": railDim },
  });
  measures.set("sidebar/right", {
    dataset: { focusLighting: "exempt" },
    style: { "--dim": "" },
    stacking: chain(link("sidebar-right", sidebarZ, [0, 2])),
  });
  for (const nodePath of drop) measures.set(nodePath, { style: {} });

  // 평면이 화면에 서 있는가 — 한 순간에 한꺼번에 읽는 가시성 원장.
  const presence = new Map();
  for (const scope of planes) {
    presence.set(`focus-lighting/${scope}`, planeStyles[scope] ?? {
      visibility: presented.includes(scope) ? "visible" : "hidden",
      display: "block",
    });
  }

  return { nodes, measures, presence, activePaneId };
}

function fakeRpc(fixture) {
  const calls = [];
  const rpc = async (command, params = {}) => {
    calls.push({ command, params });
    if (command === "ui.tree") {
      return { ok: true, data: { window: WIN, count: fixture.nodes.length, duplicates: [], nodes: fixture.nodes } };
    }
    if (command === "ui.snapshot.dom") {
      const filter = typeof params.filter === "string" ? params.filter : "";
      return {
        ok: true,
        data: {
          nodes: fixture.nodes
            .filter((node) => node.address.includes(filter))
            .map((node) => ({
              address: node.address,
              nodePath: node.nodePath,
              rect: node.rect,
              style: fixture.presence.get(node.nodePath) ?? {},
            })),
        },
      };
    }
    if (command === "ui.measure") {
      const node = fixture.nodes.find((item) => item.address === params.address);
      if (!node) return { ok: false, code: "NOT_EXPOSED", message: params.address };
      const measure = fixture.measures.get(node.nodePath) ?? {};
      return {
        ok: true,
        data: {
          address: params.address,
          nodeIdentity: node.nodeIdentity,
          dataset: measure.dataset ?? node.dataset,
          rect: node.rect,
          style: measure.style ?? {},
          ...(params.stacking === true && measure.stacking ? { stacking: measure.stacking } : {}),
        },
      };
    }
    throw new Error(`fixture 가 모르는 명령: ${command}`);
  };
  return { rpc, calls };
}

const lightingFor = (activeIndex) => ({
  dims: activeIndex === 0 ? [0, 0.5] : [0.5, 0],
  levels: activeIndex === 0 ? ["clear", "idle"] : ["idle", "clear"],
  adapterAlphas: [1, 1],
  adapterBases: ["pane-host", "pane-host"],
});

async function checkpointFor(activeIndex, overrides = {}) {
  const fixture = domFixture({ activePaneId: PANE_IDS[activeIndex], ...overrides });
  const { rpc } = fakeRpc(fixture);
  return collectB06Checkpoint({
    rpc,
    win: WIN,
    phase: `0${activeIndex + 1}-${activeIndex ? "right" : "left"}`,
    activePaneId: PANE_IDS[activeIndex],
    paneIds: PANE_IDS,
    lighting: lightingFor(activeIndex),
    stage: "test",
  });
}

async function verdictFor(overrides = {}) {
  const checkpoints = [
    await checkpointFor(0, overrides),
    await checkpointFor(1, overrides),
  ];
  return judgeB06MachineEvidence(mapB06LiveEvidence({ engine: "browser-chromium", checkpoints }));
}

describe("B06 checkpoint collection", () => {
  it("reads the plane, aperture, and exemption facts the judge names", async () => {
    const checkpoint = await checkpointFor(0);
    expect(checkpoint.lightingPlane).toEqual({
      presented: 1,
      parked: 0,
      unreadable: 0,
      baseAmount: 0.5,
      aperturePaneId: PANE_IDS[0],
      apertureCount: 1,
    });
    expect(checkpoint.rail).toEqual({ exempt: true, styleDim: 0, coveredByPlane: false });
    expect(checkpoint.sidebar).toEqual({ exempt: true, styleDim: 0, coveredByPlane: false });
  });

  it("closes the gate for a two-phase cross-click run", async () => {
    expect((await verdictFor()).status).toBe("green");
  });

  it("calls the rail an overlapped surface once it paints under the veil", async () => {
    const verdict = await verdictFor({ railLayerZ: 0 });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].rail.coveredByPlane=false/true");
  });

  // 옛 판정은 레일 7 > 베일 6 을 직접 뺐다. 두 수는 같은 문맥에 없어서, 사이의 판이 레일보다
  // 위로 올라가면 화면에서는 베일이 레일을 덮는데 그 뺄셈은 그대로 통과한다.
  it("sees the veil rise with the plane that contains it, not with its own z", async () => {
    const verdict = await verdictFor({ spacePlaneZ: 8 });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].rail.coveredByPlane=false/true");
  });

  it("keeps the right sidebar uncovered while it paints above the veil", async () => {
    const verdict = await verdictFor({ sidebarRect: { x: 900, y: 100, w: 300, h: 700 } });
    expect(verdict.status).toBe("green");
  });

  it("reports a dimmed rail instead of the exemption it declares", async () => {
    const verdict = await verdictFor({ railDim: "0.5" });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].rail.styleDim=0/0.5");
  });

  it("refuses to read an unanswered rail measurement as an undimmed rail", async () => {
    const verdict = await verdictFor({ drop: ["rail/left"] });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].rail.styleDim=0/null");
  });

  it("refuses to read an unanswered veil opacity as a lit plane", async () => {
    const verdict = await verdictFor({ drop: [`focus-lighting/${SPACE}/base`] });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].lightingPlane.baseAmount=0<amount<1/null");
  });

  // 단일 평면은 **화면에 선 것**을 센다. 파킹된 공간의 평면은 DOM 에 남지만 픽셀을 칠하지
  // 않으므로 이중 감광이 될 수 없다.
  it("counts the plane that stands on screen and leaves the parked one in the ledger", async () => {
    const checkpoint = await checkpointFor(0, { planes: [SPACE, "spc-2"] });
    expect(checkpoint.lightingPlane).toMatchObject({ presented: 1, parked: 1, unreadable: 0 });
    expect((await verdictFor({ planes: [SPACE, "spc-2"] })).status).toBe("green");
  });

  it("refuses a second plane that actually stands on screen", async () => {
    const verdict = await verdictFor({
      planes: [SPACE, "spc-2"],
      presentedPlanes: [SPACE, "spc-2"],
    });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].lightingPlane.presented=1/2");
  });

  // 못 읽음을 파킹으로 적으면 두 번째 평면이 조용히 숨는다.
  it("counts an unreadable plane as unreadable, never as parked", async () => {
    const verdict = await verdictFor({
      planes: [SPACE, "spc-2"],
      planeStyles: { "spc-2": {} },
    });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].lightingPlane.unreadable=0/1");
  });

  it("names the aperture owner instead of assuming the active pane", async () => {
    const verdict = await verdictFor({ aperturePaneId: "pan-stale" });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      "B06:checkpoints[0].lightingPlane.aperturePaneId=activePaneId/\"pan-stale\"/\"pan-left\"",
    );
  });

  it("refuses a second aperture", async () => {
    const verdict = await verdictFor({ apertureCount: 2 });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].lightingPlane.apertureCount=1/2");
  });

  it("reports a rail that dropped its exemption declaration", async () => {
    const verdict = await verdictFor({ railExempt: "" });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].rail.exempt=true/false");
  });
});

describe("B06 measurement resolvers", () => {
  it("separates an undeclared dim from an unanswered read", () => {
    expect(resolveExemptDim({ style: { "--dim": "" } })).toBe(0);
    expect(resolveExemptDim({ style: { "--dim": "0.5" } })).toBe(0.5);
    expect(resolveExemptDim({ style: {} })).toBeNull();
    expect(resolveExemptDim({ style: { "--dim": "veil" } })).toBeNull();
    expect(resolveExemptDim(null)).toBeNull();
  });

  it("never substitutes zero for an unread veil opacity", () => {
    expect(resolveBaseAmount({ style: { fillOpacity: "0.5" } })).toBe(0.5);
    expect(resolveBaseAmount({ style: { fillOpacity: "" } })).toBeNull();
    expect(resolveBaseAmount({ style: {} })).toBeNull();
  });

  it("separates a parked plane from one it could not read", () => {
    expect(resolvePresented({ visibility: "visible", display: "block" })).toBe(true);
    expect(resolvePresented({ visibility: "hidden", display: "block" })).toBe(false);
    expect(resolvePresented({ visibility: "visible", display: "none" })).toBe(false);
    expect(resolvePresented({ visibility: "visible" })).toBeNull();
    expect(resolvePresented({})).toBeNull();
    expect(resolvePresented(undefined)).toBeNull();
  });

  it("decides coverage by overlap first and by paint order second", () => {
    const veilStack = chain(link("space-plane", 1, [0, 0]), link("veil", 6, [0, 0, 3]));
    const above = chain(link("rail-plane", 7, [0, 1]));
    const below = chain(link("rail-plane", 0, [0, 1]));
    expect(resolveCoveredByPlane({
      planeRect: PLANE_RECT, targetRect: CLOSED_SIDEBAR_RECT, veilStack, targetStack: above,
    })).toBe(false);
    expect(resolveCoveredByPlane({
      planeRect: PLANE_RECT, targetRect: RAIL_RECT, veilStack, targetStack: above,
    })).toBe(false);
    expect(resolveCoveredByPlane({
      planeRect: PLANE_RECT, targetRect: RAIL_RECT, veilStack, targetStack: below,
    })).toBe(true);
    // 못 읽은 축이 있으면 null 이다 — 못 읽음은 0 도 false 도 아니다.
    expect(resolveCoveredByPlane({
      planeRect: null, targetRect: RAIL_RECT, veilStack, targetStack: above,
    })).toBeNull();
    expect(resolveCoveredByPlane({
      planeRect: PLANE_RECT, targetRect: RAIL_RECT, veilStack: null, targetStack: above,
    })).toBeNull();
    expect(resolveCoveredByPlane({
      planeRect: PLANE_RECT, targetRect: RAIL_RECT, veilStack, targetStack: null,
    })).toBeNull();
  });
});
