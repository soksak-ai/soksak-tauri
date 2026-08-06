// @vitest-environment node
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { browserImplementations } from "./lib/browser-matrix.mjs";

function scenarioGateBodies(source, scenario) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bodies = [];
  const visit = (node) => {
    if (ts.isIfStatement(node)
        && ts.isCallExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.expression.getText(file) === "SCENARIOS"
        && node.expression.expression.name.text === "has"
        && node.expression.arguments.length === 1
        && ts.isStringLiteral(node.expression.arguments[0])
        && node.expression.arguments[0].text === scenario) {
      bodies.push(node.thenStatement.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bodies;
}

function frameworkGuardedRpcCalls(source, command) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)
        && node.expression.getText(file) === "rpc"
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === command) {
      let cursor = node.parent;
      let tauriOnly = false;
      while (cursor) {
        if (ts.isIfStatement(cursor)
            && (cursor.expression.getText(file).includes('frameworkName === "tauri"')
              || cursor.expression.getText(file) === "paneOwned")) {
          tauriOnly = true;
          break;
        }
        cursor = cursor.parent;
      }
      calls.push({ text: node.getText(file), tauriOnly });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function ownerGuardedFunctionCalls(source, functionName) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === functionName) {
      let cursor = node.parent;
      let paneOwnedOnly = false;
      while (cursor) {
        if (ts.isIfStatement(cursor)
            && (cursor.expression.getText(file).includes("native || windowed")
              || cursor.expression.getText(file) === "paneOwned")) {
          paneOwnedOnly = true;
          break;
        }
        cursor = cursor.parent;
      }
      calls.push({ text: node.getText(file), paneOwnedOnly });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function callFacts(source, matches) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && matches(node, file)) {
      const guards = [];
      const loops = [];
      let functionName = null;
      let cursor = node.parent;
      while (cursor) {
        if (ts.isIfStatement(cursor)) guards.push(cursor.expression.getText(file));
        if (ts.isForStatement(cursor)
            || ts.isForInStatement(cursor)
            || ts.isForOfStatement(cursor)
            || ts.isWhileStatement(cursor)) {
          loops.push(cursor.getText(file).split("{")[0].trim());
        }
        if (ts.isFunctionDeclaration(cursor)) {
          functionName = cursor.name?.text ?? null;
          break;
        }
        cursor = cursor.parent;
      }
      calls.push({
        text: node.getText(file),
        start: node.getStart(file),
        guards,
        loops,
        functionName,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function objectStringProperty(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const property = node.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate)
      && ((ts.isIdentifier(candidate.name) && candidate.name.text === name)
        || (ts.isStringLiteral(candidate.name) && candidate.name.text === name)));
  return property && ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : null;
}

function machineGateRecordCalls(source, gate) {
  return callFacts(source, (node, file) => {
    if (!ts.isPropertyAccessExpression(node.expression)
        || node.expression.name.text !== "recordMachineEvidence"
        || node.arguments.length !== 1) return false;
    return objectStringProperty(node.arguments[0], "gate") === gate;
  });
}

function memberCalls(source, owner, method) {
  return callFacts(source, (node, file) => (
    ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(file) === owner
    && node.expression.name.text === method
  ));
}

function presentationTraceRpcCalls(source) {
  return callFacts(source, (node, file) => (
    node.expression.getText(file) === "rpc"
    && /presentation[\w.]*trace|trace[\w.]*presentation/i.test(node.getText(file))
  ));
}

describe("slot-freeze instrumentation lifecycle", () => {
  it("the versioned dev entrypoint binds evidence to the built application binary", () => {
    const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");
    const target = makefile.split("e2e-slot-freeze-dev:")[1]?.split("\n\n")[0] ?? "";
    expect(target).toContain("BROWSER_EVIDENCE_BUILD_ID=");
    expect(target).toContain("$(DEV_EXECUTABLE)");
    expect(target).toContain("shasum -a 256");
  });

  it("installs PaneSurfaceHost presentation probes only for pane-owned surfaces", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('frameworkName === "tauri" && (native || windowed)');
    expect(source).not.toContain('if (frameworkName === "tauri") await installPanePresentationMarkers');
  });

  it("never judges external engine surfaces as PaneSurfaceHost members", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain(
      'const paneOwned = frameworkName === "tauri" && (native || windowed);',
    );
    const calls = ownerGuardedFunctionCalls(source, "assertPaneComposition");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.paneOwnedOnly)).toBe(true);
    const lighting = source.split("async function assertFocusLighting")[1]
      ?.split("async function assertRailCompositionContract")[0] ?? "";
    expect(lighting).toContain("if (paneOwned)");
    expect(lighting).not.toContain('if (frameworkName === "tauri")');
  });

  it("keeps Node alive until the whole scenario and finally cleanup have completed", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("await main()");
    expect(source).not.toMatch(/\nmain\(\)\.catch\(/);
  });

  it("녹화는 시각 진단을 남기지만 E2E 성공/실패를 판정하지 않는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const visual = readFileSync(new URL("./lib/browser-visual-evidence.mjs", import.meta.url), "utf8");
    const recordingReview = readFileSync(new URL("./lib/visual-recording-review.mjs", import.meta.url), "utf8");
    expect(visual).toContain('kind: "human-visual-evidence"');
    expect(visual).toContain("automatedVerdict: false");
    expect(recordingReview).toContain('kind: "human-visual-evidence"');
    expect(recordingReview).toContain("automatedVerdict: false");
    expect(source).toContain("reviewVisualRecording");
    expect(source).toContain("observeFrameSequence");
    expect(source).not.toContain("decodePng");
    expect(source).not.toContain("markerEvidence");
    expect(source).not.toContain("fixtureMarkerRowVerdict");
    expect(source).not.toContain("assertFrameMarkers");
    expect(source).not.toContain("assertChromeAnchorWithin");
    expect(source).not.toMatch(/Number\([^\n]*recording\?\.frames[^\n]*\)\s*!==/);
    expect(source).not.toMatch(/files\.length\s*!==/);
    expect(source).not.toContain("Number(fastResize.frames) !== FAST_RESIZE_FRAMES");
  });

  it("activates pane through exposed tab chrome and verifies the resulting pane state", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("activationAddressForTab");
    expect(source).toContain("browserTabActivationAddress(tree, tabId)");
    expect(source).toContain("assertActivePane(rpc, win, paneIds[side], name)");
    expect(source).toContain("address: activationAddresses[side]");
  });

  it("removes compositor rulers in finally before preserving or releasing the fixture window", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const cleanup = source.split("} finally {")[1] ?? "";
    expect(cleanup).toContain("assertCaptureInstrumentationCleared");
    expect(cleanup.indexOf("assertCaptureInstrumentationCleared"))
      .toBeLessThan(cleanup.indexOf("releaseFixtureWindow"));
  });

  it("모달은 공개 occlusion 수치로 판정하고 픽셀은 별도 visual report로만 남긴다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("observeFrameSequence");
    expect(source).toContain("modalOverlayProbe");
    expect(source).toContain("assertCaptureInstrumentationCleared");
  });

  it("checks the focused pane relation and exempts the rail from focus lighting after every cross-click", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const lighting = source.split("async function assertFocusLighting")[1]?.split("async function assertRailCompositionContract")[0] ?? "";
    expect(lighting).toContain('props: ["--dim"]');
    expect(lighting).toContain("dataset?.dim");
    expect(lighting).toContain("Math.abs(Number(match.alpha) - 1)");
    expect(lighting).not.toContain("1 - dims[index]");
    expect(lighting).not.toContain('rpc("window.pixels"');
    expect(source).toContain("lightingAddressForTab");
    expect(source).toContain('item.nodePath === `layout/tab/${tabId}`');
    expect(source).toContain("assertRailCompositionContract");
    expect(source).toContain("relation-connected=");
    expect(source).toContain("rail-not-lighting-exempt");
    expect(source).toContain("paneIds[side]");
  });

  it("pins without rearrangement and numerically covers left, right, and detached borders", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('relationSide: "right"');
    expect(source).toContain('relationSide: "left"');
    expect(source).toContain('relationSide: "detached"');
    expect(source).toContain('rpc("layout.transactions"');
    expect(source).toContain("layout-transactions=${unexpected.length}/0");
    expect(source).toContain("rectsBefore");
    expect(source).toContain("rectsAfter");
    expect(source).toContain("JSON.stringify(before.cells) !== JSON.stringify(after.cells)");
    expect(source).toContain("PIN 클릭이 native bounds를 기록");
    expect(source).toContain("process.env.CROSS_CLICK_CYCLES ?? 3");
    expect(source).toContain('process.env.BROWSER_SCENARIOS ?? "flow,pin,resize,overlay,scroll"');
  });

  it("선택한 시나리오만 실행하며 resize와 overlay를 서로 독립시킨다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const resizeBodies = scenarioGateBodies(source, "resize");
    const overlayBodies = scenarioGateBodies(source, "overlay");

    expect(resizeBodies).toHaveLength(1);
    expect(resizeBodies[0].match(/rpc\("window\.resizeSequence"/g)).toHaveLength(1);
    expect(resizeBodies[0].match(/rpc\("ui\.input\.drag"/g)).toHaveLength(1);
    expect(source.match(/rpc\("window\.resizeSequence"/g)).toHaveLength(1);
    expect(source.match(/rpc\("ui\.input\.drag"/g)).toHaveLength(1);
    expect(source.indexOf('"first paint calibration hide"'))
      .toBeLessThan(source.indexOf('if (SCENARIOS.has("resize")) {'));
    expect(resizeBodies[0]).toContain('"window resize calibration show"');
    expect(resizeBodies[0]).toContain('"DOM compositor calibration hide"');
    expect(overlayBodies).toHaveLength(1);
    expect(overlayBodies[0].match(/await assertChromeOverlayContract/g)).toHaveLength(1);
    expect(source.match(/await assertChromeOverlayContract/g)).toHaveLength(1);
    expect(source).not.toContain("SCENARIOS.size === 1");
  });

  it("사전 계획한 녹화를 공통 evidence run에서 정확히 한 번씩 소비한다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("planBrowserRecordingEvidence");
    expect(source).toContain("createBrowserRecordingEvidenceLedger");
    expect(source).toContain("runRecordingEvidenceAction");
    expect(source).toContain("recordingLedger.take");
    expect(source).toContain("recordingLedger.assertComplete()");
    expect(source).toContain("beginEvidenceRun");
    const mainBody = source.split("async function main()")[1] ?? "";
    expect(mainBody).toContain(
      "requireBrowserEvidenceBuildId(process.env.BROWSER_EVIDENCE_BUILD_ID)",
    );
    expect(mainBody.indexOf("requireBrowserEvidenceBuildId"))
      .toBeLessThan(mainBody.indexOf("await beginEvidenceRun"));
    expect(source).toContain("finishEvidenceRun(EVIDENCE_STORE_ROOT, { runId, status })");
    expect(source).not.toContain("function prepareEvidence");
    expect(source).not.toContain('"slot-freeze", "current"');
    expect(source.match(/runPlannedRecordingAction\(/g)).toHaveLength(5);
    expect(source.match(/\.\.\.recordFields/g)).toHaveLength(4);
  });

  it("모든 JSON evidence를 공통 quota store로 기록한다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("writeEvidenceFile");
    expect(source).toContain("writeMachineReport");
    expect(source).toContain("writeVisualReport");
    expect(source).not.toContain("fs.writeFileSync");
  });

  it("snapshot과 full capture 파일도 공통 artifact quota 거래로 만든다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("produceEvidenceArtifact");
    expect(source).toContain("produceEvidenceFile");
    expect(source.match(/captureWindowSnapshot\(/g)).toHaveLength(9);
    expect(source.match(/rpc\("window\.snapshot"/g)).toHaveLength(1);
    expect(source).not.toContain("fs.mkdirSync(engineEvidence");
  });

  it("Tauri composition 진단을 Electron DOM 기준에 호출하지 않는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const calls = frameworkGuardedRpcCalls(source, "webview.composition");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.tauriOnly)).toBe(true);
  });

  it("교차 이동의 자동 판정은 recorder callback이 아닌 공개 layout 거래 장부를 소비한다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("layoutTransactionVerdict");
    expect(source).toContain('path.join(dir, "layout-transaction.json")');
    expect(source).not.toContain("traceAddresses:");
    expect(source).not.toContain("clicked.trace?.samples");
  });

  it("B04는 세 엔진 FLOW 양방향의 공개 presentation producer와 layout journal만 canonical receipt로 기록한다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const paneArm = "webview.pane.presentation.trace.arm";
    const paneRead = "webview.pane.presentation.trace.close";
    const offscreenArm = "plugin.soksak-plugin-browser-chromium-offscreen.surface.trace.start";
    const offscreenRead = "plugin.soksak-plugin-browser-chromium-offscreen.surface.trace.read";
    for (const engine of ["browser", "browser-chromium", "browser-chromium-offscreen"]) {
      const adapter = browserImplementations[engine]?.presentationTrace;
      expect(adapter).toEqual(expect.objectContaining({
        armCommand: expect.any(String),
        readCommand: expect.any(String),
        armParams: expect.any(Function),
        readParams: expect.any(Function),
        resolveOwners: expect.any(Function),
        events: expect.any(Function),
      }));
    }
    expect(browserImplementations.browser.presentationTrace).toMatchObject({
      armCommand: paneArm, readCommand: paneRead,
    });
    expect(browserImplementations["browser-chromium"].presentationTrace).toMatchObject({
      armCommand: paneArm, readCommand: paneRead,
    });
    expect(browserImplementations["browser-chromium-offscreen"].presentationTrace).toMatchObject({
      armCommand: offscreenArm, readCommand: offscreenRead,
    });

    const receipts = machineGateRecordCalls(source, "B04");
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt.functionName).toBe("runEngine");
    expect(receipt.guards).toContain('SCENARIOS.has("flow")');
    expect(receipt.guards.some((guard) =>
      /implementation\.surface|engine\s*===|\bnative\b|\bwindowed\b|paneOwned/.test(guard))).toBe(false);
    expect(receipt.text).toContain("engine");
    expect(receipt.text).toContain('gate: "B04"');
    expect(receipt.text).toContain("coordinateSpace");
    expect(receipt.text).toContain("transitions: b04Transitions");
    expect(receipt.text).not.toMatch(/recording|artifact|files|clicked|png|snapshot/i);

    const transitionWrites = memberCalls(source, "b04Transitions", "push");
    expect(transitionWrites).toHaveLength(1);
    const transition = transitionWrites[0];
    expect(transition.functionName).toBe("runEngine");
    expect(transition.loops.some((loop) => /\bside\b/.test(loop))).toBe(true);
    expect(transition.guards.some((guard) =>
      /implementation\.surface|engine\s*===|\bnative\b|\bwindowed\b|paneOwned|presentation.*trace/i.test(guard))).toBe(false);
    expect(transition.text).toMatch(/direction\s*:\s*side\s*===?\s*0\s*\?\s*"to-left"\s*:\s*"to-right"/);
    expect(transition.text).toMatch(/targetViewId\s*:\s*tabIds\[side\]/);
    expect(transition.text).toContain("motionMode:");
    expect(transition.text).toMatch(/journal\s*:\s*\{[\s\S]*afterSequence[\s\S]*entries\s*:\s*layoutVerdict\.transactions/);
    expect(transition.text).toMatch(/samples\s*:\s*[\w$]*presentation[\w$]*\.samples/i);
    expect(transition.text).not.toMatch(/recording|artifact|files|clicked|png|snapshot/i);
    expect(receipt.start).toBeGreaterThan(transition.start);

    const presentationCalls = presentationTraceRpcCalls(source)
      .filter((call) => call.functionName === "runEngine");
    expect(presentationCalls.length).toBeGreaterThanOrEqual(2);
    expect(presentationCalls.every((call) =>
      call.loops.some((loop) => /\bside\b/.test(loop))
      && !call.guards.some((guard) =>
        /implementation\.surface|engine\s*===|\bnative\b|\bwindowed\b|paneOwned/.test(guard)))).toBe(true);
    expect(presentationCalls.some((call) => /arm|start/i.test(call.text))).toBe(true);
    expect(presentationCalls.some((call) => /close|read/i.test(call.text))).toBe(true);
    expect(presentationCalls.every((call) =>
      !/recording|artifact|png|snapshot/i.test(call.text))).toBe(true);
    expect(presentationCalls.every((call) =>
      /implementation\.presentationTrace\.(?:armCommand|readCommand)/.test(call.text))).toBe(true);

    expect(source).toContain("for (const engine of ENGINES)");
    expect(source).not.toContain("clicked.trace?.samples");
    expect(source).not.toContain("traceAddresses:");
  });

  it("maximizes both sides under PIN without rewriting the stored station and restores the split", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('name: "pin-maximize-left"');
    expect(source).toContain('name: "pin-maximize-right"');
    expect(source).toContain('rpc("tab.maximize"');
    expect(source).toContain('persisted.leftRailPosition?.station !== 50');
    expect(source).toContain('rpc("tab.restore"');
    expect(source).toContain('JSON.stringify(restored.cells) !== JSON.stringify(restoredBaseline.cells)');
  });

  it("B07/B08 live evidence is judged into one canonical 3x12 report without ad-hoc green", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const reportStore = readFileSync(new URL("./lib/browser-evidence-store.mjs", import.meta.url), "utf8");

    for (const symbol of [
      "createBrowserGateReport",
      "judgeBrowserMachineGateEvidence",
      "setMachineGateStatus",
      "serializeBrowserGateReport",
      "machineGateSummary",
    ]) expect(reportStore).toContain(symbol);
    expect(source).toContain("createBrowserGateReportStore");
    expect(source).toContain("mapB07PinCaseEvidence");
    expect(source).toContain("mapB08BaselineEvidence");
    expect(source).toContain("mapB08MaximizeCaseEvidence");
    expect(source).toContain('gate: "B07"');
    expect(source).toContain('gate: "B08"');
    expect(source).toContain("nodeIdentity");
    expect(source).toContain("machineSummary()");
    expect(source).not.toContain("MACHINE GREEN");
  });

  it("waits on the exposed event-driven layout barrier before first-paint judgment", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('rpc("ui.layout.wait-settled"');
    expect(source.indexOf('rpc("ui.layout.wait-settled"'))
      .toBeLessThan(source.indexOf('const firstPaintPath'));
  });

  it("hostile resize waits for child slot native commits before final composition judgment", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('rpc("webview.pane.composition.wait"');
    expect(source.indexOf('"window resize final layout settled"'))
      .toBeLessThan(source.indexOf('rpc("webview.pane.composition.wait"'));
  });

  it("pane gutter resize settles main layout and child native commits before viewport judgment", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const gutter = source.split("// 탭 패널 경계 resize")[1]?.split("await assertChromeOverlayContract")[0] ?? "";
    expect(gutter).toContain('rpc("ui.layout.wait-settled"');
    expect(gutter).toContain('"webview.pane.composition.wait"');
    expect(gutter.indexOf('rpc("ui.layout.wait-settled"'))
      .toBeLessThan(gutter.indexOf('"webview.pane.composition.wait"'));
    expect(gutter.indexOf('"webview.pane.composition.wait"'))
      .toBeLessThan(gutter.indexOf("assertViewportComposition"));
  });

  it("requires one shared pane presentation owner for plugin chrome and native members", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("rendererTopologyOwnershipVerdict");
  });

  it("drives and measures real wheel scrolling for every browser implementation", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const matrix = readFileSync(new URL("./lib/browser-matrix.mjs", import.meta.url), "utf8");
    expect(source).toContain("verifyScrollInput");
    expect(source).toContain(".input.scroll`");
    expect(source).toContain("afterY");
    expect(source).toContain("restoredY");
    expect(source).toContain("verifyFullCapture");
    expect(source).toContain(".capture.full`");
    expect(source).toContain("afterY !== 480");
    expect(source).toContain("fullCaptureReceiptVerdict");
    expect(source).toContain("result.viewId");
    expect(matrix).toContain("before?.document");
    expect(matrix).toContain("after?.document");
    expect(source).not.toContain("pngHeight");
  });
});
