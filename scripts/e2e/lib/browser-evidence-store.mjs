import {
  createBrowserGateReport,
  judgeBrowserMachineGateEvidence,
  machineGateSummary,
  serializeBrowserGateReport,
  setMachineGateStatus,
  setVisualReviewStatus,
} from "./browser-gates.mjs";
import { blockPendingMachineGates } from "./browser-gate-coverage.mjs";
import { parseBorderBox } from "./rail-border-geometry.mjs";
import {
  BROWSER_GATE_IDS,
  BROWSER_GATE_OWNERS,
  browserGatesOwnedBy,
  mergeBrowserGateReports,
  requireOwnedGates,
} from "./browser-gate-report-merge.mjs";
import { requireHumanVisualReview } from "./browser-visual-review.mjs";
import { writeEvidenceFile } from "./evidence-store.mjs";
import fs from "node:fs";
import path from "node:path";

export {
  BROWSER_GATE_IDS,
  BROWSER_GATE_OWNERS,
  browserGatesOwnedBy,
  mergeBrowserGateReports,
  requireOwnedGates,
};

export const BROWSER_GATE_REPORT_FILE = "browser-gates.json";

const RELATION_FIELDS = Object.freeze([
  "boundTabId",
  "boundPaneId",
  "relationId",
  "placement",
  "connected",
  "side",
  "borderMode",
  "pathCount",
]);

export function requireBrowserEvidenceBuildId(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > 256
      || value.trim() !== value) {
    throw new TypeError(
      "BROWSER_EVIDENCE_BUILD_ID must be an explicit trimmed 1..256 character artifact identity",
    );
  }
  return value;
}

function field(value, key) {
  return value && typeof value === "object" && Object.hasOwn(value, key)
    ? value[key]
    : null;
}

function relationValue(value) {
  return Object.fromEntries(RELATION_FIELDS.map((key) => [key, field(value, key)]));
}

function datasetBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value ?? null;
}

function datasetInteger(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return value ?? null;
}

function relationDataset(value) {
  const dataset = value?.dataset ?? value;
  return {
    boundTabId: field(dataset, "boundTab"),
    boundPaneId: field(dataset, "boundPane"),
    relationId: field(dataset, "relationId"),
    placement: field(dataset, "placement"),
    connected: datasetBoolean(field(dataset, "connected")),
    side: field(dataset, "side"),
    borderMode: field(dataset, "borderMode"),
    pathCount: datasetInteger(field(dataset, "pathCount")),
  };
}

function activeProjectAndSpace(stateTree) {
  const projects = Array.isArray(stateTree?.projects) ? stateTree.projects : [];
  const project = projects.find((item) => item?.id === stateTree?.activeProjectId) ?? null;
  const spaces = Array.isArray(project?.spaces) ? project.spaces : [];
  const space = spaces.find((item) => item?.id === project?.activeSpaceId) ?? null;
  return { project, space };
}

function xywhRect(value) {
  const rect = value?.rect ?? value;
  return {
    x: field(rect, "x"),
    y: field(rect, "y"),
    w: field(rect, "w"),
    h: field(rect, "h"),
  };
}

function percentRect(value) {
  const rect = value?.rect ?? value;
  return {
    left: field(rect, "left"),
    top: field(rect, "top"),
    width: field(rect, "width"),
    height: field(rect, "height"),
  };
}

/** 관계 노드가 실제로 그린 두 상자. 없으면 null 이다 — 안 그린 것을 0 으로 적지 않는다. */
function borderBoxes(relationMeasure) {
  const dataset = relationMeasure?.dataset ?? relationMeasure;
  return {
    railBox: parseBorderBox(field(dataset, "rail")),
    paneBox: parseBorderBox(field(dataset, "box")),
  };
}

/**
 * PIN 클릭 전후의 native bounds 기록 수. 두 composition 중 하나라도 없으면 이 실행물은
 * 장부를 내지 않는다는 뜻이라 null 이다 — 빈 장부와 없는 장부는 다른 사실이다.
 */
function nativeBoundsWriteLedger(before, after) {
  if (before == null || after == null) return null;
  const beforeWrites = new Map(
    (before.placement ?? []).map((item) => [field(item, "label"), Number(field(item, "boundsWrites"))]),
  );
  return (after.placement ?? [])
    .filter((item) => beforeWrites.has(field(item, "label")))
    .map((item) => ({
      label: field(item, "label"),
      before: beforeWrites.get(field(item, "label")),
      after: Number(field(item, "boundsWrites")),
    }));
}

