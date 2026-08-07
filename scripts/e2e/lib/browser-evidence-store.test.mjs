// @vitest-environment node

import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beginEvidenceRun } from "./evidence-store.mjs";
import { judgeB07MachineEvidence } from "./browser-gate-b07.mjs";
import { judgeB08MachineEvidence } from "./browser-gate-b08.mjs";
import {
  BROWSER_GATE_REPORT_FILE,
  createBrowserGateReportStore,
  mapB07PinCaseEvidence,
  mapB08BaselineEvidence,
  mapB08MaximizeCaseEvidence,
  requireBrowserEvidenceBuildId,
} from "./browser-evidence-store.mjs";

const TEMP_PREFIX = "soksak-browser-gate-report-test-";
const ENGINES = ["browser", "browser-chromium", "browser-chromium-offscreen"];

const splitTree = () => ({
  split: { dir: "row", sizes: [0.5, 0.5] },
  children: [{ pane: "left" }, { pane: "right" }],
});

const cells = () => [
  { id: "left", rect: { left: 0, top: 0, width: 50, height: 100 }, railSide: "after" },
  { id: "right", rect: { left: 50, top: 0, width: 50, height: 100 }, railSide: "after" },
];

function relation(side) {
  const connected = side !== "detached";
  const paneId = side === "left" ? "left" : "right";
  return {
    boundTabId: `tab-${paneId}`,
    boundPaneId: paneId,
    relationId: `rail-relation/space/${paneId}/tab-${paneId}`,
    placement: "pin",
    connected,
    side,
    borderMode: connected ? "union" : "independent",
    pathCount: connected ? 1 : 2,
  };
}

function publicState(side, station) {
  const railRelation = relation(side);
  const canonicalLayout = splitTree();
  const stateTree = {
    activeProjectId: "project-1",
    projects: [{
      id: "project-1",
      activeSpaceId: "space-1",
      leftRailPosition: { mode: "pin", station, effectiveStation: station, cleanLines: [0, 50, 100] },
      spaces: [{
        id: "space-1",
        canonicalLayout,
        railRelation,
      }],
    }],
  };
  return {
    stateTree,
    paneList: { activePaneId: railRelation.boundPaneId, canonicalLayout, railRelation },
    arrangement: { station, cells: cells(), cleanLines: [0, 50, 100], switched: false },
    railPosition: { leftRailPosition: stateTree.projects[0].leftRailPosition },
  };
}

function measures(station) {
  return {
    railMeasure: {
      address: "win/w/rail/left",
      nodeIdentity: "dom-node:rail:1",
      rect: { x: station, y: 0, w: 20, h: 700 },
    },
    paneMeasures: [
      {
        paneId: "left",
        address: "win/w/layout/pane/left",
        nodeIdentity: "dom-node:pane:left:1",
        rect: { x: 0, y: 0, w: 500, h: 700 },
      },
      {
        paneId: "right",
        address: "win/w/layout/pane/right",
        nodeIdentity: "dom-node:pane:right:1",
        rect: { x: 500, y: 0, w: 500, h: 700 },
      },
    ],
  };
}

// 호스트 1020px, 레일 20px — station 은 레일 왼쪽 변의 px 자리다.
const railLeftPx = (station) => ((1020 - 20) * station) / 100;

/** 선언(dataset)과 실제로 그린 두 상자(data-rail·data-box)를 함께 내는 관계 노드. */
function relationMeasure(side, station, paneWidth = 500) {
  const value = relation(side);
  const railLeft = railLeftPx(station);
  const paneX = side === "left"
    ? railLeft - paneWidth
    : side === "right" ? railLeft + 20 : railLeft + 20 + 500;
  return {
    address: "win/w/relation/rail/space-1",
    nodeIdentity: "dom-node:relation:1",
    dataset: {
      boundTab: value.boundTabId,
      boundPane: value.boundPaneId,
      relationId: value.relationId,
      placement: value.placement,
      connected: String(value.connected),
      side: value.side,
      borderMode: value.borderMode,
      pathCount: String(value.pathCount),
      rail: `${railLeft},0,20,700`,
      box: `${paneX},0,${paneWidth},700`,
    },
  };
}

