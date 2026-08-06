import path from "node:path";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";

const REQUIRED_CYCLES = Object.freeze(["1", "2", "3"]);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function requireB12RunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw new TypeError("B12_RUN_ID must use 1..128 ASCII letters, digits, dot, underscore, or dash");
  }
  return value;
}

export function requireB12Cycle(value) {
  const cycle = String(value ?? "");
  if (!REQUIRED_CYCLES.includes(cycle)) {
    throw new TypeError(`B12_CYCLE must be exactly 1, 2, or 3; got ${cycle || "empty"}`);
  }
  return cycle;
}

export function titlebarEvidenceRunRoot(home, runId) {
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw new TypeError("B12 evidence home must be an absolute path");
  }
  return path.join(
    home,
    ".soksak-e2e",
    "evidence",
    "titlebar-composition",
    requireB12RunId(runId),
  );
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function inspectMachine(machine, cycle, identity, failures) {
  if (!machine || typeof machine !== "object" || Array.isArray(machine)) {
    failures.push(`cycle ${cycle.cycle}: machine must be an object`);
    return;
  }
  const expectedKeys = [
    "buildId", "cycle", "framework", "runId", "schemaVersion", "status", "verdicts", "window",
  ];
  if (!sameList(Object.keys(machine).sort(), expectedKeys)) {
    failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: machine schema mismatch`);
    return;
  }
  if (machine.schemaVersion !== 1 || machine.status !== "green") {
    failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: machine=${String(machine.status)}`);
  }
  for (const key of ["buildId", "runId", "cycle", "framework"]) {
    if (machine[key] !== cycle[key] || machine[key] !== identity[key]) {
      failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: ${key} drift`);
    }
  }
  if (!cycle.windows.includes(machine.window)) {
    failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: undeclared window`);
  }
  if (!Array.isArray(machine.verdicts)) {
    failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: verdicts missing`);
    return;
  }
  const engines = machine.verdicts.map((verdict) => verdict?.engine);
  if (!sameList(engines, BROWSER_ACCEPTANCE_ENGINES)) {
    failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: engine set mismatch`);
  }
  machine.verdicts.forEach((verdict, index) => {
    if (!verdict || Object.keys(verdict).sort().join(",") !== "engine,status"
        || verdict.engine !== BROWSER_ACCEPTANCE_ENGINES[index]
        || verdict.status !== "green") {
      failures.push(`cycle ${cycle.cycle}/${String(machine.window)}: verdict ${index} not green`);
    }
  });
}

function inspectCycleIdentity(cycle, value, failures) {
  if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) {
    failures.push("cycle must be an object");
    return false;
  }
  const terminal = new Set(["red", "blocked", "not-applicable"]).has(cycle.status);
  const expectedKeys = [
    "buildId", "cycle", "framework", "machines", "platform", "runId", "schemaVersion", "status", "windows",
    ...(terminal ? ["reason"] : []),
  ].sort();
  if (!sameList(Object.keys(cycle).sort(), expectedKeys)) {
    failures.push(`cycle ${String(cycle.cycle)}: schema mismatch`);
    return false;
  }
  if (cycle.schemaVersion !== 1) failures.push(`cycle ${String(cycle.cycle)}: schemaVersion!=1`);
  if (cycle.buildId !== value.buildId) failures.push(`cycle ${String(cycle.cycle)}: buildId drift`);
  if (cycle.runId !== value.runId) failures.push(`cycle ${String(cycle.cycle)}: runId drift`);
  if (!text(cycle.framework)) failures.push(`cycle ${String(cycle.cycle)}: framework is absent`);
  if (!text(cycle.platform)) failures.push(`cycle ${String(cycle.cycle)}: platform is absent`);
  if (!Array.isArray(cycle.windows) || !Array.isArray(cycle.machines)) {
    failures.push(`cycle ${String(cycle.cycle)}: windows/machines must be arrays`);
  }
  if (terminal && !text(cycle.reason)) failures.push(`cycle ${String(cycle.cycle)}: reason is absent`);
  return true;
}

