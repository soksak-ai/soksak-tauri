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

/** 그 이름으로 선언된 함수의 본문. 산문 검색이 아니라 선언에서 잘라 읽는다. */
function namedFunctionBody(source, name) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let body = "";
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      body = node.body?.getText(file) ?? "";
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return body;
}

/** 그 iterable 로 도는 for-of 들의 본문. 게이트별 블록을 이름으로 집는다. */
function forOfBodies(source, iterableText) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bodies = [];
  const visit = (node) => {
    if (ts.isForOfStatement(node) && node.expression.getText(file) === iterableText) {
      bodies.push(node.statement.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bodies;
}

/** B09 이 사는 두 자리 — 표본을 만드는 자리와 판정을 기록하는 자리. */
const B09_FUNCTIONS = Object.freeze(["measureChromeOverlaySample", "assertChromeOverlayContract"]);

function chromeOverlayBlock(source) {
  return B09_FUNCTIONS.map((name) => namedFunctionBody(source, name)).join("\n");
}

/** 이 표현식이 **능력의 답**을 긍정으로 읽는가. 부정(`!paneOwned`)은 가드가 아니다 — 없는
 *  쪽으로 들어가는 문이다. */
function readsCapabilityAnswer(expression) {
  if (/!\s*(?:paneOwned|capabilities\.has)/.test(expression)) return false;
  return expression.includes("capabilities.has(") || /\bpaneOwned\b/.test(expression);
}

/** 이 명령을 부르는 자리가 **능력 질문** 뒤에 서 있는가.
 *
 * 프레임워크 이름을 읽는 가드는 여기서 가드로 세지 않는다 — 이름 분기는 프레임워크가 하나 늘
 * 때마다 갈리고, 그 갈림은 판정이 아니라 명단 관리다. */
function capabilityGuardedRpcCalls(source, command) {
  const file = ts.createSourceFile("slot-freeze.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)
        && node.expression.getText(file) === "rpc"
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === command) {
      let cursor = node.parent;
      let capabilityGuarded = false;
      while (cursor) {
        if (ts.isIfStatement(cursor) && readsCapabilityAnswer(cursor.expression.getText(file))) {
          capabilityGuarded = true;
          break;
        }
        cursor = cursor.parent;
      }
      calls.push({ text: node.getText(file), capabilityGuarded });
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
              || readsCapabilityAnswer(cursor.expression.getText(file)))) {
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

/** 한 셀을 판정하는 자리 전부. 증거를 적는 자리와 능력 부재로 그 칸을 닫는 자리는 같은 셀의
 *  같은 판정이므로 함께 센다 — 둘을 따로 세면 "한 번만"이라는 법이 한쪽에서만 선다. */
function machineGateRecordCalls(source, gate) {
  return callFacts(source, (node, file) => {
    const direct = ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "recordMachineEvidence"
      && node.arguments.length === 1
      && objectStringProperty(node.arguments[0], "gate") === gate;
    const capabilityAware = ts.isIdentifier(node.expression)
      && node.expression.text === "recordGateOrCapabilityAbsence"
      && node.arguments.length === 2
      && objectStringProperty(node.arguments[1], "gate") === gate;
    return direct || capabilityAware;
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
    expect(source).toContain("capabilities.has(PANE_PRESENTATION_HOST.id) && (native || windowed)");
    expect(source).not.toContain('if (frameworkName === "tauri") await installPanePresentationMarkers');
  });

  // 갈라지는 자리는 창에게 묻는다. 이름 분기는 프레임워크가 하나 늘 때마다 갈리고, 그때 새
  // 프레임워크는 "판정이 없는" 것이 아니라 "원래 없는 게이트"로 보인다.
  it("branches on what the window answers, not on who answered", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("readHarnessCapabilities(rpc, win)");
    expect(source).not.toContain('frameworkName === "tauri"');
    // 이름은 보고서 신원에만 쓴다 — 판정이 아니라 누가 쟀는지를 적는 자리다.
    for (const identityUse of source.match(/frameworkName[^\n]*/g) ?? []) {
      expect(identityUse, identityUse).not.toMatch(/frameworkName\s*===\s*"/);
    }
  });

  it("never judges external engine surfaces as PaneSurfaceHost members", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain(
      "const paneOwned = capabilities.has(PANE_PRESENTATION_HOST.id) && (native || windowed);",
    );
    const calls = ownerGuardedFunctionCalls(source, "assertPaneComposition");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.paneOwnedOnly)).toBe(true);
    const lighting = source.split("async function assertFocusLighting")[1]
      ?.split("async function assertRailCompositionContract")[0] ?? "";
    // pane composition 장부는 그 장부가 픽셀을 소유할 때만 읽는다. 옛 판은 그 갈래를
    // paneOwned 로 적었고, 지금은 같은 사실을 근거 이름(adapterBasis)이 든다.
    expect(lighting).toContain('adapterBasis === "pane-host"');
    expect(lighting).not.toContain('if (frameworkName === "tauri")');
  });

  // 창-엔진 표면의 합성 대조는 pane 표면 층을 대조 상대로 읽는다. 그 층이 없는 창에서 부르면
  // 그 명령이 UNKNOWN_COMMAND 로 죽고, 그 죽음은 이 엔진의 남은 칸을 통째로 가져간다.
  it("compares windowed engine composition only where the pane surface layer answers", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const calls = ownerGuardedFunctionCalls(source, "assertWindowedComposition");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.paneOwnedOnly)).toBe(true);
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
    // 투과율의 문턱은 judge 가 든다(adapterAlpha≈1). 하니스는 장부에서 읽어 근거와 함께 싣는다 —
    // 하니스가 문턱을 들면 못 읽은 자리를 통과값으로 메우고 싶은 자리가 생긴다.
    expect(lighting).toContain("readAdapterAlpha");
    expect(lighting).toContain("adapterBases");
    expect(lighting).not.toContain("1 - dims[index]");
    expect(lighting).not.toContain('rpc("window.pixels"');
    expect(source).toContain("lightingAddressForTab");
    expect(source).toContain('item.nodePath === `layout/tab/${tabId}`');
    expect(source).toContain("assertRailCompositionContract");
    expect(source).toContain("relation-connected=");
    expect(source).toContain("rail-not-lighting-exempt");
    expect(source).toContain("paneIds[side]");
  });

  // B06 은 mapper 가 찾는 이름(lightingPlane·rail·sidebar)을 하니스가 실제로 실어야 성립한다.
  // 손으로 적은 객체 리터럴은 이름이 어긋나도 조용하다 — 수집을 한 모듈이 소유하게 고정한다.
  it("builds every B06 checkpoint from the collected plane and exemption facts", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("collectB06Checkpoint");
    expect(source).toMatch(/b06Checkpoints\.push\(\s*await collectB06Checkpoint\(/);
    expect(source).not.toMatch(/b06Checkpoints\.push\(\s*\{/);
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
    expect(source).toContain("process.env.CROSS_CLICK_CYCLES ?? 3");
    expect(source).toContain('process.env.BROWSER_SCENARIOS ?? "flow,pin,resize,overlay,scroll"');
  });

  // 계약 위반은 던지는 것이 아니라 evidence 로 실어 judge 가 이름을 붙인다. 던지면 보고서에
  // blocked 만 남고 어느 계약이 깨졌는지 수치로 남지 않는다.
  it("PIN 케이스는 station·분할·transaction·native bounds를 evidence로 실어 판정한다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const [pinLoop] = forOfBodies(source, "pinCases");
    expect(pinLoop).toBeDefined();
    expect(pinLoop).toContain("requestedStation: pinCase.station");
    expect(pinLoop).toContain("layoutTransactions: unexpected.length");
    expect(pinLoop).toContain("nativeCompositionBefore: nativeBefore");
    expect(pinLoop).toContain("nativeCompositionAfter: nativeAfter");
    expect(pinLoop.match(/throw new Error/g)).toBeNull();
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

  it("네이티브 합성 진단을 그 층이 없는 창에 호출하지 않는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const calls = capabilityGuardedRpcCalls(source, "webview.composition");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.capabilityGuarded)).toBe(true);
  });

  // 못 재는 것은 못 잰다고 말해야 한다. 궤적 증거 구간을 건너뛰는 사유는 능력 부재 하나뿐이고,
  // 그 부재는 같은 실행에서 B04·B05 셀의 판정으로 실린다 — 조용한 통과도, 지어낸 red 도 없다.
  it("표시 궤적을 못 재면 그 사실이 두 셀의 판정으로 남는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("flowPresentationEvidence: {");
    // 못 잼의 사유는 둘이다 — 능력이 없거나(선언), 이 전이의 무장을 못 얻었거나(실측).
    // 둘 다 같은 길로 가야 없는 증거로 red 를 적지 않는다.
    expect(source).toContain("if (!presentationTraceMeasurable || !presentationOpen) {");
    expect(source).toContain("presentationArmLedger.recordFailure(name, armAnswer)");
    expect(source).toContain("unmeasured: presentationArmLedger.unmeasured()");
    expect(source).toContain("break flowPresentationEvidence;");
    for (const gate of ["B04", "B05"]) {
      const receipts = machineGateRecordCalls(source, gate);
      expect(receipts, gate).toHaveLength(1);
      expect(receipts[0].text, gate).toContain("capability: presentationTrace.capability");
    }
    // 궤적을 못 재는 실행에서도 나머지 칸은 계속 잰다 — 한 칸의 부재가 판을 멈추지 않는다.
    expect(machineGateRecordCalls(source, "B06")[0].text)
      .not.toContain("capability: presentationTrace.capability");
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
    expect(source).toContain('rpc("ui.trace.multi.start"');
    const domTraceStartCalls = callFacts(source, (node) => (
      node.expression.getText() === "rpc"
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "ui.trace.multi.start"
    ));
    const domTraceCloseCalls = callFacts(source, (node) => (
      node.expression.getText() === "rpc"
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "ui.trace.multi.close"
    ));
    expect(domTraceStartCalls).toHaveLength(1);
    expect(domTraceCloseCalls.length).toBeGreaterThanOrEqual(2);
    expect(domTraceStartCalls[0].text).toContain("railAddress");
    expect(domTraceStartCalls[0].text).toContain("paneAddresses[0]");
    expect(domTraceStartCalls[0].text).toContain("addresses[0]");
    expect(domTraceStartCalls[0].text).toContain("paneAddresses[1]");
    expect(domTraceStartCalls[0].text).toContain("addresses[1]");
    expect(source).toMatch(/domTraceSession\s*=\s*must\(await rpc\("ui\.trace\.multi\.start"/);
    expect(source).not.toContain("domTracePromise");
    const flowRecordingCalls = callFacts(source, (node, file) => (
      node.expression.getText(file) === "runPlannedRecordingAction"
    )).filter((call) => call.functionName === "runEngine"
      && call.loops.some((loop) => /\bside\b/.test(loop)));
    expect(flowRecordingCalls).toHaveLength(1);
    expect(domTraceStartCalls[0].start).toBeLessThan(flowRecordingCalls[0].start);
    expect(domTraceCloseCalls.some((call) => call.start < flowRecordingCalls[0].start)).toBe(true);
    expect(source.indexOf("const presentationReceipt = must(await rpc("))
      .toBeLessThan(source.indexOf("const domTraceReceipt = must(await rpc("));
    expect(source).toContain("resolveB04MovedParticipant({");
    expect(source).toContain("transactions: layoutVerdict.transactions");
    expect(source).toContain("owners: presentationOwners");
    expect(source).toContain("normalizeB04JournalEntries(layoutVerdict.transactions)");
    expect(source).toContain("domSamples: domTraceReceipt.samples");
    expect(source).toContain("domCommittedAtUnixMs: layoutVerdict.transaction.domCommittedAtUnixMs");
    expect(source).toContain("joins: flowPresentationTrace.joins");
    expect(source).not.toContain("maxPairGapMs: flowPresentationTrace.maxPairGapMs");
    expect(source).not.toContain("pairs: flowPresentationTrace.pairs");
    expect(source).not.toMatch(/translatedB04Rect|railBaseline|paneBaseline/);
    // 표시 원장의 이름은 코어 계약이다 — 프레임워크 이름 공간에 두면 다른 프레임워크에서
    // 이 게이트가 통째로 안 재지고, 그 부재는 결함이 아니라 "원래 없는 게이트"로 보인다.
    const paneArm = "view.presentation.trace.arm";
    const paneRead = "view.presentation.trace.close";
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
    expect(transition.text).toMatch(/\btargetViewId\s*,/);
    expect(transition.text).not.toMatch(/targetViewId\s*:\s*tabIds\[side\]/);
    expect(transition.text).toContain("motionMode:");
    expect(source).toContain(
      "presentationStartAtUnixMs: layoutVerdict.transaction.startAtUnixMs",
    );
    expect(source).toContain('"dom-presentation-raw.json"');
    expect(source).toContain('"native-presentation-raw.json"');
    expect(source).not.toMatch(/expectedMode:\s*frameworkName\s*===\s*["']tauri["']/);
    expect(source).toContain('expectedMode: "glide"');
    expect(transition.text).toMatch(/journal\s*:\s*\{[\s\S]*afterSequence[\s\S]*entries\s*:\s*b04JournalEntries/);
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

    expect(source).toContain("engines: ENGINES");
    expect(source).not.toContain("clicked.trace?.samples");
    expect(source).not.toContain("traceAddresses:");
  });

  it("maximizes both sides under PIN without rewriting the stored station and restores the split", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('name: "pin-maximize-left"');
    expect(source).toContain('name: "pin-maximize-right"');
    expect(source).toContain('rpc("tab.maximize"');
    expect(source).toContain('rpc("tab.restore"');
    const [maximizeLoop] = forOfBodies(source, "maximizeCases");
    expect(maximizeLoop).toBeDefined();
    expect(maximizeLoop).toContain('rpc("sidebar.left.position"');
    expect(maximizeLoop).toContain("restoredPosition");
    expect(maximizeLoop.match(/throw new Error/g)).toBeNull();
  });

  // 세 엔진 판정이 byte-identical 이던 이유는 native surface 를 아예 안 물었기 때문이다.
  it("maximize 세 시점의 native surface·결부·보더를 같은 방법으로 읽어 싣는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const [maximizeLoop] = forOfBodies(source, "maximizeCases");
    for (const stage of ["baseline", "maximized", "restored"]) {
      expect(maximizeLoop, stage).toContain(`${stage}: stage${stage[0].toUpperCase()}${stage.slice(1)}`);
    }
    expect(maximizeLoop.match(/readPinStageEvidence\(/g)).toHaveLength(3);
    expect(source).toContain("readBrowserSurfaceEvidence");
    expect(source).toContain('import { readPinStage } from "./lib/pin-geometry-probe.mjs"');
  });

  it("carries presentation-trace violations to the judge instead of ending the run", () => {
    const matrix = readFileSync(new URL("./lib/browser-matrix.mjs", import.meta.url), "utf8");
    // 위반은 계약 사실이다. B05 judge 가 trace.violations.<축>=0/<관측> 으로 이미 이름을 부른다 —
    // 여기서 던지면 그 이름에 닿지 못하고 그 엔진의 남은 칸이 통째로 blocked 가 된다.
    expect(matrix).not.toContain("presentation trace가 깨졌습니다");
    const judge = readFileSync(new URL("./lib/browser-gate-b05.mjs", import.meta.url), "utf8");
    expect(judge).toContain("trace.violations");
  });

  it("carries an answered surface-settlement failure to the report instead of ending the run", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    // 앱이 답했으면 그것은 측정이다. `{"ok":false,"code":"TIMEOUT","message":"surface 12 actual
    // presentation timeout"}` 은 계약 사실이지 측정 불가가 아니다 — 던지면 그 이름이 사라지고
    // 그 엔진의 남은 칸이 통째로 blocked 가 된다(실측 2026-08-07: 정착 실패 하나가 11칸을 삼켰다).
    expect(source).toContain('from "./lib/surface-settlement.mjs"');
    expect(source).toContain("surfaceSettlementVerdict({ stage, viewId, reply })");
    expect(source).toContain("SURFACE_SETTLEMENT.record(");
    expect(source).not.toContain("`${stage} settle ${viewId}`");
    // 위반은 실행을 세우지 않는다. 다만 그 엔진은 모든 칸을 잰 뒤 RED 로 끝난다 — 기준은 그대로다.
    expect(source).toContain("SURFACE_SETTLEMENT.assertSettled(engine)");
    expect(source).toContain("SURFACE_SETTLEMENT.reset()");
  });

  it("can turn the display-column recorder off so the instrument can be ruled out", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    // 8ms recorder 는 tick 마다 대상 노드 전부의 rect 를 강제로 읽는다. 그것이 재려는 rendering
    // update 를 밀어냈는지는 끄고 같은 거래를 다시 재야 갈린다 — 그 대조가 불가능하면 표시 열의
    // 구멍을 제품 결함이라고 단정할 수 없다.
    expect(source).toContain("DISPLAY_TRACE_PRODUCERS");
    expect(source).toContain("SLOT_FREEZE_DOM_RECORDER");
    const start = source.split('rpc("ui.trace.multi.start"')[1]?.slice(0, 600) ?? "";
    expect(start).toContain("producers: DISPLAY_TRACE_PRODUCERS");
  });

  it("owns its fixture window size before measuring anything that depends on it", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    // 앱 기본 크기나 앞 엔진이 남긴 크기를 물려받으면 hostile resize 자극이 실행마다 생겼다
    // 사라진다 — 같은 앱이 실행마다 다른 칸을 잃는다. 크기는 픽스처가 소유한다.
    expect(source).toContain("FIXTURE_WINDOW_SIZE");
    expect(source).toContain('rpc("window.resize", FIXTURE_WINDOW_SIZE');
    // 기준 크기는 자극의 하한보다 커야 한다 — 그 하한은 hostileWindowResizeSizes 가 소유한다.
    const declared = source.match(/FIXTURE_WINDOW_SIZE = Object\.freeze\(\{ w: (\d+), h: (\d+) \}\)/);
    expect(declared).not.toBeNull();
    expect(Number(declared[1])).toBeGreaterThan(1400);
    expect(Number(declared[2])).toBeGreaterThan(940);
    // 크기를 세운 뒤에 원본을 읽어야 그 원본이 자극의 기준이 된다.
    expect(source.indexOf('rpc("window.resize", FIXTURE_WINDOW_SIZE'))
      .toBeLessThan(source.indexOf('const originalWindow = must(await rpc("window.info"'));
  });

  it("asks every surface-evidence caller for the declared provision, not a framework name", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    // 판정면이 갈리는 축은 이름이 아니라 선언된 능력이다. 한 호출자가 옛 이름을 들고 남으면
    // 그 자리에서만 provision 이 undefined 가 되고, 실행은 그 엔진의 남은 칸을 통째로 잃는다.
    // 표면 원장을 읽는 입구는 둘이다(영수증만 받는 쪽과 원장 이름·표본 시각까지 받는 쪽) —
    // 한쪽만 세면 나머지 입구가 이 법 밖에서 자란다.
    const calls = source
      .split(/read(?:BrowserSurfaceEvidence|BrowserSurfaceObservation)\(rpc, win, \{/)
      .slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const [index, call] of calls.entries()) {
      const args = call.slice(0, call.indexOf("});"));
      expect(args, `call ${index}`).toContain("nativeChildWebview");
      expect(args, `call ${index}`).not.toContain("frameworkName");
    }
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

  it("records every slot-freeze-owned B01-B11 live gate exactly once", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    for (let number = 1; number <= 11; number += 1) {
      const gate = `B${String(number).padStart(2, "0")}`;
      expect(machineGateRecordCalls(source, gate), gate).toHaveLength(1);
    }
    // B12 is a cold-start/titlebar transaction and is owned by titlebar-composition.mjs.
    expect(machineGateRecordCalls(source, "B12"), "B12").toHaveLength(0);
  });

  it("waits on the exposed event-driven layout barrier before first-paint judgment", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('rpc("ui.layout.wait-settled"');
    expect(source.indexOf('rpc("ui.layout.wait-settled"'))
      .toBeLessThan(source.indexOf('const firstPaintPath'));
  });

  it("settles child presentation before reading B01 projected urlbar values", () => {
    // 실측은 lib/browser-gate-b01.mjs 가 소유한다. 이 법은 그 파일에서 계속 성립해야 한다.
    const source = readFileSync(new URL("./lib/browser-gate-b01.mjs", import.meta.url), "utf8");
    const step = source.split("async function observeB01Navigation")[1] ?? "";
    const firstBarrier = step.indexOf('rpc("ui.layout.wait-settled"');
    const urlbarRead = step.indexOf('rpc("ui.measure"');
    expect(firstBarrier).toBeGreaterThan(-1);
    expect(urlbarRead).toBeGreaterThan(-1);
    expect(firstBarrier).toBeLessThan(urlbarRead);
  });

  it("records the B01 verdict before any measurement-impossible stop", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const record = source.indexOf('gate: "B01"');
    const stop = source.indexOf("b01.blockedReason");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(stop);
  });

  it("closes both machine traces before the separately replayed human PNG recording", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const machineClose = source.indexOf("const presentationReceipt = must(await rpc(");
    const domClose = source.indexOf("const domTraceReceipt = must(await rpc(");
    const replayRestore = source.indexOf("visual replay source restore");
    const recording = source.indexOf("const recordingOutcome = await runPlannedRecordingAction");
    const review = source.indexOf("reviewRecordingOutcome", recording);
    expect(machineClose).toBeGreaterThan(-1);
    expect(domClose).toBeGreaterThan(machineClose);
    expect(replayRestore).toBeGreaterThan(domClose);
    expect(recording).toBeGreaterThan(replayRestore);
    expect(review).toBeGreaterThan(recording);
    const machinePhase = source.slice(machineClose, recording);
    expect(machinePhase).not.toContain("recordFrames");
  });

  it("hostile resize waits for child slot native commits before final composition judgment", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain('rpc("webview.pane.composition.wait"');
    expect(source.indexOf('"window resize final layout settled"'))
      .toBeLessThan(source.indexOf('rpc("webview.pane.composition.wait"'));
  });

  it("B04 preserves raw producer receipts before adapter validation can reject them", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const rawWrite = source.indexOf('path.join(dir, "native-presentation-raw.json")');
    const adapterRead = source.indexOf("implementation.presentationTrace.events(");
    expect(rawWrite).toBeGreaterThan(-1);
    expect(adapterRead).toBeGreaterThan(rawWrite);
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

  it("measures every engine before reporting, and closes a lost engine as blocked", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("runEngineCoverage");
    expect(source).toContain("blockPending");
    // 엔진 순회를 직접 돌면 한 엔진의 실패가 남은 엔진의 측정을 통째로 삼킨다.
    expect(source).not.toMatch(/for\s*\(\s*const\s+engine\s+of\s+ENGINES\s*\)/);
  });

  it("reports every gate verdict without ending the engine's remaining measurements", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    // 판정은 정본 보고서가 소유한다. receipt 를 다시 던지면 같은 엔진의 남은 게이트가
    // 측정되지 않아 보고서에 없는 사실이 생긴다. 최종 판정은 machineSummary 가 한다.
    expect(source).not.toMatch(/Receipt\.status !== "green"/);
    for (let number = 1; number <= 11; number += 1) {
      const gate = `B${String(number).padStart(2, "0")}`;
      expect(source, gate).toContain(`formatGateVerdict(engine, "${gate}"`);
    }
    // 판정 줄은 한 자리에서 만든다 — 자리마다 다시 쓰면 red 의 수치가 어떤 줄에서는 사라진다.
    expect(source).not.toContain("canonical machine verdict:");
  });

  // B09 판정은 이 블록 안 어떤 throw 보다 먼저 기록돼야 한다. throw 가 앞서면 계약 위반이
  // blocked 로 사라지고 41개 런 전수에서 그랬듯 judge 는 한 번도 RED 를 못 낸다.
  it("records the B09 verdict before any throwing oracle in the same block", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const block = namedFunctionBody(source, "assertChromeOverlayContract");
    expect(block).not.toBe("");
    const verdict = block.indexOf('gate: "B09"');
    expect(verdict).toBeGreaterThan(-1);
    for (const oracle of ["observeFrameSequence(", "throw new Error("]) {
      const at = block.indexOf(oracle);
      if (at >= 0) expect(at, oracle).toBeGreaterThan(verdict);
    }
  });

  it("names chrome overlay contract violations in evidence instead of throwing", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const block = chromeOverlayBlock(source);
    // 측정 불가는 must() 가 blocked 로 남긴다. 계약 위반은 표본에 실려 judge 가 이름 붙인다 —
    // 이 블록에 남은 throw 는 둘을 다시 뭉뚱그린다.
    expect(block).not.toContain("throw new Error(");
    expect(block).toContain("buildB09Sample(");
    expect(block).toContain("deriveChromeControl(");
    // 층 순서·최상위 소유자는 하니스 리터럴이 아니라 응답에서 파생된다.
    expect(block).not.toContain("topmostOwner:");
    expect(block).not.toContain('kind: "native-surface"');
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
    // 휠이 무엇을 움직였는지는 페이지가 센 사건 수가 답한다. 좌표만 보면 프로그램으로 옮긴
    // 스크롤과 휠이 옮긴 스크롤이 같은 값을 만든다.
    const wheel = readFileSync(new URL("./lib/browser-gate-b11-scroll.mjs", import.meta.url), "utf8");
    expect(wheel).toContain("wheelEvents");
    expect(source).toContain("wheelLedgerStage");
    expect(matrix).toContain('addEventListener("wheel"');
    // 스크롤이 옮겨진 사실과 휠이 닿은 사실은 다른 사건이고 엔진은 앞의 것을 먼저 낸다.
    // 앞의 것만 기다리고 원장을 읽으면 언제나 아직 세지 않은 0 을 읽는다.
    expect(matrix).toContain("dataset.wheelSeq");
    expect(source).toContain("wheelReachedSelector");
    // 산출물 범위는 산출물 실측으로만 답한다. 픽셀을 푸는 일은 여전히 하니스 밖이다.
    expect(source).toContain("measureCapturedImage");
    expect(source).toContain("capturedWidth");
    expect(source).not.toContain("decodePng");
    // 페이지 답과 eval 봉투를 가르는 자리는 하나다. 구현마다 다른 포장을 읽는 자리에서 직접
    // 풀면 봉투 축이 페이지 기록에 섞이고, 그 사실은 배선 장부에만 뒤늦게 나타난다
    // (실측 2026-08-07 browser-chromium B11: wiring.B11.page.viewId=produced-not-consumed).
    expect(source).toContain("mapPageState(openPageStateReply(");
    expect(source).not.toContain("mapPageState(unwrapEvalValue(");
  });

  it("B11은 pane resize를 실제로 재고 나서 도장을 찍는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    // 재지 않은 축을 뒤에서 도장으로 덮으면 보고서를 읽는 사람이 두 사건을 하나로 읽는다.
    const baseline = source.indexOf('readB11PaneStage(rpc, win, b11PaneContext, "baseline")');
    const wider = source.indexOf("b11PaneStages[direction] = await readB11PaneStage");
    const stamp = source.indexOf('gate: "B11"');
    expect(baseline).toBeGreaterThan(-1);
    expect(wider).toBeGreaterThan(baseline);
    expect(stamp).toBeGreaterThan(wider);
    expect(source).toContain("b11PaneRequestedDx = Number(dragged.dx)");
  });
});

