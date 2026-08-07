// macOS titlebar composition live E2E.
//
// This harness uses only public command/status/DOM surfaces. Screenshots are mandatory human
// evidence but never determine PASS/FAIL; raw DOM/AppKit rectangles and startup receipts do.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { openClient, requireSocket, must, resolveControlWindow } from "./lib/client.mjs";
import { requireBrowserEvidenceBuildId } from "./lib/browser-evidence-store.mjs";
import { BROWSER_ACCEPTANCE_ENGINES } from "./lib/browser-gate-identity.mjs";
import { judgeB12MachineEvidence } from "./lib/browser-gate-b12.mjs";
import { hostileWindowResizeSizes } from "./lib/browser-matrix.mjs";
import {
  requireB12Cycle,
  requireB12RunId,
  titlebarEvidenceRunRoot,
} from "./lib/titlebar-cold-start-run.mjs";

const HEIGHTS = Object.freeze([30, 60, 72]);
const HOLD_FRAMES = 6;
const HOLD_INTERVAL_MS = 180;
const HOSTILE_RECORD_FRAMES = 64;
const buildId = requireBrowserEvidenceBuildId(process.env.BROWSER_EVIDENCE_BUILD_ID);
const runId = requireB12RunId(process.env.B12_RUN_ID);
const cycle = requireB12Cycle(process.env.B12_CYCLE);
const runRoot = titlebarEvidenceRunRoot(os.homedir(), runId);
const evidenceRoot = path.join(runRoot, cycle);
const cycleFile = path.join(evidenceRoot, "cycle.json");

function publicElements(items) {
  if (!Array.isArray(items)) return null;
  return items.map((item) => item && typeof item === "object"
    ? { role: item.role, rect: item.rect && typeof item.rect === "object" ? { ...item.rect } : null }
    : null);
}

function publicSize(value) {
  return value && typeof value === "object" ? { w: value.w, h: value.h } : null;
}

/** 한 창의 유일한 paint owner 원장. 없는 값은 null로 남겨 판정을 RED로 보낸다. */
function publicOwner(owner) {
  if (!owner || typeof owner !== "object") return null;
  return {
    identity: owner.identity ?? null,
    drawOwnerCount: owner.drawOwnerCount ?? null,
    targetSequence: owner.targetSequence ?? null,
    appliedTargetSequence: owner.appliedTargetSequence ?? null,
    mutationSequence: owner.mutationSequence ?? null,
    drawSequence: owner.drawSequence ?? null,
    applying: owner.applying ?? null,
    lastApplyOk: owner.lastApplyOk ?? null,
    lastApplyError: owner.lastApplyError ?? null,
  };
}

function publicHostileOwner(owner) {
  if (!owner || typeof owner !== "object") return null;
  return {
    identity: owner.identity ?? null,
    drawOwnerCount: owner.drawOwnerCount ?? null,
  };
}

/** 창을 실제로 드러낸 시작 게이트 영수증. 재시작 직후 정렬의 유일한 공개 기준점이다. */
function publicStartup(startup) {
  const composition = startup?.composition;
  return {
    platform: startup?.platform ?? null,
    generation: startup?.generation ?? null,
    headless: startup?.headless ?? null,
    creationCommitted: startup?.creationCommitted ?? null,
    rendererGreen: startup?.rendererGreen ?? null,
    presentationInFlight: startup?.presentationInFlight ?? null,
    presented: startup?.presented ?? null,
    composition: composition && typeof composition === "object"
      ? { kind: composition.kind ?? null, nativeSequence: composition.nativeSequence ?? null }
      : null,
  };
}

function writeCycle(value) {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(cycleFile, `${JSON.stringify(value, null, 2)}\n`);
}

function cycleIdentity(framework) {
  return {
    schemaVersion: 1,
    buildId,
    runId,
    cycle,
    framework,
    platform: process.platform,
  };
}

function machineSummary(report) {
  return {
    schemaVersion: 1,
    status: report.status,
    buildId,
    runId,
    cycle,
    window: report.window,
    framework: report.framework,
    coldStart: report.coldStart,
    verdicts: report.verdicts.map(({ engine, verdict }) => ({ engine, status: verdict.status })),
  };
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
    viewportPhysical: publicSize(composition.viewportPhysical),
    titlebarPhysical: { ...composition.titlebarPhysical },
    reservations: publicElements(composition.reservations),
    buttons: publicElements(composition.buttons),
    backings: publicElements(composition.backings),
    owner: publicOwner(composition.owner),
  };
}

function hostileTitlebar(composition) {
  if (!composition || typeof composition !== "object") return null;
  return {
    presentationRevision: composition.nativeSequence,
    viewportPhysical: publicSize(composition.viewportPhysical),
    titlebarPhysical: composition.titlebarPhysical && typeof composition.titlebarPhysical === "object"
      ? { ...composition.titlebarPhysical }
      : null,
    reservations: publicElements(composition.reservations),
    buttons: publicElements(composition.buttons),
    backings: publicElements(composition.backings),
    owner: publicHostileOwner(composition.owner),
  };
}