function b07Snapshot({ stateTree, arrangement, railMeasure, paneMeasures }) {
  const { space } = activeProjectAndSpace(stateTree);
  return {
    station: field(arrangement, "station"),
    switched: field(arrangement, "switched"),
    cells: arrangementValue(arrangement).cells,
    rail: {
      domIdentity: field(railMeasure, "nodeIdentity"),
      rect: xywhRect(railMeasure),
    },
    panes: Array.isArray(paneMeasures)
      ? paneMeasures.map((pane) => ({
          paneId: field(pane, "paneId"),
          domIdentity: field(pane, "nodeIdentity"),
          rect: xywhRect(pane),
        }))
      : [],
    splitTree: space?.canonicalLayout ?? null,
  };
}

/**
 * Maps only public command responses into the closed B07 judge schema.
 * Missing nodeIdentity stays null so an old/opaque runtime produces RED rather than a made-up identity.
 */
export function mapB07PinCaseEvidence({
  position,
  requestedStation,
  layoutTransactions,
  stateTreeAfter,
  paneListAfter,
  relationMeasureAfter,
  nativeCompositionBefore,
  nativeCompositionAfter,
  before,
  after,
}) {
  const { space } = activeProjectAndSpace(stateTreeAfter);
  return {
    position,
    requestedStation: requestedStation ?? null,
    layoutTransactions: layoutTransactions ?? null,
    stateTreeRelation: relationValue(space?.railRelation),
    paneListRelation: relationValue(paneListAfter?.railRelation),
    domRelation: relationDataset(relationMeasureAfter),
    border: borderBoxes(relationMeasureAfter),
    nativeBoundsWrites: nativeBoundsWriteLedger(
      nativeCompositionBefore ?? null,
      nativeCompositionAfter ?? null,
    ),
    before: b07Snapshot(before ?? {}),
    after: b07Snapshot(after ?? {}),
  };
}

function pinValue(railPosition) {
  const value = railPosition?.leftRailPosition;
  return {
    mode: field(value, "mode"),
    station: field(value, "station"),
  };
}

function arrangementValue(arrangement) {
  return {
    station: field(arrangement, "station"),
    cells: Array.isArray(arrangement?.cells)
      ? arrangement.cells.map((cell) => ({
          id: field(cell, "id"),
          rect: percentRect(cell),
        }))
      : null,
  };
}

export function mapB08BaselineEvidence({ railPosition, arrangement, paneList }) {
  return {
    persistedPin: pinValue(railPosition),
    arrangement: arrangementValue(arrangement),
    splitTree: paneList?.canonicalLayout ?? null,
  };
}

/**
 * 한 시점의 native surface 자리·결부·그려진 보더를 한 장으로 묶는다.
 * 세 시점(직전·최대화·복원)이 같은 모양이라 시점끼리 바로 맞댈 수 있다.
 */
export function mapB08PinStageEvidence({ surfaceRect, paneList, relationMeasure }) {
  return {
    surfaceRect: xywhRect(surfaceRect),
    relation: relationValue(paneList?.railRelation),
    border: borderBoxes(relationMeasure),
  };
}

export function mapB08MaximizeCaseEvidence({
  direction,
  targetPaneId,
  maximized,
  restored,
  stages,
}) {
  return {
    direction,
    targetPaneId,
    maximized: {
      persistedPin: pinValue(maximized?.railPosition),
      arrangementStation: field(maximized?.arrangement, "station"),
      effectiveStation: field(maximized?.railPosition?.leftRailPosition, "effectiveStation"),
      maximizedPaneId: field(maximized?.paneList, "activePaneId"),
      cells: arrangementValue(maximized?.arrangement).cells,
      splitTree: maximized?.paneList?.canonicalLayout ?? null,
    },
    restored: mapB08BaselineEvidence(restored ?? {}),
    pinGeometry: {
      baseline: mapB08PinStageEvidence(stages?.baseline ?? {}),
      maximized: mapB08PinStageEvidence(stages?.maximized ?? {}),
      restored: mapB08PinStageEvidence(stages?.restored ?? {}),
    },
  };
}

function sameIdentity(left, right) {
  return ["framework", "platform", "buildId", "runId"]
    .every((fieldName) => left[fieldName] === right[fieldName]);
}

/** Owns one immutable live-run identity and its canonical, always-complete 3x12 report.
 *
 * `gates` 는 이 실행기가 소유한 칸의 이름이다. 선언한 칸에만 판정을 적고, 선언하지 않은 칸은
 * 재지 않은 그대로 둔다. 선언 없이 만든 저장소는 병합에 낼 기여를 만들지 못한다 — 무엇을 잰
 * 실행인지 이름으로 말하지 못하는 보고서는 다른 실행기의 보고서와 이을 수 없다.
 */
