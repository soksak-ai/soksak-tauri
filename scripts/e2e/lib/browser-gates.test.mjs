// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_GATES,
  MACHINE_GATE_STATUSES,
  VISUAL_REVIEW_STATUSES,
  createBrowserGateReport,
  machineGateSummary,
  serializeBrowserGateReport,
  setMachineGateStatus,
  setVisualReviewStatus,
  visualReviewSummary,
} from "./browser-gates.mjs";

const expectedGateNames = [
  ["B01", "initial-mount-address-page-identity"],
  ["B02", "korean-ime-state-retention"],
  ["B03", "dom-live-surface-one-to-one"],
  ["B04", "flow-atomic-composition"],
  ["B05", "continuous-visible-presentation"],
  ["B06", "focus-lighting"],
  ["B07", "pin-border-layout-invariance"],
  ["B08", "pin-maximize-restore-station"],
  ["B09", "chrome-over-native-layering"],
  ["B10", "hostile-window-resize"],
  ["B11", "pane-resize-scroll-full-capture"],
  ["B12", "traffic-light-composition"],
];

describe("브라우저 12-gate 정본", () => {
  it("B01..B12와 3개 브라우저 구현의 이름·순서를 고정한다", () => {
    expect(BROWSER_ACCEPTANCE_ENGINES).toEqual([
      "browser",
      "browser-chromium",
      "browser-chromium-offscreen",
    ]);
    expect(BROWSER_ACCEPTANCE_GATES.map(({ id, name }) => [id, name])).toEqual(expectedGateNames);
    expect(MACHINE_GATE_STATUSES).toEqual(["not-run", "blocked", "red", "green"]);
    expect(VISUAL_REVIEW_STATUSES).toEqual(["pending", "passed", "failed"]);
  });

  it("새 보고서는 빠짐없는 3×12 not-run과 별도 pending 시각 검토로 시작한다", () => {
    const report = createBrowserGateReport();

    expect(Object.keys(report.engines)).toEqual(BROWSER_ACCEPTANCE_ENGINES);
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(Object.keys(report.engines[engine])).toEqual(expectedGateNames.map(([id]) => id));
      for (const gate of BROWSER_ACCEPTANCE_GATES) {
        expect(report.engines[engine][gate.id]).toEqual({
          machine: { status: "not-run", evidence: [], reason: null },
          visualReview: { status: "pending", artifacts: [], notes: null },
        });
      }
    }
    expect(machineGateSummary(report)).toEqual({
      status: "not-run",
      total: 36,
      counts: { "not-run": 36, blocked: 0, red: 0, green: 0 },
    });
    expect(visualReviewSummary(report)).toEqual({
      status: "pending",
      total: 36,
      counts: { pending: 36, passed: 0, failed: 0 },
    });
  });

  it("36개 machine gate가 전부 green일 때만 machine 전체가 green이다", () => {
    let report = createBrowserGateReport();
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      for (const gate of BROWSER_ACCEPTANCE_GATES) {
        report = setMachineGateStatus(report, {
          engine,
          gate: gate.id,
          status: "green",
          evidence: [`${engine}/${gate.id}:assertions=green`],
        });
      }
    }
    expect(machineGateSummary(report).status).toBe("green");

    const red = setMachineGateStatus(report, {
      engine: "browser-chromium",
      gate: "B05",
      status: "red",
      evidence: ["presentation.disappearances=1"],
      reason: "착지 후 live surface가 사라졌다",
    });
    expect(machineGateSummary(red)).toMatchObject({
      status: "red",
      counts: { red: 1, green: 35 },
    });

    const blocked = setMachineGateStatus(report, {
      engine: "browser-chromium-offscreen",
      gate: "B11",
      status: "blocked",
      reason: "full capture 공개 측정면이 없다",
    });
    expect(machineGateSummary(blocked)).toMatchObject({
      status: "blocked",
      counts: { blocked: 1, green: 35 },
    });
  });

  it("근거 없는 green/red와 이유 없는 blocked를 거부해 기준 약화를 막는다", () => {
    const report = createBrowserGateReport();
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", status: "green",
    })).toThrow(/evidence/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", status: "red",
    })).toThrow(/evidence/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", status: "blocked",
    })).toThrow(/reason/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", status: "not-run", evidence: ["old-green"],
    })).toThrow(/not-run/);
    expect(() => setMachineGateStatus(report, {
      engine: "unknown", gate: "B01", status: "green", evidence: ["x"],
    })).toThrow(/engine/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B13", status: "green", evidence: ["x"],
    })).toThrow(/gate/);
  });

  it("시각 검토는 기록하되 machine gate 판정에는 영향을 주지 않는다", () => {
    const initial = createBrowserGateReport();
    const machineBefore = machineGateSummary(initial);
    const reviewed = setVisualReviewStatus(initial, {
      engine: "browser-chromium",
      gate: "B04",
      status: "failed",
      artifacts: ["evidence/flow-transition.mov"],
      notes: "눈으로 rail보다 surface가 늦게 도착하는 것을 확인",
    });

    expect(machineGateSummary(reviewed)).toEqual(machineBefore);
    expect(visualReviewSummary(reviewed)).toMatchObject({
      status: "failed",
      counts: { pending: 35, passed: 0, failed: 1 },
    });
    expect(reviewed.engines["browser-chromium"].B04.machine.status).toBe("not-run");
  });

  it("직렬화는 catalog와 36개 결과를 고정 순서로 보존하고 입력을 변경하지 않는다", () => {
    const report = setMachineGateStatus(createBrowserGateReport(), {
      engine: "browser",
      gate: "B01",
      status: "red",
      evidence: ["addressBar.present=false"],
      reason: "주소표시줄이 없다",
    });
    const serialized = serializeBrowserGateReport(report);
    const parsed = JSON.parse(serialized);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.catalog.map(({ id, name }) => [id, name])).toEqual(expectedGateNames);
    expect(Object.keys(parsed.engines)).toEqual(BROWSER_ACCEPTANCE_ENGINES);
    expect(parsed.engines.browser.B01.machine).toEqual(report.engines.browser.B01.machine);
    expect(parsed.summary.machine.status).toBe("red");
    expect(parsed.summary.visualReview.status).toBe("pending");
    expect(report.engines.browser.B01.machine.status).toBe("red");
    expect(serialized).toBe(serializeBrowserGateReport(report));
  });

  it("한·영 테스트 정본이 같은 12-gate와 machine/visual 분리를 선언한다", () => {
    const documents = [
      readFileSync(new URL("../../../docs/TESTING.ko.md", import.meta.url), "utf8"),
      readFileSync(new URL("../../../docs/TESTING.md", import.meta.url), "utf8"),
    ];
    const gateIds = expectedGateNames.map(([id]) => id);
    for (const document of documents) {
      const heading = document.indexOf("B01–B12");
      expect(heading).toBeGreaterThan(-1);
      const nextHeading = document.indexOf("\n## ", heading + 1);
      const section = document.slice(heading, nextHeading === -1 ? undefined : nextHeading);
      expect([...section.matchAll(/^\|\s*(B\d{2})\s*\|/gm)].map((match) => match[1])).toEqual(gateIds);
      for (const engine of BROWSER_ACCEPTANCE_ENGINES) expect(section).toContain(`\`${engine}\``);
      for (const status of MACHINE_GATE_STATUSES) expect(section).toContain(`\`${status}\``);
      for (const status of VISUAL_REVIEW_STATUSES) expect(section).toContain(`\`${status}\``);
      expect(section).toMatch(/visualReview/);
    }
  });
});