const nativeComposition = (writes) => ({
  placement: [
    { label: "b-w-1-left", boundsWrites: writes },
    { label: "b-w-1-right", boundsWrites: writes },
  ],
});

function b07Case(position, side, station) {
  const beforeState = publicState(side, station);
  const afterState = structuredClone(beforeState);
  const beforeMeasures = measures(station);
  const afterMeasures = structuredClone(beforeMeasures);
  return mapB07PinCaseEvidence({
    position,
    requestedStation: station,
    layoutTransactions: 0,
    stateTreeAfter: afterState.stateTree,
    paneListAfter: afterState.paneList,
    relationMeasureAfter: relationMeasure(side, station),
    nativeCompositionBefore: nativeComposition(4),
    nativeCompositionAfter: nativeComposition(4),
    before: {
      stateTree: beforeState.stateTree,
      arrangement: beforeState.arrangement,
      ...beforeMeasures,
    },
    after: {
      stateTree: afterState.stateTree,
      arrangement: afterState.arrangement,
      ...afterMeasures,
    },
  });
}

function b07Evidence(engine = "browser") {
  return {
    engine,
    cases: [
      b07Case("left-adjacent", "left", 50),
      b07Case("right-adjacent", "right", 0),
      b07Case("detached", "detached", 0),
    ],
  };
}

const restingSurface = (paneId) => paneId === "left"
  ? { x: 0, y: 0, w: 500, h: 700 }
  : { x: 520, y: 0, w: 500, h: 700 };

function b08Evidence(engine = "browser") {
  const baselineRaw = publicState("left", 50);
  const baseline = mapB08BaselineEvidence(baselineRaw);
  const maximizeCase = (direction, targetPaneId, station) => {
    const maximized = publicState(direction, station);
    maximized.railPosition.leftRailPosition.station = 50;
    maximized.railPosition.leftRailPosition.effectiveStation = station;
    maximized.arrangement.station = station;
    maximized.arrangement.cells = [{
      id: targetPaneId,
      rect: { left: 0, top: 0, width: 100, height: 100 },
      railSide: "after",
    }];
    maximized.paneList.activePaneId = targetPaneId;
    maximized.paneList.railRelation = relation(direction);
    maximized.paneList.railRelation.boundPaneId = targetPaneId;
    maximized.paneList.railRelation.boundTabId = `tab-${targetPaneId}`;
    maximized.paneList.railRelation.relationId = `rail-relation/space/${targetPaneId}/tab-${targetPaneId}`;
    const restoredRaw = publicState(direction, 50);
    return mapB08MaximizeCaseEvidence({
      direction,
      targetPaneId,
      maximized,
      restored: baselineRaw,
      stages: {
        baseline: {
          surfaceRect: restingSurface(targetPaneId),
          paneList: baselineRaw.paneList,
          relationMeasure: relationMeasure("left", 50),
        },
        maximized: {
          surfaceRect: direction === "left"
            ? { x: 0, y: 0, w: 1000, h: 700 }
            : { x: 20, y: 0, w: 1000, h: 700 },
          paneList: maximized.paneList,
          relationMeasure: relationMeasure(direction, station, 1000),
        },
        restored: {
          surfaceRect: restingSurface(targetPaneId),
          paneList: restoredRaw.paneList,
          relationMeasure: relationMeasure(direction, 50),
        },
      },
    });
  };
  return {
    engine,
    baseline,
    cases: [
      maximizeCase("left", "left", 100),
      maximizeCase("right", "right", 0),
    ],
  };
}

async function inTemporaryStore(run) {
  const base = path.resolve(os.tmpdir());
  const sandbox = await mkdtemp(path.join(base, TEMP_PREFIX));
  const stat = await lstat(sandbox);
  if (!stat.isDirectory()
      || path.dirname(sandbox) !== base
      || !path.basename(sandbox).startsWith(TEMP_PREFIX)) {
    throw new Error(`test sandbox boundary mismatch: ${sandbox}`);
  }
  try {
    return await run(path.join(sandbox, "evidence"));
  } finally {
    if (path.dirname(sandbox) !== base || !path.basename(sandbox).startsWith(TEMP_PREFIX)) {
      throw new Error(`test cleanup boundary mismatch: ${sandbox}`);
    }
    await rm(sandbox, { recursive: true });
  }
}

