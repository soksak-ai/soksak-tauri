import { BROWSER_ACCEPTANCE_GATES, setMachineGateStatus } from "./browser-gates.mjs";

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

export function blockPendingMachineGates(report, { engine, reason } = {}) {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new TypeError("blocked machine cells require a non-empty reason");
  }
  return pendingMachineGates(report, engine).reduce(
    (current, gate) => setMachineGateStatus(current, { engine, gate, status: "blocked", reason }),
    report,
  );
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
