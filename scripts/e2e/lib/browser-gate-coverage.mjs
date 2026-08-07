import {
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_FRAMEWORKS,
} from "./browser-gate-identity.mjs";
import {
  BROWSER_ACCEPTANCE_GATES,
  machineGateSummary,
  setMachineGateStatus,
} from "./browser-gates.mjs";

/** 36칸 보고서의 측정 커버리지를 소유한다.
 *
 * 판정과 측정은 다른 책임이다. 한 셀이 red 라는 사실은 다른 셀을 측정하지 못할 이유가 아니며,
 * 측정하지 않은 셀을 red 로 적으면 없는 증거를 만든 것이다. 그래서 측정을 계속할 수 없게 된
 * 셀만 사유와 함께 blocked 로 남기고, 남은 셀은 계속 측정한다. 최종 판정은 요약이 소유한다.
 */

const APPLICABLE_STATUS = "not-run";

export function pendingMachineGates(report, engine) {
  const cells = report.engines[engine];
  if (!cells) throw new TypeError(`unknown browser engine: ${engine}`);
  return BROWSER_ACCEPTANCE_GATES
    .map(({ id }) => id)
    .filter((gate) => cells[gate].machine.status === APPLICABLE_STATUS);
}

/** gates 를 주면 그 실행기가 소유한 칸만 닫는다. 소유하지 않은 칸은 재지 않은 그대로 남는다 —
 * 남의 칸을 차단으로 적으면 그 게이트의 소유자가 낸 판정을 덮어쓸 자리가 사라진다. */
export function blockPendingMachineGates(report, { engine, reason, gates } = {}) {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new TypeError("blocked machine cells require a non-empty reason");
  }
  const owned = gates == null ? null : new Set(gates);
  return pendingMachineGates(report, engine)
    .filter((gate) => owned === null || owned.has(gate))
    .reduce(
      (current, gate) => setMachineGateStatus(current, { engine, gate, status: "blocked", reason }),
      report,
    );
}

/** 인수는 한 프레임워크의 36칸이 아니라 프레임워크 전부의 합이다.
 *
 * 한 실행은 한 프레임워크의 신원만 담는다. 그래서 그 실행의 요약이 green 이어도 인수가 끝났다는
 * 뜻이 아니다. 제출되지 않은 프레임워크는 0 으로 세어지는 것이 아니라 이름으로 남아야 한다 —
 * 재지 않은 것과 재서 통과한 것은 같은 값으로 표현될 수 없다.
 */
export function acceptanceCoverage(reports) {
  const byFramework = new Map();
  let buildId = null;
  for (const report of reports) {
    const identity = report.identity;
    if (buildId === null) buildId = identity.buildId;
    else if (buildId !== identity.buildId) {
      throw new TypeError(
        `acceptance coverage mixes builds: expected buildId=${buildId} actual=${identity.buildId}`,
      );
    }
    // 같은 프레임워크를 다시 제출해도 축은 하나다. 재실행이 커버리지를 늘리지 않는다.
    byFramework.set(identity.framework, report);
  }

  const cellsPerFramework = BROWSER_ACCEPTANCE_ENGINES.length * BROWSER_ACCEPTANCE_GATES.length;
  const missingFrameworks = BROWSER_ACCEPTANCE_FRAMEWORKS
    .filter((framework) => !byFramework.has(framework));

  const counts = { "not-applicable": 0, "not-run": 0, blocked: 0, red: 0, green: 0 };
  let required = missingFrameworks.length * cellsPerFramework;
  let measured = 0;
  for (const report of byFramework.values()) {
    const summary = machineGateSummary(report);
    required += summary.required;
    measured += summary.total - summary.counts["not-applicable"];
    for (const key of Object.keys(counts)) counts[key] += summary.counts[key];
  }

  const status = counts.red > 0 ? "red"
    : counts.blocked > 0 ? "blocked"
      : (counts["not-run"] > 0 || missingFrameworks.length > 0) ? "not-run"
        : "green";

  return { status, required, measured, green: counts.green, counts, missingFrameworks };
}

/** 실행 로그의 판정 한 줄. green 이 아니면 판정을 만든 수치를 같은 줄에 남겨, 실행 로그만으로
 * 원인 범위를 좁힐 수 있게 한다. 로그는 증거가 아니라 정본 보고서로 가는 이정표다. */
export function formatGateVerdict(engine, gate, receipt) {
  const detail = receipt.status === "green" ? "" : ` — ${receipt.evidence.join(", ")}`;
  return `◉ ${engine}/${gate} canonical machine verdict: ${receipt.status}${detail}`;
}

function failureText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 엔진을 순차로 실행한다. 한 엔진의 실패는 그 엔진의 남은 셀을 차단으로 남기고 끝나며,
 * 다음 엔진의 측정을 막지 않는다. 앱 수명주기는 여전히 한 번에 하나만 산다. */
export async function runEngineCoverage({ engines, runEngine, blockEngine }) {
  const failures = [];
  let total = 0;
  for (const engine of engines) {
    try {
      total += (await runEngine(engine)) ?? 0;
    } catch (error) {
      let recorded = error;
      try {
        blockEngine(engine, failureText(error));
      } catch (blockError) {
        recorded = new AggregateError(
          [error, blockError],
          `${failureText(error)}; coverage block: ${failureText(blockError)}`,
        );
      }
      failures.push({ engine, error: recorded });
    }
  }
  return { total, failures };
}
