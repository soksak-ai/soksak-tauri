import {
  createBrowserGateReport,
  judgeBrowserMachineGateEvidence,
  machineGateSummary,
  serializeBrowserGateReport,
  setMachineGateStatus,
  setVisualReviewStatus,
} from "./browser-gates.mjs";
import { blockPendingMachineGates } from "./browser-gate-coverage.mjs";
import {
  BROWSER_GATE_IDS,
  BROWSER_GATE_OWNERS,
  browserGatesOwnedBy,
  mergeBrowserGateReports,
  requireOwnedGates,
} from "./browser-gate-report-merge.mjs";
import { writeEvidenceFile } from "./evidence-store.mjs";

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

function b07Snapshot({ stateTree, arrangement, railMeasure, paneMeasures }) {
  const { space } = activeProjectAndSpace(stateTree);
  return {
    station: field(arrangement, "station"),
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
  stateTreeAfter,
  paneListAfter,
  relationMeasureAfter,
  before,
  after,
}) {
  const { space } = activeProjectAndSpace(stateTreeAfter);
  return {
    position,
    stateTreeRelation: relationValue(space?.railRelation),
    paneListRelation: relationValue(paneListAfter?.railRelation),
    domRelation: relationDataset(relationMeasureAfter),
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

export function mapB08MaximizeCaseEvidence({
  direction,
  targetPaneId,
  maximized,
  restored,
}) {
  return {
    direction,
    targetPaneId,
    maximized: {
      persistedPin: pinValue(maximized?.railPosition),
      effectiveStation: field(maximized?.railPosition?.leftRailPosition, "effectiveStation"),
      maximizedPaneId: field(maximized?.paneList, "activePaneId"),
      cells: arrangementValue(maximized?.arrangement).cells,
      splitTree: maximized?.paneList?.canonicalLayout ?? null,
      relation: relationValue(maximized?.paneList?.railRelation),
    },
    restored: mapB08BaselineEvidence(restored ?? {}),
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

  const bindFramework = (framework) => {
    const candidate = createBrowserGateReport({
      framework,
      platform,
      buildId: artifactBuildId,
      runId,
    });
    if (!currentReport) {
      currentReport = candidate;
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

  const recordVisualReview = ({ framework, engine, gate, status, artifacts, notes }) => {
    const report = bindFramework(framework);
    requireOwnership(gate);
    currentReport = setVisualReviewStatus(report, {
      engine,
      gate,
      status,
      artifacts,
      notes,
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
