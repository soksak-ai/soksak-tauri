// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeTitlebarColdStartRun } from "./titlebar-cold-start-run.mjs";

const ENGINES = Object.freeze(["browser", "browser-chromium", "browser-chromium-offscreen"]);
const BUILD_ID = "a".repeat(64);
const RUN_ID = "b12-run-1";
const WINDOWS = Object.freeze(["main", "w-a"]);

function coldStart(window, overrides = {}) {
  return {
    generation: 1,
    ownerIdentity: `${window}#1`,
    presentedCompositionSequence: 9,
    coldPresentationRevision: 9,
    finalPresentationRevision: 26,
    ...overrides,
  };
}

function machine(cycle, window, status = "green", coldStartOverrides = {}) {
  return {
    schemaVersion: 1,
    status,
    buildId: BUILD_ID,
    runId: RUN_ID,
    cycle: String(cycle),
    window,
    framework: "tauri",
    coldStart: coldStart(window, coldStartOverrides),
    verdicts: ENGINES.map((engine) => ({ engine, status })),
  };
}

function cycle(value, overrides = {}, coldStartOverrides = {}) {
  return {
    schemaVersion: 1,
    status: "green",
    buildId: BUILD_ID,
    runId: RUN_ID,
    cycle: String(value),
    framework: "tauri",
    platform: "darwin",
    windows: [...WINDOWS],
    machines: WINDOWS.map((window) => machine(value, window, "green", coldStartOverrides)),
    ...overrides,
  };
}

function run(cycles = [cycle(1), cycle(2), cycle(3)]) {
  return { buildId: BUILD_ID, runId: RUN_ID, cycles };
}

function terminalCycle(value, status, framework, reason) {
  return {
    schemaVersion: 1,
    status,
    buildId: BUILD_ID,
    runId: RUN_ID,
    cycle: String(value),
    framework,
    platform: framework === "electron" ? "darwin" : "linux",
    windows: [],
    machines: [],
    reason,
  };
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

  it("rejects a warm cycle whose native composition sequence continues the previous cycle", () => {
    // 앱이 실제로 죽었으면 native 합성 sequence가 다시 1부터 센다. 앞 cycle의 마지막 값보다
    // 큰 냉시작 값은 프로세스가 살아남았다는 뜻이며 냉시작 3회 계약을 깬다.
    const warm = run([
      cycle(1),
      cycle(2, {}, { coldPresentationRevision: 27, finalPresentationRevision: 44 }),
      cycle(3, {}, { coldPresentationRevision: 45, finalPresentationRevision: 62 }),
    ]);
    expect(judgeTitlebarColdStartRun(warm).status).toBe("red");
  });

  it("requires one cold-start receipt per window and rejects a stalled composition sequence", () => {
    const cases = [
      (value) => { delete value.cycles[1].machines[0].coldStart; },
      (value) => { value.cycles[1].machines[0].coldStart.generation = 0; },
      (value) => { value.cycles[1].machines[0].coldStart.ownerIdentity = ""; },
      (value) => { value.cycles[1].machines[0].coldStart.presentedCompositionSequence = 0; },
      // 표시된 합성보다 앞선 냉시작 읽기는 낡은 표본이다.
      (value) => { value.cycles[1].machines[0].coldStart.coldPresentationRevision = 8; },
      // 높이 3종과 reset은 반드시 합성을 진행시킨다. 멈춘 sequence는 측정하지 않은 cycle이다.
      (value) => { value.cycles[1].machines[0].coldStart.finalPresentationRevision = 9; },
      (value) => { value.cycles[1].machines[0].coldStart.generation = "1"; },
    ];
    for (const mutate of cases) {
      const value = run();
      mutate(value);
      expect(judgeTitlebarColdStartRun(value).status).toBe("red");
    }
  });

  it("keeps Electron explicitly blocked only after all three cold starts report the adapter absence", () => {
    const cycles = [1, 2, 3].map((value) => terminalCycle(
      value,
      "blocked",
      "electron",
      "Electron native traffic-light position adapter is absent",
    ));
    expect(judgeTitlebarColdStartRun(run(cycles))).toMatchObject({
      status: "blocked",
      evidence: [expect.stringContaining("adapter is absent")],
    });
  });

  it("treats an incomplete blocked run as RED instead of hiding missing cold starts", () => {
    expect(judgeTitlebarColdStartRun(run([
      terminalCycle(1, "blocked", "electron", "adapter is absent"),
    ])).status).toBe("red");
  });

  it("accepts not-applicable only after all three identity-bound cold starts", () => {
    const cycles = [1, 2, 3].map((value) => terminalCycle(
      value,
      "not-applicable",
      "tauri",
      "macOS traffic lights are absent",
    ));
    expect(judgeTitlebarColdStartRun(run(cycles))).toEqual({
      status: "not-applicable",
      evidence: [],
    });
    cycles[2].runId = "stale-run";
    expect(judgeTitlebarColdStartRun(run(cycles)).status).toBe("red");
  });
});
