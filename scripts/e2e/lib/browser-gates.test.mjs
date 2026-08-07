// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_FRAMEWORKS,
  BROWSER_ACCEPTANCE_PLATFORMS,
  BROWSER_ACCEPTANCE_GATES,
  B02_RETENTION_PHASES,
  MACHINE_GATE_STATUSES,
  VISUAL_REVIEW_STATUSES,
  createBrowserGateReport,
  judgeB01MachineEvidence,
  judgeB02MachineEvidence,
  judgeB03MachineEvidence,
  judgeB04MachineEvidence,
  judgeB11MachineEvidence,
  judgeBrowserMachineGateEvidence,
  machineGateSummary,
  serializeBrowserGateReport,
  setMachineGateStatus,
  setVisualReviewStatus,
  visualReviewSummary,
} from "./browser-gates.mjs";

const TAURI_RUN = Object.freeze({
  framework: "tauri",
  platform: "darwin",
  buildId: "tauri-dev-build-a1",
  runId: "browser-gates-tauri-run-1",
});

const ELECTRON_RUN = Object.freeze({
  framework: "electron",
  platform: "darwin",
  buildId: "electron-dev-build-b1",
  runId: "browser-gates-electron-run-1",
});

const LINUX_RUN = Object.freeze({
  framework: "tauri",
  platform: "linux",
  buildId: "tauri-linux-build-c1",
  runId: "browser-gates-linux-run-1",
});

function createReport(identity = TAURI_RUN) {
  return createBrowserGateReport(identity);
}

function judgeReceipt(options = {}) {
  const {
    identity = TAURI_RUN,
    engine = "browser",
    gate = "B01",
  } = options;
  const evidence = Object.hasOwn(options, "evidence") ? options.evidence
    : gate === "B01" ? b01Evidence(engine)
      : gate === "B02" ? b02Evidence(engine)
        : gate === "B03" ? b03Evidence(engine)
          : gate === "B04" ? b04Evidence(engine)
            : b11Evidence(engine);
  return judgeBrowserMachineGateEvidence({
    ...identity,
    engine,
    gate,
    evidence,
  });
}

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

function b03Evidence(engine = "browser") {
  const scaleFactor = 2;
  const physicalFrame = ({ x, y, w, h }) => {
    const left = Math.round(x * scaleFactor);
    const top = Math.round(y * scaleFactor);
    const right = Math.round((x + w) * scaleFactor);
    const bottom = Math.round((y + h) * scaleFactor);
    return { x: left, y: top, w: right - left, h: bottom - top };
  };
  const viewFrames = [
    ["left", { x: 100.25, y: 80.25, w: 320.5, h: 480.25 }],
    ["right", { x: 440.25, y: 80.25, w: 360.5, h: 480.25 }],
  ];
  const participant = (kind, viewId, logicalFrame) => ({
    id: `${kind}-${engine}-${viewId}`,
    viewId: `${engine}-${viewId}`,
    topologyPath: `workspace/pane/${viewId}/content`,
    visible: true,
    logicalFrame: { ...logicalFrame },
    physicalFrame: physicalFrame(logicalFrame),
  });
  return {
    engine,
    coordinateSpace: { logical: "css-px", physical: "device-px", scaleFactor },
    visibleViewIds: viewFrames.map(([viewId]) => `${engine}-${viewId}`),
    slots: viewFrames.map(([viewId, frame]) => participant("slot", viewId, frame)),
    renderers: viewFrames.map(([viewId, frame]) => participant("renderer", viewId, frame)),
    surfaces: viewFrames.map(([viewId, frame]) => participant("surface", viewId, frame)),
  };
}

