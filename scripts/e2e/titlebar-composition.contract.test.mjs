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
    // 실행기는 저장소를 열고 닫는다. 어느 칸에 무엇이 적히는가는 라이브러리가 소유하므로,
    // 그 자리는 앱 없이도 단위로 다시 부를 수 있다(lib/titlebar-gate-contribution.test.mjs).
    const injection = readFileSync(
      new URL("./lib/titlebar-cold-start-run.mjs", import.meta.url),
      "utf8",
    );
    for (const marker of [
      "createBrowserGateReportStore",
      "TITLEBAR_OWNED_GATES",
      "recordB12ColdStartCells",
      "titlebarGateStoreRoot",
      "beginEvidenceRun",
      "finishEvidenceRun",
      ".persist()",
    ]) expect(summary).toContain(marker);
    for (const marker of [
      "b12ColdStartCells",
      "recordMachineEvidence",
      "recordMachineStatus",
      'gate: "B12"',
    ]) expect(injection).toContain(marker);
    // 정본 보고서는 이 실행기가 소유한 칸만 든다 — 나머지 11칸은 재지 않았다는 사실 그대로 남는다.
    expect(summary).toContain('gates: TITLEBAR_OWNED_GATES');
    expect(summary).not.toMatch(/blockPending/);
    // 주입이 두 자리에 살면 한쪽만 고쳐진다 — 실행기는 칸에 직접 적지 않는다.
    expect(summary).not.toMatch(/recordMachine(Evidence|Status)/);
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

  // 하니스도 이름으로 가르지 않는다. 예전에는 `framework === "electron"` 이면 실행을 통째로
  // 멈췄고(blocked), 그 칸은 인수 장부에서 "재지 않은 칸"으로 사라졌다.
  it("reads the framework's own traffic-light declaration instead of its name", () => {
    for (const marker of [
      "info.titlebarComposition",
      "publicProvision(",
      "composesTrafficLights(",
      "declaredAbsentReport(",
      "provision,",
    ]) expect(source).toContain(marker);
    expect(source).not.toMatch(/framework\s*===\s*["'](electron|tauri)["']/);
    expect(source).not.toContain('status: "blocked"');
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
