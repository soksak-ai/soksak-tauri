// @vitest-environment node
//
// 요약기가 정본 36칸 보고서에 B12 를 실제로 적는지 값으로 확인한다. 앱은 필요 없다 —
// cycle 관측을 파일로 세워 두고 요약기를 그 홈에서 돌린 뒤 기록된 칸을 읽는다.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SUMMARY = fileURLToPath(new URL("./titlebar-composition-summary.mjs", import.meta.url));
const BUILD_ID = "c".repeat(64);
const ENGINES = ["browser", "browser-chromium", "browser-chromium-offscreen"];
const homes = [];

function temporaryHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "soksak-b12-summary-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop(), { recursive: true, force: true });
});

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runRoot(home, runId) {
  return path.join(home, ".soksak-e2e", "evidence", "titlebar-composition", runId);
}

function writeCycle(home, runId, cycle, { windows = ["main"], status = "green" } = {}) {
  writeJson(path.join(runRoot(home, runId), cycle, "cycle.json"), {
    schemaVersion: 1,
    buildId: BUILD_ID,
    runId,
    cycle,
    framework: "tauri",
    platform: "darwin",
    status,
    windows,
    machines: windows.map((window) => ({
      schemaVersion: 1,
      status,
      buildId: BUILD_ID,
      runId,
      cycle,
      window,
      framework: "tauri",
      coldStart: {
        generation: Number(cycle),
        ownerIdentity: `${window}#${cycle}`,
        presentedCompositionSequence: 9,
        coldPresentationRevision: 9,
        finalPresentationRevision: 26,
      },
      verdicts: ENGINES.map((engine) => ({ engine, status })),
    })),
  });
  for (const window of windows) {
    writeJson(path.join(runRoot(home, runId), cycle, window, "machine.json"), {
      schemaVersion: 1,
      status,
      buildId: BUILD_ID,
      runId,
      cycle,
      window,
      framework: "tauri",
      verdicts: ENGINES.map((engine) => ({
        engine,
        verdict: { status, evidence: [], reason: null },
        evidence: { engine, fabricated: true },
      })),
    });
  }
}

function runSummary(home, runId) {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [SUMMARY], {
        env: { ...process.env, HOME: home, BROWSER_EVIDENCE_BUILD_ID: BUILD_ID, B12_RUN_ID: runId },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function persistedReport(home) {
  const store = path.join(home, ".soksak-e2e", "evidence", "titlebar-gates");
  for (const bucket of ["current", "last-red"]) {
    const file = path.join(store, bucket, "browser-gates.json");
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
  }
  throw new Error(`no canonical browser gate report under ${store}`);
}

describe("titlebar composition summary → canonical 3x12 report", () => {
  it("writes the cold-start run failure into every B12 cell", () => {
    const home = temporaryHome();
    const runId = "b12-red-run";
    writeCycle(home, runId, "1");
    const { code } = runSummary(home, runId);
    expect(code).toBe(1);

    const report = persistedReport(home);
    expect(report.identity).toMatchObject({
      framework: "tauri",
      platform: "darwin",
      buildId: BUILD_ID,
      runId,
    });
    for (const engine of ENGINES) {
      const cell = report.engines[engine].B12.machine;
      expect(cell.status).toBe("red");
      expect(cell.reason).toBe("B12 cold-start run red");
      expect(cell.evidence.join(" ")).toMatch(/cycles=1\/3/);
      // 소유하지 않은 11칸은 재지 않은 그대로다 — 여기서 green 도 blocked 도 만들지 않는다.
      expect(report.engines[engine].B07.machine.status).toBe("not-run");
    }
    expect(report.summary.machine.counts.red).toBe(3);
  });

  it("refuses to record green when the anchor sample does not satisfy the B12 judge", () => {
    const home = temporaryHome();
    const runId = "b12-anchor-run";
    for (const cycle of ["1", "2", "3"]) writeCycle(home, runId, cycle);
    const { code } = runSummary(home, runId);
    expect(code).toBe(1);

    const report = persistedReport(home);
    for (const engine of ENGINES) {
      const cell = report.engines[engine].B12.machine;
      expect(cell.status).toBe("red");
      expect(cell.judgeReceipt.judgeId).toBe("B12-machine-v1");
      expect(cell.evidence.join(" ")).toMatch(/B12:/);
    }
  });
});
