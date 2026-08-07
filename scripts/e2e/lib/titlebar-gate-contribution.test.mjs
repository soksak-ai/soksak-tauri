// @vitest-environment node
//
// 두 실행기가 한 판을 나눠 쓴다는 계약을, 두 실행기가 **실제로 내는 보고서**로 확인한다.
//
// B12 는 프로세스를 세 번 죽였다 살려야 재는 값이라 살아 있는 앱 한 번으로 도는 11칸과 같은
// 실행에 못 들어간다. 그래서 파일 둘이 남고, 그 둘이 36칸 한 판으로 이어지지 않으면 B12 는
// 실행돼도 인수 장부에서 여전히 안 보인다 — 재지 않은 칸과 구별되지 않기 때문이다.
//
// 손으로 지은 상태를 넣지 않는다: 냉시작 판정(judgeTitlebarColdStartRun)과 주입
// (recordB12ColdStartCells)을 정본 그대로 부르고, 실전처럼 직렬화본을 되읽어 병합에 넘긴다.

import { describe, expect, it } from "vitest";
import { createBrowserGateReportStore } from "./browser-evidence-store.mjs";
import { b12Evidence } from "./browser-gate-b12-fixture.mjs";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { machineGateSummary } from "./browser-gates.mjs";
import {
  BROWSER_GATE_IDS,
  browserGatesOwnedBy,
  mergeBrowserGateReports,
} from "./browser-gate-report-merge.mjs";
import {
  judgeTitlebarColdStartRun,
  recordB12ColdStartCells,
} from "./titlebar-cold-start-run.mjs";

// 이 스위트는 파일을 쓰지 않는다. 저장소 root 는 신원에만 쓰이고 persist 는 부르지 않는다.
const UNUSED_ROOT = "/tmp/soksak-titlebar-gate-contribution-unused";
const BUILD_ID = "d".repeat(64);
const B12_RUN_ID = "b12-cold-run";
const SLOT_RUN_ID = "slot-live-run";
const FRAMEWORK = "tauri";
const WINDOW = "w-b12";
const SLOT_GATES = browserGatesOwnedBy("slot-freeze");
const TITLEBAR_GATES = browserGatesOwnedBy("titlebar-composition");

function anchorSet() {
  return Object.fromEntries(BROWSER_ACCEPTANCE_ENGINES
    .map((engine) => [engine, b12Evidence(engine, FRAMEWORK)]));
}

/** 하니스가 machine.json 에 적는 냉시작 영수증 — 표본에서 그대로 파생한다. */
function coldStartOf(evidence) {
  return {
    generation: evidence.startup.generation,
    ownerIdentity: evidence.cold.owner.identity,
    presentedCompositionSequence: evidence.startup.composition.nativeSequence,
    coldPresentationRevision: evidence.cold.presentationRevision,
    finalPresentationRevision: evidence.final.presentationRevision,
  };
}

function greenCycle(cycle) {
  const coldStart = coldStartOf(b12Evidence("browser", FRAMEWORK));
  return {
    schemaVersion: 1,
    status: "green",
    buildId: BUILD_ID,
    runId: B12_RUN_ID,
    cycle: String(cycle),
    framework: FRAMEWORK,
    platform: "darwin",
    windows: [WINDOW],
    machines: [{
      schemaVersion: 1,
      status: "green",
      buildId: BUILD_ID,
      runId: B12_RUN_ID,
      cycle: String(cycle),
      window: WINDOW,
      framework: FRAMEWORK,
      coldStart,
      verdicts: BROWSER_ACCEPTANCE_ENGINES.map((engine) => ({ engine, status: "green" })),
    }],
  };
}

function store(runId, gates) {
  return createBrowserGateReportStore({
    root: UNUSED_ROOT,
    buildId: BUILD_ID,
    runId,
    platform: "darwin",
    gates,
  });
}

/** 실전에서 두 보고서는 파일로 만난다 — 되읽은 직렬화본만 기여로 낸다. */
function contributionOf(gateStore, gates) {
  return { gates: [...gates], report: JSON.parse(gateStore.serialize()) };
}

