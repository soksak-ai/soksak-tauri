// 브라우저 인수 판정 — 두 실행기의 기여를 한 판으로 잇는다.
//
// B01~B11 은 살아 있는 앱 한 번으로 재고(slot-freeze), B12 는 프로세스를 세 번 죽였다 살려야
// 재는 냉시작 게이트다(titlebar-composition). 그래서 실행기가 둘이고, 어느 칸이 누구 것인지는
// browser-gate-report-merge.mjs 의 BROWSER_GATE_OWNERS 한 자리에만 산다.
//
// 이 자리는 그 둘을 합쳐 36칸을 판정한다. 합치는 규칙은 병합 계약이 소유하고 여기서 다시
// 판정하지 않는다 — 같은 판정을 두 곳에서 지으면 둘 중 하나가 거짓말이 된다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  browserGatesOwnedBy,
  mergeBrowserGateReports,
} from "./lib/browser-gate-report-merge.mjs";
import { acceptanceCoverage } from "./lib/browser-gate-coverage.mjs";
import { machineGateSummary } from "./lib/browser-gates.mjs";

/** 그 저장소가 마지막으로 닫은 실행의 정본 보고서. `current` 는 실행 중인 것이라 읽지 않는다. */
export function latestRunReport(storeRoot) {
  const runs = path.join(storeRoot, "runs");
  const entries = readdirSync(runs)
    .map((name) => ({ name, at: statSync(path.join(runs, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at);
  if (entries.length === 0) throw new Error(`완료된 실행이 없다: ${runs}`);
  return JSON.parse(readFileSync(path.join(runs, entries[0].name, "browser-gates.json"), "utf8"));
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
  const slotFreeze = latestRunReport(path.join(home, ".soksak-e2e/evidence/slot-freeze"));
  const titlebar = latestRunReport(path.join(home, ".soksak-e2e/evidence/titlebar-gates"));
  const { merged, machine, acceptance } = browserAcceptanceVerdict({ slotFreeze, titlebar });
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
