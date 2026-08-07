// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createBrowserGateReportStore } from "./browser-evidence-store.mjs";
import {
  BROWSER_GATE_IDS,
  BROWSER_GATE_OWNERS,
  browserGatesOwnedBy,
  mergeBrowserGateReports,
} from "./browser-gate-report-merge.mjs";
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

describe("BROWSER_GATE_OWNERS", () => {
  it("splits the twelve gates between the two runners without a gap or an overlap", () => {
    const declared = Object.values(BROWSER_GATE_OWNERS).flat();
    expect([...declared].sort()).toEqual([...BROWSER_GATE_IDS].sort());
    expect(new Set(declared).size).toBe(BROWSER_GATE_IDS.length);
    expect(browserGatesOwnedBy("titlebar-composition")).toEqual([...TITLEBAR_GATES]);
    expect(browserGatesOwnedBy("slot-freeze")).toEqual([...SLOT_FREEZE_GATES]);
    expect(() => browserGatesOwnedBy("nobody")).toThrow(/unknown browser gate runner/);
  });
});

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
    // 판사 이름은 정본에서 읽는다 — 여기 베껴 두면 판사가 판올림될 때 조용히 갈린다.
    expect(b01.judgeReceipt.runId).toBe("run-slot+run-titlebar");
    expect(b01.judgeReceipt.judgeId)
      .toBe(slot.report().engines.browser.B01.machine.judgeReceipt.judgeId);
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

// 규칙 — 한 칸의 상함이 판을 못 보게 만들지 않는다.
//
// 병합은 저장된 증거로 판정을 다시 낸다. 판정 규칙이 바뀐 뒤 옛 실행을 읽으면 그 재판정이
// 저장된 상태와 어긋나는데, 지금은 그 순간 판 전체를 던진다 — 36칸 중 35칸의 잰 값까지 사라진다.
// 실측 2026-08-07: B10 증거 문자열을 고친 뒤 집계가 던져, 끝까지 돈 실행의 표가 한 줄도 안 나왔다.
// 어긋남은 그 칸의 사실이다. 그 칸에 이름을 달고 나머지는 그대로 낸다.
describe("재판정이 저장된 판정과 어긋나면", () => {
  function reportWithStaleCell() {
    const store = slotFreezeStore();
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      store.recordMachineEvidence({ framework: "tauri", engine, gate: "B01", evidence: redB01Evidence(engine) });
    }
    const report = structuredClone(store.report());
    // 판정 규칙이 바뀐 실행을 그대로 흉내낸다 — 원자료(machineEvidence)는 그대로 두고, 저장된
    // 판정 문자열만 옛 모양으로 남긴다. 다시 판정하면 지금 규칙이 다른 문자열을 낸다.
    const cell = report.engines.browser.B01.machine;
    cell.evidence = ["B01:옛 규칙이 내던 문자열"];
    cell.judgeReceipt.evidence = ["B01:옛 규칙이 내던 문자열"];
    return report;
  }

  it("어긋난 칸을 blocked 로 이름 붙이고 나머지 칸은 그대로 낸다", () => {
    const titlebar = titlebarStore();
    recordColdStartBlocked(titlebar, "cold start blocked");
    const merged = mergeBrowserGateReports([
      { gates: SLOT_FREEZE_GATES, report: reportWithStaleCell() },
      { gates: TITLEBAR_GATES, report: titlebar.report() },
    ]);
    const cell = merged.engines.browser.B01.machine;
    expect(cell.status).toBe("blocked");
    expect(cell.reason).toContain("re-judged");
    // 같은 판의 다른 칸은 살아 있다.
    expect(merged.engines["browser-chromium"].B01.machine.status).toBe("red");
    expect(merged.engines.browser.B12.machine.status).toBe("blocked");
  });
});
