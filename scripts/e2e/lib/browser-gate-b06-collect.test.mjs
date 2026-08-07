// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB06MachineEvidence } from "./browser-gate-b06.mjs";
import { mapB06LiveEvidence } from "./browser-gate-b06-evidence.mjs";
import {
  collectB06Checkpoint,
  resolveBaseAmount,
  resolveCoveredByPlane,
  resolveExemptDim,
  resolveLayerZ,
} from "./browser-gate-b06-collect.mjs";

const WIN = "w-fixture";
const PANE_IDS = ["pan-left", "pan-right"];
const SPACE = "spc-1";

// 실측 기하 — 조명 평면은 space-body 전체를 덮고, 레일은 그 안의 복도에 선다.
// 따라서 rect 교차만으로는 레일이 "덮였다"가 되고, 덮이지 않는 사실은 선언된 층에서만 읽힌다.
const PLANE_RECT = { x: 0, y: 100, w: 1200, h: 700 };
const RAIL_RECT = { x: 0, y: 100, w: 240, h: 700 };
const CLOSED_SIDEBAR_RECT = { x: 1200, y: 100, w: 0, h: 700 };

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
  aperturePaneId = activePaneId,
  apertureCount = 1,
  railLayerZ = "7",
  planeZ = "6",
  railDim = "",
  railExempt = "exempt",
  baseFillOpacity = "0.5",
  sidebarRect = CLOSED_SIDEBAR_RECT,
  sidebarZ = "20",
  drop = [],
} = {}) {
  const nodes = [];
  for (const scope of planes) {
    nodes.push(treeNode(`focus-lighting/${scope}`, PLANE_RECT));
    nodes.push(treeNode(`focus-lighting/${scope}/mask`, PLANE_RECT));
    nodes.push(treeNode(`focus-lighting/${scope}/base`, PLANE_RECT, { lightingBase: "idle" }));
  }
  for (let index = 0; index < apertureCount; index += 1) {
    const id = index === 0 ? aperturePaneId : `${aperturePaneId}-extra-${index}`;
    nodes.push(treeNode(
      `focus-lighting/${planes[0]}/aperture/${id}`,
      { x: 240, y: 110, w: 470, h: 680 },
      { lightingAperture: id },
    ));
  }
  nodes.push(treeNode("rail/plane", PLANE_RECT));
  nodes.push(treeNode("rail/left", RAIL_RECT, { focusLighting: railExempt, station: "0" }));
  nodes.push(treeNode("sidebar/right", sidebarRect, { focusLighting: "exempt" }));

  const measures = new Map([
    [`focus-lighting/${planes[0]}`, { style: { zIndex: planeZ } }],
    [`focus-lighting/${planes[0]}/base`, { style: { fillOpacity: baseFillOpacity } }],
    ["rail/plane", { style: { zIndex: railLayerZ } }],
    ["rail/left", { dataset: { focusLighting: railExempt }, style: { "--dim": railDim } }],
    ["sidebar/right", { dataset: { focusLighting: "exempt" }, style: { "--dim": "", zIndex: sidebarZ } }],
  ]);
  for (const nodePath of drop) measures.set(nodePath, { style: {} });

  return { nodes, measures, activePaneId };
}

function fakeRpc(fixture) {
  const calls = [];
  const rpc = async (command, params = {}) => {
    calls.push({ command, params });
    if (command === "ui.tree") {
      return { ok: true, data: { window: WIN, count: fixture.nodes.length, duplicates: [], nodes: fixture.nodes } };
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
      count: 1,
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

  it("calls the rail an overlapped surface once its layer sinks under the veil", async () => {
    const verdict = await verdictFor({ railLayerZ: "5" });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].rail.coveredByPlane=false/true");
  });

  it("keeps the right sidebar uncovered while it overlays the plane above the veil", async () => {
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

  it("counts every lighting plane the window exposes", async () => {
    const verdict = await verdictFor({ planes: [SPACE, "spc-2"] });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:checkpoints[0].lightingPlane.count=1/2");
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

  it("reads auto as no declared layer", () => {
    expect(resolveLayerZ({ style: { zIndex: "7" } })).toBe(7);
    expect(resolveLayerZ({ style: { zIndex: "auto" } })).toBeNull();
    expect(resolveLayerZ({ style: {} })).toBeNull();
  });

  it("decides coverage by overlap first and by declared layer second", () => {
    const planeRect = PLANE_RECT;
    expect(resolveCoveredByPlane({
      planeRect, targetRect: CLOSED_SIDEBAR_RECT, planeZ: 6, layerZ: null,
    })).toBe(false);
    expect(resolveCoveredByPlane({
      planeRect, targetRect: RAIL_RECT, planeZ: 6, layerZ: 7,
    })).toBe(false);
    expect(resolveCoveredByPlane({
      planeRect, targetRect: RAIL_RECT, planeZ: 6, layerZ: 6,
    })).toBe(true);
    expect(resolveCoveredByPlane({
      planeRect, targetRect: RAIL_RECT, planeZ: 6, layerZ: null,
    })).toBe(true);
    expect(resolveCoveredByPlane({
      planeRect: null, targetRect: RAIL_RECT, planeZ: 6, layerZ: 7,
    })).toBeNull();
    expect(resolveCoveredByPlane({
      planeRect, targetRect: RAIL_RECT, planeZ: null, layerZ: 7,
    })).toBeNull();
  });
});
