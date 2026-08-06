// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("slot-freeze instrumentation lifecycle", () => {
  it("녹화는 시각 진단을 남기지만 E2E 성공/실패를 판정하지 않는다", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    const observer = source.split("function observeFrameSequence")[1]?.split("\n}\n")[0] ?? "";
    expect(observer).toContain('kind: "human-visual-evidence"');
    expect(observer).toContain("automatedVerdict: false");
    expect(observer).not.toContain("throw new Error");
    expect(source).not.toContain("assertFrameSequence(");
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

  it("proves modal pixels over a browser surface and verifies instrumentation cleanup", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("assertChromeAnchorWithin");
    expect(source).toContain("modalOverlayProbe");
    expect(source).toContain("assertCaptureInstrumentationCleared");
  });

  it("checks the focused pane relation and exempts the rail from focus lighting after every cross-click", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
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
    expect(source).toContain("pinnedDomTraceVerdict");
    expect(source).toContain("JSON.stringify(before.cells) !== JSON.stringify(after.cells)");
    expect(source).toContain("PIN 클릭이 native bounds를 기록");
    expect(source).toContain("process.env.CROSS_CLICK_CYCLES ?? 3");
    expect(source).toContain('process.env.BROWSER_SCENARIOS ?? "flow,pin,resize,overlay,scroll"');
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

  it("requires one shared pane presentation owner for plugin chrome and native members", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("rendererTopologyOwnershipVerdict");
  });

  it("drives and measures real wheel scrolling for every browser implementation", () => {
    const source = readFileSync(new URL("./slot-freeze.mjs", import.meta.url), "utf8");
    expect(source).toContain("verifyScrollInput");
    expect(source).toContain(".input.scroll`");
    expect(source).toContain("afterY");
    expect(source).toContain("restoredY");
    expect(source).toContain("verifyFullCapture");
    expect(source).toContain(".capture.full`");
    expect(source).toContain("pngHeight");
    expect(source).toContain("fixtureMarkerRowVerdict");
    expect(source).toContain("identity.ok");
  });
});