describe("live browser gate producer mapping", () => {
  it("B07 maps three independent public relations and opaque nodeIdentity without inventing DOM identity", () => {
    const value = b07Evidence();
    expect(value.cases[0].stateTreeRelation).toEqual(value.cases[0].paneListRelation);
    expect(value.cases[0].stateTreeRelation).toEqual(value.cases[0].domRelation);
    expect(value.cases[0].before.rail.domIdentity).toBe("dom-node:rail:1");
    expect(value.cases[0].before.panes.map(({ domIdentity }) => domIdentity)).toEqual([
      "dom-node:pane:left:1",
      "dom-node:pane:right:1",
    ]);
    expect(judgeB07MachineEvidence(value).status).toBe("green");

    const missingIdentity = b07Evidence();
    const publicBefore = publicState("left", 50);
    const publicAfter = structuredClone(publicBefore);
    const beforeMeasures = measures(50);
    const afterMeasures = structuredClone(beforeMeasures);
    delete afterMeasures.railMeasure.nodeIdentity;
    missingIdentity.cases[0] = mapB07PinCaseEvidence({
      position: "left-adjacent",
      stateTreeAfter: publicAfter.stateTree,
      paneListAfter: publicAfter.paneList,
      relationMeasureAfter: relationMeasure("left"),
      before: { stateTree: publicBefore.stateTree, arrangement: publicBefore.arrangement, ...beforeMeasures },
      after: { stateTree: publicAfter.stateTree, arrangement: publicAfter.arrangement, ...afterMeasures },
    });
    expect(missingIdentity.cases[0].after.rail.domIdentity).toBeNull();
    expect(judgeB07MachineEvidence(missingIdentity).status).toBe("red");
  });

  it("B08 maps stored pin separately from effective station and strips non-contract arrangement fields", () => {
    const value = b08Evidence();
    expect(value.baseline).toEqual({
      persistedPin: { mode: "pin", station: 50 },
      arrangement: {
        station: 50,
        cells: cells().map(({ id, rect }) => ({ id, rect })),
      },
      splitTree: splitTree(),
    });
    expect(value.cases[0].maximized).toMatchObject({
      persistedPin: { mode: "pin", station: 50 },
      effectiveStation: 100,
      maximizedPaneId: "left",
    });
    expect(value.cases[1].maximized).toMatchObject({
      persistedPin: { mode: "pin", station: 50 },
      effectiveStation: 0,
      maximizedPaneId: "right",
    });
    expect(judgeB08MachineEvidence(value).status).toBe("green");
  });
});

