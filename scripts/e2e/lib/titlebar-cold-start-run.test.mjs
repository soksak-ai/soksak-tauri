// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeTitlebarColdStartRun } from "./titlebar-cold-start-run.mjs";

const ENGINES = Object.freeze(["browser", "browser-chromium", "browser-chromium-offscreen"]);
const BUILD_ID = "a".repeat(64);
const RUN_ID = "b12-run-1";
const WINDOWS = Object.freeze(["main", "w-a"]);

function machine(cycle, window, status = "green") {
  return {
    schemaVersion: 1,
    status,
    buildId: BUILD_ID,
    runId: RUN_ID,
    cycle: String(cycle),
    window,
    framework: "tauri",
    verdicts: ENGINES.map((engine) => ({ engine, status })),
  };
}

function cycle(value, overrides = {}) {
  return {
    schemaVersion: 1,
    status: "green",
    buildId: BUILD_ID,
    runId: RUN_ID,
    cycle: String(value),
    framework: "tauri",
    platform: "darwin",
    windows: [...WINDOWS],
    machines: WINDOWS.map((window) => machine(value, window)),
    ...overrides,
  };
}

function run(cycles = [cycle(1), cycle(2), cycle(3)]) {
  return { buildId: BUILD_ID, runId: RUN_ID, cycles };
}

describe("B12 three-cold-start aggregate verdict", () => {
  it("is GREEN only for exact cycles 1/2/3 from one build/run and one window population", () => {
    expect(judgeTitlebarColdStartRun(run())).toEqual({ status: "green", evidence: [] });
  });

  it.each([
    ["missing cycle", () => run([cycle(1), cycle(2)])],
    ["duplicate cycle", () => run([cycle(1), cycle(2), cycle(2)])],
    ["build drift", () => {
      const third = cycle(3, { buildId: "c".repeat(64) });
      third.machines = third.machines.map((value) => ({ ...value, buildId: third.buildId }));
      return run([cycle(1), cycle(2), third]);
    }],
    ["run drift", () => run([cycle(1), cycle(2), cycle(3, { runId: "another-run" })])],
    ["window drift", () => run([cycle(1), cycle(2), cycle(3, {
      windows: ["main"], machines: [machine(3, "main")],
    })])],
    ["machine red", () => run([cycle(1), cycle(2), cycle(3, {
      machines: [machine(3, "main", "red"), machine(3, "w-a")],
    })])],
    ["engine omission", () => {
      const third = cycle(3);
      third.machines[0].verdicts.pop();
      return run([cycle(1), cycle(2), third]);
    }],
  ])("rejects %s instead of reusing stale evidence", (_name, makeRun) => {
    expect(judgeTitlebarColdStartRun(makeRun()).status).toBe("red");
  });

  it("keeps Electron explicitly blocked when its native button-position adapter is absent", () => {
    expect(judgeTitlebarColdStartRun(run([{
      schemaVersion: 1,
      status: "blocked",
      buildId: BUILD_ID,
      runId: RUN_ID,
      cycle: "1",
      framework: "electron",
      platform: "darwin",
      windows: [],
      machines: [],
      reason: "Electron native traffic-light position adapter is absent",
    }]))).toMatchObject({
      status: "blocked",
      evidence: [expect.stringContaining("adapter is absent")],
    });
  });
});
