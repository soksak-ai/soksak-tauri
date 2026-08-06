import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

const DIRECTIONS = Object.freeze(["left", "right"]);
const RECT_KEYS = Object.freeze(["left", "top", "width", "height"]);
const RELATION_KEYS = Object.freeze([
  "boundTabId",
  "boundPaneId",
  "relationId",
  "placement",
  "connected",
  "side",
  "borderMode",
  "pathCount",
]);
const BASELINE_KEYS = Object.freeze(["persistedPin", "arrangement", "splitTree"]);
const MAXIMIZED_KEYS = Object.freeze([
  "persistedPin",
  "effectiveStation",
  "maximizedPaneId",
  "cells",
  "splitTree",
  "relation",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function inspectPin(value, path, failures) {
  if (!requireExactKeys(value, ["mode", "station"], path, failures)) return false;
  let valid = true;
  if (value.mode !== "pin") {
    failures.push(`${path}.mode=pin/${displayValue(value.mode)}`);
    valid = false;
  }
  if (!(Number.isFinite(value.station) && value.station >= 0 && value.station <= 100)) {
    failures.push(`${path}.station=0..100/${displayValue(value.station)}`);
    valid = false;
  }
  return valid;
}

function inspectRect(value, path, failures, { full = false } = {}) {
  if (!requireExactKeys(value, RECT_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of RECT_KEYS) {
    if (!Number.isFinite(value[key])) {
      failures.push(`${path}.${key}=finite/${displayValue(value[key])}`);
      valid = false;
    }
  }
  if (!(value.width > 0 && value.height > 0)) {
    failures.push(`${path}.size=positive/${displayValue({ width: value.width, height: value.height })}`);
    valid = false;
  }
  if (full && canonical(value) !== canonical({ left: 0, top: 0, width: 100, height: 100 })) {
    failures.push(`${path}=full-percent-rect/${displayValue(value)}`);
    valid = false;
  }
  return valid;
}

function inspectCells(value, path, failures, { exactlyOneFull = false } = {}) {
  if (!Array.isArray(value) || value.length < 1) {
    failures.push(`${path}=non-empty-array/${displayValue(value)}`);
    return false;
  }
  if (exactlyOneFull && value.length !== 1) {
    failures.push(`${path}.length=1/${displayValue(value.length)}`);
  }
  let valid = true;
  const ids = new Set();
  value.forEach((cell, index) => {
    const cellPath = `${path}[${index}]`;
    if (!requireExactKeys(cell, ["id", "rect"], cellPath, failures)) {
      valid = false;
      return;
    }
    if (!hasText(cell.id) || ids.has(cell.id)) {
      failures.push(`${cellPath}.id=unique-non-empty/${displayValue(cell.id)}`);
      valid = false;
    } else ids.add(cell.id);
    if (!inspectRect(cell.rect, `${cellPath}.rect`, failures, { full: exactlyOneFull })) valid = false;
  });
  return valid;
}

function inspectBaseline(value, path, failures) {
  if (!requireExactKeys(value, BASELINE_KEYS, path, failures)) return false;
  const pinValid = inspectPin(value.persistedPin, `${path}.persistedPin`, failures);
  let arrangementValid = false;
  if (requireExactKeys(value.arrangement, ["station", "cells"], `${path}.arrangement`, failures)) {
    arrangementValid = Number.isFinite(value.arrangement.station)
      && value.arrangement.station >= 0
      && value.arrangement.station <= 100;
    if (!arrangementValid) {
      failures.push(`${path}.arrangement.station=0..100/${displayValue(value.arrangement.station)}`);
    }
    if (!inspectCells(value.arrangement.cells, `${path}.arrangement.cells`, failures)) arrangementValid = false;
  }
  if (pinValid && arrangementValid && value.persistedPin.station !== value.arrangement.station) {
    failures.push(`${path}.persistedPin.station=arrangement.station/${displayValue({
      pin: value.persistedPin.station,
      arrangement: value.arrangement.station,
    })}`);
  }
  if (!isRecord(value.splitTree)) {
    failures.push(`${path}.splitTree=record/${displayValue(value.splitTree)}`);
    return false;
  }
  return pinValid && arrangementValid;
}

function inspectRelation(value, direction, targetPaneId, path, failures) {
  if (!requireExactKeys(value, RELATION_KEYS, path, failures)) return;
  for (const field of ["boundTabId", "boundPaneId", "relationId"]) {
    if (!hasText(value[field])) failures.push(`${path}.${field}=non-empty/${displayValue(value[field])}`);
  }
  if (value.boundPaneId !== targetPaneId) {
    failures.push(`${path}.boundPaneId=${displayValue(targetPaneId)}/${displayValue(value.boundPaneId)}`);
  }
  const expected = {
    placement: "pin",
    connected: true,
    side: direction,
    borderMode: "union",
    pathCount: 1,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      failures.push(`${path}.${key}=${displayValue(expectedValue)}/${displayValue(value[key])}`);
    }
  }
}

function inspectCase(value, index, baseline, failures, seenDirections, seenTargets) {
  const path = `cases[${index}]`;
  if (!requireExactKeys(value, ["direction", "targetPaneId", "maximized", "restored"], path, failures)) return;
  if (!DIRECTIONS.includes(value.direction) || seenDirections.has(value.direction)) {
    failures.push(`${path}.direction=unique-known/${displayValue(value.direction)}`);
  } else seenDirections.add(value.direction);
  if (!hasText(value.targetPaneId) || seenTargets.has(value.targetPaneId)) {
    failures.push(`${path}.targetPaneId=unique-non-empty/${displayValue(value.targetPaneId)}`);
  } else seenTargets.add(value.targetPaneId);

  if (!requireExactKeys(value.maximized, MAXIMIZED_KEYS, `${path}.maximized`, failures)) return;
  inspectPin(value.maximized.persistedPin, `${path}.maximized.persistedPin`, failures);
  if (canonical(value.maximized.persistedPin) !== canonical(baseline.persistedPin)) {
    failures.push(`${path}.maximized.persistedPin=baseline`);
  }
  const expectedStation = value.direction === "left" ? 100 : 0;
  if (value.maximized.effectiveStation !== expectedStation) {
    failures.push(`${path}.maximized.effectiveStation=${expectedStation}/${displayValue(value.maximized.effectiveStation)}`);
  }
  if (value.maximized.maximizedPaneId !== value.targetPaneId) {
    failures.push(`${path}.maximized.maximizedPaneId=${displayValue(value.targetPaneId)}/${displayValue(value.maximized.maximizedPaneId)}`);
  }
  inspectCells(value.maximized.cells, `${path}.maximized.cells`, failures, { exactlyOneFull: true });
  if (value.maximized.cells?.[0]?.id !== value.targetPaneId) {
    failures.push(`${path}.maximized.cells[0].id=${displayValue(value.targetPaneId)}/${displayValue(value.maximized.cells?.[0]?.id)}`);
  }
  if (canonical(value.maximized.splitTree) !== canonical(baseline.splitTree)) {
    failures.push(`${path}.maximized.splitTree=baseline`);
  }
  inspectRelation(value.maximized.relation, value.direction, value.targetPaneId, `${path}.maximized.relation`, failures);

  inspectBaseline(value.restored, `${path}.restored`, failures);
  if (canonical(value.restored) !== canonical(baseline)) {
    failures.push(`${path}.restored=baseline`);
  }
  if (!baseline.arrangement?.cells?.some((cell) => cell?.id === value.targetPaneId)) {
    failures.push(`${path}.targetPaneId=baseline-cell/${displayValue(value.targetPaneId)}`);
  }
}

/** PIN maximize는 저장 상태를 쓰지 않는 일시 projection이어야 한다. */
export function judgeB08MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "baseline", "cases"], "evidence", failures)) {
    return finishMachineVerdict("B08", failures, "B08:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  const baselineValid = inspectBaseline(value.baseline, "baseline", failures);
  if (!Array.isArray(value.cases) || value.cases.length !== DIRECTIONS.length) {
    failures.push(`cases=exactly-${DIRECTIONS.length}/${displayValue(value.cases?.length)}`);
  } else if (baselineValid) {
    const seenDirections = new Set();
    const seenTargets = new Set();
    value.cases.forEach((maximizeCase, index) => {
      inspectCase(maximizeCase, index, value.baseline, failures, seenDirections, seenTargets);
    });
    for (const direction of DIRECTIONS) {
      if (!seenDirections.has(direction)) failures.push(`direction=${direction}=missing`);
    }
  }
  return finishMachineVerdict(
    "B08",
    failures,
    `${value.engine}/B08:left=100;right=0;stored-pin+split-invariant;restore=exact`,
  );
}