describe("canonical browser gate report store", () => {
  it("requires an explicit already-trimmed immutable build identity", () => {
    for (const value of [undefined, null, "", "   ", " build-1", "build-1 "]) {
      expect(() => requireBrowserEvidenceBuildId(value)).toThrow(/BROWSER_EVIDENCE_BUILD_ID/);
    }
    expect(requireBrowserEvidenceBuildId("build-1")).toBe("build-1");
  });

  it("binds the first live framework and rejects a different framework identity", () => {
    const store = createBrowserGateReportStore({
      root: "/tmp/soksak-browser-gate-report-contract",
      buildId: "build-1",
      runId: "run-1",
      platform: "darwin",
    });
    expect(store.hasReport()).toBe(false);
    expect(store.bindFramework("tauri").identity).toEqual({
      framework: "tauri",
      platform: "darwin",
      buildId: "build-1",
      runId: "run-1",
    });
    expect(() => store.bindFramework("electron")).toThrow(/identity mismatch/);
  });

  it("writes the full 3x12 report and preserves every unproduced cell as not-run", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "run-partial" });
      const store = createBrowserGateReportStore({
        root,
        buildId: "build-partial",
        runId: "run-partial",
        platform: "darwin",
      });
      store.bindFramework("tauri");
      store.recordMachineEvidence({
        framework: "tauri",
        engine: "browser",
        gate: "B07",
        evidence: b07Evidence("browser"),
      });
      store.recordMachineEvidence({
        framework: "tauri",
        engine: "browser",
        gate: "B08",
        evidence: b08Evidence("browser"),
      });

      expect(store.machineSummary()).toMatchObject({
        status: "not-run",
        total: 36,
        counts: { "not-run": 34, red: 0, green: 2 },
      });
      expect(store.report().engines.browser.B07.machine.judgeReceipt).toMatchObject({
        judgeId: "B07-machine-v1",
        status: "green",
      });
      expect(store.report().engines.browser.B08.machine.judgeReceipt).toMatchObject({
        judgeId: "B08-machine-v1",
        status: "green",
      });
      for (const engine of ENGINES.slice(1)) {
        expect(Object.values(store.report().engines[engine]).every(({ machine }) =>
          machine.status === "not-run")).toBe(true);
      }

      await store.persist();
      const persisted = JSON.parse(await readFile(
        path.join(root, "current", BROWSER_GATE_REPORT_FILE),
        "utf8",
      ));
      expect(Object.keys(persisted.engines)).toEqual(ENGINES);
      expect(Object.keys(persisted.engines.browser)).toHaveLength(12);
      expect(persisted.summary.machine).toEqual(store.machineSummary());
      expect(persisted.summary.visualReview.status).toBe("pending");
    });
  });

  it("records visual review only through an explicit human verdict and never from artifact creation", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "run-review" });
      const store = createBrowserGateReportStore({
        root,
        buildId: "build-review",
        runId: "run-review",
        platform: "darwin",
      });
      store.bindFramework("tauri");
      expect(store.report().engines.browser.B04.visualReview.status).toBe("pending");

      const reviewed = store.recordVisualReview({
        framework: "tauri",
        engine: "browser",
        gate: "B04",
        status: "passed",
        artifacts: ["browser/01-left/f0001.png", "browser/02-right/f0048.png"],
        notes: "사람이 양방향 전 프레임을 검토함",
      });
      expect(reviewed).toEqual({
        status: "passed",
        artifacts: ["browser/01-left/f0001.png", "browser/02-right/f0048.png"],
        notes: "사람이 양방향 전 프레임을 검토함",
      });
      await store.persist();
      const persisted = JSON.parse(await readFile(
        path.join(root, "current", BROWSER_GATE_REPORT_FILE),
        "utf8",
      ));
      expect(persisted.engines.browser.B04.visualReview).toEqual(reviewed);
      expect(persisted.summary.visualReview.counts.passed).toBe(1);
      expect(persisted.summary.visualReview.counts.pending).toBe(35);
    });
  });

  it("blocks only the engine that lost measurement and keeps its recorded verdicts", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "run-blocked" });
      const store = createBrowserGateReportStore({
        root,
        buildId: "build-blocked",
        runId: "run-blocked",
        platform: "darwin",
      });
      store.bindFramework("tauri");
      store.recordMachineEvidence({
        framework: "tauri",
        engine: "browser",
        gate: "B07",
        evidence: b07Evidence("browser"),
      });

      store.blockPending({ engine: "browser", reason: "native surface host lost" });

      const report = store.report();
      expect(report.engines.browser.B07.machine.status).toBe("green");
      expect(report.engines.browser.B04.machine.status).toBe("blocked");
      expect(report.engines.browser.B04.machine.reason).toBe("native surface host lost");
      expect(report.engines["browser-chromium"].B04.machine.status).toBe("not-run");

      await store.persist();
      const persisted = JSON.parse(await readFile(
        path.join(root, "current", BROWSER_GATE_REPORT_FILE),
        "utf8",
      ));
      expect(persisted.summary.machine.counts.blocked).toBe(11);
      expect(persisted.summary.machine.counts.green).toBe(1);
      expect(persisted.summary.machine.status).toBe("blocked");
    });
  });

  it("refuses to block before a live framework identity exists", () => {
    const store = createBrowserGateReportStore({
      root: "/tmp/soksak-browser-gate-report-block",
      buildId: "build-1",
      runId: "run-1",
      platform: "darwin",
    });
    expect(() => store.blockPending({ engine: "browser", reason: "mount lost" }))
      .toThrow(/live framework identity/);
  });
});
