// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_GATES,
  B02_RETENTION_PHASES,
  MACHINE_GATE_STATUSES,
  VISUAL_REVIEW_STATUSES,
  createBrowserGateReport,
  judgeB01MachineEvidence,
  judgeB02MachineEvidence,
  judgeB11MachineEvidence,
  judgeBrowserMachineGateEvidence,
  machineGateSummary,
  serializeBrowserGateReport,
  setMachineGateStatus,
  setVisualReviewStatus,
  visualReviewSummary,
} from "./browser-gates.mjs";

function b01Evidence(engine = "browser") {
  return {
    engine,
    tabs: ["left", "right"].map((side) => {
      const viewId = `${engine}-${side}`;
      const expectedUrl = `https://fixture.invalid/${engine}/${side}`;
      return {
        viewId,
        expectedUrl,
        mounted: true,
        toolbarAddress: { dataNode: "urlbar", value: expectedUrl },
        pageIdentity: { viewId, url: expectedUrl },
        commandReceipt: { requestedViewId: viewId, returnedViewId: viewId },
      };
    }),
  };
}

function b02Evidence(engine = "browser") {
  return {
    engine,
    tabs: ["left", "right"].map((side) => {
      const expectedText = `한글 입력 ${side === "left" ? "왼쪽" : "오른쪽"}`;
      return {
        viewId: `${engine}-${side}`,
        expectedText,
        phases: Object.fromEntries(B02_RETENTION_PHASES.map((phase, index) => [
          phase,
          {
            value: expectedText,
            active: phase === "initial" ? true : index % 2 === 0,
            ledger: {
              beforeInput: 1 + index,
              inputEvents: 1 + index,
              values: [expectedText, expectedText],
            },
          },
        ])),
      };
    }),
  };
}

