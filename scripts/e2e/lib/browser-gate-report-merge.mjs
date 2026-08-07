import {
  BROWSER_ACCEPTANCE_GATES,
  createBrowserGateReport,
  judgeBrowserMachineGateEvidence,
  machineGateSummary,
  setMachineGateStatus,
  setVisualReviewStatus,
} from "./browser-gates.mjs";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";

/** 12칸의 이름. 소유 선언은 반드시 이 목록의 부분집합이다. */
export const BROWSER_GATE_IDS = Object.freeze(BROWSER_ACCEPTANCE_GATES.map(({ id }) => id));

const RUN_ID_SEPARATOR = "+";
const RUN_ID_MAX = 256;
const gateSet = new Set(BROWSER_GATE_IDS);

/**
 * 12칸의 소유. 한 칸은 정확히 한 실행기의 것이고, 두 실행기의 소유를 합치면 12칸이 된다.
 *
 * B12 만 따로 나온 이유는 냉시작이다 — 프로세스를 세 번 죽였다 살려야 재는 값이라 살아 있는 앱
 * 한 번으로 도는 나머지 11칸과 같은 실행에 들어갈 수 없다. 그래서 실행기가 둘이고, 이 표가
 * 둘을 가르는 유일한 자리다. 목록을 손으로 다시 적지 마라 — 여기서 읽어라.
 */
export const BROWSER_GATE_OWNERS = Object.freeze({
  "slot-freeze": Object.freeze(BROWSER_GATE_IDS.filter((gate) => gate !== "B12")),
  "titlebar-composition": Object.freeze(["B12"]),
});

export function browserGatesOwnedBy(runner) {
  const owned = BROWSER_GATE_OWNERS[runner];
  if (!owned) throw new TypeError(`unknown browser gate runner: ${String(runner)}`);
  return owned;
}

/**
 * 한 실행기가 소유한 게이트 이름. 소유하지 않은 칸에는 판정을 적지 못한다 —
 * 재지 못한 칸을 차단으로 적는 것도 없는 사실을 만드는 일이다.
 */
