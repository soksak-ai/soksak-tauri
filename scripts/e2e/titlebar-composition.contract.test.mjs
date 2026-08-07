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

  it("measures the cold start and the settled load as two separate samples", () => {
    const startupAt = source.indexOf("const startup = await readStartup(");
    const coldAt = source.indexOf('"cold", null)');
    const settledAt = source.indexOf('rpc("ui.layout.wait-settled"');
    const baselineAt = source.indexOf('"baseline", null)');
    expect(startupAt).toBeGreaterThan(0);
    expect(coldAt).toBeGreaterThan(startupAt);
    expect(settledAt).toBeGreaterThan(coldAt);
    expect(baselineAt).toBeGreaterThan(settledAt);
    for (const marker of [
      "publicStartup",
      "publicOwner",
      "publicHostileOwner",
      "startup,",
      "cold,",
      "coldStart: {",
      "presentedCompositionSequence:",
      "coldPresentationRevision:",
      "finalPresentationRevision:",
      "coldStart: report.coldStart,",
    ]) expect(source).toContain(marker);
  });

  it("records the cold-start verdict into the canonical 3x12 report", () => {
    const summary = readFileSync(
      new URL("./titlebar-composition-summary.mjs", import.meta.url),
      "utf8",
    );
    for (const marker of [
      "createBrowserGateReportStore",
      "TITLEBAR_OWNED_GATES",
      "b12ColdStartCells",
      "titlebarGateStoreRoot",
      "beginEvidenceRun",
      "finishEvidenceRun",
      "recordMachineEvidence",
      "recordMachineStatus",
      ".persist()",
    ]) expect(summary).toContain(marker);
    // 정본 보고서는 이 실행기가 소유한 칸만 든다 — 나머지 11칸은 재지 않았다는 사실 그대로 남는다.
    expect(summary).toContain('gates: TITLEBAR_OWNED_GATES');
    expect(summary).not.toMatch(/blockPending/);
  });

  it("anchors a green B12 cell to a real sample from the last cold start", () => {
    const summary = readFileSync(
      new URL("./titlebar-composition-summary.mjs", import.meta.url),
      "utf8",
    );
    expect(summary).toContain('"machine.json"');
    expect(summary).toContain("anchors");
    // 마지막 냉시작의 표본만 영수증이 된다 — 아무 cycle 이나 집으면 어느 실행인지 알 수 없다.
    expect(summary).toContain("cycles.at(-1)");
    expect(summary).toContain("verdicts");
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
