// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createBrowserGateReportStore } from "./browser-evidence-store.mjs";
import { mergeBrowserGateReports } from "./browser-gate-report-merge.mjs";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";

const SLOT_FREEZE_GATES = Object.freeze([
  "B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B09", "B10", "B11",
]);
const TITLEBAR_GATES = Object.freeze(["B12"]);
const UNUSED_ROOT = "/tmp/soksak-browser-gate-merge-unused";

/** B01 봉투를 일부러 깨서 red 영수증을 만든다. 병합이 영수증을 다시 발급해도
 * 판정 수치가 그대로인지 확인하는 데 쓴다. */
function redB01Evidence(engine) {
  return { engine, tabs: [{ viewId: `${engine}-tab` }] };
}

function boundStore({ gates, buildId = "build-1", runId, platform = "darwin" }) {
  const store = createBrowserGateReportStore({
    root: UNUSED_ROOT,
    buildId,
    runId,
    platform,
    gates,
  });
  store.bindFramework("tauri");
  return store;
}

function slotFreezeStore(options = {}) {
  return boundStore({ gates: SLOT_FREEZE_GATES, runId: "run-slot", ...options });
}

function titlebarStore(options = {}) {
  return boundStore({ gates: TITLEBAR_GATES, runId: "run-titlebar", ...options });
}

function recordColdStartBlocked(store, reason) {
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    store.recordMachineStatus({
      framework: "tauri",
      engine,
      gate: "B12",
      status: "blocked",
      evidence: ["cycle 2: blocked (Electron traffic-light adapter is absent)"],
      reason,
    });
  }
}

describe("browser gate report ownership", () => {
  it("refuses to record a gate the runner did not declare", () => {
    const store = slotFreezeStore();
    expect(() => store.recordMachineEvidence({
      framework: "tauri",
      engine: "browser",
      gate: "B12",
      evidence: null,
    })).toThrow(/B12/);
  });

  it("blocks only the gates the runner owns", () => {
    const store = slotFreezeStore();
    store.blockPending({ engine: "browser", reason: "native surface host lost" });
    const cells = store.report().engines.browser;
    expect(cells.B01.machine.status).toBe("blocked");
    expect(cells.B11.machine.status).toBe("blocked");
    // B12 는 이 실행기의 것이 아니다 — 재지 못한 칸을 차단으로 적으면 없는 사실을 만든다.
    expect(cells.B12.machine.status).toBe("not-run");
  });

  it("names the declared gates in its contribution", () => {
    const contribution = slotFreezeStore().contribution();
    expect(contribution.gates).toEqual([...SLOT_FREEZE_GATES]);
    expect(contribution.report.identity.runId).toBe("run-slot");
  });

  it("refuses a contribution from a runner that declared no gates", () => {
    const store = createBrowserGateReportStore({
      root: UNUSED_ROOT,
      buildId: "build-1",
      runId: "run-undeclared",
      platform: "darwin",
    });
    store.bindFramework("tauri");
    expect(() => store.contribution()).toThrow(/declare/i);
  });
});

describe("mergeBrowserGateReports", () => {
  it("joins two runners into one 36-cell verdict and names both runs", () => {
    const slot = slotFreezeStore();
    slot.recordMachineEvidence({
      framework: "tauri",
      engine: "browser",
      gate: "B01",
      evidence: redB01Evidence("browser"),
    });
    const titlebar = titlebarStore();
    recordColdStartBlocked(titlebar, "B12 cold-start run blocked");

    const merged = mergeBrowserGateReports([slot.contribution(), titlebar.contribution()]);
    expect(merged.identity.runId).toBe("run-slot+run-titlebar");
    expect(merged.identity.buildId).toBe("build-1");
    expect(merged.identity.framework).toBe("tauri");

    const b01 = merged.engines.browser.B01.machine;
    expect(b01.status).toBe("red");
    expect(b01.evidence).toEqual(slot.report().engines.browser.B01.machine.evidence);
    // 영수증은 병합 신원으로 다시 발급되지만 판정 수치는 같은 판사가 같은 증거에서 다시 낸다.
    expect(b01.judgeReceipt.runId).toBe("run-slot+run-titlebar");
    expect(b01.judgeReceipt.judgeId).toBe("B01-machine-v1");
    expect(b01.judgeReceipt.machineEvidence)
      .toEqual(slot.report().engines.browser.B01.machine.judgeReceipt.machineEvidence);

    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(merged.engines[engine].B12.machine.status).toBe("blocked");
      expect(merged.engines[engine].B12.machine.reason).toBe("B12 cold-start run blocked");
    }
  });

  it("keeps B12 statically not-applicable off darwin instead of inventing a verdict", () => {
    const slot = slotFreezeStore({ platform: "linux" });
    const titlebar = titlebarStore({ platform: "linux" });
    const merged = mergeBrowserGateReports([slot.contribution(), titlebar.contribution()]);
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(merged.engines[engine].B12.machine.status).toBe("not-applicable");
    }
  });

  it("refuses gate ownership that is not a partition of the twelve gates", () => {
    const slot = slotFreezeStore();
    expect(() => mergeBrowserGateReports([slot.contribution()])).toThrow(/B12/);

    const titlebar = titlebarStore();
    expect(() => mergeBrowserGateReports([
      { gates: [...SLOT_FREEZE_GATES, "B12"], report: slot.report() },
      titlebar.contribution(),
    ])).toThrow(/B12/);
  });

  it("refuses contributions measured against a different artifact", () => {
    const slot = slotFreezeStore();
    const titlebar = titlebarStore({ buildId: "build-2" });
    expect(() => mergeBrowserGateReports([slot.contribution(), titlebar.contribution()]))
      .toThrow(/buildId/);
  });

  it("refuses a contribution that wrote a verdict into a gate it does not own", () => {
    const rogue = titlebarStore({ runId: "run-rogue" });
    recordColdStartBlocked(rogue, "cold-start run blocked");
    const titlebar = titlebarStore();
    recordColdStartBlocked(titlebar, "B12 cold-start run blocked");
    expect(() => mergeBrowserGateReports([
      { gates: [...SLOT_FREEZE_GATES], report: rogue.report() },
      titlebar.contribution(),
    ])).toThrow(/B12/);
  });
});