function b04Evidence(engine = "browser") {
  const transition = ({ direction, target, mode, sequence, positions }) => {
    const transactionId = `${engine}-${direction}-${sequence}`;
    const sample = (x, index) => {
      const participant = (id, frame) => ({
        id,
        ownerViewId: target,
        connected: true,
        frame,
      });
      return {
        transactionId,
        sequence: index,
        phase: index === 0 ? "prepared" : index === positions.length - 1 ? "committed" : "presenting",
        sampledAtUnixMs: 1_000 + sequence * 100 + index * 16,
        rail: participant("rail-left", { x: x - 100, y: 40, w: 80, h: 520 }),
        pane: participant(`pane-${target}`, { x, y: 40, w: 320, h: 520 }),
        slot: participant(`slot-${target}`, { x: x + 8, y: 96, w: 304, h: 456 }),
        renderer: participant(`renderer-${target}`, { x: x + 8, y: 96, w: 304, h: 456 }),
        surface: participant(`surface-${target}`, { x: x + 8, y: 96, w: 304, h: 456 }),
      };
    };
    const baseAt = 1_000 + sequence * 100;
    const timelineSample = (x, sampledAtUnixMs, index) => ({
      sequence: index,
      sampledAtUnixMs,
      frame: { x: x + 8, y: 96, w: 304, h: 456 },
    });
    const nativePositions = mode === "glide" ? [100, 180, 260, 340, 420] : [];
    return {
      direction,
      targetViewId: target,
      motionMode: mode,
      journal: {
        afterSequence: sequence - 1,
        entries: [{
          transactionId,
          sequence,
          phase: "committed",
          mode,
          startAtUnixMs: mode === "glide" ? 1_000 + sequence * 100 : null,
          durationMs: mode === "glide" ? 32 : null,
          preparedAtUnixMs: 1_000 + sequence * 100,
          domCommittedAtUnixMs: 1_000 + sequence * 100 + 24,
          closedAtUnixMs: 1_000 + sequence * 100 + 48,
          moves: [{ viewId: target, dx: positions[0] - positions.at(-1) }],
        }],
      },
      samples: positions.map(sample),
      timeline: mode === "glide" ? {
        startAtUnixMs: baseAt,
        durationMs: 32,
        timingFunction: [0, 0, 1, 1],
        from: { x: 108, y: 96, w: 304, h: 456 },
        to: { x: 428, y: 96, w: 304, h: 456 },
        slot: positions.map((x, index) => timelineSample(x, baseAt + index * 16, index)),
        renderer: nativePositions.map((x, index) => timelineSample(x, baseAt + index * 8, index)),
        surface: nativePositions.map((x, index) => timelineSample(x, baseAt + index * 8, index)),
      } : null,
    };
  };
  return {
    engine,
    coordinateSpace: { logical: "css-px", scaleFactor: 2 },
    transitions: [
      transition({
        direction: "to-right",
        target: `${engine}-right`,
        mode: "glide",
        sequence: 4,
        positions: [100, 260, 420],
      }),
      transition({
        direction: "to-left",
        target: `${engine}-left`,
        mode: "snap",
        sequence: 5,
        positions: [420, 100],
      }),
    ],
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
    expect(BROWSER_ACCEPTANCE_FRAMEWORKS).toEqual(["tauri", "electron"]);
    expect(BROWSER_ACCEPTANCE_PLATFORMS).toEqual(["darwin", "linux", "win32"]);
    expect(BROWSER_ACCEPTANCE_ENGINES).toEqual([
      "browser",
      "browser-chromium",
      "browser-chromium-offscreen",
    ]);
    expect(BROWSER_ACCEPTANCE_GATES.map(({ id, name }) => [id, name])).toEqual(expectedGateNames);
    expect(MACHINE_GATE_STATUSES).toEqual(["not-applicable", "not-run", "blocked", "red", "green"]);
    expect(VISUAL_REVIEW_STATUSES).toEqual(["not-applicable", "pending", "passed", "failed"]);
    expect(BROWSER_ACCEPTANCE_GATES.find(({ id }) => id === "B12")?.contract).toContain("Tauri");
    expect(BROWSER_ACCEPTANCE_GATES.find(({ id }) => id === "B12")?.contract).toContain("Electron");
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

  it("B03은 visible owner와 독립 slot·renderer·surface inventory가 양 좌표계에서 rounding-only 1:1이어야 green이다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB03MachineEvidence(b03Evidence(engine))).toMatchObject({ status: "green", reason: null });
    }
    expect(judgeB03MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });

    const missingSurface = b03Evidence();
    missingSurface.surfaces.pop();
    expect(judgeB03MachineEvidence(missingSurface).status).toBe("red");

    const omittedVisibleOwner = b03Evidence();
    omittedVisibleOwner.visibleViewIds.push("browser-omitted");
    expect(judgeB03MachineEvidence(omittedVisibleOwner).status).toBe("red");

    const wrongTopology = b03Evidence();
    wrongTopology.renderers[0].topologyPath = "workspace/pane/wrong/content";
    expect(judgeB03MachineEvidence(wrongTopology).status).toBe("red");

    const onePhysicalPixel = b03Evidence();
    onePhysicalPixel.surfaces[0].physicalFrame.x += 1;
    expect(judgeB03MachineEvidence(onePhysicalPixel).status).toBe("red");

    const pixelContamination = b03Evidence();
    pixelContamination.surfaces[0].markerPixels = { cyan: 64 };
    expect(judgeB03MachineEvidence(pixelContamination).status).toBe("red");
  });

  it("B04는 FLOW 양방향에서 한 layout 거래와 같은 유한 tick의 rail·pane·surface 원자 이동만 green이다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB04MachineEvidence(b04Evidence(engine))).toMatchObject({ status: "green", reason: null });
    }
    expect(judgeB04MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });

    const missingDirection = b04Evidence();
    missingDirection.transitions.pop();
    expect(judgeB04MachineEvidence(missingDirection).status).toBe("red");

    const lateSurface = b04Evidence();
    lateSurface.transitions[0].samples[1].surface.frame.x -= 160;
    expect(judgeB04MachineEvidence(lateSurface).status).toBe("red");

    const replacedPane = b04Evidence();
    replacedPane.transitions[1].samples[1].pane.id = "replacement-pane";
    expect(judgeB04MachineEvidence(replacedPane).status).toBe("red");

    const duplicateTransaction = b04Evidence();
    duplicateTransaction.transitions[0].journal.entries.push({
      ...duplicateTransaction.transitions[0].journal.entries[0],
      transactionId: "unexpected-second-transaction",
      sequence: 5,
    });
    expect(judgeB04MachineEvidence(duplicateTransaction).status).toBe("red");

    const wrongMove = b04Evidence();
    wrongMove.transitions[0].journal.entries[0].moves[0].dx += 10;
    expect(judgeB04MachineEvidence(wrongMove).status).toBe("red");

    const missingDomCommit = b04Evidence();
    delete missingDomCommit.transitions[0].journal.entries[0].domCommittedAtUnixMs;
    expect(judgeB04MachineEvidence(missingDomCommit).status).toBe("red");

    const pixelContamination = b04Evidence();
    pixelContamination.transitions[0].samples[0].framePixels = [0, 0, 0];
    expect(judgeB04MachineEvidence(pixelContamination).status).toBe("red");

    const malformedParticipant = b04Evidence();
    malformedParticipant.transitions[0].samples[1].pane = null;
    expect(judgeB04MachineEvidence(malformedParticipant).status).toBe("red");
  });

  it("B04는 거래 장부 구간 밖에서 관측한 sample을 좌표가 맞아도 epoch 거리로 거절한다", () => {
    // 실측(evidence/slot-freeze/last-red/browser/01-left): native display producer가
    // 4,041,616ms 뒤처진 epoch를 냈고, 좌표만 보는 판정은 이 receipt를 green으로 통과시켰다.
    const skewMs = 4_041_616.4294433594;
    const foreignEpoch = b04Evidence();
    for (const sample of foreignEpoch.transitions[0].samples) sample.sampledAtUnixMs -= skewMs;
    const verdict = judgeB04MachineEvidence(foreignEpoch);
    expect(verdict.status).toBe("red");
    // glide 구간은 [startAtUnixMs, startAtUnixMs+durationMs]다.
    expect(verdict.evidence).toEqual(expect.arrayContaining([
      "B04:transitions[0].samples:presentation:window-gap=4041584.4294433594",
    ]));

    // snap 거래는 선언된 표시 구간이 없으므로 prepared~closed가 그 거래의 관측 구간이다.
    const lateEpoch = b04Evidence();
    for (const sample of lateEpoch.transitions[1].samples) sample.sampledAtUnixMs += skewMs;
    expect(judgeB04MachineEvidence(lateEpoch).evidence).toEqual(expect.arrayContaining([
      "B04:transitions[1].samples:presentation:window-gap=4041568.4294433594",
    ]));
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
    expect(judgeReceipt({ gate: "B01", evidence: undefined }).status).toBe("not-run");
    expect(judgeReceipt({ gate: "B02", evidence: { engine: "browser" } }).status).toBe("red");
    expect(judgeReceipt({ gate: "B11" }).status).toBe("green");
    expect(judgeReceipt({ gate: "B03" }).status).toBe("green");
    expect(judgeReceipt({ gate: "B04" }).status).toBe("green");

    const receipt = judgeReceipt({ gate: "B11" });
    let report = setMachineGateStatus(createReport(), {
      engine: "browser",
      gate: "B11",
      judgeReceipt: receipt,
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
    const report = createReport();

    expect(report.schemaVersion).toBe(3);
    expect(report.identity).toEqual(TAURI_RUN);
    expect(Object.keys(report.engines)).toEqual(BROWSER_ACCEPTANCE_ENGINES);
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(Object.keys(report.engines[engine])).toEqual(expectedGateNames.map(([id]) => id));
      for (const gate of BROWSER_ACCEPTANCE_GATES) {
        expect(report.engines[engine][gate.id]).toEqual({
          machine: { status: "not-run", evidence: [], reason: null, judgeReceipt: null },
          visualReview: { status: "pending", artifacts: [], notes: null },
        });
      }
    }
    expect(machineGateSummary(report)).toEqual({
      status: "not-run",
      total: 36,
      required: 36,
      counts: { "not-applicable": 0, "not-run": 36, blocked: 0, red: 0, green: 0 },
    });
    expect(visualReviewSummary(report)).toEqual({
      status: "pending",
      total: 36,
      required: 36,
      counts: { "not-applicable": 0, pending: 36, passed: 0, failed: 0 },
    });
  });

  it("macOS 전용 B12는 다른 플랫폼에서 숨기지 않고 정적 not-applicable로 기록한다", () => {
    const report = createReport(LINUX_RUN);
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(report.engines[engine].B12).toEqual({
        machine: {
          status: "not-applicable",
          evidence: [],
          reason: "B12 applies only to macOS traffic lights",
          judgeReceipt: null,
        },
        visualReview: {
          status: "not-applicable",
          artifacts: [],
          notes: "B12 applies only to macOS traffic lights",
        },
      });
    }
    expect(machineGateSummary(report)).toEqual({
      status: "not-run",
      total: 36,
      required: 33,
      counts: { "not-applicable": 3, "not-run": 33, blocked: 0, red: 0, green: 0 },
    });
    expect(visualReviewSummary(report)).toEqual({
      status: "pending",
      total: 36,
      required: 33,
      counts: { "not-applicable": 3, pending: 33, passed: 0, failed: 0 },
    });
    expect(() => setMachineGateStatus(report, {
      engine: "browser",
      gate: "B12",
      status: "blocked",
      reason: "override",
    })).toThrow(/not applicable/);
    expect(() => setVisualReviewStatus(report, {
      engine: "browser",
      gate: "B12",
      status: "failed",
      artifacts: ["fake.png"],
    })).toThrow(/not applicable/);

    const forgedApplicable = structuredClone(report);
    forgedApplicable.engines.browser.B12.machine = {
      status: "not-run", evidence: [], reason: null, judgeReceipt: null,
    };
    expect(() => serializeBrowserGateReport(forgedApplicable)).toThrow(/static not-applicable/);

    const forgedAbsence = structuredClone(createReport());
    forgedAbsence.engines.browser.B01.machine = {
      status: "not-applicable", evidence: [], reason: "forged", judgeReceipt: null,
    };
    expect(() => serializeBrowserGateReport(forgedAbsence)).toThrow(/applicable/);
    expect(() => setMachineGateStatus(createReport(), {
      engine: "browser",
      gate: "B01",
      status: "not-applicable",
    })).toThrow(/derived/);
  });

  it("framework/build/run identity가 없거나 모호하면 보고서와 judge를 만들지 않는다", () => {
    expect(() => createBrowserGateReport()).toThrow(/identity/);
    expect(() => createBrowserGateReport({ ...TAURI_RUN, framework: "unknown" })).toThrow(/framework/);
    expect(() => createBrowserGateReport({ ...TAURI_RUN, platform: "unknown" })).toThrow(/platform/);
    expect(() => createBrowserGateReport({ ...TAURI_RUN, buildId: " build " })).toThrow(/buildId/);
    expect(() => createBrowserGateReport({ ...TAURI_RUN, extra: "ignored" })).toThrow(/exactly/);
    expect(() => judgeBrowserMachineGateEvidence({
      ...TAURI_RUN,
      engine: "browser",
      gate: "B01",
      evidence: b01Evidence(),
      visualReview: "passed",
    })).toThrow(/machine judge request/);
  });

  it("machine 전체는 미판정 cell을 숨기지 않고 red·blocked를 우선 집계한다", () => {
    let report = createReport();
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      const receipt = judgeReceipt({ engine, gate: "B01" });
      report = setMachineGateStatus(report, { engine, gate: "B01", judgeReceipt: receipt });
    }
    expect(machineGateSummary(report)).toMatchObject({
      status: "not-run",
      counts: { "not-run": 33, green: 3 },
    });

    const red = setMachineGateStatus(report, {
      engine: "browser-chromium",
      gate: "B05",
      status: "red",
      evidence: ["presentation.disappearances=1"],
      reason: "착지 후 live surface가 사라졌다",
    });
    expect(machineGateSummary(red)).toMatchObject({
      status: "red",
      counts: { "not-run": 32, red: 1, green: 3 },
    });

    const blocked = setMachineGateStatus(report, {
      engine: "browser-chromium-offscreen",
      gate: "B11",
      status: "blocked",
      reason: "full capture 공개 측정면이 없다",
    });
    expect(machineGateSummary(blocked)).toMatchObject({
      status: "blocked",
      counts: { "not-run": 32, blocked: 1, green: 3 },
    });
  });

  it("green은 같은 framework/build/run/engine/gate에서 judge가 재검증한 receipt로만 기록한다", () => {
    const report = createReport();
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", status: "green", evidence: ["arbitrary-green"],
    })).toThrow(/judgeReceipt/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", judgeReceipt: judgeB01MachineEvidence(b01Evidence()),
    })).toThrow(/judgeReceipt/);

    const valid = judgeReceipt();
    const copied = setMachineGateStatus(report, {
      engine: "browser", gate: "B01", judgeReceipt: { ...valid },
    });
    expect(copied.engines.browser.B01.machine.status).toBe("green");
    const tampered = structuredClone(valid);
    tampered.machineEvidence.tabs[0].mounted = false;
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", judgeReceipt: tampered,
    })).toThrow(/verdict/);
    expect(() => setMachineGateStatus(createReport(ELECTRON_RUN), {
      engine: "browser", gate: "B01", judgeReceipt: valid,
    })).toThrow(/framework/);
    expect(() => setMachineGateStatus(createReport({ ...TAURI_RUN, buildId: "tauri-dev-build-a2" }), {
      engine: "browser", gate: "B01", judgeReceipt: valid,
    })).toThrow(/buildId/);
    expect(() => setMachineGateStatus(createReport({ ...TAURI_RUN, runId: "browser-gates-tauri-run-2" }), {
      engine: "browser", gate: "B01", judgeReceipt: valid,
    })).toThrow(/runId/);
    expect(() => setMachineGateStatus(createReport({ ...TAURI_RUN, platform: "linux" }), {
      engine: "browser", gate: "B01", judgeReceipt: valid,
    })).toThrow(/platform/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser-chromium", gate: "B01", judgeReceipt: valid,
    })).toThrow(/engine/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B02", judgeReceipt: valid,
    })).toThrow(/gate/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", judgeReceipt: valid, extra: "ignored",
    })).toThrow(/only/);

    const green = setMachineGateStatus(report, {
      engine: "browser", gate: "B01", judgeReceipt: valid,
    });
    expect(green.engines.browser.B01.machine).toEqual({
      status: "green",
      evidence: valid.evidence,
      reason: null,
      judgeReceipt: valid,
    });

    const wrongEvidenceEngine = judgeReceipt({
      engine: "browser",
      evidence: b01Evidence("browser-chromium"),
    });
    expect(wrongEvidenceEngine.status).toBe("red");
    const red = setMachineGateStatus(report, {
      engine: "browser", gate: "B01", judgeReceipt: wrongEvidenceEngine,
    });
    expect(red.engines.browser.B01.machine.status).toBe("red");

    const electronReceipt = judgeReceipt({ identity: ELECTRON_RUN });
    const electron = setMachineGateStatus(createReport(ELECTRON_RUN), {
      engine: "browser", gate: "B01", judgeReceipt: electronReceipt,
    });
    expect(electron.identity.framework).toBe("electron");
    expect(electron.engines.browser.B01.machine.status).toBe("green");
  });

  it("근거 없는 red와 이유 없는 blocked를 거부해 기준 약화를 막는다", () => {
    const report = createReport();
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
      engine: "unknown", gate: "B01", status: "red", evidence: ["x"],
    })).toThrow(/engine/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B13", status: "red", evidence: ["x"],
    })).toThrow(/gate/);
    expect(() => setMachineGateStatus(report, {
      engine: "browser", gate: "B01", status: "red", evidence: ["x"], extra: "ignored",
    })).toThrow(/only/);
  });

  it("시각 검토는 기록하되 machine gate 판정에는 영향을 주지 않는다", () => {
    const initial = createReport();
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
    const report = setMachineGateStatus(createReport(), {
      engine: "browser",
      gate: "B01",
      status: "red",
      evidence: ["addressBar.present=false"],
      reason: "주소표시줄이 없다",
    });
    const serialized = serializeBrowserGateReport(report);
    const parsed = JSON.parse(serialized);

    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.identity).toEqual(TAURI_RUN);
    expect(parsed.catalog.map(({ id, name }) => [id, name])).toEqual(expectedGateNames);
    expect(Object.keys(parsed.engines)).toEqual(BROWSER_ACCEPTANCE_ENGINES);
    expect(parsed.engines.browser.B01.machine).toEqual(report.engines.browser.B01.machine);
    expect(parsed.summary.machine.status).toBe("red");
    expect(parsed.summary.visualReview.status).toBe("pending");
    expect(report.engines.browser.B01.machine.status).toBe("red");
    expect(serialized).toBe(serializeBrowserGateReport(report));
  });

  it("직렬화된 green receipt도 동일 judge로 재검증되어 집계 가능하다", () => {
    const receipt = judgeReceipt();
    const report = setMachineGateStatus(createReport(), {
      engine: "browser",
      gate: "B01",
      judgeReceipt: receipt,
    });
    const parsed = JSON.parse(serializeBrowserGateReport(report));
    delete parsed.catalog;
    delete parsed.summary;

    expect(machineGateSummary(parsed)).toMatchObject({
      status: "not-run",
      counts: { "not-run": 35, green: 1 },
    });
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
