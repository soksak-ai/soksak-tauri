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
  createSurfaceSettlementLedger,
  surfaceSettlementVerdict,
} from "./lib/surface-settlement.mjs";
import { hostileResizeObservationGaps } from "./lib/hostile-resize-composition.mjs";
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
  browserGatesOwnedBy,
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
import { browserSurfaceObservation } from "./lib/browser-surface-rects.mjs";
import {
  PANE_PRESENTATION_HOST,
  presentationTraceCapability,
  readHarnessCapabilities,
  recordGateOrCapabilityAbsence,
} from "./lib/harness-capabilities.mjs";
import { readPinStage } from "./lib/pin-geometry-probe.mjs";
import {
  buildB09Sample,
  deriveChromeControl,
  pickOverlapSurface,
  probePointFor,
} from "./lib/browser-gate-b09-evidence.mjs";
import {
  captureDocumentGeometry,
  fullCaptureDocumentProbeJs,
  mapPageState,
  openPageStateReply,
} from "./lib/browser-page-state.mjs";
import { assertSentinelMounted } from "./lib/browser-sentinel.mjs";
import { windowedSurfaceCompositionVerdict } from "./lib/windowed-surface-composition.mjs";
import { displayScaleFact } from "./lib/surface-scale.mjs";
import { mapB03LiveEvidence } from "./lib/browser-gate-b03-evidence.mjs";
import { mapB05LiveEvidence } from "./lib/browser-gate-b05-evidence.mjs";
import { awaitPostSettleHold, resolveB05Settlement } from "./lib/browser-gate-b05-hold.mjs";
import { mapB06LiveEvidence } from "./lib/browser-gate-b06-evidence.mjs";
import { collectB06Checkpoint } from "./lib/browser-gate-b06-collect.mjs";
import { adapterAlphaBasis, readAdapterAlpha } from "./lib/browser-gate-b06-adapter.mjs";
import { comparePaintOrder, stackingPathOf } from "./lib/browser-gate-b06-stacking.mjs";
import { mapB10LiveEvidence } from "./lib/browser-gate-b10-evidence.mjs";
import { measureCapturedImage } from "./lib/browser-gate-b11-capture.mjs";
import { mapB11TabEvidence } from "./lib/browser-gate-b11-evidence.mjs";
import {
  scrollMovedSelector,
  wheelLedgerProbeJs,
  wheelLedgerStage,
  wheelReachedSelector,
} from "./lib/browser-gate-b11-scroll.mjs";
import { mapImeObservation } from "./lib/browser-live-evidence.mjs";
import {
  collectB01LiveEvidence,
  renderB01IdentityFixture,
} from "./lib/browser-gate-b01.mjs";
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
import { b04DomLedgerProducerErrors } from "./lib/browser-gate-b04-slot-timeline.mjs";

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
// hostile resize 자극은 원본이 하한(1280·900·1400·1360·940)보다 충분히 커야 만들어진다.
// 그 사실은 hostileWindowResizeSizes 가 소유하고, 이 크기는 그 하한에 여유를 둔 픽스처 계약이다.
const FIXTURE_WINDOW_SIZE = Object.freeze({ w: 2000, h: 1400 });
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

/**
 * 배율은 창의 사실이므로 `window.info` 레코드를 받아 여기서 읽는다. 맨 숫자를 받지 않는 것이
 * 요점이다 — 캡처에서 잰 배율은 맨 숫자로 돌아다니고, 그것이 이 판정의 반올림 기준이 되면
 * 캡처가 실패할수록 판정이 느슨해진다.
 */
