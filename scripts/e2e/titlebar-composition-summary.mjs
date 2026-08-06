import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { requireBrowserEvidenceBuildId } from "./lib/browser-evidence-store.mjs";
import {
  judgeTitlebarColdStartRun,
  requireB12RunId,
  titlebarEvidenceRunRoot,
} from "./lib/titlebar-cold-start-run.mjs";

const buildId = requireBrowserEvidenceBuildId(process.env.BROWSER_EVIDENCE_BUILD_ID);
const runId = requireB12RunId(process.env.B12_RUN_ID);
const root = titlebarEvidenceRunRoot(os.homedir(), runId);
const cycles = [];
for (const cycle of ["1", "2", "3"]) {
  const file = path.join(root, cycle, "cycle.json");
  if (fs.existsSync(file)) cycles.push(JSON.parse(fs.readFileSync(file, "utf8")));
}
const verdict = judgeTitlebarColdStartRun({ buildId, runId, cycles });
const report = {
  schemaVersion: 1,
  buildId,
  runId,
  ...verdict,
  cycles: cycles.map((cycle) => ({
    cycle: cycle.cycle,
    status: cycle.status,
    framework: cycle.framework,
    windows: cycle.windows,
  })),
};
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
if (verdict.status === "green" || verdict.status === "not-applicable") {
  console.log(`✓ B12 three-cold-start aggregate ${verdict.status.toUpperCase()} — ${root}`);
} else {
  console.error(`✗ B12 three-cold-start aggregate ${verdict.status.toUpperCase()} — ${verdict.evidence.join("; ")}`);
  process.exitCode = 1;
}