async function readStartup(rpc, windowLabel) {
  return publicStartup(must(
    await rpc("window.startup", {}, windowLabel),
    `${windowLabel} window.startup`,
  ));
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

async function hold(rpc, windowLabel, stage) {
  const dir = path.join(evidenceRoot, windowLabel, "holds", stage);
  must(
    await rpc("window.record", {
      dir,
      frames: HOLD_FRAMES,
      intervalMs: HOLD_INTERVAL_MS,
    }, windowLabel),
    `${windowLabel} ${stage} hold`,
  );
}

async function inspectWindow(rpc, windowLabel, framework) {
  const directory = path.join(evidenceRoot, windowLabel);
  const machineFile = path.join(directory, "machine.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(machineFile, `${JSON.stringify({
    schemaVersion: 1,
    status: "running",
    buildId,
    runId,
    cycle,
    window: windowLabel,
    framework,
  }, null, 2)}\n`);
  let reportWritten = false;
  const tree = must(await rpc("ui.tree", {}, windowLabel), `${windowLabel} ui.tree`);
  const titlebar = tree.nodes.find((node) => node.nodePath === "titlebar");
  if (!titlebar?.address) throw new Error(`${windowLabel}: public titlebar address is absent`);

  let needsReset = false;
  let originalOuter = null;
  let needsWindowRestore = false;
  try {
    const initialWindow = must(await rpc("window.info", {}, windowLabel), `${windowLabel} window.info`);
    originalOuter = { w: initialWindow.w, h: initialWindow.h };
    // 재시작 직후 정렬과 로딩 완료 후 정렬은 별개 표본이다. 이 창을 드러낸 시작 게이트
    // 영수증을 먼저 읽고, 아무것도 건드리지 않은 냉시작 합성을 그 다음에 읽는다.
    const startup = await readStartup(rpc, windowLabel);
    const cold = await readSample(rpc, windowLabel, titlebar.address, "cold", null);
    await capture(rpc, windowLabel, "cold");
    must(
      await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, windowLabel, { timeoutMs: 10_000 }),
      `${windowLabel} cold start layout settled`,
    );
    const baseline = await readSample(rpc, windowLabel, titlebar.address, "baseline", null);
    await hold(rpc, windowLabel, "baseline");
    const heldBaseline = await readSample(
      rpc,
      windowLabel,
      titlebar.address,
      "baseline",
      null,
    );
    await capture(rpc, windowLabel, "baseline-held");
    const heights = [];
    const heldHeights = [];
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
      await hold(rpc, windowLabel, `height-${height}`);
      heldHeights.push(await readSample(
        rpc,
        windowLabel,
        titlebar.address,
        "height",
        height,
      ));
      await capture(rpc, windowLabel, `height-${height}-held`);
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
    await hold(rpc, windowLabel, "reset");
    const heldReset = await readSample(rpc, windowLabel, titlebar.address, "reset", null);

    const hostileSizes = hostileWindowResizeSizes(originalOuter);
    needsWindowRestore = true;
    const hostileResult = must(await rpc("window.resizeSequence", {
      sizes: hostileSizes,
      intervalMs: 8,
      recordDir: path.join(directory, "hostile-resize"),
      recordFrames: HOSTILE_RECORD_FRAMES,
      recordIntervalMs: 16,
    }, windowLabel, { timeoutMs: 60_000 }), `${windowLabel} hostile window resize`);
    if (hostileResult.recording?.status !== "complete"
        || hostileResult.recording?.frames !== HOSTILE_RECORD_FRAMES) {
      throw new Error(
        `${windowLabel}: hostile resize recording incomplete ${JSON.stringify(hostileResult.recording)}`,
      );
    }
    must(
      await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, windowLabel, { timeoutMs: 10_000 }),
      `${windowLabel} hostile resize final layout settled`,
    );
    const restoredInfo = must(
      await rpc("window.info", {}, windowLabel),
      `${windowLabel} hostile resize restored window.info`,
    );
    const settledRestore = await readSample(
      rpc,
      windowLabel,
      titlebar.address,
      "resize-restored",
      null,
    );
    await hold(rpc, windowLabel, "hostile-resize-restored");
    const heldRestore = await readSample(
      rpc,
      windowLabel,
      titlebar.address,
      "resize-restored",
      null,
    );
    const heldInfo = must(
      await rpc("window.info", {}, windowLabel),
      `${windowLabel} hostile resize held window.info`,
    );
    await capture(rpc, windowLabel, "hostile-resize-restored-held");
    const hostileResize = {
      baselineOuterPhysical: { ...originalOuter },
      transactions: Array.isArray(hostileResult.samples)
        ? hostileResult.samples.map((entry) => ({
            step: entry?.step,
            requestedOuterPhysical: publicSize(entry?.size),
            probeGeneration: entry?.observation?.generation,
            titlebar: hostileTitlebar(entry?.observation?.titlebar),
          }))
        : null,
      restoredOuterPhysical: { w: restoredInfo.w, h: restoredInfo.h },
      settledRestore,
      heldOuterPhysical: { w: heldInfo.w, h: heldInfo.h },
      heldRestore,
    };
    needsWindowRestore = heldInfo.w !== originalOuter.w || heldInfo.h !== originalOuter.h;
    const final = await readSample(rpc, windowLabel, titlebar.address, "final", null);
    await hold(rpc, windowLabel, "final");
    const heldFinal = await readSample(rpc, windowLabel, titlebar.address, "final", null);
    await capture(rpc, windowLabel, "final-held");

    const verdicts = [];
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      const evidence = {
        engine,
        coordinateSpace: {
          logical: "css-px",
          physical: "device-px",
          scaleFactor: resetReceipt.cssToPhysicalScale,
        },
        startup,
        cold,
        baseline,
        heights,
        reset,
        hostileResize,
        final,
        held: {
          baseline: heldBaseline,
          heights: heldHeights,
          reset: heldReset,
          final: heldFinal,
        },
      };
      const verdict = judgeB12MachineEvidence(evidence, { framework });
      verdicts.push({ engine, verdict, evidence });
    }
    const failed = verdicts.find(({ verdict }) => verdict.status !== "green");
    const report = {
      schemaVersion: 1,
      status: failed ? "red" : "green",
      buildId,
      runId,
      cycle,
      window: windowLabel,
      framework,
      coldStart: {
        generation: startup.generation,
        ownerIdentity: cold.owner?.identity ?? null,
        presentedCompositionSequence: startup.composition?.nativeSequence ?? null,
        coldPresentationRevision: cold.presentationRevision,
        finalPresentationRevision: final.presentationRevision,
      },
      verdicts,
    };
    fs.writeFileSync(
      machineFile,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    reportWritten = true;
    if (failed) {
      throw new Error(
        `${windowLabel}/${failed.engine}/B12 RED: ${failed.verdict.reason}; `
          + failed.verdict.evidence.join("; "),
      );
    }
    return report;
  } catch (error) {
    if (!reportWritten) {
      fs.writeFileSync(machineFile, `${JSON.stringify({
        schemaVersion: 1,
        status: "red",
        buildId,
        runId,
        cycle,
        window: windowLabel,
        framework,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`);
    }
    throw error;
  } finally {
    if (needsReset) {
      must(
        await rpc("titlebar.height.reset", {}, windowLabel),
        `${windowLabel} emergency titlebar.height.reset`,
      );
    }
    if (needsWindowRestore && originalOuter) {
      must(
        await rpc("window.resize", originalOuter, windowLabel),
        `${windowLabel} emergency window size restore`,
      );
    }
  }
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  writeCycle({
    ...cycleIdentity("unknown"),
    status: "running",
    windows: [],
    machines: [],
  });
  let client = null;
  let framework = "unknown";
  let labels = [];
  const reports = [];
  try {
    client = await openClient(requireSocket());
    const rpc = client.rpc;
    const control = await resolveControlWindow(rpc);
    labels = must(await rpc("window.list", {}, control), "window.list").labels;
    if (!Array.isArray(labels) || labels.length === 0) throw new Error("live window list is empty");
    labels = [...labels].sort();
    framework = must(await rpc("framework.info", {}, control), "framework.info").framework;
    if (framework === "electron") {
      const reason = "Electron native traffic-light position adapter is absent";
      writeCycle({
        ...cycleIdentity(framework),
        status: "blocked",
        windows: [],
        machines: [],
        reason,
      });
      const error = new Error(reason);
      error.b12Status = "blocked";
      throw error;
    }
    if (framework !== "tauri") throw new Error(`B12 live harness requires tauri, got ${framework}`);
    if (process.platform !== "darwin") {
      writeCycle({
        ...cycleIdentity(framework),
        status: "not-applicable",
        windows: [],
        machines: [],
        reason: "macOS traffic lights are absent",
      });
      console.log("B12 not-applicable: macOS traffic lights are absent");
      return;
    }
    for (const windowLabel of labels) {
      const report = await inspectWindow(rpc, windowLabel, framework);
      reports.push(report);
      console.log(`✓ ${windowLabel}: ${report.verdicts.length}/3 B12 machine GREEN`);
    }
    writeCycle({
      ...cycleIdentity(framework),
      status: "green",
      windows: labels,
      machines: reports.map(machineSummary),
    });
    console.log(`✓ B12 live cycle ${cycle} GREEN — evidence ${evidenceRoot}`);
  } catch (error) {
    if (error?.b12Status !== "blocked") {
      writeCycle({
        ...cycleIdentity(framework),
        status: "red",
        windows: labels,
        machines: reports.map(machineSummary),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    client?.close();
  }
}

await main().catch((error) => {
  console.error(`✗ B12 live RED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