async function assertWindowedComposition(rpc, win, plugin, tabIds, labels, windowInfo) {
  const scaleFactor = displayScaleFact(windowInfo);
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

/** 이번 엔진 실행이 잰 표시 정착. runEngine 이 시작에서 비우고 끝에서 판정한다 — 위반은 실행을
 * 세우지 않지만 그 엔진을 RED 로 끝낸다. */
const SURFACE_SETTLEMENT = createSurfaceSettlementLedger();

async function assertEngineSurfaceLedger(rpc, win, implementation, tabIds, stage) {
  if (implementation.surface === "framework-native") return;
  if (implementation.surface === "engine-offscreen") {
    for (const viewId of tabIds) {
      // 답한 실패는 계약 사실이다. 여기서 던지면 그 이름이 보고서에서 사라지고 그 엔진의 남은
      // 칸이 통째로 blocked 가 된다(실측 2026-08-07 · buildId=2ebb2eb4: 정착 실패 하나가
      // browser-chromium-offscreen 11칸을 삼켰다). 던지는 것은 응답 부재뿐이다.
      const reply = await rpc(
        `plugin.${implementation.plugin}.surface.wait-settled`,
        { viewId, timeoutMs: 8_000 },
        win,
        { timeoutMs: 20_000 },
      ).catch(() => null);
      const settlement = surfaceSettlementVerdict({ stage, viewId, reply });
      if (!settlement.answered) throw new Error(settlement.reason);
      SURFACE_SETTLEMENT.record(settlement);
      if (settlement.violation) console.error(`✗ ${settlement.violation}`);
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

/** presentation 궤적의 소유자 — 먼저 이 창이 그 궤적을 답하는지 묻고, 답할 때만 읽는다.
 *
 * 어댑터의 owner 명령이 곧 이 능력의 입구다. 그 이름에 창이 부재 코드로 답하면 그것은 이
 * 게이트의 실패가 아니라 **잴 자리가 없다**는 사실이고, 부르는 쪽은 그 사실을 이름으로 받는다. */
async function resolvePresentationTrace(
  rpc,
  win,
  capabilities,
  implementation,
  viewIds,
  paneIds,
  surfaceIds,
) {
  const adapter = implementation.presentationTrace;
  if (!adapter?.ownerCommand || typeof adapter.resolveOwners !== "function") {
    throw new Error(`${implementation.plugin}: presentation trace adapter가 선언되지 않았다`);
  }
  const capability = await capabilities.ask({
    ...presentationTraceCapability(adapter),
    witnessParams: adapter.ownerParams({ windowLabel: win, viewIds, paneIds, surfaceIds }),
  });
  if (capability.status === "unreadable") throw new Error(capability.reason);
  if (capability.status === "absent") {
    console.log(`◉ ${implementation.plugin} ${capability.reason}`);
    return { capability, owners: [] };
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
  return { capability, owners };
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

/**
 * 포커스 조명의 수치 사실 — pane 별 흐림과 **어댑터가 통과시키는 빛**.
 *
 * 어댑터 투과율은 픽셀을 소유한 장부에서 온다(browser-gate-b06-adapter.mjs). 옛 판은 그 장부가
 * 없는 경로에서 1 을 써 넣었다 — judge 가 1 을 요구하는데 하니스가 답을 대신 쓰니 offscreen·
 * 문서 안 표면에 이중 감광이 걸려 있어도 이 축은 영원히 통과했다. 못 읽으면 null 이고, 그 이름
 * (adapterBasis)과 함께 judge 로 간다. 여기서 던지지 않는다 — 판정은 B06 영수증이 소유한다.
 *
 * 장부의 이름은 **선언**이 정하고(adapterBasis), 그 장부를 이 창이 답하는지는 **능력**이 정한다
 * (paneLedgerAnswered). 둘은 같은 사실이 아니다 — 선언만 보고 부르면 답하지 않는 창에서 실행이
 * 통째로 끝나고, 능력만 보고 채우면 안 물어본 장부의 값이 측정으로 둔갑한다.
 */
async function assertFocusLighting(
  rpc, win, addresses, labels, activeIndex, adapterBasis, paneLedgerAnswered, stage,
) {
  const dims = [];
  const levels = [];
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
  const paneComposition = adapterBasis === "pane-host" && paneLedgerAnswered
    ? must(await rpc("webview.pane.composition", {}, win), `${stage} lighting composition`)
    : null;
  const surfaces = adapterBasis === "engine-surface" || adapterBasis === "content-view-dom"
    ? must(await rpc("webview.surfaces", {}, win), `${stage} lighting surfaces`)
    : null;
  const adapterAlphas = labels.map((label) => readAdapterAlpha({
    basis: adapterBasis, label, paneComposition, surfaces,
  }));
  const adapterBases = labels.map(() => adapterBasis);
  if (errors.length) throw new Error(`${stage}: focus lighting 수치 계약 불일치 — ${errors.join(", ")}`);
  return { dims, levels, adapterAlphas, adapterBases };
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
    rpc("ui.measure", { address: railPlaneNode.address, props: ["zIndex"], stacking: true }, win),
    rpc("ui.measure", { address: lightingNode.address, props: ["zIndex"], stacking: true }, win),
    rpc("ui.measure", { address: relationNode.address, props: ["zIndex"] }, win),
  ]).then((values) => values.map((value, index) => must(value, `${stage} rail layer ${index}`)));
  const railZ = Number(railPlane.style?.zIndex);
  const lightingZ = Number(lighting.style?.zIndex);
  const relationZ = Number(relation.style?.zIndex);
  const errors = [];
  if (rail.dataset?.focusLighting !== "exempt") errors.push("rail-not-lighting-exempt");
  // 레일이 조명 위인지는 두 z 의 뺄셈이 아니라 **칠하는 순서 사슬**이 답한다 — 둘 사이에는
  // 자기 문맥을 만드는 판(.space-plane)이 끼어 있어 7>6 은 이유가 아니다.
  const railAbove = comparePaintOrder(stackingPathOf(railPlane), stackingPathOf(lighting));
  if (railAbove !== 1) {
    errors.push(`rail-paint-order=${String(railAbove)} rail-z=${railZ} lighting-z=${lightingZ}`);
  }
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

// 원장을 어디서 읽는지는 프레임워크가 선언한 능력이 정한다 — 이름으로 가르면 프레임워크가
// 하나 늘 때마다 여기가 또 갈라진다.
async function readBrowserSurfaceObservation(
  rpc,
  win,
  { nativeChildWebview, implementation, plugin, tabIds, labels },
) {
  const paneComposition = nativeChildWebview
    && implementation.surface !== "engine-offscreen"
    ? must(await rpc("webview.pane.composition", {}, win), "chrome pane composition")
    : null;
  // 문서 안에 사는 표면의 원장은 content view host 자신의 목록이다.
  const contentViews = nativeChildWebview
    ? null
    : must(await rpc("webview.surfaces", {}, win), "content view surfaces").contentViews;
  const stats = implementation.surface.startsWith("engine-")
    ? must(await rpc(`plugin.${plugin}.stats`, {}, win), "chrome engine stats")
    : null;
  return browserSurfaceObservation({
    nativeChildWebview,
    surface: implementation.surface,
    windowLabel: win,
    viewIds: tabIds,
    labels,
    contentViews,
    paneComposition,
    stats,
  });
}

/** 영수증만 필요한 자리 — 원장 이름·표본 시각은 B03 판정만 소비한다. */
async function readBrowserSurfaceEvidence(rpc, win, options) {
  return (await readBrowserSurfaceObservation(rpc, win, options)).receipts;
}

/**
 * B11의 pane resize 반쪽 한 순간.
 *
 * 같은 정착 epoch 아래에서 pane rect, 그 pane 위 native surface rect, 그 안 문서 뷰포트 폭을
 * 함께 읽는다. 셋을 따로 재면 하나가 제자리에 남은 사실이 다른 값에 가린다. epoch를 함께
 * 실어야 이 순간이 wheel/full capture를 잰 순간과 다른 순간임을 보고서가 증명한다.
 *
 * 주소는 매 순간 트리에서 다시 찾는다 — 자리가 바뀐 뒤에도 옛 주소를 들고 있으면 재는 대상이
 * 무엇인지 아무도 답할 수 없다.
 */
async function readB11PaneStage(rpc, win, context, stage) {
  const { nativeChildWebview, implementation, plugin, tabIds, paneIds, labels } = context;
  const settled = must(
    await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
    `B11 ${stage} settled`,
  );
  const tree = must(await rpc("ui.tree", { rects: true }, win), `B11 ${stage} ui.tree`);
  const surfaces = await readBrowserSurfaceEvidence(rpc, win, {
    nativeChildWebview,
    implementation,
    plugin,
    tabIds,
    labels,
  });
  const measured = [];
  for (let index = 0; index < tabIds.length; index += 1) {
    const pane = must(
      await rpc("ui.measure", { address: paneAddress(tree, paneIds[index]) }, win),
      `B11 ${stage} pane rect ${tabIds[index]}`,
    );
    const page = mapPageState(openPageStateReply(must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabIds[index],
      js: fullCaptureDocumentProbeJs(),
    }, win), `B11 ${stage} page state ${tabIds[index]}`)));
    measured.push({
      settledAtUnixMs: Number(settled.settledAtUnixMs),
      paneX: Number(pane.rect?.x),
      paneWidth: Number(pane.rect?.w),
      surfaceX: Number(surfaces[index]?.rect?.x),
      surfaceWidth: Number(surfaces[index]?.rect?.w),
      viewportWidth: page.viewportWidth,
    });
  }
  return measured;
}

/** chrome 한 자리를 재고 그 자리의 히트를 실제로 넣어 표본 하나를 만든다. */
async function measureChromeOverlaySample(rpc, win, {
  target, relation, address, surfaces, planeAddress = null,
}) {
  const measured = must(await rpc("ui.measure", {
    address, occlusion: true, props: ["zIndex", "position"],
  }, win), `chrome measure ${target}`);
  const planeMeasured = planeAddress === null ? measured : must(await rpc("ui.measure", {
    address: planeAddress, occlusion: true, props: ["zIndex", "position"],
  }, win), `chrome plane measure ${target}`);
  const nativeSurface = pickOverlapSurface(measured.rect, surfaces);
  const point = probePointFor(measured.rect, nativeSurface?.rect ?? null);
  const hit = must(await rpc("ui.hit", point, win), `${target} hit`);
  return {
    measured,
    sample: buildB09Sample({
      target,
      relation,
      chromeRect: measured.rect,
      chromeControl: deriveChromeControl(measured, planeMeasured),
      nativeSurface,
      point,
      hit,
    }),
  };
}

/**
 * B09 — rail +, 우측 overlay sidebar, project modal 이 브라우저 native surface 위에 있는가.
 *
 * 판정은 이 함수가 하지 않는다. 잰 값을 표본에 실어 정본 보고서의 judge 가 이름 붙인다. 계약
 * 위반(도달 불가·겹침 없음·층 순서 역전·소유자 불일치)에 여기서 throw 를 세우면 그 사실이
 * blocked 로 사라져 보고서에 이름이 남지 않는다 — 측정 불가(명령 무응답)만 must() 로 던진다.
 * 판정 기록은 픽셀 오라클(observeFrameSequence)보다 먼저 온다. 오라클이 던져도 B09 영수증은
 * 이미 보고서에 있다.
 */
async function assertChromeOverlayContract(
  rpc,
  win,
  engineEvidence,
  scale,
  { frameworkName, nativeChildWebview, implementation, plugin, tabIds, labels, engine, gateReportStore },
) {
  must(await rpc("sidebar.right.mode", { mode: "overlay" }, win), "right sidebar overlay mode");
  must(await rpc("project.rightbar.toggle", { open: true }, win), "right sidebar open");
  const tree = must(await rpc("ui.tree", { rects: true }, win), "chrome ui.tree");
  const railAdd = nodeAddress(tree, "rail/add");
  const rightSidebar = nodeAddress(tree, "sidebar/right");
  const surfaces = await readBrowserSurfaceEvidence(rpc, win, {
    nativeChildWebview, implementation, plugin, tabIds, labels,
  });
  const rail = await measureChromeOverlaySample(rpc, win, {
    target: "rail/add", relation: "global-layer-order", address: railAdd, surfaces,
  });
  const sidebar = await measureChromeOverlaySample(rpc, win, {
    target: "sidebar/right", relation: "point-overlap", address: rightSidebar, surfaces,
  });
  const b09Samples = [rail.sample, sidebar.sample];
  const sidebarRect = sidebar.measured.rect;
  const sidebarProbePoint = sidebar.sample.hit.point;
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
    overlappingSurface: sidebar.sample.nativeSurface?.rect ?? null,
    sidebarProbePoint,
    anchors: anchorState.anchors,
  });
  const before = path.join(engineEvidence, "chrome-overlay.png");
  await captureWindowSnapshot(rpc, win, before, "chrome overlay snapshot");

  must(await rpc("ui.input.click", { address: railAdd }, win), "rail add click");
  const modalTree = must(await rpc("ui.tree", { rects: true }, win), "project modal ui.tree");
  const modal = nodeAddress(modalTree, "modal/project-new");
  const modalCard = nodeAddress(modalTree, "modal/project-new/card");
  const close = nodeAddress(modalTree, "modal/project-new/close");
  const modalSurfaces = await readBrowserSurfaceEvidence(rpc, win, {
    nativeChildWebview, implementation, plugin, tabIds, labels,
  });
  // overlay 검증은 보이는 카드를 겨눈다 — 창 전체 backdrop 은 어떤 surface 와도 겹치므로
  // 그것으로 교집합을 재면 아무 자리나 GREEN 이 된다. 평면 번호는 modal root 가 답한다.
  const modalSample = await measureChromeOverlaySample(rpc, win, {
    target: "modal/project-new",
    relation: "point-overlap",
    address: modalCard,
    planeAddress: modal,
    surfaces: modalSurfaces,
  });
  b09Samples.push(modalSample.sample);
  const measuredModalCard = modalSample.measured;
  const probePoint = modalSample.sample.hit.point;
  const modalAnchorState = must(await rpc("capture.motion-anchors", {
    anchors: [{
      address: modalCard,
      color: CHROME_MARKERS.modalOverlayProbe,
      x: probePoint.x - measuredModalCard.rect.x,
      y: probePoint.y - measuredModalCard.rect.y,
    }],
  }, win), "modal overlay probe");
  await writeMachineReport(path.join(engineEvidence, "chrome-project-modal-contract.json"), {
    modalCardRect: measuredModalCard.rect,
    surfaceRect: modalSample.sample.nativeSurface?.rect ?? null,
    probePoint,
    anchors: modalAnchorState.anchors,
  });
  const modalPath = path.join(engineEvidence, "chrome-project-modal.png");
  await captureWindowSnapshot(rpc, win, modalPath, "project modal snapshot");

  const b09Receipt = gateReportStore.recordMachineEvidence({
    framework: frameworkName,
    engine,
    gate: "B09",
    evidence: { engine, samples: b09Samples },
  });
  await gateReportStore.persist();
  console.log(formatGateVerdict(engine, "B09", b09Receipt));

  // 사람이 볼 증거는 판정 뒤에 읽는다. 오라클이 던져도 B09 영수증은 이미 보고서에 있다.
  await observeFrameSequence([before], `${path.basename(engineEvidence)}/chrome-overlay`, scale, {
    requireFixture: false,
    chromeAnchors: [CHROME_MARKERS.railAdd],
    pointAnchors: [{ color: CHROME_MARKERS.rightSidebar, point: sidebarProbePoint }],
  });
  await observeFrameSequence([modalPath], `${path.basename(engineEvidence)}/chrome-project-modal`, scale, {
    requireFixture: false,
    pointAnchors: [{ color: CHROME_MARKERS.modalOverlayProbe, point: probePoint }],
  });
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
      // 좌표(y)와 함께 페이지가 센 실제 사건 수를 읽는다 — 좌표만 보면 프로그램으로 옮긴
      // 스크롤과 휠이 옮긴 스크롤을 가를 수 없다.
      js: wheelLedgerProbeJs(),
    }, win), `${stage} scroll audit ${tabId}`);
    return unwrapEvalValue(result);
  };
  const waitForPage = async (selector, what) => must(await rpc(`plugin.${plugin}.dom.wait-for`, {
    viewId: tabId, selector, timeoutMs: 8_000,
  }, win, { timeoutMs: 10_000 }), `${what} ${tabId}`);
  // 스크롤이 옮겨진 사실과 휠이 페이지에 닿은 사실은 다른 사건이고, 두 엔진 모두 앞의 것을
  // 먼저 낸다. 휠 쪽을 기다리지 않고 원장을 읽으면 아직 세지 않은 0 을 읽는다.
  // 못 오면 던지지 않는다 — 기다린 뒤에도 0 이면 그 0 이 판정의 답이다.
  const awaitWheelReached = async (seenWheelSeq, leg) =>
    waitForPage(wheelReachedSelector(seenWheelSeq), `wheel reached page ${leg}`);
  // 이 반쪽(휠·full capture)을 잰 순간. pane resize 반쪽은 나중에 자기 순간을 따로 싣는다.
  const settled = must(
    await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
    `scroll phase settled ${tabId}`,
  );
  const forwardRequest = { viewId: tabId, selector: "body", dx: 0, dy: 480 };
  const restoreRequest = { viewId: tabId, selector: "body", dx: 0, dy: -480 };
  const before = await readScroll("before");
  if (Number(before?.y) !== 0 || Number(before?.h) <= Number(before?.v) + 960) {
    throw new Error(`${tabId}: scroll fixture 계약 불일치 ${JSON.stringify(before)}`);
  }
  must(await rpc(`plugin.${plugin}.input.scroll`, forwardRequest, win), `input.scroll forward ${tabId}`);
  const forwardApplied = await waitForPage(
    scrollMovedSelector(Number(before.seq)), "input.scroll forward applied",
  );
  if (forwardApplied.found !== true) {
    throw new Error(`${tabId}: 전진 스크롤 미도달 ${JSON.stringify(forwardApplied)}`);
  }
  await awaitWheelReached(Number(before.wheelSeq), "forward");
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
  must(await rpc(`plugin.${plugin}.input.scroll`, restoreRequest, win), `input.scroll restore ${tabId}`);
  const restoreApplied = await waitForPage(
    scrollMovedSelector(Number(after.seq)), "input.scroll restore applied",
  );
  if (restoreApplied.found !== true) {
    throw new Error(`${tabId}: 복원 스크롤 미도달 ${JSON.stringify(restoreApplied)}`);
  }
  await awaitWheelReached(Number(after.wheelSeq), "restore");
  const restored = await readScroll("restored");
  const restoredY = Number(restored?.y);
  if (restoredY !== 0) {
    throw new Error(`${tabId}: 실제 wheel 복원량 불일치 ${JSON.stringify({ afterY, restoredY })}`);
  }
  return {
    beforeY: Number(before.y),
    afterY,
    restoredY,
    // 요청은 요청 자리에, 관측은 관측 자리에 남긴다 — 판정이 둘을 맞댄다.
    requestedDy: [forwardRequest.dy, restoreRequest.dy],
    settledAtUnixMs: Number(settled.settledAtUnixMs),
    ledger: {
      before: wheelLedgerStage(before),
      after: wheelLedgerStage(after),
      restored: wheelLedgerStage(restored),
    },
  };
}