function b11Evidence(engine = "browser") {
  return {
    engine,
    tabs: ["left", "right"].map((side, index) => {
      const viewId = `${engine}-${side}`;
      const page = {
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 640 + index * 40,
        viewportHeight: 480,
        documentWidth: 640 + index * 40,
        documentHeight: 1600 + index * 100,
      };
      return {
        viewId,
        wheel: { positions: [0, 480, 0] },
        capture: {
          before: page,
          receipt: {
            requestedViewId: viewId,
            returnedViewId: viewId,
            requestedPath: `/evidence/${engine}/${side}-full.png`,
            returnedPath: `/evidence/${engine}/${side}-full.png`,
            reportedBytes: 4096 + index,
            fileBytes: 4096 + index,
            width: page.documentWidth,
            docHeight: page.documentHeight,
          },
          after: { ...page },
        },
      };
    }),
  };
}

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

  it("B01은 각 engine/tab의 mount·공개 주소 input·페이지 신원·명시 view 영수증이 모두 맞아야 green이다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB01MachineEvidence(b01Evidence(engine))).toMatchObject({ status: "green", reason: null });
    }

    expect(judgeB01MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
    expect(judgeB01MachineEvidence({ engine: "browser", tabs: [] }).status).toBe("red");

    const cases = [
      (evidence) => { evidence.tabs[0].mounted = false; },
      (evidence) => { evidence.tabs[0].toolbarAddress.value = "about:blank"; },
      (evidence) => { evidence.tabs[0].toolbarAddress.dataNode = "private-urlbar"; },
      (evidence) => { evidence.tabs[0].pageIdentity.url = "about:blank"; },
      (evidence) => { evidence.tabs[0].pageIdentity.viewId = evidence.tabs[1].viewId; },
      (evidence) => { evidence.tabs[0].commandReceipt.returnedViewId = evidence.tabs[1].viewId; },
      (evidence) => { delete evidence.tabs[0].commandReceipt.requestedViewId; },
    ];
    for (const mutate of cases) {
      const evidence = b01Evidence();
      mutate(evidence);
      expect(judgeB01MachineEvidence(evidence).status).toBe("red");
    }
  });

  it("B02는 두 탭의 최초·FLOW 양방향·window resize·pane 왕복 전 단계에서 IME ledger를 보존해야 green이다", () => {
    expect(B02_RETENTION_PHASES).toEqual([
      "initial",
      "flow-left",
      "flow-right",
      "hostile-window-resize",
      "pane-wider",
      "pane-restored",
    ]);
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB02MachineEvidence(b02Evidence(engine)).status).toBe("green");
    }

    expect(judgeB02MachineEvidence(undefined)).toEqual({ status: "not-run", evidence: [], reason: null });
    const missingPhase = b02Evidence();
    delete missingPhase.tabs[0].phases["flow-right"];
    expect(judgeB02MachineEvidence(missingPhase).status).toBe("red");

    const inactiveInitial = b02Evidence();
    inactiveInitial.tabs[0].phases.initial.active = false;
    expect(judgeB02MachineEvidence(inactiveInitial).status).toBe("red");

    const changedValue = b02Evidence();
    changedValue.tabs[1].phases["pane-restored"].value = "한글 유실";
    expect(judgeB02MachineEvidence(changedValue).status).toBe("red");

    const regressedCounts = b02Evidence();
    regressedCounts.tabs[0].phases.initial.ledger.beforeInput = 9;
    regressedCounts.tabs[0].phases["flow-left"].ledger.beforeInput = 8;
    expect(judgeB02MachineEvidence(regressedCounts).status).toBe("red");

    const stringCount = b02Evidence();
    stringCount.tabs[0].phases["pane-wider"].ledger.inputEvents = "5";
    expect(judgeB02MachineEvidence(stringCount).status).toBe("red");

    const wrongLedgerTail = b02Evidence();
    wrongLedgerTail.tabs[0].phases["hostile-window-resize"].ledger.values.push("깨짐");
    expect(judgeB02MachineEvidence(wrongLedgerTail).status).toBe("red");
  });

  it("B11은 두 탭 모두 exact wheel 왕복과 explicit-view full capture 영수증·전후 페이지 불변성을 증명해야 green이다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB11MachineEvidence(b11Evidence(engine)).status).toBe("green");
    }

    expect(judgeB11MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
    expect(judgeB11MachineEvidence({ engine: "browser", tabs: [] }).status).toBe("red");

    const wrongWheel = b11Evidence();
    wrongWheel.tabs[0].wheel.positions = [0, 479, 0];
    expect(judgeB11MachineEvidence(wrongWheel).status).toBe("red");

    const wrongView = b11Evidence();
    wrongView.tabs[0].capture.receipt.returnedViewId = wrongView.tabs[1].viewId;
    expect(judgeB11MachineEvidence(wrongView).status).toBe("red");

    for (const field of [
      "requestedPath", "returnedPath", "reportedBytes", "fileBytes", "width", "docHeight",
    ]) {
      const missingReceipt = b11Evidence();
      delete missingReceipt.tabs[0].capture.receipt[field];
      expect(judgeB11MachineEvidence(missingReceipt).status).toBe("red");
    }

    const wrongPathAndBytes = b11Evidence();
    wrongPathAndBytes.tabs[0].capture.receipt.returnedPath = "/evidence/wrong.png";
    wrongPathAndBytes.tabs[0].capture.receipt.fileBytes += 1;
    expect(judgeB11MachineEvidence(wrongPathAndBytes).status).toBe("red");

    const changedScroll = b11Evidence();
    changedScroll.tabs[0].capture.after.scrollY = 480;
    expect(judgeB11MachineEvidence(changedScroll).status).toBe("red");

    const changedDimensions = b11Evidence();
    changedDimensions.tabs[1].capture.after.documentHeight += 1;
    expect(judgeB11MachineEvidence(changedDimensions).status).toBe("red");

    const pixelInput = b11Evidence();
    pixelInput.tabs[0].capture.receipt.markerPixels = { red: 64 };
    expect(judgeB11MachineEvidence(pixelInput).status).toBe("red");
  });

  it("gate별 순수 판정은 evidence가 없으면 not-run, 불완전하면 red이며 visualReview와 PNG를 입력으로 받지 않는다", () => {
    expect(judgeBrowserMachineGateEvidence("B01", undefined).status).toBe("not-run");
    expect(judgeBrowserMachineGateEvidence("B02", { engine: "browser" }).status).toBe("red");
    expect(judgeBrowserMachineGateEvidence("B11", b11Evidence()).status).toBe("green");
    expect(() => judgeBrowserMachineGateEvidence("B03", {})).toThrow(/B01, B02, B11/);

    const machine = judgeB11MachineEvidence(b11Evidence());
    let report = setMachineGateStatus(createBrowserGateReport(), {
      engine: "browser",
      gate: "B11",
      ...machine,
    });
    report = setVisualReviewStatus(report, {
      engine: "browser",
      gate: "B11",
      status: "failed",
      artifacts: ["evidence/browser/full.png"],
      notes: "사람의 PNG 검토 실패는 별도 시각 판정이다",
    });
    expect(report.engines.browser.B11.machine.status).toBe("green");
    expect(report.engines.browser.B11.visualReview.status).toBe("failed");
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
