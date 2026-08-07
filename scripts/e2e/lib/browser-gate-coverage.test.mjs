// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createBrowserGateReport,
  machineGateSummary,
  setMachineGateStatus,
} from "./browser-gates.mjs";
import {
  blockPendingMachineGates,
  formatGateVerdict,
  pendingMachineGates,
  runEngineCoverage,
} from "./browser-gate-coverage.mjs";

const IDENTITY = Object.freeze({
  framework: "tauri",
  platform: "darwin",
  buildId: "build-id-fixture",
  runId: "run-id-fixture",
});

const ENGINES = ["browser", "browser-chromium", "browser-chromium-offscreen"];
const ALL_GATES = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B09", "B10", "B11", "B12"];

const reportWithRed = (engine, gate) => setMachineGateStatus(createBrowserGateReport(IDENTITY), {
  engine,
  gate,
  status: "red",
  evidence: [`${gate}:fixture-mismatch=1/0`],
});

describe("pendingMachineGates", () => {
  it("초기 보고서의 모든 게이트를 미측정으로 센다", () => {
    const report = createBrowserGateReport(IDENTITY);
    expect(pendingMachineGates(report, "browser")).toEqual(ALL_GATES);
  });

  it("측정이 끝난 셀은 미측정에서 제외한다", () => {
    const report = reportWithRed("browser", "B04");
    expect(pendingMachineGates(report, "browser")).not.toContain("B04");
    expect(pendingMachineGates(report, "browser-chromium")).toContain("B04");
  });

  it("적용 대상이 아닌 셀은 미측정이 아니다", () => {
    const report = createBrowserGateReport({ ...IDENTITY, platform: "linux" });
    expect(pendingMachineGates(report, "browser")).not.toContain("B12");
  });
});

describe("blockPendingMachineGates", () => {
  it("미측정 셀만 사유와 함께 차단으로 바꾼다", () => {
    const report = blockPendingMachineGates(reportWithRed("browser", "B04"), {
      engine: "browser",
      reason: "engine mount failed",
    });
    expect(report.engines.browser.B04.machine.status).toBe("red");
    expect(report.engines.browser.B01.machine.status).toBe("blocked");
    expect(report.engines.browser.B01.machine.reason).toBe("engine mount failed");
  });

  it("다른 엔진의 셀은 건드리지 않는다", () => {
    const report = blockPendingMachineGates(createBrowserGateReport(IDENTITY), {
      engine: "browser",
      reason: "engine mount failed",
    });
    expect(report.engines["browser-chromium"].B01.machine.status).toBe("not-run");
  });

  it("적용 대상이 아닌 셀은 차단하지 않는다", () => {
    const report = blockPendingMachineGates(createBrowserGateReport({ ...IDENTITY, platform: "linux" }), {
      engine: "browser",
      reason: "engine mount failed",
    });
    expect(report.engines.browser.B12.machine.status).toBe("not-applicable");
  });

  it("사유 없는 차단을 거부한다", () => {
    expect(() => blockPendingMachineGates(createBrowserGateReport(IDENTITY), { engine: "browser" }))
      .toThrow(/reason/);
  });

  it("차단된 보고서는 미측정을 남기지 않고 green 이 되지 않는다", () => {
    let report = createBrowserGateReport(IDENTITY);
    for (const engine of ENGINES) {
      report = blockPendingMachineGates(report, { engine, reason: "app lifecycle lost" });
    }
    const summary = machineGateSummary(report);
    expect(summary.counts["not-run"]).toBe(0);
    expect(summary.counts.blocked).toBe(36);
    expect(summary.status).toBe("blocked");
    expect(summary.status).not.toBe("green");
  });

  it("차단은 이미 기록된 red 를 가리지 않는다", () => {
    let report = reportWithRed("browser", "B04");
    for (const engine of ENGINES) {
      report = blockPendingMachineGates(report, { engine, reason: "app lifecycle lost" });
    }
    const summary = machineGateSummary(report);
    expect(summary.counts.red).toBe(1);
    expect(summary.status).toBe("red");
  });
});

describe("formatGateVerdict", () => {
  it("green 은 판정만 적는다", () => {
    expect(formatGateVerdict("browser", "B04", { status: "green", evidence: [] }))
      .toBe("◉ browser/B04 canonical machine verdict: green");
  });

  it("green 이 아니면 실행 로그에 수치 증거를 함께 적는다", () => {
    expect(formatGateVerdict("browser", "B04", {
      status: "red",
      evidence: ["B04:transitions[0].pane-dx=-160/0", "B04:timeline:renderer:samples=1/3"],
    })).toBe(
      "◉ browser/B04 canonical machine verdict: red"
      + " — B04:transitions[0].pane-dx=-160/0, B04:timeline:renderer:samples=1/3",
    );
  });
});

describe("runEngineCoverage", () => {
  it("엔진 하나가 실패해도 남은 엔진을 계속 측정한다", async () => {
    const visited = [];
    const blocked = [];
    const outcome = await runEngineCoverage({
      engines: ENGINES,
      runEngine: async (engine) => {
        visited.push(engine);
        if (engine === "browser") throw new Error("mount lost");
        return 1;
      },
      blockEngine: (engine, reason) => blocked.push({ engine, reason }),
    });
    expect(visited).toEqual(ENGINES);
    expect(blocked).toEqual([{ engine: "browser", reason: "mount lost" }]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].engine).toBe("browser");
  });

  it("실패가 없으면 차단을 기록하지 않고 결과를 합산한다", async () => {
    const blocked = [];
    const outcome = await runEngineCoverage({
      engines: ENGINES,
      runEngine: async () => 48,
      blockEngine: (engine, reason) => blocked.push({ engine, reason }),
    });
    expect(blocked).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.total).toBe(144);
  });

  it("엔진을 순차로만 실행한다", async () => {
    let live = 0;
    let maxLive = 0;
    await runEngineCoverage({
      engines: ENGINES,
      runEngine: async () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await new Promise((resolve) => setImmediate(resolve));
        live -= 1;
        return 0;
      },
      blockEngine: () => {},
    });
    expect(maxLive).toBe(1);
  });

  it("차단 기록이 실패하면 원인 실패와 함께 드러낸다", async () => {
    const outcome = await runEngineCoverage({
      engines: ["browser"],
      runEngine: async () => {
        throw new Error("mount lost");
      },
      blockEngine: () => {
        throw new Error("report frozen");
      },
    });
    expect(outcome.failures).toHaveLength(1);
    expect(String(outcome.failures[0].error.message)).toContain("mount lost");
    expect(String(outcome.failures[0].error.message)).toContain("report frozen");
  });
});