// 규칙 — 부르는 쪽이 소유한 값은 부르는 쪽이 든다.
//
// 원인 id 는 하니스가 만들어 무장에 실어 보낸 값이다. 그것을 상대의 영수증에서 되읽으면
// 우리가 소유한 값이 상대의 답 모양에 매인다. 실측 2026-08-07: browser-chromium-offscreen 의
// 무장 영수증이 traceId 를 문자열이 아닌 모양으로 답했고, 하니스가 그것을 그대로
// ui.input.click 에 넘겨 `causeTraceId: string 이어야 함` 으로 거절당했다. 엔진 실행이 그
// 자리에서 죽어 11칸 중 9칸이 blocked 로 남았다.
describe("원인 id 소유", () => {
  const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");

  it("무장 영수증에서 원인 id 를 되읽지 않는다", () => {
    expect(source).not.toContain("armedPresentation?.traceId");
  });

  it("원인 id 를 만든 자리와 무장에 싣는 자리가 같다", () => {
    expect(source).toContain("const causeTraceId = `${engine}-${name}-${randomUUID()}`");
    expect(source).toContain("armParams({\n                traceId: causeTraceId,");
  });
});

// 규칙 — 계약이 답하는 사실은 부르는 쪽이 실제로 읽어야 한다.
//
// 실측 2026-08-08: 계약에 observation 축을 세우고 판정도 그것을 읽게 했는데, 하니스가 그 계약을
// 한 번도 부르지 않았다. 단위 테스트는 전부 통과했고 라이브에서만 모든 전이가
// `skip-owner-undeclared` 로 blocked 가 됐다 — 적어 둔 계약은 읽혀야 한다.
describe("관측 자기보고 배선", () => {
  const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");

  it("네이티브 원장의 자기보고를 계약에 물어 넘긴다", () => {
    expect(source).toContain("implementation.presentationTrace.observation?.(presentationReceipt)");
  });

  it("slot 열의 주인은 두 생산자의 실측에서 파생한다", () => {
    expect(source).toContain("slotObservation: b04SlotObservation(");
  });
});