function titlebarContribution({ cycles, anchors }) {
  const verdict = judgeTitlebarColdStartRun({ buildId: BUILD_ID, runId: B12_RUN_ID, cycles });
  const gateStore = store(B12_RUN_ID, TITLEBAR_GATES);
  recordB12ColdStartCells(gateStore, { framework: FRAMEWORK, verdict, anchors });
  return { verdict, contribution: contributionOf(gateStore, TITLEBAR_GATES) };
}

/** 살아 있는 앱 한 번이 소유한 11칸. 값이 무엇인지는 이 스위트의 축이 아니므로 이름만 단다. */
function slotFreezeContribution() {
  const gateStore = store(SLOT_RUN_ID, SLOT_GATES);
  gateStore.bindFramework(FRAMEWORK);
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    for (const gate of SLOT_GATES) {
      gateStore.recordMachineStatus({
        framework: FRAMEWORK,
        engine,
        gate,
        status: "red",
        evidence: [`${engine}/${gate}: live surface verdict`],
      });
    }
  }
  return contributionOf(gateStore, SLOT_GATES);
}

describe("B12 cold-start contribution → merged 36-cell report", () => {
  it("carries a green cold-start run into the canonical board without re-measuring it", () => {
    const anchors = anchorSet();
    const { verdict, contribution } = titlebarContribution({
      cycles: [greenCycle(1), greenCycle(2), greenCycle(3)],
      anchors,
    });
    expect(verdict).toEqual({ status: "green", evidence: [] });

    const merged = mergeBrowserGateReports([slotFreezeContribution(), contribution]);
    expect(merged.identity.runId).toBe(`${SLOT_RUN_ID}+${B12_RUN_ID}`);

    // 36칸이 한 판으로 선다: 세 엔진 × 열두 칸, 재지 않은 칸이 하나도 남지 않는다.
    expect(Object.keys(merged.engines).sort()).toEqual([...BROWSER_ACCEPTANCE_ENGINES].sort());
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(Object.keys(merged.engines[engine]).sort()).toEqual([...BROWSER_GATE_IDS].sort());
    }
    const summary = machineGateSummary(merged);
    expect(summary.total).toBe(36);
    expect(summary.counts).toMatchObject({ green: 3, red: 33, "not-run": 0, blocked: 0 });

    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      const cell = merged.engines[engine].B12.machine;
      expect(cell.status).toBe("green");
      expect(cell.judgeReceipt.judgeId).toBe("B12-machine-v1");
      expect(cell.judgeReceipt.runId).toBe(`${SLOT_RUN_ID}+${B12_RUN_ID}`);
      // 병합본은 냉시작이 실제로 든 표본을 그대로 든다 — 통과를 요약으로 바꿔 적지 않는다.
      expect(cell.judgeReceipt.machineEvidence).toEqual(anchors[engine]);
      // 11칸은 남의 측정이다. B12 기여가 그 자리를 덮으면 두 실행이 한 칸을 다툰 것이다.
      expect(merged.engines[engine].B07.machine.evidence)
        .toEqual([`${engine}/B07: live surface verdict`]);
    }
  });

  it("leaves an unmeasured cold-start run named red instead of silently not-run", () => {
    const { verdict, contribution } = titlebarContribution({ cycles: [], anchors: {} });
    expect(verdict.status).toBe("red");

    const merged = mergeBrowserGateReports([slotFreezeContribution(), contribution]);
    expect(machineGateSummary(merged).counts).toMatchObject({ "not-run": 0, red: 36 });
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      const cell = merged.engines[engine].B12.machine;
      expect(cell.status).toBe("red");
      expect(cell.reason).toBe("B12 cold-start run red");
      expect(cell.evidence.join(" ")).toMatch(/cycles=0\/3/);
    }
  });

  it("refuses to stand behind a green run that hands over no cold-start sample", () => {
    expect(() => titlebarContribution({
      cycles: [greenCycle(1), greenCycle(2), greenCycle(3)],
      anchors: {},
    })).toThrow(/anchor/i);
  });
});