async function verifyFullCapture(rpc, win, plugin, tabId, outputPath, identityMarker) {
  const readDocument = async (stage) => {
    const value = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabId,
      js: fullCaptureDocumentProbeJs(),
    }, win), `${stage} full capture document ${tabId}`);
    return mapPageState(openPageStateReply(value));
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
    before: captureDocumentGeometry(before),
    after: captureDocumentGeometry(after),
    result,
  });
  if (!verdict.ok) {
    throw new Error(`${tabId}: full capture 명시 view/영수증/문서 상태 불일치 — ${verdict.errors.join(", ")}`);
  }
  const visual = inspectFullCapture(outputPath, `${tabId}/full`, { identityMarker, receipt: result });
  await writeVisualReport(`${outputPath}.visual.json`, visual);
  // 산출물이 문서 전체를 담았는가는 산출물 자신만 답한다. 영수증의 width/height는 캡처
  // 요청에 쓴 문서 크기라, 하니스가 같은 식으로 읽은 문서 크기와 맞대면 순환이다.
  const measured = measureCapturedImage(outputPath);
  return {
    requestedPath: outputPath,
    returnedPath: result.path,
    reportedBytes: result.bytes,
    width: result.width,
    height: result.height,
    capturedWidth: measured.capturedWidth,
    capturedHeight: measured.capturedHeight,
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

/** 뷰가 스스로 보고한 status(R8 회신). 못 읽으면 빈 목록 — 판정을 status 에 걸지 않는다. */
async function readViewStatuses(rpc, win) {
  const reply = await rpc("status.query", {}, win).catch(() => null);
  if (!reply || reply.ok !== true) return [];
  return (reply.data ?? reply).statuses ?? [];
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
  // 판정면이 갈리는 축은 이름이 아니라 프레임워크가 선언한 능력이다.
  let nativeChildWebview = null;
  let runFailure = null;
  // 앞 엔진이 남긴 정착 위반을 이 엔진의 사실로 읽지 않는다.
  SURFACE_SETTLEMENT.reset();
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
      // tab.open 이 이미 답한 마운트 사실을 여기서 읽는다. 안 읽으면 다음 명령의 NO_VIEW 가
      // 소유자를 가린다(실측: offscreen 12칸이 navigate 실패로 blocked 됐다).
      assertSentinelMounted({
        engine,
        receipt: sentinelTab,
        statuses: await readViewStatuses(rpc, sentinelWin),
      });
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
    // 이 창이 무엇을 할 수 있는지는 이름이 아니라 창에게 묻는다. 선언(framework.provision 의 축)과
    // 답(읽기 전용 witness 명령)이 여기서 만나고, 갈라지는 자리는 전부 이 답을 본다 —
    // 프레임워크가 하나 더 늘어도 이 아래는 그대로다.
    const capabilities = await readHarnessCapabilities(rpc, win);
    const provision = capabilities.provision;
    if (typeof provision.nativeChildWebview !== "boolean") {
      throw new Error(`framework가 nativeChildWebview를 선언하지 않았다: ${JSON.stringify(provision)}`);
    }
    nativeChildWebview = provision.nativeChildWebview;
    console.log(`◉ ${engine} capability: ${[...capabilities.entries.values()]
      .map((verdict) => `${verdict.id}=${verdict.status}`).join(" · ")}`);
    must(await rpc("program.wait", { id: engine, timeoutMs: 20_000 }, win), `program.wait ${engine}`);
    const calibration = must(
      await rpc("capture.calibration", { visible: true }, win),
      "DOM compositor calibration show",
    );
    if (!calibration.visible || calibration.rect?.w !== 40 || calibration.rect?.h !== 40) {
      throw new Error(`DOM compositor calibration 계약 불일치: ${JSON.stringify(calibration)}`);
    }
    // 픽스처는 자기 창의 크기도 소유한다. 앱 기본 크기나 앞 엔진이 남긴 크기를 물려받으면
    // hostile resize 자극이 어느 실행에서는 만들어지고 어느 실행에서는 못 만들어져, 같은 앱이
    // 실행마다 다른 칸을 잃는다. 기준 크기를 먼저 세우고 그 위에서 잰다.
    must(await rpc("window.resize", FIXTURE_WINDOW_SIZE, win), "fixture window size");
    must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
      "fixture window size settled");
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
    const tabIds = [left.tabId, right.tabId];
    const paneIds = [left.paneId, right.paneId];
    const mountReceipts = [left, right];
    const imeEvidence = tabIds.map((viewId, index) => ({
      viewId,
      expectedText: IME_TEXTS[index],
      phases: {},
    }));
    // B11의 반쪽. 게이트 이름의 다른 반쪽(pane resize)은 그 사건이 실제로 일어나는 자리에서
    // 따로 재고, 도장은 둘을 다 쥔 뒤에 한 번 찍는다.
    const b11ScrollHalves = [];
    if (paneIds.some((id) => typeof id !== "string")) throw new Error(`브라우저 pane id 누락: ${JSON.stringify(paneIds)}`);
    must(await rpc("sidebar.left.position", { mode: "flow" }, win), "sidebar flow");

    // 마운트 영수증과 실제 항해는 B01 이 소유한다. mounted 가 거짓이거나 탭 id 가 없거나
    // 주소표시줄이 신원을 안 따라온 사실은 던지지 않고 B01 판정에 이름으로 실린다.
    const b01 = await collectB01LiveEvidence({
      rpc, win, plugin, engine, pageUrl: page.url, tabIds, mountReceipts,
    });
    const b01Receipt = gateReportStore.recordMachineEvidence({
      framework: frameworkName,
      engine,
      gate: "B01",
      evidence: b01.evidence,
    });
    await gateReportStore.persist();
    console.log(formatGateVerdict(engine, "B01", b01Receipt));
    // 판정을 남긴 뒤에만 멈춘다. 뒤 게이트가 딛고 설 정본 문서가 없으면 그때부터는 측정 불가다.
    if (b01.blockedReason) throw new Error(`브라우저 정본 문서 미도달 — ${b01.blockedReason}`);

    for (let index = 0; index < tabIds.length; index += 1) {
      const tabId = tabIds[index];
      must(await rpc("tab.activate", { tab: tabId }, win), `tab.activate ${tabId}`);
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
        b11ScrollHalves.push({ viewId: tabId, scroll, fullCapture: full });
      }
      // tab.open + pane.split은 두 view를 먼저 선언하므로 엔진도 둘을 병렬 생성할 수 있다.
      // 부분 prefix를 기대하지 않고 선언된 전체 view 집합과 엔진 장부의 일대일성을 검사한다.
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `create-${index}`);
    }

    // 공용 event-driven layout barrier가 child 측정을 요청하고 native presentation까지
    // 정착시킨 뒤에만 주소를 읽는다(고정 대기·재시도·private DOM 조회 없음).
    must(
      await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
      "projected chrome settled",
    );
    const tree = must(await rpc("ui.tree", { rects: true }, win), "ui.tree");
    const addresses = tabIds.map((id) => addressForTab(tree, id));
    const lightingAddresses = tabIds.map((id) => lightingAddressForTab(tree, id));
    const activationAddresses = tabIds.map((id) => activationAddressForTab(tree, id));
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
    // pane 표면 층을 이 창이 답하는가 — 그 층이 있어야 pane 소유 합성을 잴 수 있다.
    const paneOwned = capabilities.has(PANE_PRESENTATION_HOST.id) && (native || windowed);
    // 어댑터 투과율의 근거 장부 — 선언된 능력 × 엔진의 합성 축에서 나온다. 이름으로 가르면
    // 프레임워크가 하나 늘 때마다 이 자리가 또 갈라진다.
    const adapterBasis = adapterAlphaBasis({
      nativeChildWebview,
      surface: implementation.surface,
    });
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
    // 세 관측은 한 정착 창 안에서 읽는다. 자리를 먼저 재고 표면 원장을 나중에 읽으면 두 숫자는
    // 서로 다른 순간의 레이아웃이고, 그 차이는 합성 결함과 구분되지 않는다. 표면 원장이 스스로
    // 적은 표본 시각이 이 창 안에 드는지는 B03 판정이 본다.
    const b03Settled = must(
      await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
      "B03 observation window settled",
    );
    const b03Tree = must(await rpc("ui.tree", { rects: true }, win), "B03 composition tree");
    const initialSurfaceObservation = await readBrowserSurfaceObservation(rpc, win, {
      nativeChildWebview,
      implementation,
      plugin,
      tabIds,
      labels,
    });
    const b03Receipt = gateReportStore.recordMachineEvidence({
      framework: frameworkName,
      engine,
      gate: "B03",
      evidence: mapB03LiveEvidence({
        engine,
        scaleFactor: Number(originalWindow.scale),
        settledAtUnixMs: Number(b03Settled.settledAtUnixMs),
        visibleViewIds: tabIds,
        uiTree: b03Tree,
        surfaceObservation: initialSurfaceObservation,
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
    const presentationTrace = SCENARIOS.has("flow")
      ? await resolvePresentationTrace(rpc, win, capabilities, implementation, tabIds, paneIds, labels)
      : { capability: null, owners: [] };
    const presentationOwners = presentationTrace.owners;
    // 궤적을 못 재는 창에서도 클릭·레이아웃 거래·조명·IME 는 그대로 잰다. 못 재는 것은 B04·B05
    // 두 칸이고, 그 두 칸은 아래에서 능력의 이름을 달고 닫힌다 — 나머지를 함께 묻지 않는다.
    const presentationTraceMeasurable = presentationTrace.capability?.status !== "absent";
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
          if (presentationTraceMeasurable) {
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
          }
          const journalBefore = must(await rpc("layout.transactions", {}, win), `layout journal baseline ${name}`);
          const priorEntries = journalBefore.entries ?? [];
          const afterSequence = Number(priorEntries[priorEntries.length - 1]?.sequence ?? 0);
          // 기계 presentation 원장과 PNG 캡처는 같은 네이티브 compositor를 점유한다.
          // 둘을 겹치면 캡처가 display-link close를 막아 거래 이후 프레임까지 원장에 섞인다.
          // 먼저 녹화 없는 실제 클릭을 수치 판정하고 원장을 닫는다. 사람용 녹화는 같은 빌드와
          // 같은 시작/종료 상태를 복원한 별도 반복에서만 수행하며 자동 verdict에는 참여하지 않는다.
          // 자극은 자기 관측 거래를 선언한다 — 장부를 sequence 창으로 오려내는 것은
          // "그 사이에 다른 거래가 없었다"는 가정이고, 가정은 영수증이 아니다. 표시 궤적을 못
          // 여는 창에서도 자극은 여전히 자기 관측 거래를 선언한다 — 사유가 없는 거래를 만들지
          // 않으려면 이 자리에 실재하는 부르는 쪽의 id 가 있어야 한다.
          const causeTraceId = armedPresentation?.traceId ?? domTraceSession.traceId;
          const clickReceipt = must(await rpc("ui.input.click", {
            address: activationAddresses[side],
            causeTraceId,
          }, win, { timeoutMs: 10_000 }), `교차 클릭 ${name}`);
          await assertActivePane(rpc, win, paneIds[side], name);
          const settleReceipt = must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${name} layout settled`);
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
          // 표시 궤적을 못 재는 창에서는 이 구간만 건너뛴다 — 클릭·레이아웃 거래·조명·IME 는
          // 그대로 잰다. 못 잰 B04·B05 두 칸은 아래에서 능력의 이름을 달고 닫힌다.
          flowPresentationEvidence: {
            if (!presentationTraceMeasurable) {
              const unusedDomTrace = must(await rpc(
                "ui.trace.multi.close",
                { traceId: domTraceSession.traceId },
                win,
                { timeoutMs: 5_000 },
              ), `B04 raw DOM trace close ${name}`);
              domTraceOpen = false;
              if (unusedDomTrace.timedOut === true) {
                throw new Error(`${engine}/${name}: raw DOM trace가 explicit close 전에 만료됐다`);
              }
              break flowPresentationEvidence;
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
            // B05 유지 창 — 정착 뒤에도 표면이 그대로 표시되는지가 판정 대상이다. 원장을 정착
            // 즉시 닫으면 착지 후 빈 브라우저·잔상·사라짐이 관측 밖에서 일어난다.
            await awaitPostSettleHold();
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
            const ledgerErrors = b04DomLedgerProducerErrors(domTraceReceipt.samples);
            if (ledgerErrors.length > 0) {
              throw new Error(`${engine}/${name}: DOM 원장이 관측자 이름을 안 실었다 — ${ledgerErrors.join(", ")}`);
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
              settlement: resolveB05Settlement({
                settleReceipt,
                presentationReceipt,
              }),
            });
            await writeMachineReport(
              path.join(dir, "composition-trace.json"),
              {
                traceId: armedPresentation.traceId,
                targetViewId,
                owner,
                joins: flowPresentationTrace.joins,
                // 결합이 원장에서 뒤로 간 자리는 이름으로 남는다 — 실행을 끊지 않는다.
                pairing: flowPresentationTrace.pairing,
                // 표본 구멍은 간격이 아니라 관측자 계수로 읽는다 — 0 은 "안 움직였다"가 아니라
                // "그 관측자가 한 번도 안 왔다"다.
                domProducers: domTraceReceipt.producers ?? null,
                domSamples: domTraceReceipt.samples,
                presentationEvents,
                samples: flowPresentationTrace.samples,
              },
            );
          }
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
            rpc, win, lightingAddresses, labels, side, adapterBasis, paneOwned,
            `${engine}/${name}`,
          );
          await assertRailCompositionContract(
            rpc,
            win,
            railAddress,
            paneIds[side],
            `${engine}/${name}`,
          );
          b06Checkpoints.push(await collectB06Checkpoint({
            rpc,
            win,
            phase: name,
            activePaneId: paneIds[side],
            paneIds,
            lighting,
            stage: `${engine}/${name}`,
          }));

          if (paneOwned) {
            assertPaneComposition(
              must(await rpc("webview.pane.composition", {}, win), `pane composition ${name}`),
              labels,
            );
            assertNativeLighting(must(await rpc("webview.surfaces", {}, win), `surfaces ${name}`), labels[side], labels);
          }
          // 창-엔진 표면의 합성 대조도 pane 표면 층이 있어야 읽는다(그 층이 대조 상대다).
          if (windowed && paneOwned) {
            await assertWindowedComposition(rpc, win, plugin, tabIds, labels, originalWindow);
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
      // 궤적을 못 잰 창에서는 이 두 칸이 능력의 이름을 달고 닫힌다. 없는 증거로 red 를 적지도,
      // 아무 말 없이 not-run 으로 묻지도 않는다.
      const b04Receipt = recordGateOrCapabilityAbsence(gateReportStore, {
        framework: frameworkName,
        engine,
        gate: "B04",
        capability: presentationTrace.capability,
        evidence: {
          engine,
          coordinateSpace: { logical: "css-px", scaleFactor: Number(originalWindow.scale) },
          transitions: b04Transitions,
        },
      });
      await gateReportStore.persist();
      console.log(formatGateVerdict(engine, "B04", b04Receipt));
      const b05Receipt = recordGateOrCapabilityAbsence(gateReportStore, {
        framework: frameworkName,
        engine,
        gate: "B05",
        capability: presentationTrace.capability,
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
      // 네이티브 합성 원장은 pane 표면 층을 답하는 창에만 있다.
      if (paneOwned && native) {
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
      // 여기서 던지지 않는다. rect 고정·station·분할 배치·relation 은 전부 값이라 evidence 로
      // 실어 judge 가 RED 로 이름을 붙인다 — 던지면 보고서에 blocked 만 남고 위반이 안 남는다.
      const after = must(await rpc("layout.arrangement", {}, win), `${pinCase.name} arrangement after`);
      await assertActivePane(rpc, win, paneIds[pinCase.side], pinCase.name);
      const paneState = must(await rpc("pane.list", {}, win), `${pinCase.name} pane.list`);
      const stateTreeAfter = must(await rpc("state.tree", {}, win), `${pinCase.name} state.tree after`);
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
      // PIN 클릭이 native surface 좌표를 다시 썼는지는 값이다 — 장부를 그대로 싣는다.
      // 읽는 조건은 nativeBefore 와 같아야 한다: 한쪽만 있으면 장부가 아니라 반쪽이다.
      let nativeAfter = null;
      if (paneOwned && native) {
        nativeAfter = must(await rpc("webview.composition", {}, win), `${pinCase.name} native after`);
      }
      b07Cases.push(mapB07PinCaseEvidence({
        position: pinCase.position,
        requestedStation: pinCase.station,
        layoutTransactions: unexpected.length,
        stateTreeAfter,
        paneListAfter: paneState,
        relationMeasureAfter: railContract.relationMeasure,
        nativeCompositionBefore: nativeBefore,
        nativeCompositionAfter: nativeAfter,
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
      // 최대화 대상 뷰의 native surface 자리를 세 시점에 같은 방법으로 읽는다. 프레임워크
      // 이름을 묻지 않는다 — surface 소유자 해소는 이미 공개면 매퍼가 한다.
      const readPinStageEvidence = (side, stage) => readPinStage(
        rpc,
        win,
        stage,
        async (tree) => {
          const [surface] = await readBrowserSurfaceEvidence(rpc, win, {
            nativeChildWebview,
            implementation,
            plugin,
            tabIds: [tabIds[side]],
            labels: [labels[side]],
          });
          return surface?.rect ?? null;
        },
      );
      for (const maximizeCase of maximizeCases) {
        const stageBaseline = await readPinStageEvidence(maximizeCase.side, `${maximizeCase.name} baseline`);
        must(await rpc("tab.maximize", { tab: tabIds[maximizeCase.side] }, win), `${maximizeCase.name} maximize`);
        must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${maximizeCase.name} settled`);
        const maximized = must(await rpc("layout.arrangement", {}, win), `${maximizeCase.name} arrangement`);
        const persisted = must(await rpc("sidebar.left.position", {}, win), `${maximizeCase.name} persisted pin`);
        const maximizedPanes = must(await rpc("pane.list", {}, win), `${maximizeCase.name} pane.list`);
        // 최대화 station·full rect·저장 PIN 은 전부 값이다 — 던지지 않고 judge 가 이름을 붙인다.
        const stageMaximized = await readPinStageEvidence(maximizeCase.side, `${maximizeCase.name} maximized`);
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
        const stageRestored = await readPinStageEvidence(maximizeCase.side, `${maximizeCase.name} restored`);
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
          stages: {
            baseline: stageBaseline,
            maximized: stageMaximized,
            restored: stageRestored,
          },
        }));
        console.log(`✓ ${maximizeCase.name}: station=${maximized.station} · 저장 PIN=${persisted.leftRailPosition?.station} · surface=${JSON.stringify(stageRestored.surfaceRect)}`);
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
      await writeMachineReport(
        path.join(fastResizeDir, "composition-samples.json"),
        { baseline: fastResize.baseline ?? null, samples: fastResize.samples ?? [] },
      );
      // 단계 원장이 없으면 판정할 것이 없다 — 그때만 멈춘다. 관측면이 답한 합성 판정은
      // 계약 사실이므로 여기서 던지지 않고 B10 증거로 실려 red 로 남는다.
      const resizeGaps = hostileResizeObservationGaps({
        requestedSteps: fastSizes.length,
        resizeSequence: fastResize,
      });
      if (resizeGaps.length) {
        throw new Error(`rapid window resize 관측 불가 — ${resizeGaps.join("; ")}`);
      }
      // 프레임워크 이름으로 가르지 않는다. 어느 프레임워크든 관측면이 코어 계약 봉투를
      // 답해야 하고, 봉투 안의 사실은 B10 판정면이 이름으로 부른다. 여기서 끝내는 것은
      // **봉투 자체가 없는 경우**뿐 — 그때는 판정할 사실이 애초에 없다.
      const shapeless = (fastResize.samples ?? []).filter((sample) => (
        !Array.isArray(sample.observation?.contractViolations)
      ));
      if (shapeless.length) {
        throw new Error(
          "rapid window resize 관측면이 계약 봉투를 답하지 않았다 — "
            + shapeless.map((sample) => `s${sample.step}:${JSON.stringify(sample.observation ?? null)}`)
              .join("; "),
        );
      }
      for (const sample of fastResize.samples ?? []) {
        if (sample.observation.contractViolations.length === 0) continue;
        console.log(
          `${engine}/resize s${sample.step} 관측 계약 위반: `
            + sample.observation.contractViolations.join(","),
        );
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
      const b11PaneContext = {
        nativeChildWebview, implementation, plugin, tabIds, paneIds, labels,
      };
      const b11PaneStages = SCENARIOS.has("scroll")
        ? { baseline: await readB11PaneStage(rpc, win, b11PaneContext, "baseline") }
        : null;
      let b11PaneRequestedDx = null;
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
        if (b11PaneStages) {
          // 요청한 pointer 이동량은 drag 영수증이 답한 값이다 — 하니스가 다시 적으면 두 자리가 갈린다.
          if (direction === "wider") b11PaneRequestedDx = Number(dragged.dx);
          b11PaneStages[direction] = await readB11PaneStage(rpc, win, b11PaneContext, direction);
        }
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
      if (b11PaneStages) {
        // 도장은 두 반쪽을 다 쥔 지금 찍는다. 휠/캡처만 재고 pane resize 뒤에 찍으면 보고서를
        // 읽는 사람이 재지 않은 축까지 증명된 것으로 읽는다.
        const b11Tabs = b11ScrollHalves.map((half, index) => mapB11TabEvidence({
          viewId: half.viewId,
          scroll: half.scroll,
          fullCapture: half.fullCapture,
          paneResize: {
            paneId: paneIds[index],
            // 왼쪽 pane은 tab.open이, 오른쪽 pane은 pane.split side:"right"가 만든 것이다.
            // 이 선언은 판정이 실측 baseline paneX 순서와 맞대 검사한다.
            side: index === 0 ? "left" : "right",
            requestedDx: b11PaneRequestedDx,
            stages: {
              baseline: b11PaneStages.baseline?.[index],
              wider: b11PaneStages.wider?.[index],
              restored: b11PaneStages.restored?.[index],
            },
          },
        }));
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
        frameworkName, nativeChildWebview, implementation, plugin, tabIds, labels, engine,
        gateReportStore,
      });
    }

    const finalPath = path.join(engineEvidence, "final.png");
    await captureWindowSnapshot(rpc, win, finalPath, "final snapshot");
    await observeFrameSequence([finalPath], `${engine}/final`, scale);
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "final-ledger");
    const crossClicks = SCENARIOS.has("flow") ? CYCLES * 2 : 0;
    console.log(`✓ ${engine} evidence collected — 시나리오 ${[...SCENARIOS].join(",")} · 한글 IME 2개 · 교차 클릭 ${crossClicks}회 · ${resizeSummary} · 연속 프레임 ${frameCount}장`);
    // 모든 칸을 잰 뒤에 판정한다. 기준은 그대로다 — 정착하지 않은 표면은 이 엔진을 RED 로 끝낸다.
    SURFACE_SETTLEMENT.assertSettled(engine);
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
    // B12 는 냉시작 실행기의 것이다. 이 실행기는 재지 못한 칸을 차단으로도 적지 않는다.
    gates: browserGatesOwnedBy("slot-freeze"),
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
    // B01 은 view 마다 다른 문서를 요구한다. 그 구간만 자기 문서를 답하고 나머지는 정본이다.
    page = await startHtmlFixture((request) => renderB01IdentityFixture(request) ?? fixtureHtml());
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