// 규칙 — 같은 관측을 만드는 자리는 같은 사실을 싣는다.
//
// 실측 2026-08-08: IME 관측을 만드는 자리가 둘인데 한 곳만 창의 포커스 사실을 실었다. 나머지
// phase 는 나란히 null 을 답했고 판정은 "아무도 안 밝혔다" 로 읽어 B02 가 red 였다. 자리가 늘면
// 또 빠진다 — 기계가 센다.
describe("IME 관측 자리", () => {
  const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");

  it("mapImeObservation 을 부르는 모든 자리가 창의 포커스 사실을 넘긴다", () => {
    const calls = [...source.matchAll(/mapImeObservation\(([\s\S]{0,200}?)\)[,;)]/g)]
      .map(([, args]) => args);
    expect(calls.length).toBeGreaterThan(1);
    for (const args of calls) {
      expect(args).toContain("focus");
      expect(args).toContain("tabId");
    }
  });

  it("포커스는 인자 없이 묻는다 — 이 명령은 params 를 받지 않는다", () => {
    expect(source).not.toMatch(/ui\.focus\.state",\s*\{\s*[A-Za-z]/);
  });
});

// 규칙 — 사람용 녹화의 규모는 판정을 바꾸지 않는다.
//
// 녹화는 사람이 보는 증거다(recording visual review — 제품 machine 판정과 분리). 판정은 수치
// 영수증이 소유하므로 프레임 수를 줄여도 어느 칸의 답도 달라지지 않는다. 그런데 그 규모가
// 소스에 박혀 있어, 실행이 긴 환경에서 판정을 끝까지 못 받는 자리가 생겼다 —
// 실측 2026-08-08: 세 실행이 04-right 녹화 중 같은 지점에서 외부 종료됐다.
//
// 규모는 선언으로 고르되, 기본값은 지금 값 그대로다. 기준을 낮추는 것이 아니라 사람용 증거의
// 분량을 부르는 쪽이 정하는 것이다.
describe("녹화 규모 선언", () => {
  const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");

  it("프레임 수를 환경에서 고를 수 있고 기본은 지금 값이다", () => {
    expect(source).toContain("SLOT_FREEZE_RECORD_FRAMES");
    expect(source).toMatch(/FRAMES_PER_CLICK\s*=[\s\S]{0,120}48/);
  });

  it("판정 축은 그 값을 읽지 않는다 — 녹화는 판정 근거가 아니다", () => {
    const judgeSection = source.slice(source.indexOf("recordMachineEvidence"));
    expect(judgeSection).not.toContain("SLOT_FREEZE_RECORD_FRAMES");
  });
});
