// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  gateAppliesTo,
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_FRAMEWORKS,
  BROWSER_ACCEPTANCE_GATES,
  createBrowserGateReport,
  machineGateSummary,
  setMachineGateStatus,
} from "./browser-gates.mjs";
import {
  acceptanceCoverage,
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
  nativeChildWebview: true,
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

describe("acceptanceCoverage", () => {
  it("한 프레임워크만 제출하면 나머지 프레임워크를 미측정으로 이름지어 센다", () => {
    const coverage = acceptanceCoverage([createBrowserGateReport(IDENTITY)]);
    expect(coverage.required).toBe(72);
    expect(coverage.measured).toBe(36);
    expect(coverage.missingFrameworks).toEqual(["electron"]);
    expect(coverage.status).not.toBe("green");
  });

  it("같은 프레임워크를 두 번 제출해도 인수 커버리지가 차지 않는다", () => {
    const coverage = acceptanceCoverage([
      createBrowserGateReport(IDENTITY),
      createBrowserGateReport({ ...IDENTITY, runId: "run-id-second" }),
    ]);
    expect(coverage.missingFrameworks).toEqual(["electron"]);
    expect(coverage.measured).toBe(36);
  });

  it("두 프레임워크가 모두 있어도 green 이 아닌 셀이 있으면 green 이 아니다", () => {
    const coverage = acceptanceCoverage([
      createBrowserGateReport(IDENTITY),
      createBrowserGateReport({ ...IDENTITY, framework: "electron" }),
    ]);
    expect(coverage.missingFrameworks).toEqual([]);
    expect(coverage.required).toBe(72);
    expect(coverage.green).toBe(0);
    expect(coverage.status).toBe("not-run");
  });

  it("적용 대상이 아닌 셀은 요구 수에서 뺀다", () => {
    const coverage = acceptanceCoverage([
      createBrowserGateReport({ ...IDENTITY, platform: "linux" }),
      createBrowserGateReport({ ...IDENTITY, platform: "linux", framework: "electron" }),
    ]);
    expect(coverage.required).toBe(66);
  });

  it("보고서가 하나도 없으면 아무것도 측정되지 않았다고 답한다", () => {
    const coverage = acceptanceCoverage([]);
    expect(coverage.measured).toBe(0);
    expect(coverage.missingFrameworks).toEqual(["tauri", "electron"]);
    expect(coverage.status).toBe("not-run");
  });

  it("서로 다른 빌드의 보고서를 한 인수 합계로 섞지 않는다", () => {
    expect(() => acceptanceCoverage([
      createBrowserGateReport(IDENTITY),
      createBrowserGateReport({ ...IDENTITY, framework: "electron", buildId: "other-build" }),
    ])).toThrow(/buildId/);
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

/** 정본 문서가 커버리지 축을 실제로 적었는지 값으로 확인한다.
 *
 * 축이 하나 늘면 두 수가 함께 움직인다 — 문서가 옛 수를 들고 있으면 여기서 RED 다.
 * 이름(`missingFrameworks`)은 재지 않은 프레임워크가 0 이 아니라 이름으로 남는다는 사실의 주소다. */
const CELLS_PER_FRAMEWORK = BROWSER_ACCEPTANCE_ENGINES.length * BROWSER_ACCEPTANCE_GATES.length;
const ACCEPTANCE_CELLS = CELLS_PER_FRAMEWORK * BROWSER_ACCEPTANCE_FRAMEWORKS.length;

function acceptanceSections() {
  return ["../../../docs/TESTING.ko.md", "../../../docs/TESTING.md"].map((path) => {
    const document = readFileSync(new URL(path, import.meta.url), "utf8");
    const heading = document.indexOf("B01–B12");
    expect(heading).toBeGreaterThan(-1);
    const nextHeading = document.indexOf("\n## ", heading + 1);
    return document.slice(heading, nextHeading === -1 ? undefined : nextHeading);
  });
}

describe("정본 문서의 인수 커버리지 선언", () => {
  it("한 프레임워크의 칸 수와 프레임워크 전부의 합을 함께 적는다", () => {
    // 맨 숫자는 titlebar 높이 같은 남의 수치와 구별되지 않는다 — 칸을 세는 자리에서만 인정한다.
    const cellCount = (count) => new RegExp(`${count}(칸|\\s*cells)`);
    for (const section of acceptanceSections()) {
      expect(section).toMatch(cellCount(CELLS_PER_FRAMEWORK));
      expect(section).toMatch(cellCount(ACCEPTANCE_CELLS));
    }
  });

  it("제출되지 않은 프레임워크를 이름으로 남기는 축을 적는다", () => {
    for (const section of acceptanceSections()) {
      expect(section).toContain("missingFrameworks");
    }
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


// 규칙 — 해당 여부는 선언된 능력에서 파생한다. 프레임워크 이름으로 가르지 않는다.
//
// 인수는 프레임워크마다 36칸을 요구하지만, 모든 칸이 모든 프레임워크에 해당하지는 않는다.
// B09 는 "rail 의 + 버튼, 우측 sidebar, modal 은 **native browser surface 위에** 합성된다" 를
// 요구한다 — 네이티브 자식 표면이 없는 프레임워크(engineProvision.nativeChildWebview=false)에는
// 그 사실 자체가 없다. 없는 사실을 red 로 칠하면 달성 불가능한 기준이 되고, green 으로 세면
// 재지 않은 칸이 통과로 잡힌다. 둘 다 틀렸다 — not-applicable 이 답이다.
//
// 이름으로 가르면 프레임워크가 하나 늘 때마다 갈래가 늘고 새 이름은 자기 자리를 못 찾는다.
// 그래서 선언된 능력으로 가른다. 그 능력은 앱이 framework.provision 으로 답한다.
describe("게이트 해당 여부", () => {
  it("네이티브 자식 표면을 요구하는 칸은 그 능력이 없으면 해당하지 않는다", () => {
    expect(gateAppliesTo({ platform: "darwin", nativeChildWebview: false }, "B09")).toBe(false);
    expect(gateAppliesTo({ platform: "darwin", nativeChildWebview: true }, "B09")).toBe(true);
  });

  it("그 능력과 무관한 칸은 두 프레임워크 모두에 해당한다", () => {
    for (const gate of ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B10", "B11"]) {
      expect(gateAppliesTo({ platform: "darwin", nativeChildWebview: false }, gate)).toBe(true);
      expect(gateAppliesTo({ platform: "darwin", nativeChildWebview: true }, gate)).toBe(true);
    }
  });

  it("B12 는 플랫폼 축을 그대로 지킨다 — 두 프레임워크 모두 자기 방식으로 증명한다", () => {
    expect(gateAppliesTo({ platform: "darwin", nativeChildWebview: false }, "B12")).toBe(true);
    expect(gateAppliesTo({ platform: "linux", nativeChildWebview: true }, "B12")).toBe(false);
  });

  // 선언을 못 읽은 것을 "능력 없음" 으로 읽으면 재야 할 칸이 조용히 사라진다.
  it("능력을 선언하지 않았으면 해당 여부를 답하지 않는다", () => {
    expect(() => gateAppliesTo({ platform: "darwin" }, "B09")).toThrow(/nativeChildWebview/);
  });
});

// 규칙 — 판정 대상은 자기 능력을 신원에 담는다.
//
// 해당 여부가 능력에서 파생하는데 신원이 그 능력을 안 담으면, 판정하는 자리마다 능력을 다시
// 물어야 하고 그 물음이 갈리면 같은 칸이 자리마다 다른 답을 받는다. 신원은 buildId·runId 처럼
// 그 실행이 무엇을 잰 것인지 말하는 자리다 — 능력도 그 사실이다.
describe("보고서 신원이 능력을 담는다", () => {
  it("네이티브 자식 표면이 없는 실행에서 B09 는 not-applicable 이다", () => {
    const report = createBrowserGateReport({
      framework: "electron",
      platform: "darwin",
      buildId: "b",
      runId: "r",
      nativeChildWebview: false,
    });
    expect(report.engines.browser.B09.machine.status).toBe("not-applicable");
    expect(report.engines.browser.B09.machine.reason).toContain("nativeChildWebview");
    // 그 능력과 무관한 칸은 그대로 재야 한다.
    expect(report.engines.browser.B04.machine.status).toBe("not-run");
  });

  it("네이티브 자식 표면이 있는 실행에서 B09 는 재야 할 칸이다", () => {
    const report = createBrowserGateReport({
      framework: "tauri",
      platform: "darwin",
      buildId: "b",
      runId: "r",
      nativeChildWebview: true,
    });
    expect(report.engines.browser.B09.machine.status).toBe("not-run");
  });

  it("능력을 선언하지 않은 신원은 보고서를 열지 못한다", () => {
    expect(() => createBrowserGateReport({
      framework: "tauri", platform: "darwin", buildId: "b", runId: "r",
    })).toThrow(/nativeChildWebview/);
  });
});