export function requireOwnedGates(value, label = "gates") {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must declare at least one browser gate`);
  }
  const owned = [];
  for (const gate of value) {
    if (!gateSet.has(gate)) throw new TypeError(`${label} names an unknown browser gate: ${String(gate)}`);
    if (owned.includes(gate)) throw new TypeError(`${label} names ${gate} twice`);
    owned.push(gate);
  }
  return Object.freeze(owned);
}

function requireContribution(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`browser gate contribution ${index} must be a record`);
  }
  const gates = requireOwnedGates(value.gates, `contribution ${index} gates`);
  const report = value.report;
  // machineGateSummary 는 보고서 전체 계약을 다시 검사한다. 직렬화본을 되읽어 넘겨도 같은 문이다.
  machineGateSummary(report);
  return { gates, report };
}

function requirePartition(contributions) {
  const owner = new Map();
  for (const { gates, report } of contributions) {
    for (const gate of gates) {
      const previous = owner.get(gate);
      if (previous) {
        throw new TypeError(
          `${gate} is owned by both ${previous.identity.runId} and ${report.identity.runId}`,
        );
      }
      owner.set(gate, report);
    }
  }
  const missing = BROWSER_GATE_IDS.filter((gate) => !owner.has(gate));
  if (missing.length > 0) {
    throw new TypeError(`no contribution owns ${missing.join(", ")}`);
  }
  return owner;
}

function requireSharedArtifact(contributions) {
  const [first] = contributions;
  const runIds = [];
  for (const { report } of contributions) {
    for (const field of ["framework", "platform", "buildId"]) {
      if (report.identity[field] !== first.report.identity[field]) {
        throw new TypeError(
          `browser gate contributions disagree on ${field}: `
          + `${first.report.identity[field]}/${report.identity[field]}`,
        );
      }
    }
    const runId = report.identity.runId;
    if (runIds.includes(runId)) throw new TypeError(`browser gate contributions reuse runId ${runId}`);
    runIds.push(runId);
  }
  const runId = runIds.join(RUN_ID_SEPARATOR);
  if (runId.length > RUN_ID_MAX) {
    throw new TypeError(`merged runId exceeds ${RUN_ID_MAX} characters: ${runId.length}`);
  }
  return {
    framework: first.report.identity.framework,
    platform: first.report.identity.platform,
    buildId: first.report.identity.buildId,
    runId,
  };
}

/** 소유하지 않은 칸에 무엇을 적었는지 이름으로 되돌려 준다. 조용히 버리면 그 칸의 사실이 사라진다. */
function requireSilenceOutsideOwnership(contributions) {
  for (const { gates, report } of contributions) {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      for (const gate of BROWSER_GATE_IDS) {
        if (gates.includes(gate)) continue;
        const status = report.engines[engine][gate].machine.status;
        if (status === "not-run" || status === "not-applicable") continue;
        throw new TypeError(
          `${report.identity.runId} wrote ${engine}/${gate}=${status} without owning ${gate}`,
        );
      }
    }
  }
}

function applyMachineCell(report, engine, gate, cell) {
  const { machine } = cell;
  if (machine.status === "not-applicable" || machine.status === "not-run") return report;
  if (machine.judgeReceipt) {
    // 신원만 병합본으로 다시 새긴다. 증거는 그대로이고 판정은 같은 판사가 다시 낸다.
    const judgeReceipt = judgeBrowserMachineGateEvidence({
      ...report.identity,
      engine,
      gate,
      evidence: machine.judgeReceipt.machineEvidence,
    });
    // 저장된 판정 문자열과 재판정이 다르면(규칙이 바뀐 뒤 옛 실행) 그것도 같은 어긋남이다.
    const evidenceDrifted = judgeReceipt.evidence.length !== machine.evidence.length
      || judgeReceipt.evidence.some((item, index) => item !== machine.evidence[index]);
    if (judgeReceipt.status !== machine.status || evidenceDrifted) {
      // 판정 규칙이 바뀐 뒤 옛 실행을 읽으면 재판정이 저장된 판정과 어긋난다. 그것은 이 칸의
      // 사실이지 판 전체의 사실이 아니다 — 던지면 나머지 35칸의 잰 값까지 함께 사라진다.
      return setMachineGateStatus(report, {
        engine,
        gate,
        status: "blocked",
        evidence: [],
        reason: `stored judgeReceipt re-judged as ${judgeReceipt.status} instead of ${machine.status}`,
      });
    }
    return setMachineGateStatus(report, { engine, gate, judgeReceipt });
  }
  return setMachineGateStatus(report, {
    engine,
    gate,
    status: machine.status,
    evidence: machine.evidence,
    reason: machine.reason,
  });
}

function applyVisualCell(report, engine, gate, cell) {
  const review = cell.visualReview;
  if (review.status === "not-applicable" || review.status === "pending") return report;
  return setVisualReviewStatus(report, {
    engine,
    gate,
    status: review.status,
    artifacts: review.artifacts,
    notes: review.notes,
  });
}

/**
 * 두 실행기가 한 보고서를 나눠 쓴다.
 *
 * 냉시작 3회를 요구하는 B12 와 살아 있는 앱 한 번을 요구하는 B01~B11 은 같은 프로세스에서 잴 수
 * 없다. 그래서 실행기마다 자기가 소유한 칸만 적고, 병합이 12칸의 분할을 확인한 뒤 한 판으로 잇는다.
 * 소유가 분할이 아니거나 소유하지 않은 칸에 판정이 적혀 있으면 이름으로 거절한다.
 *
 * 병합본의 runId 는 기여한 실행 id 를 순서대로 이어 붙인 이름이다 — 어느 측정이 어느 칸을 냈는지
 * 파일 하나만 보고도 되짚을 수 있어야 한다. buildId·framework·platform 이 다르면 병합하지 않는다.
 */
export function mergeBrowserGateReports(contributions) {
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new TypeError("browser gate merge needs at least one contribution");
  }
  const normalized = contributions.map(requireContribution);
  const owner = requirePartition(normalized);
  requireSilenceOutsideOwnership(normalized);
  const identity = requireSharedArtifact(normalized);

  let merged = createBrowserGateReport(identity);
  for (const gate of BROWSER_GATE_IDS) {
    const source = owner.get(gate);
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      const cell = source.engines[engine][gate];
      merged = applyMachineCell(merged, engine, gate, cell);
      merged = applyVisualCell(merged, engine, gate, cell);
    }
  }
  return merged;
}
