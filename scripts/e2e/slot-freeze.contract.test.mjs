// @vitest-environment node
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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

describe("slot-freeze instrumentation lifecycle", () => {
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
    expect(source).toContain('item.nodePath === `tab/view/${tabId}`');
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
    expect(lighting).toContain("1 - dims[index]");
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

  it("교차 이동의 자동 판정은 recorder callback이 아닌 공개 layout 거래 장부를 소비한다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("layoutTransactionVerdict");
    expect(source).toContain('path.join(dir, "layout-transaction.json")');
    expect(source).not.toContain("traceAddresses:");
    expect(source).not.toContain("clicked.trace?.samples");
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
