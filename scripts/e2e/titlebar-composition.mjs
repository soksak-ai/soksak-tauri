// macOS titlebar composition live E2E.
//
// This harness uses only public command/status/DOM surfaces. Screenshots are mandatory human
// evidence but never determine PASS/FAIL; raw DOM/AppKit rectangles and startup receipts do.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { openClient, requireSocket, must, resolveControlWindow } from "./lib/client.mjs";
import { BROWSER_ACCEPTANCE_ENGINES } from "./lib/browser-gate-identity.mjs";
import { judgeB12MachineEvidence } from "./lib/browser-gate-b12.mjs";

const HEIGHTS = Object.freeze([30, 60, 72]);
const cycle = String(process.env.B12_CYCLE ?? "single");
const evidenceRoot = path.join(
  os.homedir(),
  ".soksak-e2e",
  "evidence",
  "titlebar-composition",
  cycle,
);

function publicElements(items) {
  return items.map(({ role, rect }) => ({ role, rect: { ...rect } }));
}

function sample(stage, requestedHeightCssPx, composition, measured, startup) {
  return {
    stage,
    presentationRevision: composition.nativeSequence,
    presented: startup.presented,
    requestedHeightCssPx,
    dom: {
      nodeIdentity: measured.nodeIdentity,
      inlineStyle: {
        height: measured.inlineStyle.height,
        flexBasis: measured.inlineStyle.flexBasis,
      },
    },
    titlebarPhysical: { ...composition.titlebarPhysical },
    reservations: publicElements(composition.reservations),
    buttons: publicElements(composition.buttons),
    backings: publicElements(composition.backings),
  };
}

async function readSample(rpc, windowLabel, titlebarAddress, stage, requestedHeightCssPx, mutation) {
  const composition = mutation ?? must(
    await rpc("titlebar.composition", {}, windowLabel),
    `${windowLabel} titlebar.composition`,
  );
  const startup = must(
    await rpc("window.startup", {}, windowLabel),
    `${windowLabel} window.startup`,
  );
  const measured = must(
    await rpc("ui.measure", { address: titlebarAddress }, windowLabel),
    `${windowLabel} ui.measure titlebar`,
  );
  return sample(stage, requestedHeightCssPx, composition, measured, startup);
}

async function capture(rpc, windowLabel, name) {
  const directory = path.join(evidenceRoot, windowLabel);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.png`);
  must(await rpc("window.snapshot", { path: file }, windowLabel), `${windowLabel} ${name} capture`);
  return file;
}

async function inspectWindow(rpc, windowLabel, framework) {
  const tree = must(await rpc("ui.tree", {}, windowLabel), `${windowLabel} ui.tree`);
  const titlebar = tree.nodes.find((node) => node.nodePath === "titlebar");
  if (!titlebar?.address) throw new Error(`${windowLabel}: public titlebar address is absent`);

  let needsReset = false;
  try {
    const baseline = await readSample(rpc, windowLabel, titlebar.address, "baseline", null);
    await capture(rpc, windowLabel, "baseline");
    const heights = [];
    for (const height of HEIGHTS) {
      needsReset = true;
      const receipt = must(
        await rpc("titlebar.height.set", { height }, windowLabel),
        `${windowLabel} titlebar.height.set ${height}`,
      );
      heights.push(await readSample(
        rpc,
        windowLabel,
        titlebar.address,
        "height",
        height,
        receipt,
      ));
      await capture(rpc, windowLabel, `height-${height}`);
    }
    const resetReceipt = must(
      await rpc("titlebar.height.reset", {}, windowLabel),
      `${windowLabel} titlebar.height.reset`,
    );
    needsReset = false;
    const reset = await readSample(
      rpc,
      windowLabel,
      titlebar.address,
      "reset",
      null,
      resetReceipt,
    );
    const final = await readSample(rpc, windowLabel, titlebar.address, "final", null);
    await capture(rpc, windowLabel, "final");

    const verdicts = [];
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      const evidence = {
        engine,
        coordinateSpace: {
          logical: "css-px",
          physical: "device-px",
          scaleFactor: resetReceipt.cssToPhysicalScale,
        },
        baseline,
        heights,
        reset,
        final,
      };
      const verdict = judgeB12MachineEvidence(evidence, { framework });
      verdicts.push({ engine, verdict, evidence });
      if (verdict.status !== "green") {
        throw new Error(`${windowLabel}/${engine}/B12 RED: ${verdict.reason}`);
      }
    }
    const report = { cycle, window: windowLabel, framework, verdicts };
    fs.writeFileSync(
      path.join(evidenceRoot, windowLabel, "machine.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    if (needsReset) {
      must(
        await rpc("titlebar.height.reset", {}, windowLabel),
        `${windowLabel} emergency titlebar.height.reset`,
      );
    }
  }
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const client = await openClient(requireSocket());
  try {
    const rpc = client.rpc;
    const control = await resolveControlWindow(rpc);
    const labels = must(await rpc("window.list", {}, control), "window.list").labels;
    if (!Array.isArray(labels) || labels.length === 0) throw new Error("live window list is empty");
    const framework = must(await rpc("framework.info", {}, control), "framework.info").framework;
    if (framework !== "tauri") throw new Error(`B12 live harness requires tauri, got ${framework}`);
    if (process.platform !== "darwin") {
      console.log("B12 not-applicable: macOS traffic lights are absent");
      return;
    }
    for (const windowLabel of labels) {
      const report = await inspectWindow(rpc, windowLabel, framework);
      console.log(`✓ ${windowLabel}: ${report.verdicts.length}/3 B12 machine GREEN`);
    }
    console.log(`✓ B12 live cycle ${cycle} GREEN — evidence ${evidenceRoot}`);
  } finally {
    client.close();
  }
}

await main().catch((error) => {
  console.error(`✗ B12 live RED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