export function createBrowserGateReportStore({
  root,
  buildId,
  runId,
  platform,
  keep = false,
  gates = null,
}) {
  const artifactBuildId = requireBrowserEvidenceBuildId(buildId);
  const ownedGates = gates === null ? null : requireOwnedGates(gates);
  let currentReport = null;

  const requireOwnership = (gate) => {
    if (ownedGates !== null && !ownedGates.includes(gate)) {
      throw new TypeError(`${runId} does not own ${gate}; declare it in gates to record a verdict`);
    }
    return gate;
  };

  const requireReport = () => {
    if (!currentReport) throw new Error("browser gate report has no live framework identity");
    return currentReport;
  };

  // 프레임워크와 함께 그 프레임워크가 **선언한 능력**을 받는다. 해당 여부가 능력에서 파생하므로
  // 신원이 그것을 들어야 하고, 라이브에서 답한 값만이 그 사실이다.
  let boundProvision = null;
  const bindFramework = (framework, provision) => {
    const nativeChildWebview = provision?.nativeChildWebview ?? boundProvision?.nativeChildWebview;
    const candidate = createBrowserGateReport({
      framework,
      platform,
      buildId: artifactBuildId,
      runId,
      nativeChildWebview,
    });
    if (!currentReport) {
      currentReport = candidate;
      boundProvision = { nativeChildWebview };
    } else if (!sameIdentity(currentReport.identity, candidate.identity)) {
      throw new Error(
        `browser gate report identity mismatch: expected=${JSON.stringify(currentReport.identity)} actual=${JSON.stringify(candidate.identity)}`,
      );
    }
    return currentReport;
  };

  const recordMachineEvidence = ({ framework, engine, gate, evidence }) => {
    const report = bindFramework(framework);
    requireOwnership(gate);
    const judgeReceipt = judgeBrowserMachineGateEvidence({
      ...report.identity,
      engine,
      gate,
      evidence,
    });
    currentReport = setMachineGateStatus(report, { engine, gate, judgeReceipt });
    return judgeReceipt;
  };

  /** 판사가 볼 표본이 없는 판정(red·blocked)을 그 사유와 함께 그 칸에 적는다.
   * green 은 여기로 들어오지 못한다 — 통과는 영수증 없이 표현할 수 없다. */
  const recordMachineStatus = ({ framework, engine, gate, status, evidence, reason }) => {
    const report = bindFramework(framework);
    requireOwnership(gate);
    currentReport = setMachineGateStatus(report, { engine, gate, status, evidence, reason });
    return currentReport.engines[engine][gate].machine;
  };

  /** 실행 중에 사람이 판정을 남기는 자리. 실행이 끝난 뒤의 검토는 `scripts/e2e/visual-review.mjs`
   * 가 같은 계약으로 정본 파일 위에서 한다. 두 자리가 서로 다른 기준을 들지 않도록 검사는 하나다. */
  const recordVisualReview = ({
    framework,
    engine,
    gate,
    status,
    artifacts,
    notes,
    artifactExists = (artifact) => {
      const resolved = path.resolve(root, "current", artifact);
      return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    },
  }) => {
    const verdict = requireHumanVisualReview({ status, artifacts, notes, artifactExists });
    const report = bindFramework(framework);
    requireOwnership(gate);
    currentReport = setVisualReviewStatus(report, {
      engine,
      gate,
      status: verdict.status,
      artifacts: verdict.artifacts,
      notes: verdict.notes,
    });
    return currentReport.engines[engine][gate].visualReview;
  };

  /** 이 엔진의 측정을 이어갈 수 없을 때 남은 셀만 사유와 함께 차단으로 닫는다.
   * 이미 기록된 판정은 그대로 두고 다른 엔진의 셀은 건드리지 않는다. */
  const blockPending = ({ engine, reason }) => {
    currentReport = blockPendingMachineGates(requireReport(), {
      engine,
      reason,
      gates: ownedGates,
    });
    return currentReport;
  };

  /** 병합에 낼 기여. 소유 선언과 그 실행의 보고서를 한 봉투로 묶는다. */
  const contribution = () => {
    if (ownedGates === null) {
      throw new TypeError(
        `${runId} must declare the gates it owns before it can contribute to a merged report`,
      );
    }
    return { gates: [...ownedGates], report: requireReport() };
  };

  return Object.freeze({
    hasReport: () => currentReport !== null,
    ownedGates: () => (ownedGates === null ? null : [...ownedGates]),
    bindFramework,
    recordMachineEvidence,
    recordMachineStatus,
    recordVisualReview,
    blockPending,
    contribution,
    report: () => requireReport(),
    machineSummary: () => machineGateSummary(requireReport()),
    serialize: () => serializeBrowserGateReport(requireReport()),
    persist: async () => {
      const report = requireReport();
      await writeEvidenceFile(
        root,
        BROWSER_GATE_REPORT_FILE,
        serializeBrowserGateReport(report),
        { keep },
      );
      return report;
    },
  });
}
