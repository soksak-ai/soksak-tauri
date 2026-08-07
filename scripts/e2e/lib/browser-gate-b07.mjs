import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";
import { borderGapsPx, drawnBorderSide, isBorderBox } from "./rail-border-geometry.mjs";

const POSITIONS = Object.freeze(["left-adjacent", "right-adjacent", "detached"]);
/** 그 자리에서 보더가 실제로 그려져야 하는 변 — 선언이 아니라 이것과 잰 거리를 맞댄다. */
const DRAWN_SIDE_BY_POSITION = Object.freeze({
  "left-adjacent": "left",
  "right-adjacent": "right",
  detached: "detached",
});
const CASE_KEYS = Object.freeze([
  "position",
  "requestedStation",
  "layoutTransactions",
  "stateTreeRelation",
  "paneListRelation",
  "domRelation",
  "border",
  "nativeBoundsWrites",
  "before",
  "after",
]);
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
const SNAPSHOT_KEYS = Object.freeze(["station", "switched", "cells", "rail", "panes", "splitTree"]);
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const PERCENT_RECT_KEYS = Object.freeze(["left", "top", "width", "height"]);
const BORDER_KEYS = Object.freeze(["railBox", "paneBox"]);
const NATIVE_WRITE_KEYS = Object.freeze(["label", "before", "after"]);

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

function inspectPercentCells(value, path, failures) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${path}=non-empty-array/${displayValue(value)}`);
    return;
  }
  const ids = new Set();
  value.forEach((cell, index) => {
    const at = `${path}[${index}]`;
    if (!requireExactKeys(cell, ["id", "rect"], at, failures)) return;
    if (!hasText(cell.id) || ids.has(cell.id)) {
      failures.push(`${at}.id=unique-non-empty/${displayValue(cell.id)}`);
    } else ids.add(cell.id);
    if (!requireExactKeys(cell.rect, PERCENT_RECT_KEYS, `${at}.rect`, failures)) return;
    for (const key of PERCENT_RECT_KEYS) {
      if (!Number.isFinite(cell.rect[key])) {
        failures.push(`${at}.rect.${key}=finite/${displayValue(cell.rect[key])}`);
      }
    }
    if (!(cell.rect.width > 0 && cell.rect.height > 0)) {
      failures.push(`${at}.rect.size=positive/${cell.rect.width}x${cell.rect.height}`);
    }
  });
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

/**
 * 보더가 어느 변에 그려졌는지를 두 상자 사이 거리로 판정한다.
 *
 * borderMode 와 pathCount 는 렌더가 자기 결정을 이름으로 부른 것이라, 셋을 나란히 놓아도
 * 다른 변에 그린 사실을 잡지 못한다. 잰 것은 상자뿐이고 판정은 여기서만 한다.
 */
function inspectBorder(value, position, path, failures) {
  if (!requireExactKeys(value, BORDER_KEYS, path, failures)) return;
  let measured = true;
  for (const key of BORDER_KEYS) {
    if (!isBorderBox(value[key])) {
      failures.push(`${path}.${key}=drawn-box/${displayValue(value[key])}`);
      measured = false;
      continue;
    }
    if (Object.keys(value[key]).length !== RECT_KEYS.length) {
      failures.push(`${path}.${key}=exactly-xywh/${displayValue(value[key])}`);
    }
  }
  if (!measured) return;
  const expected = DRAWN_SIDE_BY_POSITION[position];
  if (expected === undefined) return;
  const side = drawnBorderSide(value.railBox, value.paneBox);
  if (side !== expected) {
    failures.push(`${path}.drawnSide=${expected}/${displayValue({
      side,
      gaps: borderGapsPx(value.railBox, value.paneBox),
    })}`);
  }
}

/**
 * PIN 클릭이 native surface 좌표를 다시 썼는가.
 *
 * null 은 이 실행물이 bounds 기록 장부를 아예 내지 않는다는 사실이다 — 빈 장부와 다른 값이다.
 */
function inspectNativeBoundsWrites(value, path, failures) {
  if (value === null) return;
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${path}=null-or-non-empty-ledger/${displayValue(value)}`);
    return;
  }
  const labels = new Set();
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!requireExactKeys(entry, NATIVE_WRITE_KEYS, at, failures)) return;
    if (!hasText(entry.label) || labels.has(entry.label)) {
      failures.push(`${at}.label=unique-non-empty/${displayValue(entry.label)}`);
    } else labels.add(entry.label);
    if (!Number.isInteger(entry.before) || !Number.isInteger(entry.after)) {
      failures.push(`${at}=integer-counts/${displayValue({ before: entry.before, after: entry.after })}`);
      return;
    }
    if (entry.before !== entry.after) {
      failures.push(`${at}.boundsWrites=${entry.before}/${entry.after}`);
    }
  });
}

function inspectSnapshot(value, path, failures) {
  if (!requireExactKeys(value, SNAPSHOT_KEYS, path, failures)) return null;
  let structurallyValid = true;
  if (!(Number.isFinite(value.station) && value.station >= 0 && value.station <= 100)) {
    failures.push(`${path}.station=0..100/${displayValue(value.station)}`);
  }
  if (value.switched !== false) {
    failures.push(`${path}.switched=false/${displayValue(value.switched)}`);
  }
  inspectPercentCells(value.cells, `${path}.cells`, failures);
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
    switched: value.switched,
    cells: value.cells,
    rail: value.rail,
    panes: [...value.panes].sort((a, b) => String(a.paneId).localeCompare(String(b.paneId))),
    splitTree: value.splitTree,
  };
}

function inspectCase(value, index, failures, seenPositions) {
  const path = `cases[${index}]`;
  if (!requireExactKeys(value, CASE_KEYS, path, failures)) return;
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
  inspectBorder(value.border, value.position, `${path}.border`, failures);
  inspectNativeBoundsWrites(value.nativeBoundsWrites, `${path}.nativeBoundsWrites`, failures);
  if (value.layoutTransactions !== 0) {
    failures.push(`${path}.layoutTransactions=0/${displayValue(value.layoutTransactions)}`);
  }
  const before = inspectSnapshot(value.before, `${path}.before`, failures);
  const after = inspectSnapshot(value.after, `${path}.after`, failures);
  // 명령한 station 이 실제로 선 station 인가 — 두 시점 모두 명령값과 맞댄다.
  if (!(Number.isFinite(value.requestedStation)
      && value.requestedStation >= 0
      && value.requestedStation <= 100)) {
    failures.push(`${path}.requestedStation=0..100/${displayValue(value.requestedStation)}`);
  } else {
    for (const when of ["before", "after"]) {
      const station = value[when]?.station;
      if (station !== value.requestedStation) {
        failures.push(`${path}.${when}.station=requested-${value.requestedStation}/${displayValue(station)}`);
      }
    }
  }
  if (before && after && canonical(comparableSnapshot(before)) !== canonical(comparableSnapshot(after))) {
    failures.push(`${path}.layout=identity+rect+cells+split+station-invariant`);
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
    `${value.engine}/B07:left+right=union/1;detached=independent/2;drawn-side=measured;layout-invariant`,
  );
}