/** Closes three cold processes into one immutable artifact/run verdict. */
export function judgeTitlebarColdStartRun(value) {
  const failures = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "red", evidence: ["B12 cold-start run must be an object"] };
  }
  if (!text(value.buildId)) failures.push("run buildId is absent");
  try { requireB12RunId(value.runId); } catch (error) { failures.push(error.message); }
  const cycles = Array.isArray(value.cycles) ? value.cycles : [];

  if (failures.length > 0) return { status: "red", evidence: failures };
  if (cycles.length !== REQUIRED_CYCLES.length) {
    failures.push(`cycles=${cycles.length}/${REQUIRED_CYCLES.length}`);
  }

  const sorted = [...cycles].sort((a, b) => String(a?.cycle).localeCompare(String(b?.cycle)));
  const cycleIds = sorted.map((cycle) => String(cycle?.cycle ?? ""));
  if (!sameList(cycleIds, REQUIRED_CYCLES)) failures.push(`cycles=${cycleIds.join(",")}/1,2,3`);
  const structurallyValid = sorted.map((cycle) => inspectCycleIdentity(cycle, value, failures));
  const baselineFramework = sorted[0]?.framework;
  const baselinePlatform = sorted[0]?.platform;
  sorted.forEach((cycle) => {
    if (cycle?.framework !== baselineFramework) {
      failures.push(`cycle ${String(cycle?.cycle)}: framework drift`);
    }
    if (cycle?.platform !== baselinePlatform) {
      failures.push(`cycle ${String(cycle?.cycle)}: platform drift`);
    }
  });
  if (failures.length > 0) return { status: "red", evidence: failures };
  const statuses = sorted.map((cycle) => cycle.status);
  if (statuses.every((status) => status === "blocked")) {
    return { status: "blocked", evidence: [...new Set(sorted.map((cycle) => cycle.reason))] };
  }
  if (statuses.every((status) => status === "not-applicable")) {
    return { status: "not-applicable", evidence: [] };
  }
  if (statuses.some((status) => status !== "green")) {
    return {
      status: "red",
      evidence: sorted.map((cycle) => `cycle ${cycle.cycle}: ${cycle.status}${cycle.reason ? ` (${cycle.reason})` : ""}`),
    };
  }
  const baselineWindows = sorted[0]?.windows;
  for (let index = 0; index < sorted.length; index += 1) {
    const cycle = sorted[index];
    if (!structurallyValid[index]) continue;
    if (cycle.platform !== "darwin") failures.push(`cycle ${String(cycle.cycle)}: platform=${String(cycle.platform)}`);
    if (!Array.isArray(cycle.windows) || cycle.windows.length === 0
        || !sameList(cycle.windows, [...cycle.windows].sort())) {
      failures.push(`cycle ${String(cycle.cycle)}: windows must be non-empty and sorted`);
    }
    if (!sameList(cycle.windows, baselineWindows)) {
      failures.push(`cycle ${String(cycle.cycle)}: window population drift`);
    }
    if (!Array.isArray(cycle.machines) || cycle.machines.length !== cycle.windows.length) {
      failures.push(`cycle ${String(cycle.cycle)}: machine/window count mismatch`);
      continue;
    }
    const identity = {
      buildId: value.buildId,
      runId: value.runId,
      cycle: cycle.cycle,
      framework: cycle.framework,
    };
    cycle.machines.forEach((machine) => inspectMachine(machine, cycle, identity, failures));
    const machineWindows = cycle.machines.map((machine) => machine?.window).sort();
    if (!sameList(machineWindows, cycle.windows)) {
      failures.push(`cycle ${String(cycle.cycle)}: machine window set mismatch`);
    }
  }
  return { status: failures.length === 0 ? "green" : "red", evidence: failures };
}
