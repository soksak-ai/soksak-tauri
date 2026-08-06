import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

const POSITIONS = Object.freeze(["left-adjacent", "right-adjacent", "detached"]);
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
const SNAPSHOT_KEYS = Object.freeze(["station", "rail", "panes", "splitTree"]);
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);

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

function inspectRect(value, path, failures) {
  if (!requireExactKeys(value, RECT_KEYS, path, failures)) return;
  for (const key of RECT_KEYS) {
    if (!Number.isFinite(value[key])) failures.push(`${path}.${key}=finite/${displayValue(value[key])}`);
  }
  if (!(value.w > 0 && value.h > 0)) failures.push(`${path}.size=positive/${value.w}x${value.h}`);
}

function inspectRelation(value, position, path, failures) {
  if (!requireExactKeys(value, RELATION_KEYS, path, failures)) return;
  for (const field of ["boundTabId", "boundPaneId", "relationId"]) {
    if (!hasText(value[field])) failures.push(`${path}.${field}=non-empty/${displayValue(value[field])}`);
  }
  if (value.placement !== "pin") failures.push(`${path}.placement=pin/${displayValue(value.placement)}`);
  const expected = position === "detached"
    ? { side: "detached", connected: false, borderMode: "independent", pathCount: 2 }
    : { side: position === "left-adjacent" ? "left" : "right", connected: true, borderMode: "union", pathCount: 1 };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      failures.push(`${path}.${key}=${displayValue(expectedValue)}/${displayValue(value[key])}`);
    }
  }
}

function inspectSnapshot(value, path, failures) {
  if (!requireExactKeys(value, SNAPSHOT_KEYS, path, failures)) return null;
  let structurallyValid = true;
  if (!(Number.isFinite(value.station) && value.station >= 0 && value.station <= 100)) {
    failures.push(`${path}.station=0..100/${displayValue(value.station)}`);
  }
  if (requireExactKeys(value.rail, ["domIdentity", "rect"], `${path}.rail`, failures)) {
    if (!hasText(value.rail.domIdentity)) {
      failures.push(`${path}.rail.domIdentity=non-empty/${displayValue(value.rail.domIdentity)}`);
    }
    inspectRect(value.rail.rect, `${path}.rail.rect`, failures);
  } else structurallyValid = false;
  if (!Array.isArray(value.panes) || value.panes.length < 2) {
    failures.push(`${path}.panes=at-least-2/${displayValue(value.panes?.length)}`);
    structurallyValid = false;
  } else {
    const seenPaneIds = new Set();
    const seenDomIds = new Set();
    value.panes.forEach((pane, index) => {
      const panePath = `${path}.panes[${index}]`;
      if (!requireExactKeys(pane, ["paneId", "domIdentity", "rect"], panePath, failures)) {
        structurallyValid = false;
        return;
      }
      if (!hasText(pane.paneId) || seenPaneIds.has(pane.paneId)) {
        failures.push(`${panePath}.paneId=unique-non-empty/${displayValue(pane.paneId)}`);
      } else seenPaneIds.add(pane.paneId);
      if (!hasText(pane.domIdentity) || seenDomIds.has(pane.domIdentity)) {
        failures.push(`${panePath}.domIdentity=unique-non-empty/${displayValue(pane.domIdentity)}`);
      } else seenDomIds.add(pane.domIdentity);
      inspectRect(pane.rect, `${panePath}.rect`, failures);
    });
  }
  if (!isRecord(value.splitTree)) {
    failures.push(`${path}.splitTree=record/${displayValue(value.splitTree)}`);
    structurallyValid = false;
  }
  return structurallyValid ? value : null;
}

function comparableSnapshot(value) {
  return {
    station: value.station,
    rail: value.rail,
    panes: [...value.panes].sort((a, b) => String(a.paneId).localeCompare(String(b.paneId))),
    splitTree: value.splitTree,
  };
}

function inspectCase(value, index, failures, seenPositions) {
  const path = `cases[${index}]`;
  if (!requireExactKeys(
    value,
    ["position", "stateTreeRelation", "paneListRelation", "domRelation", "before", "after"],
    path,
    failures,
  )) return;
  if (!POSITIONS.includes(value.position) || seenPositions.has(value.position)) {
    failures.push(`${path}.position=unique-known/${displayValue(value.position)}`);
  } else seenPositions.add(value.position);
  for (const source of ["stateTreeRelation", "paneListRelation", "domRelation"]) {
    inspectRelation(value[source], value.position, `${path}.${source}`, failures);
  }
  if (canonical(value.stateTreeRelation) !== canonical(value.paneListRelation)
      || canonical(value.stateTreeRelation) !== canonical(value.domRelation)) {
    failures.push(`${path}.relation=state-tree==pane-list==dom`);
  }
  const before = inspectSnapshot(value.before, `${path}.before`, failures);
  const after = inspectSnapshot(value.after, `${path}.after`, failures);
  if (before && after && canonical(comparableSnapshot(before)) !== canonical(comparableSnapshot(after))) {
    failures.push(`${path}.layout=identity+rect+split+station-invariant`);
  }
  const boundPaneId = value.stateTreeRelation?.boundPaneId;
  if (before && hasText(boundPaneId) && !before.panes.some((pane) => pane.paneId === boundPaneId)) {
    failures.push(`${path}.boundPaneId=visible-pane/${displayValue(boundPaneId)}`);
  }
}

/** PIN 관계 변경과 layout 불변을 픽셀 없이 판정하는 B07 순수 judge. */
export function judgeB07MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "cases"], "evidence", failures)) {
    return finishMachineVerdict("B07", failures, "B07:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (!Array.isArray(value.cases) || value.cases.length !== POSITIONS.length) {
    failures.push(`cases=exactly-${POSITIONS.length}/${displayValue(value.cases?.length)}`);
  } else {
    const seenPositions = new Set();
    value.cases.forEach((pinCase, index) => inspectCase(pinCase, index, failures, seenPositions));
    for (const position of POSITIONS) {
      if (!seenPositions.has(position)) failures.push(`position=${position}=missing`);
    }
  }
  return finishMachineVerdict(
    "B07",
    failures,
    `${value.engine}/B07:left+right=union/1;detached=independent/2;layout-invariant`,
  );
}
