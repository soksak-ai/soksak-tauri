// 브라우저 표면 동등성 E2E.
//
// 세 브라우저 구현을 같은 제품 시나리오로 검증한다: 실제 입력 경로의 한글 커밋, 탭 교차 클릭에
// 따른 sidebar flow 이동, 이동 전 구간의 픽셀 생존, 최종 슬롯 착지. 구현별 저수준 진단은 각 표면
// 소유자가 답하지만 제품 판정은 동일하다.
//
// 실행: SOKSAK_SOCKET=<cored.sock> node scripts/e2e/slot-freeze.mjs
// 부분 실행: BROWSER_ENGINES=browser-chromium,... (기본은 세 구현 전부)
// 포커스 금지: fixture window는 focus:false, 입력·캡처는 공개 command만 사용한다.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { openClient, requireSocket, must } from "./lib/client.mjs";
import {
  releaseFixtureWindow,
  replaceFixtureWindow,
} from "./lib/fixtureWindow.mjs";
import { closeHtmlFixture, startHtmlFixture } from "./lib/http-fixture.mjs";
import { tauriSurfaceResizePolicyVerdict } from "./lib/tauri-surface-resize-policy.mjs";
import {
  observeFrameSequence as inspectFrameSequence,
  observeFullCapture as inspectFullCapture,
  snapshotScaleForVisualEvidence,
} from "./lib/browser-visual-evidence.mjs";
import { reviewVisualRecordingSafely } from "./lib/visual-recording-review.mjs";
import {
  createBrowserRecordingEvidenceLedger,
  planBrowserRecordingEvidence,
} from "./lib/browser-evidence-plan.mjs";
import {
  createBrowserGateReportStore,
  mapB07PinCaseEvidence,
  mapB08BaselineEvidence,
  mapB08MaximizeCaseEvidence,
  requireBrowserEvidenceBuildId,
} from "./lib/browser-evidence-store.mjs";
import { formatGateVerdict, runEngineCoverage } from "./lib/browser-gate-coverage.mjs";
import {
  beginEvidenceRun,
  evidenceStorePaths,
  finishEvidenceRun,
  produceEvidenceArtifact,
  resolveEvidenceFile,
  writeEvidenceFile,
} from "./lib/evidence-store.mjs";
import {
  recordingReportFromCommandResponse,
  runRecordingEvidenceAction,
} from "./lib/recording-evidence-action.mjs";
import {
  browserTabActivationAddress,
  browserTabNodeAddress,
} from "./lib/browser-ui-addresses.mjs";
import { mapBrowserSurfaceRects } from "./lib/browser-surface-rects.mjs";
import { windowedSurfaceCompositionVerdict } from "./lib/windowed-surface-composition.mjs";
import { mapB03LiveEvidence } from "./lib/browser-gate-b03-evidence.mjs";
import { mapB05LiveEvidence } from "./lib/browser-gate-b05-evidence.mjs";
import { mapB06LiveEvidence } from "./lib/browser-gate-b06-evidence.mjs";
import { mapB10LiveEvidence } from "./lib/browser-gate-b10-evidence.mjs";
import {
  mapB01TabEvidence,
  mapB11TabEvidence,
  mapImeObservation,
} from "./lib/browser-live-evidence.mjs";
import {
  browserImplementations,
  browserSurfaceInvariant,
  fixtureHtml,
  fixtureMotionMarkers,
  rendererTopologyOwnershipVerdict,
  fixtureMarkers,
  fullCaptureReceiptVerdict,
  hostileWindowResizeSizes,
  layoutTransactionVerdict,
  mapB04PresentationSamples,
  normalizeB04JournalEntries,
  parseBrowserEngines,
  resolveB04MovedParticipant,
  unwrapEvalValue,
  viewportGeometryVerdict,
} from "./lib/browser-matrix.mjs";

const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "slot-freeze");
const EVIDENCE_STORE_ROOT = path.join(os.homedir(), ".soksak-e2e", "evidence", "slot-freeze");
const EVIDENCE_ROOT = evidenceStorePaths(EVIDENCE_STORE_ROOT).current;
const ENGINES = parseBrowserEngines(process.env.BROWSER_ENGINES ?? process.env.BROWSER_ENGINE);
const SCENARIOS = (() => {
  const allowed = new Set(["flow", "pin", "resize", "overlay", "scroll"]);
  const selected = new Set((process.env.BROWSER_SCENARIOS ?? "flow,pin,resize,overlay,scroll")
    .split(",").map((value) => value.trim()).filter(Boolean));
  const invalid = [...selected].filter((value) => !allowed.has(value));
  if (!selected.size || invalid.length) {
    throw new Error(`BROWSER_SCENARIOS는 flow,pin,resize,overlay,scroll의 비어 있지 않은 부분집합이어야 한다: ${invalid.join(",")}`);
  }
  return selected;
})();
const CYCLES = (() => {
  const value = Number(process.env.CROSS_CLICK_CYCLES ?? 3);
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new Error(`CROSS_CLICK_CYCLES는 0..20 정수여야 한다: ${process.env.CROSS_CLICK_CYCLES}`);
  }
  return value;
})();
const RECORDING_PLAN = planBrowserRecordingEvidence({
  engines: ENGINES,
  scenarios: [...SCENARIOS],
  cycles: CYCLES,
});
const FRAMES_PER_CLICK = 48;
const PIN_FRAMES_PER_CLICK = 24;
const FAST_RESIZE_FRAMES = 64;
const EVIDENCE_PNG_MAX_BYTES = 128 * 1024 ** 2;
const IME_TEXTS = ["한글 입력 왼쪽", "한글 입력 오른쪽"];
const CHROME_MARKERS = Object.freeze({
  railAdd: "#ff0000",
  rightSidebar: "#00ff00",
  modalOverlayProbe: "#ff00ff",
});
const PRESENTATION_MARKERS = Object.freeze(["#00ff80", "#ff0080"]);

async function runPlannedRecordingAction({ recordingLedger, engine, scenario, name, action }) {
  const recording = recordingLedger.take(engine, scenario, name);
  return runRecordingEvidenceAction({
    root: EVIDENCE_STORE_ROOT,
    relativePath: recording.relativePath,
    maxBytes: recording.maxBytes,
    keep: process.env.KEEP === "1",
    action,
  });
}

async function reviewRecordingOutcome({ outcome, expectedFrames, name }) {
  const relativePath = outcome.visualEvidence.artifact?.relativePath;
  if (!relativePath) {
    const report = outcome.visualEvidence;
    console.log(`◉ ${name}: recording visual review FAILED ${report.failures.join(" · ")} (제품 machine 판정과 분리)`);
    return { artifacts: [], report };
  }
  return reviewRecordingArtifacts({
    directory: resolveEvidenceFile(EVIDENCE_STORE_ROOT, "current", relativePath),
    recording: recordingReportFromCommandResponse(outcome.actionResult),
    expectedFrames,
    name,
  });
}

function evidenceRelativePath(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(EVIDENCE_ROOT, absolute);
  if (resolveEvidenceFile(EVIDENCE_STORE_ROOT, "current", relative) !== absolute) {
    throw new Error(`evidence report 경계 불일치: ${file}`);
  }
  return relative;
}

async function produceEvidenceFile(file, producer) {
  const stored = await produceEvidenceArtifact(
    EVIDENCE_STORE_ROOT,
    evidenceRelativePath(file),
    {
      kind: "file",
      maxBytes: EVIDENCE_PNG_MAX_BYTES,
      keep: process.env.KEEP === "1",
    },
    producer,
  );
  return stored.result;
}

async function captureWindowSnapshot(rpc, win, file, label, params = {}) {
  return produceEvidenceFile(file, async ({ path: outputPath }) => must(
    await rpc("window.snapshot", { ...params, path: outputPath }, win),
    label,
  ));
}

async function writeMachineReport(file, report) {
  await writeEvidenceFile(
    EVIDENCE_STORE_ROOT,
    evidenceRelativePath(file),
    `${JSON.stringify(report, null, 2)}\n`,
    { keep: process.env.KEEP === "1" },
  );
  return report;
}

