// 브라우저 인수 판정 — 두 실행기의 기여를 한 판으로 잇는다.
//
// B01~B11 은 살아 있는 앱 한 번으로 재고(slot-freeze), B12 는 프로세스를 세 번 죽였다 살려야
// 재는 냉시작 게이트다(titlebar-composition). 그래서 실행기가 둘이고, 어느 칸이 누구 것인지는
// browser-gate-report-merge.mjs 의 BROWSER_GATE_OWNERS 한 자리에만 산다.
//
// 이 자리는 그 둘을 합쳐 36칸을 판정한다. 합치는 규칙은 병합 계약이 소유하고 여기서 다시
// 판정하지 않는다 — 같은 판정을 두 곳에서 지으면 둘 중 하나가 거짓말이 된다.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  browserGatesOwnedBy,
  mergeBrowserGateReports,
} from "./lib/browser-gate-report-merge.mjs";
import { evidenceRunPath } from "./lib/evidence-store.mjs";
import { acceptanceCoverage } from "./lib/browser-gate-coverage.mjs";
import { machineGateSummary } from "./lib/browser-gates.mjs";

/** 그 저장소가 마지막으로 닫은 실행의 정본 보고서. `current` 는 실행 중인 것이라 읽지 않는다. */
/**
 * 이름 준 실행 하나를 읽는다.
 *
 * "가장 최근" 을 mtime 으로 고르면 한 실행기가 실패했을 때 그 저장소의 지난 실행이 최신으로
 * 남고, 인수가 서로 다른 두 실행을 잇는다 — buildId 가 우연히 같으면 통과하고 다르면 던진다.
 * 같은 코드가 저장소 상태에 따라 다른 답을 내면 그건 판정이 아니라 운이다. 부르는 쪽이 자기
 * 실행의 이름을 들고 오고, 그 이름이 없으면 다른 실행으로 대신하지 않는다.
 */
export function namedRunReport(storeRoot, runId) {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error(
      `읽을 실행의 run id 가 없다: ${storeRoot}`
      + " — 인수는 자기 실행을 이름으로 읽는다(BROWSER_EVIDENCE_RUN_ID·B12_RUN_ID).",
    );
  }
  // 저장소는 실행의 생애에 따라 세 통을 쓴다: 도는 동안 current, green 이면 runs 로 확정,
  // red 면 last-red 로 회전. 이름이 같으면 어느 통에 있든 그 실행이다 — 한 통만 보면 red 로
  // 끝난 실행도, 확정이 못 돈 실행도 못 찾는다. 그 둘이야말로 읽어야 할 것이다.
  // 확정본이 정본이므로 runs 를 먼저 본다.
  //
  // 경로 규칙은 저장소가 소유한다 — 여기서 다시 세우면 두 번째 정의가 생긴다.
  const candidates = [
    evidenceRunPath(storeRoot, runId),
    path.join(storeRoot, "last-red"),
    path.join(storeRoot, "current"),
  ];
  const failures = [];
  for (const dir of candidates) {
    try {
      const report = JSON.parse(readFileSync(path.join(dir, "browser-gates.json"), "utf8"));
      // last-red·current 통에는 실행 하나만 산다 — 이름이 다르면 그 실행이 아니다.
      if (report?.identity?.runId === runId) return report;
      failures.push(`${dir}: runId=${report?.identity?.runId}`);
    } catch (cause) {
      failures.push(`${dir}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  throw new Error(`실행 ${runId} 의 보고서를 읽지 못했다 — ${failures.join(" · ")}`);
}

export function browserAcceptanceVerdict({ slotFreeze, titlebar }) {
  const merged = mergeBrowserGateReports([
    { gates: browserGatesOwnedBy("slot-freeze"), report: slotFreeze },
    { gates: browserGatesOwnedBy("titlebar-composition"), report: titlebar },
  ]);
  return {
    merged,
    machine: machineGateSummary(merged),
    acceptance: acceptanceCoverage([merged]),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = process.env.HOME ?? "";
  const slotFreeze = namedRunReport(
    path.join(home, ".soksak-e2e/evidence/slot-freeze"),
    process.env.BROWSER_EVIDENCE_RUN_ID,
  );
  const titlebar = namedRunReport(
    path.join(home, ".soksak-e2e/evidence/titlebar-gates"),
    process.env.B12_RUN_ID,
  );
  const { merged, machine, acceptance } = browserAcceptanceVerdict({ slotFreeze, titlebar });
  // 어느 두 실행을 이었는지 표 위에 남긴다 — 판을 되짚을 때 이 두 이름이 있어야 같은 판을 다시 읽는다.
  const gates = Object.keys(merged.engines[Object.keys(merged.engines)[0]]);
  console.log(`build ${merged.identity.buildId.slice(0, 12)} · run ${merged.identity.runId}`);
  console.log("engine".padEnd(30) + gates.map((gate) => gate.padEnd(9)).join(""));
  for (const [engine, cells] of Object.entries(merged.engines)) {
    console.log(engine.padEnd(30) + gates.map((gate) => cells[gate].machine.status.padEnd(9)).join(""));
  }
  console.log(`\nmachine ${machine.status} — ${JSON.stringify(machine.counts)}`);
  console.log(`acceptance ${acceptance.status} — ${acceptance.green}/${acceptance.required}`
    + ` · missing ${JSON.stringify(acceptance.missingFrameworks)}`);
  process.exitCode = acceptance.status === "green" ? 0 : 1;
}
