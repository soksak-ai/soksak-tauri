// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("titlebar composition live E2E contract", () => {
  const source = readFileSync(new URL("./titlebar-composition.mjs", import.meta.url), "utf8");
  const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");

  it("uses only public status/DOM commands and a finite height sequence", () => {
    for (const marker of [
      'rpc("window.list"',
      'rpc("window.startup"',
      'rpc("window.record"',
      'rpc("titlebar.composition"',
      'rpc("titlebar.height.set"',
      'rpc("titlebar.height.reset"',
      'rpc("ui.measure"',
      'rpc("window.snapshot"',
      "[30, 60, 72]",
      "held:",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("window.focus");
  });

  it("judges every live window against all three browser acceptance identities", () => {
    expect(source).toContain("BROWSER_ACCEPTANCE_ENGINES");
    expect(source).toContain("judgeB12MachineEvidence");
    expect(source).toContain("for (const windowLabel of labels)");
    expect(source).toContain("for (const engine of BROWSER_ACCEPTANCE_ENGINES)");
    expect(source).toContain('verdict.status !== "green"');
  });

  it("overwrites stale machine evidence and persists RED details before failing", () => {
    expect(source).toContain('status: "running"');
    const reportWrite = source.indexOf('JSON.stringify(report, null, 2)');
    const failedVerdict = source.indexOf("if (failed)");
    expect(reportWrite).toBeGreaterThan(0);
    expect(failedVerdict).toBeGreaterThan(reportWrite);
    expect(source).toContain('failed.verdict.evidence.join("; ")');
  });

  it("always restores exact titlebar inline geometry", () => {
    const finallyAt = source.indexOf("finally {");
    const resetAt = source.indexOf('rpc("titlebar.height.reset"', finallyAt);
    expect(finallyAt).toBeGreaterThan(0);
    expect(resetAt).toBeGreaterThan(finallyAt);
  });

  it("runs one finite hostile resize per live window without focus or polling", () => {
    expect(source).toContain("hostileWindowResizeSizes");
    expect(source.match(/rpc\("window\.resizeSequence"/g)).toHaveLength(1);
    expect(source).toContain('rpc("window.info"');
    expect(source).toContain('rpc("ui.layout.wait-settled"');
    expect(source).toMatch(/hostileResize[:,]/);
    expect(source).toContain("heldRestore");
    expect(source).toContain("recordDir");
    expect(source).toContain("entry?.observation?.generation");
    expect(source).toContain("entry?.observation?.titlebar");
    expect(source).not.toContain("entry?.observation?.verdict");
    expect(source).not.toMatch(/setTimeout|setInterval|window\.focus/);
  });

  it("binds exactly three cold starts and their aggregate verdict to one executable", () => {
    const target = makefile.split("e2e-titlebar-dev:")[1]?.split("\n\n")[0] ?? "";
    expect(target).toContain("for cycle in 1 2 3");
    expect(target).toContain('shasum -a 256 "$(DEV_EXECUTABLE)"');
    expect(target).toContain('BROWSER_EVIDENCE_BUILD_ID="$$evidence_build_id"');
    expect(target).toContain('B12_RUN_ID="$$evidence_run_id"');
    expect(target).toContain('B12_CYCLE="$$cycle"');
    expect(target).toContain("titlebar-composition-summary.mjs");
    expect(target).not.toContain("break;");
  });

  it("persists artifact and cold-run identity in every cycle and window receipt", () => {
    for (const marker of [
      "requireBrowserEvidenceBuildId",
      "requireB12RunId",
      "buildId,",
      "runId,",
      "cycle,",
      '"cycle.json"',
    ]) expect(source).toContain(marker);
  });
});