async function writeVisualReport(file, report) {
  try {
    await writeMachineReport(file, report);
  } catch (error) {
    console.error(`시각 진단 보고서 저장 실패(기계 판정과 분리): ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}

async function reviewRecordingArtifacts({ directory, recording, expectedFrames, name }) {
  let artifacts = [];
  let artifactReadError = null;
  try {
    artifacts = fs.readdirSync(directory)
      .filter((file) => /^f\d{4}\.png$/.test(file))
      .sort()
      .map((file) => path.join(directory, file));
  } catch (error) {
    artifactReadError = error instanceof Error ? error.message : String(error);
  }
  const report = reviewVisualRecordingSafely({ recording, expectedFrames, artifacts, artifactReadError });
  await writeVisualReport(`${directory}.visual-recording.json`, report);
  const summary = report.status === "failed" ? `FAILED ${report.failures.join(" · ")}` : report.status;
  console.log(`◉ ${name}: recording visual review ${summary} (제품 machine 판정과 분리)`);
  return { artifacts, report };
}

async function observeFrameSequence(files, name, scale, options = {}) {
  const report = inspectFrameSequence(files, name, scale, options);
  if (files.length === 1) await writeVisualReport(`${files[0]}.visual.json`, report);
  else if (files[0]) await writeVisualReport(path.join(path.dirname(files[0]), "visual-diagnostics.json"), report);
  console.log(`◉ ${name}: ${files.length}장 human visual evidence 저장(자동 판정 안 함)`);
  return report;
}

const addressForTab = (tree, tabId) => browserTabNodeAddress(tree, tabId, "surface");

const motionAddressForTab = (tree, tabId) => browserTabNodeAddress(tree, tabId, "toolbar");

const activationAddressForTab = (tree, tabId) => browserTabActivationAddress(tree, tabId);

const paneAddress = (tree, paneId) => {
  const node = (tree.nodes ?? []).find((item) => item.nodePath === `layout/pane/${paneId}`);
  if (!node?.address) throw new Error(`pane 공개 DOM 주소가 노출되지 않았다: ${paneId}`);
  return node.address;
};

const lightingAddressForTab = (tree, tabId) => {
  const node = (tree.nodes ?? []).find((item) => item.nodePath === `layout/tab/${tabId}`);
  if (!node?.address) throw new Error(`탭 focus lighting 소유자 주소가 노출되지 않았다: ${tabId}`);
  return node.address;
};

async function assertActivePane(rpc, win, expectedPaneId, stage) {
  const state = must(await rpc("pane.list", {}, win), `${stage} pane.list`);
  if (state.activePaneId !== expectedPaneId) {
    throw new Error(
      `${stage}: pane 활성화 실패 expected=${expectedPaneId} actual=${state.activePaneId}`,
    );
  }
  return state;
}

function assertNativeLighting(data, _activeLabel, labels) {
  const surfaces = new Map((data.engine?.surfaces ?? []).map((surface) => [surface.label, surface]));
  const errors = [];
  for (const label of labels) {
    const surface = surfaces.get(label);
    if (!surface) { errors.push(`${label}:missing`); continue; }
    if ("dim" in surface || "lighting" in surface) errors.push(`${label}:per-surface-lighting-present`);
  }
  if (errors.length) throw new Error(`single lighting plane 불일치 — ${errors.join(", ")}`);
}

function assertPaneComposition(data, labels) {
  const errors = [];
  if (data.verdict !== "green" || data.matched !== true) {
    errors.push(`verdict=${data.verdict}/matched=${data.matched}`);
  }
  if ((data.orphanNative ?? []).length) errors.push(`orphan=${JSON.stringify(data.orphanNative)}`);
  const members = new Map();
  for (const match of data.matches ?? []) {
    if (!match.ok) errors.push(`pane:${match.pane}:geometry`);
    const topology = rendererTopologyOwnershipVerdict(match.rendererTopology ?? null);
    if (!topology.ok) errors.push(`pane:${match.pane}:topology:${topology.errors.join("/")}`);
    if (!(Number(match.alpha) > 0 && Number(match.alpha) <= 1)) {
      errors.push(`pane:${match.pane}:alpha=${match.alpha}`);
    }
    for (const member of match.memberMatches ?? []) members.set(member.label, member);
  }
  for (const label of labels) {
    const member = members.get(label);
    if (!member?.ok) errors.push(`member:${label}:missing-or-misaligned`);
  }
  if (members.size !== labels.length) errors.push(`members=${members.size}/${labels.length}`);
  if (errors.length) throw new Error(`pane composition 불일치 — ${errors.join(", ")}`);
}

function assertTauriSurfaceResizePolicy(data, stage) {
  const verdict = tauriSurfaceResizePolicyVerdict(data.surfaces ?? []);
  if (!verdict.ok) {
    throw new Error(`${stage}: Tauri surface resize policy 불일치 — ${verdict.errors.join(", ")}`);
  }
}

async function assertWindowedComposition(rpc, win, plugin, tabIds, labels, scaleFactor) {
  const stats = must(await rpc(`plugin.${plugin}.stats`, {}, win), "windowed stats");
  const paneComposition = must(
    await rpc("webview.pane.composition", {}, win),
    "windowed pane composition",
  );
  const verdict = windowedSurfaceCompositionVerdict({
    stats,
    paneComposition,
    viewIds: tabIds,
    labels,
    scaleFactor,
  });
  if (!verdict.ok) throw new Error(`windowed composition 불일치 — ${verdict.errors.join(", ")}`);
}

async function assertEngineSurfaceLedger(rpc, win, implementation, tabIds, stage) {
  if (implementation.surface === "framework-native") return;
  if (implementation.surface === "engine-offscreen") {
    for (const viewId of tabIds) {
      must(await rpc(
        `plugin.${implementation.plugin}.surface.wait-settled`,
        { viewId, timeoutMs: 8_000 },
        win,
        { timeoutMs: 20_000 },
      ), `${stage} settle ${viewId}`);
    }
  }
  const stats = must(await rpc(`plugin.${implementation.plugin}.stats`, {}, win), `${stage} stats`);
  const verdict = browserSurfaceInvariant({
    surface: implementation.surface,
    plugin: implementation.plugin,
    windowLabel: win,
    viewIds: tabIds,
    expectedVisible: tabIds.map(() => true),
    stats,
  });
  if (!verdict.ok) throw new Error(`${stage}: view→surface→engine 불일치 — ${verdict.errors.join(", ")}`);
  return verdict;
}

async function resolvePresentationTraceOwners(
  rpc,
  win,
  implementation,
  viewIds,
  paneIds,
  surfaceIds,
) {
  const adapter = implementation.presentationTrace;
  if (!adapter?.ownerCommand || typeof adapter.resolveOwners !== "function") {
    throw new Error(`${implementation.plugin}: presentation trace adapter가 선언되지 않았다`);
  }
  const facts = must(await rpc(
    adapter.ownerCommand,
    adapter.ownerParams({ windowLabel: win, viewIds, paneIds, surfaceIds }),
    win,
  ), `${implementation.plugin} presentation owners`);
  const owners = adapter.resolveOwners({
    facts,
    windowLabel: win,
    viewIds,
    paneIds,
    surfaceIds,
  });
  if (!Array.isArray(owners) || owners.length !== viewIds.length) {
    throw new Error(`${implementation.plugin}: presentation owners=${owners?.length ?? 0}/${viewIds.length}`);
  }
  return owners;
}

async function installPanePresentationMarkers(rpc, win, labels) {
  const exposed = must(await rpc("webview.pane.hosts", {}, win), "pane presentation hosts");
  for (let index = 0; index < labels.length; index += 1) {
    const host = (exposed.hosts ?? []).find((item) =>
      item.window === win && Array.isArray(item.members) && item.members.includes(labels[index]));
    if (!host?.renderer) throw new Error(`slot ${index} pane renderer가 노출되지 않았다: ${labels[index]}`);
    must(await rpc("webview.pane.eval", {
      label: host.renderer,
      js: `let el=document.getElementById("soksak-presentation-motion-probe");`
        + `if(!el){el=document.createElement("div");el.id="soksak-presentation-motion-probe";document.body.append(el)}`
        + `Object.assign(el.style,{position:"fixed",left:"16px",top:"0",width:"12px",height:"12px",background:${JSON.stringify(PRESENTATION_MARKERS[index])},zIndex:"2147483647",pointerEvents:"none"});return "ok";`,
    }, win), `slot ${index} pane renderer marker`);
  }
}

async function assertCaptureInstrumentationCleared(rpc, win) {
  const anchors = must(await rpc("capture.motion-anchors", { anchors: [] }, win), "capture anchors cleanup");
  const calibration = must(await rpc("capture.calibration", { visible: false }, win), "capture calibration cleanup");
  if (anchors.count !== 0 || anchors.visible || calibration.visible) {
    throw new Error(`capture instrumentation 잔류: ${JSON.stringify({ anchors, calibration })}`);
  }
}

const nodeAddress = (tree, nodePath) => {
  const node = (tree.nodes ?? []).find((item) => item.nodePath === nodePath);
  if (!node?.address) throw new Error(`공개 DOM 주소 누락: ${nodePath}`);
  return node.address;
};

async function assertFocusLighting(rpc, win, addresses, labels, activeIndex, paneOwned, stage) {
  const dims = [];
  const levels = [];
  const adapterAlphas = labels.map(() => paneOwned ? null : 1);
  for (let index = 0; index < addresses.length; index += 1) {
    const measured = must(await rpc("ui.measure", {
      address: addresses[index], props: ["--dim"],
    }, win), `${stage} lighting slot ${index}`);
    dims.push(Number.parseFloat(measured.style?.["--dim"]));
    levels.push(measured.dataset?.dim ?? "");
  }
  const errors = [];
  for (let index = 0; index < addresses.length; index += 1) {
    const active = index === activeIndex;
    if (!Number.isFinite(dims[index])) errors.push(`${index}:dim=${dims[index]}`);
    if (active && (levels[index] !== "clear" || Math.abs(dims[index]) > 0.001)) {
      errors.push(`${index}:active level=${levels[index]} dim=${dims[index]}`);
    }
    if (!active && (levels[index] === "clear" || !(dims[index] > 0 && dims[index] < 1))) {
      errors.push(`${index}:inactive level=${levels[index]} dim=${dims[index]}`);
    }
  }
  if (paneOwned) {
    const composition = must(await rpc("webview.pane.composition", {}, win), `${stage} lighting composition`);
    for (let index = 0; index < labels.length; index += 1) {
      const match = (composition.matches ?? []).find((candidate) =>
        (candidate.memberMatches ?? []).some((member) => member.label === labels[index]));
      if (!match || !Number.isFinite(Number(match.alpha))
          || Math.abs(Number(match.alpha) - 1) > 0.001) {
        errors.push(`${labels[index]}:adapter-alpha=${match?.alpha}/1`);
      }
      adapterAlphas[index] = match?.alpha ?? null;
    }
  }
  if (errors.length) throw new Error(`${stage}: focus lighting 수치 계약 불일치 — ${errors.join(", ")}`);
  return { dims, levels, adapterAlphas };
}

async function assertRailCompositionContract(
  rpc,
  win,
  railAddress,
  expectedPaneId,
  stage,
  { connected = true, side, placement } = {},
) {
  const tree = must(await rpc("ui.tree", {}, win), `${stage} rail composition tree`);
  const railPlaneNode = (tree.nodes ?? []).find((node) => node.nodePath === "rail/plane");
  const lightingNode = (tree.nodes ?? []).find((node) =>
    typeof node.nodePath === "string" && /^focus-lighting\/[^/]+$/.test(node.nodePath));
  const relationNode = (tree.nodes ?? []).find((node) =>
    typeof node.nodePath === "string" && node.nodePath.startsWith("relation/rail/"));
  if (!railPlaneNode?.address || !lightingNode?.address || !relationNode?.address) {
    throw new Error(`${stage}: rail 평면/조명/관계 공개 노드 누락 ${JSON.stringify({ railPlaneNode, lightingNode, relationNode })}`);
  }
  const [rail, railPlane, lighting, relation] = await Promise.all([
    rpc("ui.measure", { address: railAddress }, win),
    rpc("ui.measure", { address: railPlaneNode.address, props: ["zIndex"] }, win),
    rpc("ui.measure", { address: lightingNode.address, props: ["zIndex"] }, win),
    rpc("ui.measure", { address: relationNode.address, props: ["zIndex"] }, win),
  ]).then((values) => values.map((value, index) => must(value, `${stage} rail layer ${index}`)));
  const railZ = Number(railPlane.style?.zIndex);
  const lightingZ = Number(lighting.style?.zIndex);
  const relationZ = Number(relation.style?.zIndex);
  const errors = [];
  if (rail.dataset?.focusLighting !== "exempt") errors.push("rail-not-lighting-exempt");
  if (!(railZ > lightingZ)) errors.push(`rail-z=${railZ}<=lighting-z=${lightingZ}`);
  if (!(relationZ > railZ)) errors.push(`relation-z=${relationZ}<=rail-z=${railZ}`);
  if (relation.dataset?.connected !== String(connected)) {
    errors.push(`relation-connected=${relation.dataset?.connected}/${connected}`);
  }
  if (side && relation.dataset?.side !== side) errors.push(`relation-side=${relation.dataset?.side}/${side}`);
  if (placement && relation.dataset?.placement !== placement) {
    errors.push(`relation-placement=${relation.dataset?.placement}/${placement}`);
  }
  if (relation.dataset?.boundPane !== expectedPaneId) {
    errors.push(`bound-pane=${relation.dataset?.boundPane}/${expectedPaneId}`);
  }
  if (!relation.dataset?.rail || !relation.dataset?.box) errors.push("relation-geometry-missing");
  if (errors.length) throw new Error(`${stage}: rail composition 불일치 — ${errors.join(", ")}`);
  return {
    railZ,
    lightingZ,
    relationZ,
    relation: relation.dataset,
    relationMeasure: relation,
  };
}

async function readBrowserSurfaceEvidence(
  rpc,
  win,
  { frameworkName, implementation, plugin, tabIds, labels, uiNodes },
) {
  const paneComposition = frameworkName === "tauri"
    && implementation.surface !== "engine-offscreen"
    ? must(await rpc("webview.pane.composition", {}, win), "chrome pane composition")
    : null;
  const stats = implementation.surface.startsWith("engine-")
    ? must(await rpc(`plugin.${plugin}.stats`, {}, win), "chrome engine stats")
    : null;
  return mapBrowserSurfaceRects({
    framework: frameworkName,
    surface: implementation.surface,
    windowLabel: win,
    viewIds: tabIds,
    labels,
    uiNodes,
    paneComposition,
    stats,
  });
}

function pointInOverlap(chromeRect, surfaceRect) {
  const left = Math.max(chromeRect.x, surfaceRect.x);
  const top = Math.max(chromeRect.y, surfaceRect.y);
  const right = Math.min(chromeRect.x + chromeRect.w, surfaceRect.x + surfaceRect.w);
  const bottom = Math.min(chromeRect.y + chromeRect.h, surfaceRect.y + surfaceRect.h);
  if (right - left <= 48 || bottom - top <= 48) return null;
  return { x: left + 24, y: top + 24 };
}

function browserSurfaceOverlapping(chromeRect, surfaces) {
  return surfaces.find((surface) => pointInOverlap(chromeRect, surface.rect)) ?? null;
}

function chromeHitReceipt(target, relation, chromeRect, surface, point, hit) {
  const owners = [
    hit?.dataset?.node,
    hit?.host?.dataset?.node,
    ...(hit?.painters ?? []).map((painter) => painter?.node),
  ].filter((owner) => typeof owner === "string");
  if (!owners.some((owner) => owner === target || owner.startsWith(`${target}/`))) {
    throw new Error(`${target}: 공개 hit owner 불일치 ${JSON.stringify({ point, owners, hit })}`);
  }
  return {
    target,
    relation,
    chromeRect,
    nativeSurface: surface,
    hit: {
      point,
      topmostOwner: target,
      stack: [
        { kind: "chrome", owner: target, surfaceId: null },
        { kind: "native-surface", owner: surface.viewId, surfaceId: surface.surfaceId },
      ],
    },
  };
}

async function assertChromeOverlayContract(
  rpc,
  win,
  engineEvidence,
  scale,
  { frameworkName, implementation, plugin, tabIds, labels, engine, gateReportStore },
) {
  must(await rpc("sidebar.right.mode", { mode: "overlay" }, win), "right sidebar overlay mode");
  must(await rpc("project.rightbar.toggle", { open: true }, win), "right sidebar open");
  const tree = must(await rpc("ui.tree", { rects: true }, win), "chrome ui.tree");
  const railAdd = nodeAddress(tree, "rail/add");
  const rightSidebar = nodeAddress(tree, "sidebar/right");
  const chromeMeasures = new Map();
  for (const [name, address] of [["rail/add", railAdd], ["sidebar/right", rightSidebar]]) {
    const measured = must(await rpc("ui.measure", {
      address, occlusion: true, props: ["zIndex", "position"],
    }, win), `chrome measure ${name}`);
    chromeMeasures.set(name, measured);
    if (!measured.occlusion?.reachable || measured.rect.w <= 0 || measured.rect.h <= 0) {
      throw new Error(`${name}: DOM 크롬 조작면이 도달 불가 ${JSON.stringify(measured)}`);
    }
  }
  const surfaces = await readBrowserSurfaceEvidence(rpc, win, {
    frameworkName, implementation, plugin, tabIds, labels, uiNodes: tree.nodes ?? [],
  });
  const sidebarRect = chromeMeasures.get("sidebar/right").rect;
  const overlappingSurface = browserSurfaceOverlapping(sidebarRect, surfaces);
  if (!overlappingSurface) {
    throw new Error(`오른쪽 overlay sidebar와 겹치는 browser surface가 없다: ${JSON.stringify(sidebarRect)}`);
  }
  const sidebarProbePoint = pointInOverlap(sidebarRect, overlappingSurface.rect);
  const sidebarHit = must(await rpc("ui.hit", sidebarProbePoint, win), "right sidebar hit");
  const b09Samples = [chromeHitReceipt(
    "rail/add",
    "global-layer-order",
    chromeMeasures.get("rail/add").rect,
    surfaces[0],
    {
      x: chromeMeasures.get("rail/add").rect.x + chromeMeasures.get("rail/add").rect.w / 2,
      y: chromeMeasures.get("rail/add").rect.y + chromeMeasures.get("rail/add").rect.h / 2,
    },
    must(await rpc("ui.hit", {
      x: chromeMeasures.get("rail/add").rect.x + chromeMeasures.get("rail/add").rect.w / 2,
      y: chromeMeasures.get("rail/add").rect.y + chromeMeasures.get("rail/add").rect.h / 2,
    }, win), "rail add hit"),
  ), chromeHitReceipt(
    "sidebar/right", "point-overlap", sidebarRect, overlappingSurface, sidebarProbePoint, sidebarHit,
  )];
  const anchorState = must(await rpc("capture.motion-anchors", {
    anchors: [
      { address: railAdd, color: CHROME_MARKERS.railAdd },
      {
        address: rightSidebar,
        color: CHROME_MARKERS.rightSidebar,
        x: sidebarProbePoint.x - sidebarRect.x,
        y: sidebarProbePoint.y - sidebarRect.y,
      },
    ],
  }, win), "chrome overlay anchors");
  await writeMachineReport(path.join(engineEvidence, "chrome-overlay-contract.json"), {
    sidebarRect,
    overlappingSurface: overlappingSurface.rect,
    sidebarProbePoint,
    anchors: anchorState.anchors,
  });
  const before = path.join(engineEvidence, "chrome-overlay.png");
  await captureWindowSnapshot(rpc, win, before, "chrome overlay snapshot");
  await observeFrameSequence([before], `${path.basename(engineEvidence)}/chrome-overlay`, scale, {
    requireFixture: false,
    chromeAnchors: [CHROME_MARKERS.railAdd],
    pointAnchors: [{ color: CHROME_MARKERS.rightSidebar, point: sidebarProbePoint }],
  });

  must(await rpc("ui.input.click", { address: railAdd }, win), "rail add click");
  const modalTree = must(await rpc("ui.tree", { rects: true }, win), "project modal ui.tree");
  const modal = nodeAddress(modalTree, "modal/project-new");
  const modalCard = nodeAddress(modalTree, "modal/project-new/card");
  const close = nodeAddress(modalTree, "modal/project-new/close");
  const measuredModal = must(await rpc("ui.measure", {
    address: modal, occlusion: true, props: ["zIndex", "position"],
  }, win), "project modal measure");
  if (!measuredModal.occlusion?.reachable || Number(measuredModal.style.zIndex) < 300) {
    throw new Error(`project modal이 브라우저 위 크롬 평면에 없다: ${JSON.stringify(measuredModal)}`);
  }
  const measuredModalCard = must(await rpc("ui.measure", {
    address: modalCard, occlusion: true, props: ["zIndex", "position"],
  }, win), "project modal card measure");
  if (!measuredModalCard.occlusion?.reachable) {
    throw new Error(`project modal card가 브라우저 위에서 도달 불가: ${JSON.stringify(measuredModalCard)}`);
  }
  const modalSurfaces = await readBrowserSurfaceEvidence(rpc, win, {
    frameworkName, implementation, plugin, tabIds, labels, uiNodes: modalTree.nodes ?? [],
  });
  const modalSurface = browserSurfaceOverlapping(measuredModalCard.rect, modalSurfaces);
  if (!modalSurface) throw new Error("모달과 겹칠 live browser surface가 공개 상태에서 발견되지 않았다");
  const surfaceRect = modalSurface.rect;
  const probePoint = pointInOverlap(measuredModalCard.rect, surfaceRect);
  const modalHit = must(await rpc("ui.hit", probePoint, win), "project modal hit");
  b09Samples.push(chromeHitReceipt(
    "modal/project-new", "point-overlap", measuredModal.rect, modalSurface, probePoint, modalHit,
  ));
  const modalAnchorState = must(await rpc("capture.motion-anchors", {
    anchors: [{
      address: modalCard,
      color: CHROME_MARKERS.modalOverlayProbe,
      x: probePoint.x - measuredModalCard.rect.x,
      y: probePoint.y - measuredModalCard.rect.y,
    }],
  }, win), "modal overlay probe");
  await writeMachineReport(path.join(engineEvidence, "chrome-project-modal-contract.json"), {
    modalRect: measuredModal.rect,
    modalCardRect: measuredModalCard.rect,
    surfaceRect,
    probePoint,
    anchors: modalAnchorState.anchors,
  });
  const modalPath = path.join(engineEvidence, "chrome-project-modal.png");
  await captureWindowSnapshot(rpc, win, modalPath, "project modal snapshot");
  await observeFrameSequence([modalPath], `${path.basename(engineEvidence)}/chrome-project-modal`, scale, {
    requireFixture: false,
    pointAnchors: [{ color: CHROME_MARKERS.modalOverlayProbe, point: probePoint }],
  });
  const b09Receipt = gateReportStore.recordMachineEvidence({
    framework: frameworkName,
    engine,
    gate: "B09",
    evidence: { engine, samples: b09Samples },
  });
  await gateReportStore.persist();
  console.log(formatGateVerdict(engine, "B09", b09Receipt));
  must(await rpc("ui.input.click", { address: close }, win), "project modal close");
  must(await rpc("project.rightbar.toggle", { open: false }, win), "right sidebar close");
  must(
    await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
    "chrome overlay cleanup settled",
  );
  return { railAdd, rightSidebar, modalPath };
}

async function assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale, file, name) {
  await captureWindowSnapshot(rpc, win, file, `${name} snapshot`);
  const errors = [];
  for (let index = 0; index < tabIds.length; index += 1) {
    const measured = must(await rpc("ui.measure", { address: addresses[index] }, win), `${name} slot ${index}`);
    const result = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabIds[index],
      js: "const r=document.querySelector('#marker')?.getBoundingClientRect(); return { viewport:{w:innerWidth,h:innerHeight}, marker:r&&{width:r.width,height:r.height} };",
    }, win), `${name} viewport ${index}`);
    const page = unwrapEvalValue(result);
    const verdict = viewportGeometryVerdict({
      slot: measured.rect,
      viewport: page?.viewport ?? {},
      marker: page?.marker ?? {},
    });
    if (!verdict.ok) errors.push(`${tabIds[index]}:${verdict.errors.join("|")}`);
  }
  if (errors.length) throw new Error(`${name}: resize composition 불일치 — ${errors.join(", ")}`);
  await observeFrameSequence([file], name, scale);
}

async function verifyIme(rpc, win, plugin, tabId, text) {
  must(
    await rpc(
      `plugin.${plugin}.input.type`,
      { viewId: tabId, selector: "#ime", text },
      win,
      { timeoutMs: 30_000 },
    ),
    `input.type ${tabId}`,
  );
  const result = must(
    await rpc(
      `plugin.${plugin}.eval`,
      {
        viewId: tabId,
        js: "const el=document.querySelector('#ime'); return { value:el?.value, active:document.activeElement===el, ledger:window.__browserFixture };",
      },
      win,
    ),
    `input audit ${tabId}`,
  );
  const value = unwrapEvalValue(result);
  if (value?.value !== text || value?.active !== true) {
    throw new Error(`${tabId}: IME 값/포커스 불일치 ${JSON.stringify(value)}`);
  }
  if (Number(value.ledger?.beforeInput ?? 0) < 1 || Number(value.ledger?.inputEvents ?? 0) < 1) {
    throw new Error(`${tabId}: beforeinput/input 사건 누락 ${JSON.stringify(value.ledger)}`);
  }
  if (value.ledger?.values?.at?.(-1) !== text) {
    throw new Error(`${tabId}: input 사건 값 불일치 ${JSON.stringify(value.ledger?.values)}`);
  }
  return mapImeObservation(value);
}

async function verifyScrollInput(rpc, win, plugin, tabId, evidencePath) {
  const readScroll = async (stage) => {
    const result = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabId,
      js: "return { y:scrollY, h:document.documentElement.scrollHeight, v:innerHeight, seq:Number(document.documentElement.dataset.scrollSeq||0) };",
    }, win), `${stage} scroll audit ${tabId}`);
    return unwrapEvalValue(result);
  };
  const before = await readScroll("before");
  if (Number(before?.y) !== 0 || Number(before?.h) <= Number(before?.v) + 960) {
    throw new Error(`${tabId}: scroll fixture 계약 불일치 ${JSON.stringify(before)}`);
  }
  must(await rpc(`plugin.${plugin}.input.scroll`, {
    viewId: tabId, selector: "body", dx: 0, dy: 480,
  }, win), `input.scroll forward ${tabId}`);
  const forwardApplied = must(await rpc(`plugin.${plugin}.dom.wait-for`, {
    viewId: tabId, selector: 'html[data-scroll-seq]:not([data-scroll-seq="0"])', timeoutMs: 8_000,
  }, win, { timeoutMs: 10_000 }), `input.scroll forward applied ${tabId}`);
  if (forwardApplied.found !== true) {
    throw new Error(`${tabId}: 실제 wheel 전진 사건 미도달 ${JSON.stringify(forwardApplied)}`);
  }
  const after = await readScroll("after");
  const afterY = Number(after?.y);
  if (afterY !== 480) {
    throw new Error(`${tabId}: 실제 wheel 전진량 불일치 ${JSON.stringify({ before, afterY })}`);
  }
  await captureWindowSnapshot(
    rpc,
    win,
    evidencePath,
    `scroll snapshot ${tabId}`,
    { tab: tabId },
  );
  must(await rpc(`plugin.${plugin}.input.scroll`, {
    viewId: tabId, selector: "body", dx: 0, dy: -480,
  }, win), `input.scroll restore ${tabId}`);
  const restoreApplied = must(await rpc(`plugin.${plugin}.dom.wait-for`, {
    viewId: tabId, selector: `html[data-scroll-seq]:not([data-scroll-seq="${Number(after.seq)}"])`, timeoutMs: 8_000,
  }, win, { timeoutMs: 10_000 }), `input.scroll restore applied ${tabId}`);
  if (restoreApplied.found !== true) {
    throw new Error(`${tabId}: 실제 wheel 복원 사건 미도달 ${JSON.stringify(restoreApplied)}`);
  }
  const restored = await readScroll("restored");
  const restoredY = Number(restored?.y);
  if (restoredY !== 0) {
    throw new Error(`${tabId}: 실제 wheel 복원량 불일치 ${JSON.stringify({ afterY, restoredY })}`);
  }
  return { beforeY: Number(before.y), afterY, restoredY };
}

async function verifyFullCapture(rpc, win, plugin, tabId, outputPath, identityMarker) {
  const readDocument = async (stage) => {
    const value = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabId,
      js: "return { y:scrollY, viewport:{w:innerWidth,h:innerHeight}, document:{w:Math.max(innerWidth,document.documentElement.scrollWidth),h:Math.max(innerHeight,document.documentElement.scrollHeight)} };",
    }, win), `${stage} full capture document ${tabId}`);
    return unwrapEvalValue(value);
  };
  const before = await readDocument("before");
  const result = await produceEvidenceFile(outputPath, async ({ path: capturePath }) => must(
    await rpc(`plugin.${plugin}.capture.full`, {
      viewId: tabId,
      path: capturePath,
    }, win, { timeoutMs: 40_000 }),
    `capture.full ${tabId}`,
  ));
  const fileBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  const after = await readDocument("after");
  const verdict = fullCaptureReceiptVerdict({
    requestedViewId: tabId,
    outputPath,
    fileBytes,
    before,
    after,
    result,
  });
  if (!verdict.ok) {
    throw new Error(`${tabId}: full capture 명시 view/영수증/문서 상태 불일치 — ${verdict.errors.join(", ")}`);
  }
  const visual = inspectFullCapture(outputPath, `${tabId}/full`, { identityMarker, receipt: result });
  await writeVisualReport(`${outputPath}.visual.json`, visual);
  return {
    requestedPath: outputPath,
    returnedPath: result.path,
    reportedBytes: result.bytes,
    width: result.width,
    height: result.height,
    viewId: result.viewId,
    fileBytes,
    before,
    after,
    visualReview: "pending",
  };
}

async function assertImePersisted(rpc, win, plugin, tabIds, stage) {
  const observations = [];
  for (let index = 0; index < tabIds.length; index += 1) {
    const result = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabIds[index],
      js: "const el=document.querySelector('#ime'); return { value:el?.value, ledger:window.__browserFixture };",
    }, win), `${stage} IME ${index}`);
    const value = unwrapEvalValue(result);
    if (value?.value !== IME_TEXTS[index] || value?.ledger?.values?.at?.(-1) !== IME_TEXTS[index]) {
      throw new Error(`${stage}: ${tabIds[index]} IME 상태 소실 ${JSON.stringify(value)}`);
    }
    observations.push(mapImeObservation(value));
  }
  return observations;
}

async function runEngine(client, page, engine, recordingLedger, gateReportStore) {
  const implementation = browserImplementations[engine];
  const plugin = implementation.plugin;
  const engineEvidence = path.join(EVIDENCE_ROOT, engine);
  const rpc = (method, params = {}, window, options) => client.rpc(method, params, window, options);
  let win;
  let homeOverride = false;
  let sentinelWin;
  let sentinelHomeOverride = false;
  let sentinelTabId;
  let sentinelSurfaceId;
  let originalSettings;
  let originalRightMode;
  let frameworkName = "";
  let runFailure = null;
  try {
    if (implementation.surface !== "framework-native") {
      const sentinelRoot = path.join(FIXTURE_ROOT, "owner-sentinel", engine);
      fs.mkdirSync(sentinelRoot, { recursive: true });
      sentinelWin = (await replaceFixtureWindow(rpc, sentinelRoot)).label;
      must(await rpc("program.wait", { id: engine, timeoutMs: 20_000 }, sentinelWin), `sentinel program.wait ${engine}`);
      must(await rpc("plugin.settings.set", { id: plugin, key: "homeUrl", value: page.url, scope: "project" }, sentinelWin), "sentinel homeUrl");
      sentinelHomeOverride = true;
      const sentinelTab = must(await rpc("tab.open", { program: engine }, sentinelWin), "sentinel tab.open");
      sentinelTabId = sentinelTab.tabId;
      must(await rpc(`plugin.${plugin}.navigate`, { viewId: sentinelTabId, url: `${page.url}?slot=0` }, sentinelWin), "sentinel navigate");
      must(await rpc(`plugin.${plugin}.dom.wait-for`, {
        selector: 'html[data-slot="0"] #ime', timeoutMs: 8_000, viewId: sentinelTabId,
      }, sentinelWin, { timeoutMs: 30_000 }), "sentinel ready");
      await verifyIme(rpc, sentinelWin, plugin, sentinelTabId, IME_TEXTS[0]);
      const sentinelVerdict = await assertEngineSurfaceLedger(
        rpc, sentinelWin, implementation, [sentinelTabId], "sentinel-created",
      );
      sentinelSurfaceId = sentinelVerdict.mappedIds[0];
    }

    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    const acquired = await replaceFixtureWindow(rpc, FIXTURE_ROOT);
    win = acquired.label;
    console.log(`\n[${engine}] 픽스처 창: ${win}${acquired.adopted ? " (재사용)" : " (생성)"}`);
    frameworkName = String(must(await rpc("framework.info", {}, win), "framework.info").framework ?? "");
    if (frameworkName !== "tauri" && frameworkName !== "electron") {
      throw new Error(`검증하지 않은 framework adapter: ${frameworkName}`);
    }
    gateReportStore.bindFramework(frameworkName);
    await gateReportStore.persist();
    must(await rpc("program.wait", { id: engine, timeoutMs: 20_000 }, win), `program.wait ${engine}`);
    const calibration = must(
      await rpc("capture.calibration", { visible: true }, win),
      "DOM compositor calibration show",
    );
    if (!calibration.visible || calibration.rect?.w !== 40 || calibration.rect?.h !== 40) {
      throw new Error(`DOM compositor calibration 계약 불일치: ${JSON.stringify(calibration)}`);
    }
    const originalWindow = must(await rpc("window.info", {}, win), "window.info");
    originalSettings = must(await rpc("settings.get", {}, win), "settings.get");
    originalRightMode = must(await rpc("sidebar.right.mode", {}, win), "sidebar.right.mode").mode;
    for (const [key, value] of [["projectTabPosition", "left"], ["focusDim", true], ["dimIdle", 0.5]]) {
      must(await rpc("settings.set", { key, value }, win), `fixture setting ${key}`);
    }
    must(await rpc("project.rightbar.toggle", { open: false }, win), "fixture right sidebar closed");
    must(await rpc("plugin.settings.set", { id: plugin, key: "homeUrl", value: page.url, scope: "project" }, win), "fixture homeUrl");
    homeOverride = true;

    const panes = must(await rpc("pane.list", {}, win), "pane.list").panes ?? [];
    if (!panes.length) must(await rpc("space.create", {}, win), "space.create");
    const left = must(await rpc("tab.open", { program: engine }, win), "left tab.open");
    const right = must(await rpc("pane.split", { side: "right", program: engine }, win), "right pane.split");
    if (left.mounted !== true || right.mounted !== true) {
      throw new Error(`브라우저 뷰 준비 계약 위반: ${JSON.stringify({ left, right })}`);
    }
    const tabIds = [left.tabId, right.tabId];
    const paneIds = [left.paneId, right.paneId];
    const mountReceipts = [left, right];
    const expectedUrls = tabIds.map((_, index) => `${page.url}?slot=${index}`);
    const navigateReceipts = [];
    const pageIdentities = [];
    const imeEvidence = tabIds.map((viewId, index) => ({
      viewId,
      expectedText: IME_TEXTS[index],
      phases: {},
    }));
    const b11Tabs = [];
    if (tabIds.some((id) => typeof id !== "string")) throw new Error(`브라우저 탭 id 누락: ${JSON.stringify(tabIds)}`);
    if (paneIds.some((id) => typeof id !== "string")) throw new Error(`브라우저 pane id 누락: ${JSON.stringify(paneIds)}`);
    must(await rpc("sidebar.left.position", { mode: "flow" }, win), "sidebar flow");

    for (let index = 0; index < tabIds.length; index += 1) {
      const tabId = tabIds[index];
      must(await rpc("tab.activate", { tab: tabId }, win), `tab.activate ${tabId}`);
      navigateReceipts[index] = must(
        await rpc(`plugin.${plugin}.navigate`, { viewId: tabId, url: expectedUrls[index] }, win),
        `navigate ${tabId}`,
      );
      // 최초 CEF 표면은 child readiness(유한 8s) 뒤 페이지 MutationObserver(유한 8s)가 이어진다.
      // 라우터 기본 10s로 거래를 중간 절단하지 않고 이 장기 명령이 자기 상한을 명시한다.
      must(
        await rpc(
          `plugin.${plugin}.dom.wait-for`,
          { selector: `html[data-slot="${index}"] #ime`, timeoutMs: 8_000, viewId: tabId },
          win,
          { timeoutMs: 30_000 },
        ),
        `browser ready ${tabId}`,
      );
      const identity = must(await rpc(`plugin.${plugin}.dom.text`, { selector: "h1", viewId: tabId }, win), `browser identity ${tabId}`);
      if (identity.text !== "Browser Boundary") throw new Error(`${tabId}: 페이지 신원 불일치(${JSON.stringify(identity.text)})`);
      const pageIdentityResult = must(await rpc(`plugin.${plugin}.eval`, {
        viewId: tabId,
        js: "return { url: location.href };",
      }, win), `page identity ${tabId}`);
      pageIdentities[index] = { viewId: tabId, ...unwrapEvalValue(pageIdentityResult) };
      imeEvidence[index].phases.initial = await verifyIme(rpc, win, plugin, tabId, IME_TEXTS[index]);
      if (SCENARIOS.has("scroll")) {
        const scroll = await verifyScrollInput(
          rpc, win, plugin, tabId, path.join(engineEvidence, `scroll-${index}.png`),
        );
        await writeMachineReport(
          path.join(engineEvidence, `scroll-${index}.json`),
          scroll,
        );
        const full = await verifyFullCapture(
          rpc, win, plugin, tabId, path.join(engineEvidence, `full-${index}.png`), fixtureMarkers[index],
        );
        await writeMachineReport(
          path.join(engineEvidence, `full-${index}.json`),
          full,
        );
        b11Tabs.push(mapB11TabEvidence({ viewId: tabId, scroll, fullCapture: full }));
      }
      // tab.open + pane.split은 두 view를 먼저 선언하므로 엔진도 둘을 병렬 생성할 수 있다.
      // 부분 prefix를 기대하지 않고 선언된 전체 view 집합과 엔진 장부의 일대일성을 검사한다.
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `create-${index}`);
    }

    // Child PluginView의 공개 node projection은 main DOM layout과 별도 renderer 사건이다.
    // page readiness만으로는 programmatic urlbar value의 projection ACK가 보장되지 않는다.
    // 공용 event-driven layout barrier가 child 측정을 요청하고 native presentation까지
    // 정착시킨 뒤에만 B01 값을 읽는다(고정 대기·재시도·private DOM 조회 없음).
    must(
      await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
      "B01 projected urlbar settled",
    );
    const tree = must(await rpc("ui.tree", { rects: true }, win), "ui.tree");
    const addresses = tabIds.map((id) => addressForTab(tree, id));
    const lightingAddresses = tabIds.map((id) => lightingAddressForTab(tree, id));
    const activationAddresses = tabIds.map((id) => activationAddressForTab(tree, id));
    const urlbarAddresses = tabIds.map((id) => browserTabNodeAddress(tree, id, "urlbar"));
    const urlbarMeasures = await Promise.all(urlbarAddresses.map(async (address, index) => must(
      await rpc("ui.measure", { address }, win),
      `urlbar measure ${tabIds[index]}`,
    )));
    const b01Receipt = gateReportStore.recordMachineEvidence({
      framework: frameworkName,
      engine,
      gate: "B01",
      evidence: {
        engine,
        tabs: tabIds.map((viewId, index) => mapB01TabEvidence({
          viewId,
          expectedUrl: expectedUrls[index],
          mountReceipt: mountReceipts[index],
          urlbarMeasure: urlbarMeasures[index],
          pageIdentity: pageIdentities[index],
          navigateReceipt: navigateReceipts[index],
        })),
      },
    });
    await gateReportStore.persist();
    console.log(formatGateVerdict(engine, "B01", b01Receipt));
    // 플러그인 인스턴스와 함께 영속하고 surface와 같은 x축을 소유하는 공개 toolbar가
    // 브라우저 표면 궤적의 기준이다. 앱 크롬 합성은 별도로 persistent rail root와 pane root를
    // 같은 rAF에서 측정한다 — 콘텐츠 표면 검증과 크롬 DOM 검증을 한 값으로 뭉개지 않는다.
    const motionAddresses = tabIds.map((id) => motionAddressForTab(tree, id));
    const paneAddresses = paneIds.map((id) => paneAddress(tree, id));
    const railAddress = nodeAddress(tree, "rail/left");
    const railAddAddress = nodeAddress(tree, "rail/add");
    must(await rpc("capture.motion-anchors", {
      anchors: [
        ...motionAddresses.map((address, index) => ({
          address,
          color: fixtureMotionMarkers[index],
        })),
        { address: railAddAddress, color: CHROME_MARKERS.railAdd },
      ],
    }, win), "motion anchors");
    const native = implementation.surface === "framework-native";
    const windowed = implementation.surface === "engine-windowed";
    const paneOwned = frameworkName === "tauri" && (native || windowed);
    const labels = tabIds.map((id) => implementation.label(win, id));
    let initialPaneComposition = null;
    if (paneOwned) {
      await installPanePresentationMarkers(rpc, win, labels);
      const initial = must(await rpc("webview.composition", {}, win), "initial composition");
      assertTauriSurfaceResizePolicy(initial, "initial native composition");
      initialPaneComposition = must(
        await rpc("webview.pane.composition", {}, win),
        "initial pane composition",
      );
      assertPaneComposition(initialPaneComposition, labels);
    }
    const initialSurfaceLedger = await assertEngineSurfaceLedger(
      rpc, win, implementation, tabIds, "first-paint-ledger",
    );
    must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "first paint layout settled");
    const firstPaintPath = path.join(engineEvidence, "first-paint.png");
    await captureWindowSnapshot(rpc, win, firstPaintPath, "first paint snapshot");
    const scaleEvidence = snapshotScaleForVisualEvidence(firstPaintPath, originalWindow);
    await writeVisualReport(`${firstPaintPath}.scale.visual.json`, scaleEvidence);
    const scale = scaleEvidence.scale;
    await observeFrameSequence([firstPaintPath], `${engine}/first-paint`, scale);
    must(await rpc("capture.calibration", { visible: false }, win), "first paint calibration hide");
    const initialSurfaceReceipts = await readBrowserSurfaceEvidence(rpc, win, {
      frameworkName,
      implementation,
      plugin,
      tabIds,
      labels,
      uiNodes: tree.nodes ?? [],
    });
    const b03Receipt = gateReportStore.recordMachineEvidence({
      framework: frameworkName,
      engine,
      gate: "B03",
      evidence: mapB03LiveEvidence({
        engine,
        scaleFactor: Number(originalWindow.scale),
        visibleViewIds: tabIds,
        uiTree: tree,
        surfaceReceipts: initialSurfaceReceipts,
      }),
    });
    await gateReportStore.persist();
    console.log(formatGateVerdict(engine, "B03", b03Receipt));

    if (sentinelWin && sentinelTabId) {
      must(await rpc(`plugin.${plugin}.gc`, {}, win, { timeoutMs: 20_000 }), "challenger owner-scoped gc");
      const preserved = await assertEngineSurfaceLedger(
        rpc, sentinelWin, implementation, [sentinelTabId], "cross-window-preserved",
      );
      if (preserved.mappedIds[0] !== sentinelSurfaceId) {
        throw new Error(`cross-window surface identity 교체: ${sentinelSurfaceId}→${preserved.mappedIds[0]}`);
      }
      const identity = must(await rpc(`plugin.${plugin}.dom.text`, {
        selector: "h1", viewId: sentinelTabId,
      }, sentinelWin), "cross-window sentinel identity");
      if (identity.text !== "Browser Boundary") throw new Error(`cross-window sentinel DOM 소실: ${JSON.stringify(identity)}`);
      const sentinelPath = path.join(engineEvidence, "cross-window-sentinel.png");
      await captureWindowSnapshot(rpc, sentinelWin, sentinelPath, "cross-window sentinel snapshot");
      const sentinelInfo = must(await rpc("window.info", {}, sentinelWin), "cross-window sentinel info");
      const sentinelScaleEvidence = snapshotScaleForVisualEvidence(sentinelPath, sentinelInfo);
      await writeVisualReport(`${sentinelPath}.scale.visual.json`, sentinelScaleEvidence);
      await observeFrameSequence(
        [sentinelPath], `${engine}/cross-window-sentinel`, sentinelScaleEvidence.scale, { slots: [0] },
      );
    }

    let frameCount = 0;
    const b04Transitions = [];
    const b05Transitions = [];
    const b06Checkpoints = [];
    const presentationOwners = SCENARIOS.has("flow")
      ? await resolvePresentationTraceOwners(rpc, win, implementation, tabIds, paneIds, labels)
      : [];
    await assertActivePane(rpc, win, paneIds[1], "교차 클릭 시작 상태");
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "cross-click-initial-right");
    for (let cycle = 0; cycle < (SCENARIOS.has("flow") ? CYCLES : 0); cycle += 1) {
      for (let side = 0; side < addresses.length; side += 1) {
        const name = `${String(cycle * 2 + side + 1).padStart(2, "0")}-${side ? "right" : "left"}`;
        const dir = path.join(engineEvidence, name);
        // start ACK는 initial raw read와 layout DOM-commit 구독 설치를 모두 끝낸 뒤에만 온다.
        // 따라서 그 다음 presentation arm/click은 관측보다 먼저 끼어들 수 없다.
        const domTraceSession = must(await rpc("ui.trace.multi.start", {
          addresses: [
            railAddress,
            paneAddresses[0],
            addresses[0],
            paneAddresses[1],
            addresses[1],
          ],
          maxMs: 15_000,
        }, win, { timeoutMs: 5_000 }), `B04 raw DOM trace arm ${name}`);
        let domTraceOpen = true;
        let armedPresentation = null;
        let presentationOpen = false;
        try {
          armedPresentation = must(await rpc(
            implementation.presentationTrace.armCommand,
            implementation.presentationTrace.armParams({
              traceId: `${engine}-${name}-${randomUUID()}`,
              owners: presentationOwners,
            }),
            win,
            { timeoutMs: 10_000 },
          ), `B04 presentation trace arm ${name}`);
          presentationOpen = true;
          const journalBefore = must(await rpc("layout.transactions", {}, win), `layout journal baseline ${name}`);
          const priorEntries = journalBefore.entries ?? [];
          const afterSequence = Number(priorEntries[priorEntries.length - 1]?.sequence ?? 0);
          // 기계 presentation 원장과 PNG 캡처는 같은 네이티브 compositor를 점유한다.
          // 둘을 겹치면 캡처가 display-link close를 막아 거래 이후 프레임까지 원장에 섞인다.
          // 먼저 녹화 없는 실제 클릭을 수치 판정하고 원장을 닫는다. 사람용 녹화는 같은 빌드와
          // 같은 시작/종료 상태를 복원한 별도 반복에서만 수행하며 자동 verdict에는 참여하지 않는다.
          const clickReceipt = must(await rpc("ui.input.click", {
            address: activationAddresses[side],
          }, win, { timeoutMs: 10_000 }), `교차 클릭 ${name}`);
          await assertActivePane(rpc, win, paneIds[side], name);
          must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${name} layout settled`);
          const journalAfter = must(await rpc("layout.transactions", {}, win), `layout journal verdict ${name}`);
          const layoutVerdict = layoutTransactionVerdict(journalAfter.entries, {
            afterSequence,
            candidateViewIds: tabIds,
            // 포커스는 입력·조명 사실이지 presentation clock capability가 아니다. 이 FLOW
            // 픽스처는 화면에 보이는 창을 전면화하지 않고도 모든 구현이 같은 절대 epoch의
            // glide 거래를 사용해야 한다. Tauri만 snap을 정답으로 삼으면 실제 한 프레임
            // DOM/native 지연을 테스트가 승인한다.
            expectedMode: "glide",
          });
          await writeMachineReport(
            path.join(dir, "layout-transaction.json"),
            { afterSequence, entries: layoutVerdict.transactions, verdict: layoutVerdict },
          );
          if (!layoutVerdict.ok) {
            throw new Error(`${engine}/${name}: sidebar/tab layout transaction mismatch — ${layoutVerdict.errors.join(", ")}`);
          }
          const movedParticipant = resolveB04MovedParticipant({
            transactions: layoutVerdict.transactions,
            owners: presentationOwners,
            viewIds: tabIds,
            paneAddresses,
            slotAddresses: addresses,
          });
          const {
            targetViewId,
            owner,
            paneAddress,
            slotAddress,
          } = movedParticipant;
          const b04JournalEntries = normalizeB04JournalEntries(layoutVerdict.transactions);
          // Native producer를 먼저 닫는다. DOM을 먼저 닫으면 그 다음 native close ACK까지의
          // CADisplayLink 꼬리에는 대응 DOM frame이 없어 서로 다른 관측 구간을 결합하게 된다.
          const presentationReceipt = must(await rpc(
            implementation.presentationTrace.readCommand,
            implementation.presentationTrace.readParams({ traceId: armedPresentation.traceId }),
            win,
            { timeoutMs: 10_000 },
          ), `B04 presentation trace read ${name}`);
          presentationOpen = false;
          const domTraceReceipt = must(await rpc(
            "ui.trace.multi.close",
            { traceId: domTraceSession.traceId },
            win,
            { timeoutMs: 5_000 },
          ), `B04 raw DOM trace close ${name}`);
          domTraceOpen = false;
          if (domTraceReceipt.timedOut === true) {
            throw new Error(`${engine}/${name}: raw DOM trace가 explicit close 전에 만료됐다`);
          }
          await Promise.all([
            writeMachineReport(path.join(dir, "dom-presentation-raw.json"), domTraceReceipt),
            writeMachineReport(path.join(dir, "native-presentation-raw.json"), presentationReceipt),
          ]);
          const presentationEvents = implementation.presentationTrace.events(
            presentationReceipt,
            { targetViewId, owner },
          );
          const flowPresentationTrace = mapB04PresentationSamples({
            events: presentationEvents,
            domSamples: domTraceReceipt.samples,
            owner,
            targetViewId,
            transactionId: layoutVerdict.transaction.transactionId,
            domCommittedAtUnixMs: layoutVerdict.transaction.domCommittedAtUnixMs,
            presentationStartAtUnixMs: layoutVerdict.transaction.startAtUnixMs,
            durationMs: layoutVerdict.transaction.durationMs,
            moveDx: layoutVerdict.transaction.moves.find(({ viewId }) => (
              viewId === targetViewId
            ))?.dx,
            railAddress,
            paneAddress,
            slotAddress,
          });
          b04Transitions.push({
            direction: side === 0 ? "to-left" : "to-right",
            targetViewId,
            motionMode: layoutVerdict.transaction.mode,
            journal: {
              afterSequence,
              entries: b04JournalEntries,
            },
            samples: flowPresentationTrace.samples,
            timeline: flowPresentationTrace.timeline,
          });
          b05Transitions.push({
            direction: side === 0 ? "to-left" : "to-right",
            targetViewId,
            clickReceipt,
            layout: layoutVerdict.transaction,
            presentation: presentationReceipt,
          });
          await writeMachineReport(
            path.join(dir, "composition-trace.json"),
            {
              traceId: armedPresentation.traceId,
              targetViewId,
              owner,
              joins: flowPresentationTrace.joins,
              domSamples: domTraceReceipt.samples,
              presentationEvents,
              samples: flowPresentationTrace.samples,
            },
          );
          const sourceSide = side === 0 ? 1 : 0;
          must(await rpc("ui.input.click", {
            address: activationAddresses[sourceSide],
          }, win, { timeoutMs: 10_000 }), `${name} visual replay source restore`);
          must(await rpc(
            "ui.layout.wait-settled",
            { timeoutMs: 8_000 },
            win,
            { timeoutMs: 10_000 },
          ), `${name} visual replay source settled`);
          await assertActivePane(rpc, win, paneIds[sourceSide], `${name} visual replay source`);
          const recordingOutcome = await runPlannedRecordingAction({
            recordingLedger,
            engine,
            scenario: "flow",
            name,
            action: (recordFields) => rpc("ui.input.click", {
              address: activationAddresses[side],
              ...(recordFields.recordDir ? {
                ...recordFields,
                recordFrames: FRAMES_PER_CLICK,
                recordIntervalMs: 16,
                recordLeadMs: 32,
              } : {}),
            }, win, { timeoutMs: 60_000 }),
          });
          must(recordingOutcome.actionResult, `${name} visual replay click`);
          await assertActivePane(rpc, win, paneIds[side], `${name} visual replay target`);
          // PNG decode/visual diagnostics는 위에서 닫힌 수치 원장과 분리된 사람용 증거다.
          const recordingEvidence = await reviewRecordingOutcome({
            outcome: recordingOutcome,
            expectedFrames: FRAMES_PER_CLICK,
            name: `${engine}/${name}`,
          });
          const files = recordingEvidence.artifacts;
          await observeFrameSequence(
            files,
            `${engine}/${name}`,
            scale,
            {
              motion: true,
              presentationMarkers: PRESENTATION_MARKERS,
              chromeAnchors: [CHROME_MARKERS.railAdd],
            },
          );
          frameCount += files.length;

          const lighting = await assertFocusLighting(
            rpc, win, lightingAddresses, labels, side, paneOwned, `${engine}/${name}`,
          );
          const railComposition = await assertRailCompositionContract(
            rpc,
            win,
            railAddress,
            paneIds[side],
            `${engine}/${name}`,
          );
          b06Checkpoints.push({
            phase: name,
            activePaneId: paneIds[side],
            paneIds,
            lighting,
            railComposition,
          });

          if (paneOwned) {
            assertPaneComposition(
              must(await rpc("webview.pane.composition", {}, win), `pane composition ${name}`),
              labels,
            );
            assertNativeLighting(must(await rpc("webview.surfaces", {}, win), `surfaces ${name}`), labels[side], labels);
          }
          if (windowed) {
            await assertWindowedComposition(rpc, win, plugin, tabIds, labels, scale);
          }
          await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `cross-click-${name}`);
          if (cycle === 0) {
            const phase = side === 0 ? "flow-left" : "flow-right";
            const observations = await assertImePersisted(rpc, win, plugin, tabIds, phase);
            observations.forEach((observation, index) => {
              imeEvidence[index].phases[phase] = observation;
            });
          }
          console.log(`✓ ${name}: ${FRAMES_PER_CLICK} frames · 두 live marker · focus dim ${lighting.dims.join("/")} · ${native ? "DOM/native exact" : windowed ? "DOM/CEF exact" : "DOM/native-offscreen exact"}`);
        } catch (flowError) {
          if (domTraceOpen) {
            domTraceOpen = false;
            try {
              await rpc(
                "ui.trace.multi.close",
                { traceId: domTraceSession.traceId },
                win,
                { timeoutMs: 5_000 },
              );
            } catch (error) {
              console.error(`${engine}/${name}: raw DOM trace cleanup 실패`, error);
            }
          }
          if (presentationOpen) {
            presentationOpen = false;
            try {
              await rpc(
                implementation.presentationTrace.readCommand,
                implementation.presentationTrace.readParams({ traceId: armedPresentation.traceId }),
                win,
                { timeoutMs: 10_000 },
              );
            } catch (error) {
              console.error(`${engine}/${name}: presentation trace cleanup 실패`, error);
            }
          }
          throw flowError;
        }
      }
    }
    if (SCENARIOS.has("flow")) {
      const b04Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B04",
        evidence: {
          engine,
          coordinateSpace: { logical: "css-px", scaleFactor: Number(originalWindow.scale) },
          transitions: b04Transitions,
        },
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B04", b04Receipt));
      const b05Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B05",
        evidence: mapB05LiveEvidence({ engine, transitions: b05Transitions }),
      });
      const b06Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B06",
        evidence: mapB06LiveEvidence({ engine, checkpoints: b06Checkpoints }),
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B05", b05Receipt));
      console.log(formatGateVerdict(engine, "B06", b06Receipt));
    }

    // PIN 계약 — 사이드바와 분할 rect는 포커스 클릭의 입력이 아니다. station 0에서 오른쪽
    // 인접/비인접을, station 50에서 왼쪽 인접을 각각 실제 클릭·동일 tick trace·PNG로 검증한다.
    const b07Cases = [];
    const pinCases = SCENARIOS.has("pin") ? [
      {
        position: "right-adjacent",
        station: 0,
        side: 0,
        relationSide: "right",
        connected: true,
        name: "pin-right-adjacent",
      },
      {
        position: "detached",
        station: 0,
        side: 1,
        relationSide: "detached",
        connected: false,
        name: "pin-detached",
      },
      {
        position: "left-adjacent",
        station: 50,
        side: 0,
        relationSide: "left",
        connected: true,
        name: "pin-left-adjacent",
      },
    ] : [];
    for (const pinCase of pinCases) {
      must(await rpc("sidebar.left.position", { mode: "pin", station: pinCase.station }, win), `${pinCase.name} set pin`);
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${pinCase.name} pin settled`);
      const stateTreeBefore = must(await rpc("state.tree", {}, win), `${pinCase.name} state.tree before`);
      const before = must(await rpc("layout.arrangement", {}, win), `${pinCase.name} arrangement before`);
      const journalBefore = must(await rpc("layout.transactions", {}, win), `${pinCase.name} transaction baseline`);
      const priorEntries = journalBefore.entries ?? [];
      const afterSequence = Number(priorEntries[priorEntries.length - 1]?.sequence ?? 0);
      const rectsBefore = await Promise.all([railAddress, ...paneAddresses].map(async (address) => {
        const measured = must(await rpc("ui.measure", { address }, win), `${pinCase.name} rect before`);
        return {
          address,
          nodeIdentity: measured.nodeIdentity ?? null,
          rect: measured.rect,
        };
      }));
      let nativeBefore = null;
      if (frameworkName === "tauri" && native) {
        nativeBefore = must(
          await rpc("webview.composition", {}, win),
          `${pinCase.name} native before`,
        );
      }
      const dir = path.join(engineEvidence, pinCase.name);
      const recordingOutcome = await runPlannedRecordingAction({
        recordingLedger,
        engine,
        scenario: "pin",
        name: pinCase.name,
        action: (recordFields) => rpc("ui.input.click", {
          address: activationAddresses[pinCase.side],
          ...(recordFields.recordDir ? {
            ...recordFields,
            recordFrames: PIN_FRAMES_PER_CLICK,
            recordIntervalMs: 16,
            recordLeadMs: 32,
          } : {}),
        }, win, { timeoutMs: 60_000 }),
      });
      const clicked = must(recordingOutcome.actionResult, `${pinCase.name} click`);
      const recordingEvidence = await reviewRecordingOutcome({
        outcome: recordingOutcome,
        expectedFrames: PIN_FRAMES_PER_CLICK,
        name: `${engine}/${pinCase.name}`,
      });
      const files = recordingEvidence.artifacts;
      const rectsAfter = await Promise.all([railAddress, ...paneAddresses].map(async (address) => {
        const measured = must(await rpc("ui.measure", { address }, win), `${pinCase.name} rect after`);
        return {
          address,
          nodeIdentity: measured.nodeIdentity ?? null,
          rect: measured.rect,
        };
      }));
      const pinErrors = [];
      for (const [index, beforeRect] of rectsBefore.entries()) {
        const afterRect = rectsAfter[index];
        for (const key of ["x", "y", "w", "h"]) {
          if (Math.abs(Number(beforeRect.rect[key]) - Number(afterRect.rect[key])) > 0.5) {
            pinErrors.push(`${beforeRect.address}:${key}=${beforeRect.rect[key]}/${afterRect.rect[key]}`);
          }
        }
      }
      const journalAfter = must(await rpc("layout.transactions", {}, win), `${pinCase.name} transaction after`);
      const unexpected = (journalAfter.entries ?? []).filter((entry) => Number(entry.sequence) > afterSequence);
      if (unexpected.length) pinErrors.push(`layout-transactions=${unexpected.length}/0`);
      const pinTrace = { ok: pinErrors.length === 0, errors: pinErrors, before: rectsBefore, after: rectsAfter };
      await writeMachineReport(
        path.join(dir, "pin-layout-transaction.json"),
        { afterSequence, unexpected, verdict: pinTrace },
      );
      if (!pinTrace.ok) {
        throw new Error(`${engine}/${pinCase.name}: PIN DOM 고정 불일치 — ${pinTrace.errors.join(", ")}`);
      }
      const after = must(await rpc("layout.arrangement", {}, win), `${pinCase.name} arrangement after`);
      if (before.station !== pinCase.station || after.station !== before.station) {
        throw new Error(`${pinCase.name}: station 변경 ${before.station}→${after.station}, expected=${pinCase.station}`);
      }
      if (before.switched || after.switched || JSON.stringify(before.cells) !== JSON.stringify(after.cells)) {
        throw new Error(`${pinCase.name}: PIN이 분할 배치를 변경 ${JSON.stringify({ before, after })}`);
      }
      await assertActivePane(rpc, win, paneIds[pinCase.side], pinCase.name);
      const paneState = must(await rpc("pane.list", {}, win), `${pinCase.name} pane.list`);
      const stateTreeAfter = must(await rpc("state.tree", {}, win), `${pinCase.name} state.tree after`);
      const stateRelation = paneState.railRelation;
      if (!stateRelation
          || stateRelation.placement !== "pin"
          || stateRelation.connected !== pinCase.connected
          || stateRelation.side !== pinCase.relationSide) {
        throw new Error(`${pinCase.name}: 공개 relation 판정 불일치 ${JSON.stringify(stateRelation)}`);
      }
      const railContract = await assertRailCompositionContract(
        rpc,
        win,
        railAddress,
        paneIds[pinCase.side],
        pinCase.name,
        {
          connected: pinCase.connected,
          side: pinCase.relationSide,
          placement: "pin",
        },
      );
      b07Cases.push(mapB07PinCaseEvidence({
        position: pinCase.position,
        stateTreeAfter,
        paneListAfter: paneState,
        relationMeasureAfter: railContract.relationMeasure,
        before: {
          stateTree: stateTreeBefore,
          arrangement: before,
          railMeasure: rectsBefore[0],
          paneMeasures: rectsBefore.slice(1).map((measure, index) => ({
            paneId: paneIds[index],
            ...measure,
          })),
        },
        after: {
          stateTree: stateTreeAfter,
          arrangement: after,
          railMeasure: rectsAfter[0],
          paneMeasures: rectsAfter.slice(1).map((measure, index) => ({
            paneId: paneIds[index],
            ...measure,
          })),
        },
      }));
      await observeFrameSequence(
        files,
        `${engine}/${pinCase.name}`,
        scale,
        { motion: false, chromeAnchors: [CHROME_MARKERS.railAdd] },
      );
      if (frameworkName === "tauri" && native && nativeBefore) {
        const nativeAfter = must(await rpc("webview.composition", {}, win), `${pinCase.name} native after`);
        const beforeWrites = new Map((nativeBefore.placement ?? []).map((item) => [item.label, Number(item.boundsWrites ?? 0)]));
        for (const item of nativeAfter.placement ?? []) {
          if (beforeWrites.has(item.label) && Number(item.boundsWrites ?? 0) !== beforeWrites.get(item.label)) {
            throw new Error(`${pinCase.name}: PIN 클릭이 native bounds를 기록 ${item.label}:${beforeWrites.get(item.label)}→${item.boundsWrites}`);
          }
        }
      }
      frameCount += files.length;
      console.log(`✓ ${pinCase.name}: station=${pinCase.station} side=${pinCase.relationSide} connected=${pinCase.connected} · rect 고정 · ${PIN_FRAMES_PER_CLICK} frames`);
    }
    if (SCENARIOS.has("pin")) {
      const b07Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B07",
        evidence: { engine, cases: b07Cases },
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B07", b07Receipt));
    }
    if (SCENARIOS.has("pin")) {
      must(await rpc("sidebar.left.position", { mode: "pin", station: 50 }, win), "pin maximize station");
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "pin maximize station settled");
      const restoredBaseline = must(await rpc("layout.arrangement", {}, win), "pin maximize baseline");
      const restoredBaselinePosition = must(
        await rpc("sidebar.left.position", {}, win),
        "pin maximize baseline persisted pin",
      );
      const restoredBaselinePanes = must(await rpc("pane.list", {}, win), "pin maximize baseline panes");
      const b08BaselineRaw = {
        railPosition: restoredBaselinePosition,
        arrangement: restoredBaseline,
        paneList: restoredBaselinePanes,
      };
      const b08Baseline = mapB08BaselineEvidence(b08BaselineRaw);
      const b08Cases = [];
      const maximizeCases = [
        {
          side: 0,
          station: 100,
          relationSide: "left",
          targetPaneId: paneIds[0],
          name: "pin-maximize-left",
        },
        {
          side: 1,
          station: 0,
          relationSide: "right",
          targetPaneId: paneIds[1],
          name: "pin-maximize-right",
        },
      ];
      for (const maximizeCase of maximizeCases) {
        must(await rpc("tab.maximize", { tab: tabIds[maximizeCase.side] }, win), `${maximizeCase.name} maximize`);
        must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${maximizeCase.name} settled`);
        const maximized = must(await rpc("layout.arrangement", {}, win), `${maximizeCase.name} arrangement`);
        const maximizedRect = maximized.cells?.[0]?.rect;
        if (maximized.station !== maximizeCase.station
            || maximized.cells?.length !== 1
            || maximized.cells[0]?.id !== paneIds[maximizeCase.side]
            || Number(maximizedRect?.left) !== 0
            || Number(maximizedRect?.top) !== 0
            || Number(maximizedRect?.width) !== 100
            || Number(maximizedRect?.height) !== 100) {
          throw new Error(`${maximizeCase.name}: PIN 방향 최대화 불일치 expectedPane=${paneIds[maximizeCase.side]} actual=${JSON.stringify(maximized)}`);
        }
        const persisted = must(await rpc("sidebar.left.position", {}, win), `${maximizeCase.name} persisted pin`);
        const maximizedPanes = must(await rpc("pane.list", {}, win), `${maximizeCase.name} pane.list`);
        if (persisted.leftRailPosition?.mode !== "pin" || persisted.leftRailPosition?.station !== 50) {
          throw new Error(`${maximizeCase.name}: 최대화가 저장 PIN을 변경 ${JSON.stringify(persisted.leftRailPosition)}`);
        }
        await assertRailCompositionContract(rpc, win, railAddress, paneIds[maximizeCase.side], maximizeCase.name, {
          connected: true,
          side: maximizeCase.relationSide,
          placement: "pin",
        });
        const screenshot = path.join(engineEvidence, `${maximizeCase.name}.png`);
        await captureWindowSnapshot(rpc, win, screenshot, `${maximizeCase.name} snapshot`);
        await observeFrameSequence(
          [screenshot], `${engine}/${maximizeCase.name}`, scale, { slots: [maximizeCase.side] },
        );
        must(await rpc("tab.restore", {}, win), `${maximizeCase.name} restore`);
        must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${maximizeCase.name} restore settled`);
        const restored = must(await rpc("layout.arrangement", {}, win), `${maximizeCase.name} restored arrangement`);
        const restoredPosition = must(
          await rpc("sidebar.left.position", {}, win),
          `${maximizeCase.name} restored pin`,
        );
        const restoredPanes = must(await rpc("pane.list", {}, win), `${maximizeCase.name} restored pane.list`);
        if (restored.station !== 50 || JSON.stringify(restored.cells) !== JSON.stringify(restoredBaseline.cells)) {
          throw new Error(`${maximizeCase.name}: 복원이 PIN/분할을 바꿈 ${JSON.stringify({ baseline: restoredBaseline, restored })}`);
        }
        b08Cases.push(mapB08MaximizeCaseEvidence({
          direction: maximizeCase.relationSide,
          targetPaneId: maximizeCase.targetPaneId,
          maximized: {
            railPosition: persisted,
            arrangement: maximized,
            paneList: maximizedPanes,
          },
          restored: {
            railPosition: restoredPosition,
            arrangement: restored,
            paneList: restoredPanes,
          },
        }));
        console.log(`✓ ${maximizeCase.name}: station=${maximizeCase.station} · 저장 PIN=50 · 복원 동일`);
      }
      const b08Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B08",
        evidence: { engine, baseline: b08Baseline, cases: b08Cases },
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B08", b08Receipt));
    }
    if (SCENARIOS.has("pin")) {
      must(await rpc("sidebar.left.position", { mode: "flow" }, win), "restore sidebar flow after pin contract");
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "flow restore settled");
    }

    // 전체 창 경계 resize — 녹화를 먼저 열고 큰 폭의 축소/확대를 짧은 간격으로 반복한다.
    // 요청 단계는 native affine 계약을 수치 판정하고, 유한 시퀀스 정착 뒤 live DOM/native를
    // 판정한다. 브라우저가 병합할 수 있는 중간 DOM paint를 요청마다 강제하지 않는다.
    let resizeSummary = "창/pane resize 미선택";
    if (SCENARIOS.has("resize")) {
      const fastResizeDir = path.join(engineEvidence, "resize-window-fast");
      const fastSizes = hostileWindowResizeSizes(originalWindow);
      must(await rpc("capture.calibration", { visible: true }, win), "window resize calibration show");
      const fastRecordingOutcome = await runPlannedRecordingAction({
        recordingLedger,
        engine,
        scenario: "resize",
        name: "resize-window-fast",
        action: (recordFields) => rpc("window.resizeSequence", {
          sizes: fastSizes,
          intervalMs: 8,
          ...(recordFields.recordDir ? {
            ...recordFields,
            recordFrames: FAST_RESIZE_FRAMES,
            recordIntervalMs: 16,
          } : {}),
        }, win, { timeoutMs: 60_000 }),
      });
      const fastResize = must(fastRecordingOutcome.actionResult, "rapid window resize");
      const fastRecordingEvidence = await reviewRecordingOutcome({
        outcome: fastRecordingOutcome,
        expectedFrames: FAST_RESIZE_FRAMES,
        name: `${engine}/window-fast`,
      });
      const fastFiles = fastRecordingEvidence.artifacts;
      if (Number(fastResize.steps) !== fastSizes.length) {
        throw new Error(`rapid window resize 단계 누락: ${JSON.stringify(fastResize)}`);
      }
      if (Number(fastResize.resizeElapsedMs) > 4_000) {
        throw new Error(`rapid window resize 응답 정지: ${fastResize.resizeElapsedMs}ms/${fastSizes.length}단계`);
      }
      await writeMachineReport(
        path.join(fastResizeDir, "composition-samples.json"),
        fastResize.samples ?? [],
      );
      if (frameworkName === "tauri") {
        const redSamples = (fastResize.samples ?? []).filter((sample) => sample.observation?.verdict !== "green");
        if (redSamples.length) {
          const summary = redSamples.map((sample) => {
            const direct = sample.observation?.direct?.verdict;
            const directErrors = [
              ...(direct?.misplaced ?? []).map((item) => `direct-misplaced:${JSON.stringify(item)}`),
              ...(direct?.stacked ?? []).map((item) => `direct-stacked:${JSON.stringify(item)}`),
              ...(direct?.missing ?? []).map((item) => `direct-missing:${JSON.stringify(item)}`),
            ];
            const failed = (sample.observation?.pane?.matches ?? []).filter((match) => !match.ok);
            const paneErrors = failed.map((match) => {
              const member = (match.members ?? []).filter((item) => !item.ok)
                .map((item) => `${item.label}:${JSON.stringify(item.delta)}`).join("|");
              return `${match.pane}:${JSON.stringify(match.delta)}${member ? ` member=${member}` : ""}`;
            });
            return `s${sample.step}:${[...directErrors, ...paneErrors].join(",")}`;
          });
          throw new Error(`rapid window resize affine 거래 RED — ${summary.join("; ")}`);
        }
      }
      // 최소 높이에서는 입력 아래의 상태 marker가 정상적으로 viewport 밖에 놓일 수 있다. 전이 중에는
      // 상단의 고정 ruler로 live frame을 판정하고, 원복 직후 실제 input 값·event ledger를 다시 읽는다.
      await observeFrameSequence(
        fastFiles,
        `${engine}/window-fast`,
        scale,
        { requireInput: false, compareDomEpoch: true, chromeAnchors: [CHROME_MARKERS.railAdd] },
      );
      must(await rpc("capture.calibration", { visible: false }, win), "DOM compositor calibration hide");
      frameCount += fastFiles.length;
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "window resize final layout settled");
      if (paneOwned) {
        assertPaneComposition(
          must(await rpc("webview.pane.composition.wait", { settleTimeoutMs: 8_000 }, win, { timeoutMs: 12_000 }),
            "window resize final pane composition"),
          labels,
        );
      }
      await assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale,
        path.join(engineEvidence, "resize-window-restored.png"), `${engine}/window-restored`);
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "window-resize-restored");
      const hostileIme = await assertImePersisted(
        rpc, win, plugin, tabIds, "window-resize-restored",
      );
      hostileIme.forEach((observation, index) => {
        imeEvidence[index].phases["hostile-window-resize"] = observation;
      });

      // 탭 패널 경계 resize — 실제 gutter pointer path를 양방향으로 움직이고 전 구간을 캡처한다.
      const resizeTree = must(await rpc("ui.tree", { rects: true }, win), "resize ui.tree");
      const gutter = (resizeTree.nodes ?? []).find((node) =>
        String(node.nodePath ?? "").startsWith("gutter/") && Number(node.rect?.h) > Number(node.rect?.w) * 4,
      );
      if (!gutter?.address) throw new Error("세로 pane gutter가 노출되지 않았다");
      for (const [direction, dx] of [["wider", 80], ["restored", -80]]) {
        const dir = path.join(engineEvidence, `resize-pane-${direction}`);
        const recordingOutcome = await runPlannedRecordingAction({
          recordingLedger,
          engine,
          scenario: "resize",
          name: `resize-pane-${direction}`,
          action: (recordFields) => rpc("ui.input.drag", {
            from: gutter.address,
            dx,
            steps: 12,
            durationMs: 240,
            ...(recordFields.recordDir ? {
              ...recordFields,
              recordFrames: FRAMES_PER_CLICK,
              recordIntervalMs: 16,
            } : {}),
          }, win, { timeoutMs: 60_000 }),
        });
        const dragged = must(recordingOutcome.actionResult, `pane resize ${direction}`);
        const recordingEvidence = await reviewRecordingOutcome({
          outcome: recordingOutcome,
          expectedFrames: FRAMES_PER_CLICK,
          name: `${engine}/pane-${direction}`,
        });
        const files = recordingEvidence.artifacts;
        await observeFrameSequence(
          files,
          `${engine}/pane-${direction}`,
          scale,
          { chromeAnchors: [CHROME_MARKERS.railAdd] },
        );
        must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
          `pane resize ${direction} layout settled`);
        if (paneOwned) {
          const composition = must(await rpc(
            "webview.pane.composition.wait",
            { settleTimeoutMs: 8_000 },
            win,
            { timeoutMs: 12_000 },
          ), `pane resize ${direction} composition settled`);
          assertPaneComposition(composition, labels);
          await writeMachineReport(
            path.join(engineEvidence, `resize-pane-${direction}-composition.json`),
            composition,
          );
        }
        await assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale,
          path.join(engineEvidence, `resize-pane-${direction}.png`), `${engine}/pane-${direction}`);
        await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `pane-resize-${direction}`);
        const phase = direction === "wider" ? "pane-wider" : "pane-restored";
        const paneIme = await assertImePersisted(rpc, win, plugin, tabIds, phase);
        paneIme.forEach((observation, index) => {
          imeEvidence[index].phases[phase] = observation;
        });
        frameCount += files.length;
      }
      const b02Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B02",
        evidence: { engine, tabs: imeEvidence },
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B02", b02Receipt));
      if (SCENARIOS.has("scroll")) {
        const b11Receipt = gateReportStore.recordMachineEvidence({
          framework: frameworkName,
          engine,
          gate: "B11",
          evidence: { engine, tabs: b11Tabs },
        });
        await gateReportStore.persist();
        console.log(formatGateVerdict(engine, "B11", b11Receipt));
      }
      const b10Receipt = gateReportStore.recordMachineEvidence({
        framework: frameworkName,
        engine,
        gate: "B10",
        evidence: mapB10LiveEvidence({
          engine,
          scaleFactor: Number(originalWindow.scale),
          resizeSequence: fastResize,
        }),
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B10", b10Receipt));
      resizeSummary = `급격한 창 resize ${fastSizes.length}단계/${fastResize.resizeElapsedMs}ms · 패널 resize 왕복`;
    }

    if (SCENARIOS.has("overlay")) {
      await assertChromeOverlayContract(rpc, win, engineEvidence, scale, {
        frameworkName, implementation, plugin, tabIds, labels, engine, gateReportStore,
      });
    }

    const finalPath = path.join(engineEvidence, "final.png");
    await captureWindowSnapshot(rpc, win, finalPath, "final snapshot");
    await observeFrameSequence([finalPath], `${engine}/final`, scale);
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "final-ledger");
    const crossClicks = SCENARIOS.has("flow") ? CYCLES * 2 : 0;
    console.log(`✓ ${engine} evidence collected — 시나리오 ${[...SCENARIOS].join(",")} · 한글 IME 2개 · 교차 클릭 ${crossClicks}회 · ${resizeSummary} · 연속 프레임 ${frameCount}장`);
    return frameCount;
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    // 계측은 제품 UI가 아니다. 성공·RED·KEEP 어느 경로에서도 제거 ACK와 0개 상태를
    // 확인한 뒤에만 창을 사용자에게 돌려준다.
    if (win) {
      try {
        await assertCaptureInstrumentationCleared(rpc, win);
      } catch (cleanupError) {
        if (!runFailure) throw cleanupError;
        console.error(`RED cleanup 보조 실패(최초 오류 보존): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    if (win && homeOverride) {
      await rpc("plugin.settings.reset", { id: plugin, key: "homeUrl", scope: "project" }, win).catch(() => {});
    }
    if (win) await rpc("project.rightbar.toggle", { open: false }, win).catch(() => {});
    if (win && originalRightMode) await rpc("sidebar.right.mode", { mode: originalRightMode }, win).catch(() => {});
    if (win && originalSettings) {
      for (const key of ["projectTabPosition", "focusDim", "dimIdle"]) {
        await rpc("settings.set", { key, value: originalSettings[key] }, win).catch(() => {});
      }
    }
    if (win && process.env.KEEP !== "1") await releaseFixtureWindow(rpc, FIXTURE_ROOT).catch(() => {});
    else if (win) console.log(`KEEP=1 — 픽스처 창 보존: ${win}`);
    if (sentinelWin && sentinelHomeOverride) {
      await rpc("plugin.settings.reset", { id: plugin, key: "homeUrl", scope: "project" }, sentinelWin).catch(() => {});
    }
    if (sentinelWin && process.env.KEEP !== "1") {
      await releaseFixtureWindow(rpc, path.join(FIXTURE_ROOT, "owner-sentinel", engine)).catch(() => {});
    }
  }
}

async function main() {
  // Artifact identity is supplied by the build owner. Validate it before the evidence store,
  // fixture filesystem, socket, or app can be mutated.
  const buildId = requireBrowserEvidenceBuildId(process.env.BROWSER_EVIDENCE_BUILD_ID);
  const runId = process.env.BROWSER_EVIDENCE_RUN_ID ?? `slot-freeze-${randomUUID()}`;
  const recordingLedger = createBrowserRecordingEvidenceLedger(RECORDING_PLAN);
  const gateReportStore = createBrowserGateReportStore({
    root: EVIDENCE_STORE_ROOT,
    buildId,
    runId,
    platform: process.platform,
    keep: process.env.KEEP === "1",
  });
  await beginEvidenceRun(EVIDENCE_STORE_ROOT, {
    runId,
    keep: process.env.KEEP === "1",
  });

  let client = null;
  let page = null;
  let frames = 0;
  let runError = null;
  try {
    client = await openClient(requireSocket());
    page = await startHtmlFixture(() => fixtureHtml());
    const coverage = await runEngineCoverage({
      engines: ENGINES,
      runEngine: (engine) => runEngine(client, page, engine, recordingLedger, gateReportStore),
      blockEngine: (engine, reason) => gateReportStore.blockPending({ engine, reason }),
    });
    frames += coverage.total;
    if (coverage.failures.length) {
      throw new AggregateError(
        coverage.failures.map(({ error }) => error),
        `engine coverage RED — ${coverage.failures
          .map(({ engine, error }) => `${engine}: ${error instanceof Error ? error.message : String(error)}`)
          .join("; ")}`,
      );
    }
    recordingLedger.assertComplete();
  } catch (error) {
    runError = error;
  } finally {
    try {
      client?.close();
      if (page) await closeHtmlFixture(page.server);
    } catch (cleanupError) {
      runError = runError
        ? new AggregateError(
            [runError, cleanupError],
            `${runError instanceof Error ? runError.message : String(runError)}; fixture cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          )
        : cleanupError;
    }
  }

  let machineSummary = null;
  if (gateReportStore.hasReport()) {
    try {
      await gateReportStore.persist();
      machineSummary = gateReportStore.machineSummary();
    } catch (reportError) {
      runError = runError
        ? new AggregateError(
            [runError, reportError],
            `${runError instanceof Error ? runError.message : String(runError)}; browser gate report: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
          )
        : reportError;
    }
  }
  if (!runError && !machineSummary) {
    runError = new Error("canonical browser gate report was not initialized from live framework.info");
  }
  if (!runError && machineSummary?.status !== "green") {
    const counts = machineSummary.counts;
    runError = new Error(
      `canonical browser gate summary ${machineSummary.status} — green=${counts.green}/${machineSummary.required}`
      + ` red=${counts.red} blocked=${counts.blocked} not-run=${counts["not-run"]}`,
    );
  }

  const status = !runError && machineSummary?.status === "green" ? "machine-green" : "red";
  try {
    await finishEvidenceRun(EVIDENCE_STORE_ROOT, { runId, status });
  } catch (finishError) {
    runError = runError
      ? new AggregateError(
          [runError, finishError],
          `${runError instanceof Error ? runError.message : String(runError)}; evidence finish: ${finishError instanceof Error ? finishError.message : String(finishError)}`,
        )
      : finishError;
  }
  if (runError) throw runError;

  console.log(`\n✓ canonical browser gates GREEN — ${machineSummary.counts.green}/${machineSummary.required} required cells · 프레임 ${frames}장`);
  console.log(`사람 검토용 증거: ${EVIDENCE_ROOT}`);
}

await main().catch((error) => {
  console.error(`✗ browser-matrix RED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
