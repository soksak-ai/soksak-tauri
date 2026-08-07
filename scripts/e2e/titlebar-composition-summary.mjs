import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  browserGatesOwnedBy,
  createBrowserGateReportStore,
  requireBrowserEvidenceBuildId,
} from "./lib/browser-evidence-store.mjs";
import { BROWSER_ACCEPTANCE_ENGINES } from "./lib/browser-gate-identity.mjs";
import { beginEvidenceRun, finishEvidenceRun } from "./lib/evidence-store.mjs";
import {
  judgeTitlebarColdStartRun,
  recordB12ColdStartCells,
  requireB12RunId,
  titlebarEvidenceRunRoot,
  titlebarGateStoreRoot,
} from "./lib/titlebar-cold-start-run.mjs";

/** 이 실행기가 소유한 칸. 소유표는 BROWSER_GATE_OWNERS 한 자리에만 산다 — 여기서 다시 적지 않는다. */
const TITLEBAR_OWNED_GATES = browserGatesOwnedBy("titlebar-composition");

const buildId = requireBrowserEvidenceBuildId(process.env.BROWSER_EVIDENCE_BUILD_ID);
const runId = requireB12RunId(process.env.B12_RUN_ID);
const root = titlebarEvidenceRunRoot(os.homedir(), runId);
const cycles = [];
for (const cycle of ["1", "2", "3"]) {
  const file = path.join(root, cycle, "cycle.json");
  if (fs.existsSync(file)) cycles.push(JSON.parse(fs.readFileSync(file, "utf8")));
}
const verdict = judgeTitlebarColdStartRun({ buildId, runId, cycles });

/** 마지막 냉시작의 마지막 창 표본만 영수증의 닻이 된다 — 어느 실행의 값인지 이름으로 정해 둔다. */
function coldStartAnchors() {
  const last = cycles.at(-1);
  const window = Array.isArray(last?.windows) ? [...last.windows].sort().at(-1) : null;
  if (!last || !window) return {};
  const file = path.join(root, String(last.cycle), window, "machine.json");
  if (!fs.existsSync(file)) return {};
  const machine = JSON.parse(fs.readFileSync(file, "utf8"));
  const verdicts = Array.isArray(machine?.verdicts) ? machine.verdicts : [];
  return Object.fromEntries(BROWSER_ACCEPTANCE_ENGINES
    .map((engine) => [engine, verdicts.find((entry) => entry?.engine === engine)?.evidence])
    .filter(([, evidence]) => evidence != null));
}

/** 판정을 정본 36칸 보고서에 싣는다. 신원을 못 세우면 파일을 쓰지 않고 그 사실을 이름으로 남긴다. */
async function recordCanonicalReport() {
  const framework = cycles[0]?.framework;
  const platform = cycles[0]?.platform;
  if (typeof framework !== "string" || typeof platform !== "string") {
    return { status: "unwritable", reason: "no cycle reported a framework/platform identity" };
  }
  const storeRoot = titlebarGateStoreRoot(os.homedir());
  const store = createBrowserGateReportStore({
    root: storeRoot,
    buildId,
    runId,
    platform,
    gates: TITLEBAR_OWNED_GATES,
  });
  const anchors = coldStartAnchors();
  try {
    recordB12ColdStartCells(store, { framework, verdict, anchors });
  } catch (error) {
    return { status: "unwritable", reason: error instanceof Error ? error.message : String(error) };
  }
  await beginEvidenceRun(storeRoot, { runId });
  await store.persist();
  // 이 실행의 상태는 이 실행이 소유한 칸만 말한다. 나머지 11칸은 남의 측정이라 여기서 세지 않는다.
  const owned = BROWSER_ACCEPTANCE_ENGINES
    .map((engine) => store.report().engines[engine].B12.machine.status);
  const b12Status = owned.every((status) => status === "green" || status === "not-applicable")
    ? "machine-green"
    : "red";
  await finishEvidenceRun(storeRoot, { runId, status: b12Status });
  return { status: "written", root: storeRoot, b12: owned, run: b12Status };
}

const canonicalReport = await recordCanonicalReport()
  .catch((error) => ({
    status: "unwritable",
    reason: error instanceof Error ? error.message : String(error),
  }));

const report = {
  schemaVersion: 1,
  buildId,
  runId,
  ...verdict,
  canonicalReport,
  cycles: cycles.map((cycle) => ({
    cycle: cycle.cycle,
    status: cycle.status,
    framework: cycle.framework,
    windows: cycle.windows,
  })),
};
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
if (canonicalReport.status !== "written") {
  console.error(`✗ B12 canonical cells unrecorded — ${canonicalReport.reason}`);
  process.exitCode = 1;
} else if (canonicalReport.run !== "machine-green") {
  // 실행 집계가 green 이어도 정본 칸이 green 이 아니면 통과가 아니다 — 판정은 보고서가 소유한다.
  console.error(`✗ B12 canonical cells ${canonicalReport.b12.join(", ")} — ${canonicalReport.root}`);
  process.exitCode = 1;
} else {
  console.log(`◉ B12 canonical cells recorded — ${canonicalReport.root} (${canonicalReport.b12.join(", ")})`);
}
if (verdict.status === "green" || verdict.status === "not-applicable") {
  console.log(`✓ B12 three-cold-start aggregate ${verdict.status.toUpperCase()} — ${root}`);
} else {
  console.error(`✗ B12 three-cold-start aggregate ${verdict.status.toUpperCase()} — ${verdict.evidence.join("; ")}`);
  process.exitCode = 1;
}
