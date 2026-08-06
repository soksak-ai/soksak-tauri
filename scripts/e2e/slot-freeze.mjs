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
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { openClient, requireSocket, must } from "./lib/client.mjs";
import { acquireFixtureWindow, releaseFixtureWindow } from "./lib/fixtureWindow.mjs";
import { closeHtmlFixture, startHtmlFixture } from "./lib/http-fixture.mjs";
import { decodePng } from "./lib/png.mjs";
import {
  browserImplementations,
  browserSurfaceInvariant,
  fixtureHtml,
  fixtureInputMarkers,
  fixtureInputMarkerSize,
  fixtureMotionMarkers,
  compositorCalibrationMarker,
  fixtureMarkerSize,
  fixtureMarkerRowVerdict,
  rendererTopologyOwnershipVerdict,
  fixtureMarkers,
  hostileWindowResizeSizes,
  markerEvidence,
  motionMarkerAlignment,
  numericCompositionTraceVerdict,
  layoutTransactionVerdict,
  parseBrowserEngines,
  snapshotCssScale,
  selectFixtureMarkerComponent,
  unwrapEvalValue,
  viewportAlignment,
  transitionFrameAlignment,
  completeCalibrationComponents,
  calibrationFrameScale,
  summarizeFrameSequence,
} from "./lib/browser-matrix.mjs";

const SOCKET = requireSocket();
const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "slot-freeze");
const EVIDENCE_ROOT = path.join(os.homedir(), ".soksak-e2e", "evidence", "slot-freeze", "current");
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
const FRAMES_PER_CLICK = 48;
const PIN_FRAMES_PER_CLICK = 24;
const FAST_RESIZE_FRAMES = 64;
const MARKER_SAMPLE_STEP = 2;
// 장식의 동색 픽셀 합계가 아니라 넓고 이어진 fixture 직사각형 하나를 요구한다.
const MIN_MARKER_WIDTH = 100;
const MIN_MARKER_HEIGHT = 16;
const MIN_MARKER_COMPONENT = 200;
const IME_TEXTS = ["한글 입력 왼쪽", "한글 입력 오른쪽"];
const CHROME_MARKERS = Object.freeze({
  railAdd: "#ff0000",
  rightSidebar: "#00ff00",
  modalOverlayProbe: "#ff00ff",
});
const PRESENTATION_MARKERS = Object.freeze(["#00ff80", "#ff0080"]);

function prepareEvidence() {
  const boundary = path.join(os.homedir(), ".soksak-e2e", "evidence") + path.sep;
  const resolved = path.resolve(EVIDENCE_ROOT);
  if (!(`${resolved}${path.sep}`).startsWith(boundary)) throw new Error(`증거 경로 경계 위반: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

const addressForTab = (tree, tabId) => {
  const token = `/tab/${tabId}/`;
  const node = (tree.nodes ?? []).find((item) => item.nodePath === "surface" && item.address.includes(token));
  if (!node?.address) throw new Error(`탭 content surface 주소가 노출되지 않았다: ${tabId}`);
  return node.address;
};

const motionAddressForTab = (tree, tabId) => {
  const token = `/tab/${tabId}/`;
  const node = (tree.nodes ?? []).find((item) => item.nodePath === "toolbar" && item.address.includes(token));
  if (!node?.address) throw new Error(`탭의 영속 content toolbar 주소가 노출되지 않았다: ${tabId}`);
  return node.address;
};

const activationAddressForTab = (tree, tabId) => {
  const node = (tree.nodes ?? []).find(
    (item) => item.nodePath === `tab/view/${tabId}`,
  );
  if (!node?.address) throw new Error(`탭 활성화 주소가 노출되지 않았다: ${tabId}`);
  return node.address;
};

const paneAddress = (tree, paneId) => {
  const node = (tree.nodes ?? []).find((item) => item.nodePath === `layout/pane/${paneId}`);
  if (!node?.address) throw new Error(`pane 공개 DOM 주소가 노출되지 않았다: ${paneId}`);
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
  const errors = [];
  const surfaces = data.surfaces ?? [];
  if (!surfaces.length) errors.push("surface:none");
  for (const surface of surfaces) {
    if (surface.layerContentsRedrawPolicy !== 2)
      errors.push(`${surface.label ?? surface.ptr}:redraw=${surface.layerContentsRedrawPolicy}/2`);
    if (surface.layerContentsPlacement !== 11)
      errors.push(`${surface.label ?? surface.ptr}:placement=${surface.layerContentsPlacement}/11`);
    if (surface.autoresizingMask !== 0)
      errors.push(`${surface.label ?? surface.ptr}:autoresizing=${surface.autoresizingMask}/0`);
  }
  if (errors.length) throw new Error(`${stage}: Tauri surface resize policy 불일치 — ${errors.join(", ")}`);
}

async function assertWindowedComposition(rpc, win, plugin, tabIds, addresses) {
  const stats = must(await rpc(`plugin.${plugin}.stats`, {}, win), "windowed stats");
  const surfaces = new Map((stats.surfaces ?? []).map((surface) => [surface.id, surface]));
  const errors = [];
  const mappedIds = Object.values(stats.idMap ?? {}).filter(Number.isFinite).sort((a, b) => a - b);
  const liveLedger = (stats.ledger ?? []).filter((id) => surfaces.has(id)).sort((a, b) => a - b);
  if (JSON.stringify(liveLedger) !== JSON.stringify(mappedIds)) {
    errors.push(`surface ownership mapped=${JSON.stringify(mappedIds)} liveLedger=${JSON.stringify(liveLedger)}`);
  }
  for (let index = 0; index < tabIds.length; index += 1) {
    const id = stats.idMap?.[`chromium-${tabIds[index]}`];
    const surface = surfaces.get(id);
    const measured = must(await rpc("ui.measure", { address: addresses[index] }, win), `measure ${tabIds[index]}`);
    const expected = measured.rect;
    const actual = surface?.bounds;
    if (!actual) { errors.push(`${tabIds[index]}:surface/bounds missing`); continue; }
    for (const key of ["x", "y", "w", "h"]) {
      if (Math.abs(Number(actual[key]) - Math.round(Number(expected[key]))) > 1) {
        errors.push(`${tabIds[index]}:${key}=${actual[key]}/${expected[key]}`);
      }
    }
  }
  if (errors.length) throw new Error(`windowed composition 불일치 — ${errors.join(", ")}`);
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

function assertFrameMarkers(file, name, scale, {
  requireInput = true,
  compareDomEpoch = false,
  slots = [0, 1],
} = {}) {
  const bytes = fs.readFileSync(file);
  const domEvidence = compareDomEpoch
    ? completeCalibrationComponents(markerEvidence(bytes, compositorCalibrationMarker, 24, MARKER_SAMPLE_STEP)
      .components.filter((component) => component.count >= MIN_MARKER_COMPONENT && component.width >= 40 && component.height >= MIN_MARKER_HEIGHT))
    : null;
  if (compareDomEpoch && !domEvidence.length) {
    throw new Error(`${name}: DOM compositor calibration 소실(${JSON.stringify(domEvidence)})`);
  }
  const frameScale = compareDomEpoch
    ? calibrationFrameScale(domEvidence) ?? scale
    : scale;
  const kinds = [["page", fixtureMarkers]];
  if (requireInput) kinds.push(["input", fixtureInputMarkers]);
  for (const [kind, markers] of kinds) {
    for (const slot of slots) {
      const expectedWidth = (kind === "input" ? fixtureInputMarkerSize.minWidth : fixtureMarkerSize.width) * frameScale;
      const expectedHeight = (kind === "input" ? fixtureInputMarkerSize.height : fixtureMarkerSize.height) * frameScale;
      const raw = markerEvidence(bytes, markers[slot], 24, MARKER_SAMPLE_STEP);
      const selected = selectFixtureMarkerComponent(raw.components, {
        expectedWidth,
        expectedHeight,
        minWidth: kind === "input",
        tolerance: 4,
        minCount: MIN_MARKER_COMPONENT,
      });
      if (!selected) {
        throw new Error(`${name}: slot ${slot} ${kind} marker 소실(${JSON.stringify(raw.largest)})`);
      }
      const evidence = { ...selected, width: selected.bodyWidth, height: selected.bodyHeight };
      if (kind === "page" && compareDomEpoch) {
        const aligned = transitionFrameAlignment({ browser: evidence, dom: domEvidence });
        if (!aligned.ok) throw new Error(`${name}: compositor epoch 불일치 — ${aligned.errors.join(", ")}`);
      } else if (kind === "page" && scale) {
        const aligned = viewportAlignment({
          slot: { w: 1, h: 1 }, viewport: { w: 1, h: 1 },
          marker: fixtureMarkerSize, markerPixels: evidence, scale,
        });
        if (!aligned.ok) throw new Error(`${name}: slot ${slot} stale-frame stretch — ${aligned.errors.join(", ")}`);
      }
    }
  }
}

function assertFrameMotion(file, name, scale) {
  const bytes = fs.readFileSync(file);
  for (let slot = 0; slot < fixtureMotionMarkers.length; slot += 1) {
    const verdict = motionMarkerAlignment(bytes, fixtureMotionMarkers[slot], scale);
    if (!verdict.ok) {
      throw new Error(`${name}: slot ${slot} DOM/surface 궤적 불일치 — ${verdict.errors.join(", ")}`);
    }
    const expected = 12 * scale;
    const motion = markerEvidence(bytes, fixtureMotionMarkers[slot], 16, 1).components.filter((component) =>
      Math.abs(component.width - expected) <= 4 && Math.abs(component.height - expected) <= 4);
    const renderer = markerEvidence(bytes, PRESENTATION_MARKERS[slot], 16, 1).components.filter((component) =>
      Math.abs(component.width - expected) <= 4 && Math.abs(component.height - expected) <= 4);
    if (renderer.length !== 1) {
      throw new Error(`${name}: slot ${slot} plugin renderer 기준자 ${renderer.length}/1`);
    }
    // renderer probe는 toolbar controls와 겹치지 않도록 local x=16에 둔다. pane 원점 비교로 환산한다.
    const rendererX = renderer[0].x - 16 * scale;
    const split = motion.filter((component) => Math.abs(component.x - rendererX) > 4);
    if (split.length) {
      throw new Error(
        `${name}: slot ${slot} projection/renderer/page 삼자 불일치 — renderer-x=${rendererX} motion-x=${motion.map((item) => item.x).join("/")}`,
      );
    }
  }
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

function assertChromeAnchor(file, name, color, scale) {
  const expected = 12 * scale;
  const components = markerEvidence(fs.readFileSync(file), color, 16, 1).components.filter((component) =>
    Math.abs(component.width - expected) <= 4 && Math.abs(component.height - expected) <= 4);
  if (!components.length) throw new Error(`${name}: chrome anchor ${color} 소실`);
}

function assertChromeAnchorWithin(file, name, color, scale, point) {
  const expected = 12 * scale;
  const expectedX = point.x * scale;
  const expectedY = point.y * scale;
  const components = markerEvidence(fs.readFileSync(file), color, 16, 1).components.filter((component) =>
    Math.abs(component.width - expected) <= 4
    && Math.abs(component.height - expected) <= 4
    && Math.abs(component.x - expectedX) <= 4
    && Math.abs(component.y - expectedY) <= 4);
  if (!components.length) {
    throw new Error(`${name}: DOM overlay anchor ${color}가 native surface 위에서 소실`);
  }
}

async function assertCaptureInstrumentationCleared(rpc, win) {
  const anchors = must(await rpc("capture.motion-anchors", { anchors: [] }, win), "capture anchors cleanup");
  const calibration = must(await rpc("capture.calibration", { visible: false }, win), "capture calibration cleanup");
  if (anchors.count !== 0 || anchors.visible || calibration.visible) {
    throw new Error(`capture instrumentation 잔류: ${JSON.stringify({ anchors, calibration })}`);
  }
}

/**
 * 녹화는 사람이 보는 개발 증거다. 프레임을 분석해 진단 JSON을 남기지만, 이 결과로
 * E2E를 GREEN/RED 판정하지 않는다. 발견한 결함은 별도 공개 좌표/거래 불변식으로 옮겨야 한다.
 */
function observeFrameSequence(files, name, scale, options = {}) {
  const observations = files.map((file) => {
    const errors = [];
    try { assertFrameMarkers(file, path.join(name, path.basename(file)), scale, options); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    let motionDx = 0;
    if (options.motion) {
      try { assertFrameMotion(file, path.join(name, path.basename(file)), scale); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      const bytes = fs.readFileSync(file);
      for (const color of fixtureMotionMarkers) {
        const verdict = motionMarkerAlignment(bytes, color, scale);
        if (Number.isFinite(verdict.dx)) motionDx = Math.max(motionDx, verdict.dx);
      }
    }
    const bytes = fs.readFileSync(file);
    const frameScale = options.compareDomEpoch
      ? calibrationFrameScale(markerEvidence(bytes, compositorCalibrationMarker, 24, MARKER_SAMPLE_STEP).components) ?? scale
      : scale;
    for (const chrome of options.chromeAnchors ?? []) {
      try { assertChromeAnchor(file, path.join(name, path.basename(file)), chrome, frameScale); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    return { frame: path.basename(file), errors, motionDx };
  });
  const verdict = summarizeFrameSequence(observations);
  const report = { kind: "human-visual-evidence", automatedVerdict: false, name, ...verdict };
  if (files[0]) {
    fs.writeFileSync(
      path.join(path.dirname(files[0]), "visual-diagnostics.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(`◉ ${name}: 녹화 ${files.length}장 시각 증거 저장(자동 판정 안 함)`);
  return verdict;
}

const nodeAddress = (tree, nodePath) => {
  const node = (tree.nodes ?? []).find((item) => item.nodePath === nodePath);
  if (!node?.address) throw new Error(`공개 DOM 주소 누락: ${nodePath}`);
  return node.address;
};

async function assertFocusLighting(rpc, win, addresses, activeIndex, stage) {
  const luminance = [];
  for (let index = 0; index < addresses.length; index += 1) {
    const measured = must(await rpc("ui.measure", { address: addresses[index] }, win), `${stage} lighting slot ${index}`);
    const rect = measured.rect;
    const pixels = must(await rpc("window.pixels", {
      rect: { x: rect.x + rect.w - 36, y: rect.y + 12, w: 24, h: 24 },
      settle: false,
    }, win), `${stage} lighting pixels ${index}`);
    luminance.push(Number(pixels.luminance));
  }
  const active = luminance[activeIndex];
  const inactive = luminance[activeIndex === 0 ? 1 : 0];
  const ratio = inactive / active;
  if (![active, inactive, ratio].every(Number.isFinite) || active <= 0 || ratio < 0.35 || ratio > 0.65) {
    throw new Error(`${stage}: focus lighting 픽셀 불일치 active=${active} inactive=${inactive} ratio=${ratio}`);
  }
  return { active, inactive, ratio };
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
  return { railZ, lightingZ, relationZ, relation: relation.dataset };
}

async function assertChromeOverlayContract(rpc, win, engineEvidence, scale) {
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
  const sidebarRect = chromeMeasures.get("sidebar/right").rect;
  const overlappingSurface = (tree.nodes ?? [])
    .filter((node) => node.nodePath === "surface" && node.rect)
    .map((node) => node.rect)
    .find((rect) =>
      Math.min(sidebarRect.x + sidebarRect.w, rect.x + rect.w) - Math.max(sidebarRect.x, rect.x) > 48
      && Math.min(sidebarRect.y + sidebarRect.h, rect.y + rect.h) - Math.max(sidebarRect.y, rect.y) > 48);
  if (!overlappingSurface) {
    throw new Error(`오른쪽 overlay sidebar와 겹치는 browser surface가 없다: ${JSON.stringify(sidebarRect)}`);
  }
  const sidebarProbePoint = {
    x: Math.max(sidebarRect.x, overlappingSurface.x) + 24,
    y: Math.max(sidebarRect.y, overlappingSurface.y) + 24,
  };
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
  fs.writeFileSync(path.join(engineEvidence, "chrome-overlay-contract.json"), `${JSON.stringify({
    sidebarRect,
    overlappingSurface,
    sidebarProbePoint,
    anchors: anchorState.anchors,
  }, null, 2)}\n`);
  const before = path.join(engineEvidence, "chrome-overlay.png");
  must(await rpc("window.snapshot", { path: before }, win), "chrome overlay snapshot");
  assertChromeAnchor(before, `${path.basename(engineEvidence)}/chrome-overlay`, CHROME_MARKERS.railAdd, scale);
  assertChromeAnchorWithin(
    before,
    `${path.basename(engineEvidence)}/chrome-overlay`,
    CHROME_MARKERS.rightSidebar,
    scale,
    sidebarProbePoint,
  );

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
  const surfaceAddresses = (modalTree.nodes ?? [])
    .filter((node) => node.nodePath === "surface" && typeof node.address === "string")
    .map((node) => node.address);
  let surfaceRect;
  for (const address of surfaceAddresses) {
    const measured = must(await rpc("ui.measure", { address }, win), "modal overlap surface measure");
    const overlapW = Math.min(
      measuredModalCard.rect.x + measuredModalCard.rect.w,
      measured.rect.x + measured.rect.w,
    ) - Math.max(measuredModalCard.rect.x, measured.rect.x);
    const overlapH = Math.min(
      measuredModalCard.rect.y + measuredModalCard.rect.h,
      measured.rect.y + measured.rect.h,
    ) - Math.max(measuredModalCard.rect.y, measured.rect.y);
    if (overlapW > 48 && overlapH > 48) {
      surfaceRect = measured.rect;
      break;
    }
  }
  if (!surfaceRect) throw new Error("모달과 겹칠 browser surface가 공개 DOM에서 발견되지 않았다");
  const probePoint = {
    x: Math.max(surfaceRect.x, measuredModalCard.rect.x) + 24,
    y: Math.max(surfaceRect.y, measuredModalCard.rect.y) + 24,
  };
  const modalAnchorState = must(await rpc("capture.motion-anchors", {
    anchors: [{
      address: modalCard,
      color: CHROME_MARKERS.modalOverlayProbe,
      x: probePoint.x - measuredModalCard.rect.x,
      y: probePoint.y - measuredModalCard.rect.y,
    }],
  }, win), "modal overlay probe");
  fs.writeFileSync(path.join(engineEvidence, "chrome-project-modal-contract.json"), `${JSON.stringify({
    modalRect: measuredModal.rect,
    modalCardRect: measuredModalCard.rect,
    surfaceRect,
    probePoint,
    anchors: modalAnchorState.anchors,
  }, null, 2)}\n`);
  const modalPath = path.join(engineEvidence, "chrome-project-modal.png");
  must(await rpc("window.snapshot", { path: modalPath }, win), "project modal snapshot");
  assertChromeAnchorWithin(
    modalPath,
    `${path.basename(engineEvidence)}/chrome-project-modal`,
    CHROME_MARKERS.modalOverlayProbe,
    scale,
    probePoint,
  );
  must(await rpc("ui.input.click", { address: close }, win), "project modal close");
  must(await rpc("project.rightbar.toggle", { open: false }, win), "right sidebar close");
  must(
    await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
    "chrome overlay cleanup settled",
  );
  return { railAdd, rightSidebar, modalPath };
}

function assertSentinelMarkers(file, name, scale) {
  const bytes = fs.readFileSync(file);
  for (const [kind, marker] of [["page", fixtureMarkers[0]], ["input", fixtureInputMarkers[0]]]) {
    const evidence = markerEvidence(bytes, marker, 24, MARKER_SAMPLE_STEP).largest;
    const expectedWidth = (kind === "input" ? fixtureInputMarkerSize.minWidth : fixtureMarkerSize.width) * scale;
    const expectedHeight = (kind === "input" ? fixtureInputMarkerSize.height : fixtureMarkerSize.height) * scale;
    if (evidence.count < MIN_MARKER_COMPONENT
        || evidence.width < expectedWidth - 4
        || evidence.height < expectedHeight - 4) {
      throw new Error(`${name}: sentinel ${kind} marker 소실(${JSON.stringify(evidence)})`);
    }
  }
}

async function assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale, file, name) {
  must(await rpc("window.snapshot", { path: file }, win), `${name} snapshot`);
  const bytes = fs.readFileSync(file);
  const errors = [];
  for (let index = 0; index < tabIds.length; index += 1) {
    const measured = must(await rpc("ui.measure", { address: addresses[index] }, win), `${name} slot ${index}`);
    const result = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabIds[index],
      js: "const r=document.querySelector('#marker')?.getBoundingClientRect(); return { viewport:{w:innerWidth,h:innerHeight}, marker:r&&{width:r.width,height:r.height} };",
    }, win), `${name} viewport ${index}`);
    const page = unwrapEvalValue(result);
    const rawMarkerPixels = markerEvidence(bytes, fixtureMarkers[index], 24, MARKER_SAMPLE_STEP).largest;
    const markerPixels = {
      ...rawMarkerPixels,
      width: rawMarkerPixels.bodyWidth,
      height: rawMarkerPixels.bodyHeight,
    };
    const verdict = viewportAlignment({
      slot: measured.rect,
      viewport: page?.viewport ?? {},
      marker: page?.marker ?? {},
      markerPixels,
      scale,
    });
    if (!verdict.ok) errors.push(`${tabIds[index]}:${verdict.errors.join("|")}`);
  }
  if (errors.length) throw new Error(`${name}: resize composition 불일치 — ${errors.join(", ")}`);
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
  if (afterY < 479 || afterY > 481) {
    throw new Error(`${tabId}: 실제 wheel 전진량 불일치 ${JSON.stringify({ before, afterY })}`);
  }
  must(await rpc("window.snapshot", { tab: tabId, path: evidencePath }, win), `scroll snapshot ${tabId}`);
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
  const result = must(await rpc(`plugin.${plugin}.capture.full`, {
    viewId: tabId, path: outputPath,
  }, win, { timeoutMs: 40_000 }), `capture.full ${tabId}`);
  if (!fs.existsSync(outputPath) || Number(result.bytes) !== fs.statSync(outputPath).size) {
    throw new Error(`${tabId}: full capture 파일/바이트 불일치 ${JSON.stringify(result)}`);
  }
  const bytes = fs.readFileSync(outputPath);
  const image = decodePng(bytes);
  const width = Number(result.width);
  const height = Number(result.height);
  const xScale = image.w / width;
  const yScale = image.h / height;
  const tail = markerEvidence(bytes, "#ff8000", 24, 2).components
    .find((component) => component.width >= 100 && component.height >= 40 && component.y >= image.h * 0.75);
  const identity = fixtureMarkerRowVerdict(markerEvidence(bytes, identityMarker, 24, 1).components, {
    scale: (xScale + yScale) / 2,
  });
  if (!(height > 1400 && image.h > image.w && Math.abs(xScale - yScale) <= 0.03 && tail && identity.ok)) {
    throw new Error(`${tabId}: full capture 문서 기하/단일성 불일치 ${JSON.stringify({ result, image: { w: image.w, h: image.h }, xScale, yScale, identity })}`);
  }
  return { path: outputPath, bytes: result.bytes, width, height, pngWidth: image.w, pngHeight: image.h };
}

async function assertImePersisted(rpc, win, plugin, tabIds, stage) {
  for (let index = 0; index < tabIds.length; index += 1) {
    const result = must(await rpc(`plugin.${plugin}.eval`, {
      viewId: tabIds[index],
      js: "const el=document.querySelector('#ime'); return { value:el?.value, ledger:window.__browserFixture };",
    }, win), `${stage} IME ${index}`);
    const value = unwrapEvalValue(result);
    if (value?.value !== IME_TEXTS[index] || value?.ledger?.values?.at?.(-1) !== IME_TEXTS[index]) {
      throw new Error(`${stage}: ${tabIds[index]} IME 상태 소실 ${JSON.stringify(value)}`);
    }
  }
}

async function runEngine(client, page, engine) {
  const implementation = browserImplementations[engine];
  const plugin = implementation.plugin;
  const engineEvidence = path.join(EVIDENCE_ROOT, engine);
  fs.mkdirSync(engineEvidence, { recursive: true });
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
      sentinelWin = (await acquireFixtureWindow(rpc, sentinelRoot)).label;
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
    const acquired = await acquireFixtureWindow(rpc, FIXTURE_ROOT);
    win = acquired.label;
    console.log(`\n[${engine}] 픽스처 창: ${win}${acquired.adopted ? " (재사용)" : " (생성)"}`);
    frameworkName = String(must(await rpc("framework.info", {}, win), "framework.info").framework ?? "");
    if (frameworkName !== "tauri" && frameworkName !== "electron") {
      throw new Error(`검증하지 않은 framework adapter: ${frameworkName}`);
    }
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
    if (tabIds.some((id) => typeof id !== "string")) throw new Error(`브라우저 탭 id 누락: ${JSON.stringify(tabIds)}`);
    if (paneIds.some((id) => typeof id !== "string")) throw new Error(`브라우저 pane id 누락: ${JSON.stringify(paneIds)}`);
    must(await rpc("sidebar.left.position", { mode: "flow" }, win), "sidebar flow");

    for (let index = 0; index < tabIds.length; index += 1) {
      const tabId = tabIds[index];
      must(await rpc("tab.activate", { tab: tabId }, win), `tab.activate ${tabId}`);
      must(await rpc(`plugin.${plugin}.navigate`, { viewId: tabId, url: `${page.url}?slot=${index}` }, win), `navigate ${tabId}`);
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
      await verifyIme(rpc, win, plugin, tabId, IME_TEXTS[index]);
      if (SCENARIOS.has("scroll")) {
        const scroll = await verifyScrollInput(
          rpc, win, plugin, tabId, path.join(engineEvidence, `scroll-${index}.png`),
        );
        fs.writeFileSync(
          path.join(engineEvidence, `scroll-${index}.json`),
          `${JSON.stringify(scroll, null, 2)}\n`,
        );
        const full = await verifyFullCapture(
          rpc, win, plugin, tabId, path.join(engineEvidence, `full-${index}.png`), fixtureMarkers[index],
        );
        fs.writeFileSync(
          path.join(engineEvidence, `full-${index}.json`),
          `${JSON.stringify(full, null, 2)}\n`,
        );
      }
      // tab.open + pane.split은 두 view를 먼저 선언하므로 엔진도 둘을 병렬 생성할 수 있다.
      // 부분 prefix를 기대하지 않고 선언된 전체 view 집합과 엔진 장부의 일대일성을 검사한다.
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `create-${index}`);
    }

    const tree = must(await rpc("ui.tree", {}, win), "ui.tree");
    const addresses = tabIds.map((id) => addressForTab(tree, id));
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
    const labels = tabIds.map((id) => `b-${win}-${id}`);
    if (frameworkName === "tauri") await installPanePresentationMarkers(rpc, win, labels);
    if (native) {
      const initial = must(await rpc("webview.composition", {}, win), "initial composition");
      assertTauriSurfaceResizePolicy(initial, "initial native composition");
      assertPaneComposition(
        must(await rpc("webview.pane.composition", {}, win), "initial pane composition"),
        labels,
      );
    } else if (windowed) {
      const initial = must(await rpc("webview.composition", {}, win), "initial windowed composition");
      assertTauriSurfaceResizePolicy(initial, "initial windowed composition");
    }
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "first-paint-ledger");
    must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "first paint layout settled");
    const firstPaintPath = path.join(engineEvidence, "first-paint.png");
    must(await rpc("window.snapshot", { path: firstPaintPath }, win), "first paint snapshot");
    const scale = snapshotCssScale(fs.readFileSync(firstPaintPath), originalWindow);
    assertFrameMarkers(firstPaintPath, `${engine}/first-paint`, scale);

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
      must(await rpc("window.snapshot", { path: sentinelPath }, sentinelWin), "cross-window sentinel snapshot");
      const sentinelInfo = must(await rpc("window.info", {}, sentinelWin), "cross-window sentinel info");
      const sentinelScale = snapshotCssScale(fs.readFileSync(sentinelPath), sentinelInfo);
      assertSentinelMarkers(sentinelPath, `${engine}/cross-window-sentinel`, sentinelScale);
    }

    let frameCount = 0;
    const numericTraceFailures = [];
    await assertActivePane(rpc, win, paneIds[1], "교차 클릭 시작 상태");
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "cross-click-initial-right");
    for (let cycle = 0; cycle < (SCENARIOS.has("flow") ? CYCLES : 0); cycle += 1) {
      for (let side = 0; side < addresses.length; side += 1) {
        const name = `${String(cycle * 2 + side + 1).padStart(2, "0")}-${side ? "right" : "left"}`;
        const dir = path.join(engineEvidence, name);
        const trace = implementation.surface === "engine-offscreen"
          ? must(await rpc(
            `plugin.${plugin}.surface.trace.start`,
            { durationMs: 800 },
            win,
          ), `합성 수치 trace 무장 ${name}`)
          : null;
        const journalBefore = must(await rpc("layout.transactions", {}, win), `layout journal baseline ${name}`);
        const priorEntries = journalBefore.entries ?? [];
        const afterSequence = Number(priorEntries[priorEntries.length - 1]?.sequence ?? 0);
        const clicked = must(await rpc("ui.input.click", {
          address: activationAddresses[side], recordDir: dir, recordFrames: FRAMES_PER_CLICK,
          recordIntervalMs: 16, recordLeadMs: 32,
        }, win, { timeoutMs: 60_000 }), `교차 클릭 ${name}`);
        const captured = Number(clicked.recording?.frames ?? 0);
        if (captured !== FRAMES_PER_CLICK) throw new Error(`${name}: 캡처 ${captured}/${FRAMES_PER_CLICK}`);
        const files = fs.readdirSync(dir).filter((file) => /^f\d{4}\.png$/.test(file)).sort();
        if (files.length !== FRAMES_PER_CLICK) throw new Error(`${name}: PNG ${files.length}/${FRAMES_PER_CLICK}`);
        await assertActivePane(rpc, win, paneIds[side], name);
        must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${name} layout settled`);
        const journalAfter = must(await rpc("layout.transactions", {}, win), `layout journal verdict ${name}`);
        const layoutVerdict = layoutTransactionVerdict(journalAfter.entries, {
          afterSequence,
          candidateViewIds: tabIds,
          // 비전면 Tauri의 WebKit timeline은 정지할 수 있으므로 그 경우 공개 거래는 snap이다.
          // 다른 구현/전면 창은 glide이며, 판정기는 실제 trace의 유한 motion 유무를 분류한다.
          expectedMode: frameworkName === "tauri" ? "snap" : "glide",
        });
        fs.writeFileSync(
          path.join(dir, "layout-transaction.json"),
          `${JSON.stringify({ afterSequence, entries: layoutVerdict.transactions, verdict: layoutVerdict }, null, 2)}\n`,
        );
        if (!layoutVerdict.ok) {
          throw new Error(`${engine}/${name}: sidebar/tab layout transaction mismatch — ${layoutVerdict.errors.join(", ")}`);
        }
        if (trace) {
          const observed = must(await rpc(
            `plugin.${plugin}.surface.trace.read`,
            { traceId: trace.traceId },
            win,
            { timeoutMs: 10_000 },
          ), `합성 수치 trace 판독 ${name}`);
          const verdict = numericCompositionTraceVerdict(observed.samples);
          fs.writeFileSync(
            path.join(dir, "composition-trace.json"),
            `${JSON.stringify({ traceId: trace.traceId, samples: observed.samples, verdict }, null, 2)}\n`,
          );
          if (!verdict.ok) {
            const failure = `${engine}/${name}: DOM/native presentation trace 불일치 `
              + `compared=${verdict.compared} maxDelta=${verdict.maxDelta} — ${verdict.errors.join(", ")}`;
            numericTraceFailures.push(failure);
            console.error(`RED ${failure}`);
          }
        }
        observeFrameSequence(
          files.map((file) => path.join(dir, file)),
          `${engine}/${name}`,
          scale,
          { motion: true, chromeAnchors: [CHROME_MARKERS.railAdd] },
        );
        frameCount += files.length;

        const lighting = await assertFocusLighting(rpc, win, addresses, side, `${engine}/${name}`);
        await assertRailCompositionContract(
          rpc,
          win,
          railAddress,
          paneIds[side],
          `${engine}/${name}`,
        );

        if (native) {
          assertPaneComposition(
            must(await rpc("webview.pane.composition", {}, win), `pane composition ${name}`),
            labels,
          );
          assertNativeLighting(must(await rpc("webview.surfaces", {}, win), `surfaces ${name}`), labels[side], labels);
        } else if (windowed) {
          await assertWindowedComposition(rpc, win, plugin, tabIds, addresses);
        }
        await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `cross-click-${name}`);
        console.log(`✓ ${name}: ${FRAMES_PER_CLICK} frames · 두 live marker · focus ratio ${lighting.ratio.toFixed(3)} · ${native ? "DOM/native exact" : windowed ? "DOM/CEF exact" : "DOM/native-offscreen exact"}`);
      }
    }
    if (numericTraceFailures.length) {
      throw new Error(`합성 수치 trace RED ${numericTraceFailures.length}건\n${numericTraceFailures.join("\n")}`);
    }

    // PIN 계약 — 사이드바와 분할 rect는 포커스 클릭의 입력이 아니다. station 0에서 오른쪽
    // 인접/비인접을, station 50에서 왼쪽 인접을 각각 실제 클릭·동일 tick trace·PNG로 검증한다.
    const pinCases = SCENARIOS.has("pin") ? [
      { station: 0, side: 0, relationSide: "right", connected: true, name: "pin-right-adjacent" },
      { station: 0, side: 1, relationSide: "detached", connected: false, name: "pin-detached" },
      { station: 50, side: 0, relationSide: "left", connected: true, name: "pin-left-adjacent" },
    ] : [];
    for (const pinCase of pinCases) {
      must(await rpc("sidebar.left.position", { mode: "pin", station: pinCase.station }, win), `${pinCase.name} set pin`);
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${pinCase.name} pin settled`);
      const before = must(await rpc("layout.arrangement", {}, win), `${pinCase.name} arrangement before`);
      const journalBefore = must(await rpc("layout.transactions", {}, win), `${pinCase.name} transaction baseline`);
      const priorEntries = journalBefore.entries ?? [];
      const afterSequence = Number(priorEntries[priorEntries.length - 1]?.sequence ?? 0);
      const rectsBefore = await Promise.all([railAddress, ...paneAddresses].map(async (address) => ({
        address,
        rect: must(await rpc("ui.measure", { address }, win), `${pinCase.name} rect before`).rect,
      })));
      const nativeBefore = native
        ? must(await rpc("webview.composition", {}, win), `${pinCase.name} native before`)
        : null;
      const dir = path.join(engineEvidence, pinCase.name);
      const clicked = must(await rpc("ui.input.click", {
        address: activationAddresses[pinCase.side],
        recordDir: dir,
        recordFrames: PIN_FRAMES_PER_CLICK,
        recordIntervalMs: 16,
        recordLeadMs: 32,
      }, win, { timeoutMs: 60_000 }), `${pinCase.name} click`);
      const files = fs.readdirSync(dir).filter((file) => /^f\d{4}\.png$/.test(file)).sort();
      if (Number(clicked.recording?.frames ?? 0) !== PIN_FRAMES_PER_CLICK || files.length !== PIN_FRAMES_PER_CLICK) {
        throw new Error(`${pinCase.name}: 캡처 ${files.length}/${PIN_FRAMES_PER_CLICK}`);
      }
      const rectsAfter = await Promise.all([railAddress, ...paneAddresses].map(async (address) => ({
        address,
        rect: must(await rpc("ui.measure", { address }, win), `${pinCase.name} rect after`).rect,
      })));
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
      fs.writeFileSync(
        path.join(dir, "pin-layout-transaction.json"),
        `${JSON.stringify({ afterSequence, unexpected, verdict: pinTrace }, null, 2)}\n`,
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
      const stateRelation = paneState.railRelation;
      if (!stateRelation
          || stateRelation.placement !== "pin"
          || stateRelation.connected !== pinCase.connected
          || stateRelation.side !== pinCase.relationSide) {
        throw new Error(`${pinCase.name}: 공개 relation 판정 불일치 ${JSON.stringify(stateRelation)}`);
      }
      await assertRailCompositionContract(rpc, win, railAddress, paneIds[pinCase.side], pinCase.name, {
        connected: pinCase.connected,
        side: pinCase.relationSide,
        placement: "pin",
      });
      observeFrameSequence(
        files.map((file) => path.join(dir, file)),
        `${engine}/${pinCase.name}`,
        scale,
        { motion: false, chromeAnchors: [CHROME_MARKERS.railAdd] },
      );
      if (native && nativeBefore) {
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
      must(await rpc("sidebar.left.position", { mode: "pin", station: 50 }, win), "pin maximize station");
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "pin maximize station settled");
      const restoredBaseline = must(await rpc("layout.arrangement", {}, win), "pin maximize baseline");
      const maximizeCases = [
        { side: 0, station: 100, relationSide: "left", name: "pin-maximize-left" },
        { side: 1, station: 0, relationSide: "right", name: "pin-maximize-right" },
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
        if (persisted.leftRailPosition?.mode !== "pin" || persisted.leftRailPosition?.station !== 50) {
          throw new Error(`${maximizeCase.name}: 최대화가 저장 PIN을 변경 ${JSON.stringify(persisted.leftRailPosition)}`);
        }
        await assertRailCompositionContract(rpc, win, railAddress, paneIds[maximizeCase.side], maximizeCase.name, {
          connected: true,
          side: maximizeCase.relationSide,
          placement: "pin",
        });
        const screenshot = path.join(engineEvidence, `${maximizeCase.name}.png`);
        must(await rpc("window.snapshot", { path: screenshot }, win), `${maximizeCase.name} snapshot`);
        assertFrameMarkers(screenshot, `${engine}/${maximizeCase.name}`, scale, { slots: [maximizeCase.side] });
        must(await rpc("tab.restore", {}, win), `${maximizeCase.name} restore`);
        must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), `${maximizeCase.name} restore settled`);
        const restored = must(await rpc("layout.arrangement", {}, win), `${maximizeCase.name} restored arrangement`);
        if (restored.station !== 50 || JSON.stringify(restored.cells) !== JSON.stringify(restoredBaseline.cells)) {
          throw new Error(`${maximizeCase.name}: 복원이 PIN/분할을 바꿈 ${JSON.stringify({ baseline: restoredBaseline, restored })}`);
        }
        console.log(`✓ ${maximizeCase.name}: station=${maximizeCase.station} · 저장 PIN=50 · 복원 동일`);
      }
    }
    must(await rpc("sidebar.left.position", { mode: "flow" }, win), "restore sidebar flow after pin contract");
    must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "flow restore settled");

    if (SCENARIOS.size === 1 && (SCENARIOS.has("pin") || SCENARIOS.has("scroll"))) {
      const finalPath = path.join(engineEvidence, "pin-final.png");
      must(await rpc("window.snapshot", { path: finalPath }, win), "pin final snapshot");
      if (native) {
        const finalComposition = must(await rpc("webview.composition", {}, win), "pin final composition");
        fs.writeFileSync(
          path.join(engineEvidence, "pin-final-composition.json"),
          `${JSON.stringify(finalComposition, null, 2)}\n`,
        );
      }
      assertFrameMarkers(finalPath, `${engine}/pin-final`, scale);
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "pin-final-ledger");
      console.log(SCENARIOS.has("pin")
        ? `✓ ${engine} PIN GREEN — 좌·우 결합 + 비인접 독립 보더 · 연속 프레임 ${frameCount}장`
        : `✓ ${engine} SCROLL GREEN — 실제 wheel 2개 탭 0→480→0 · 탭 지정 viewport/full 캡처 각 2장`);
      return frameCount;
    }

    // 전체 창 경계 resize — 녹화를 먼저 열고 큰 폭의 축소/확대를 짧은 간격으로 반복한다.
    // 요청 단계는 native affine 계약을 수치 판정하고, 유한 시퀀스 정착 뒤 live DOM/native를
    // 판정한다. 브라우저가 병합할 수 있는 중간 DOM paint를 요청마다 강제하지 않는다.
    const fastResizeDir = path.join(engineEvidence, "resize-window-fast");
    const fastSizes = hostileWindowResizeSizes(originalWindow);
    const fastResize = must(await rpc("window.resizeSequence", {
      sizes: fastSizes,
      intervalMs: 8,
      recordDir: fastResizeDir,
      recordFrames: FAST_RESIZE_FRAMES,
      recordIntervalMs: 16,
    }, win, { timeoutMs: 60_000 }), "rapid window resize");
    const fastFiles = fs.readdirSync(fastResizeDir).filter((file) => /^f\d{4}\.png$/.test(file)).sort();
    if (Number(fastResize.steps) !== fastSizes.length || Number(fastResize.frames) !== FAST_RESIZE_FRAMES || fastFiles.length !== FAST_RESIZE_FRAMES) {
      throw new Error(`rapid window resize 거래 누락: ${JSON.stringify(fastResize)} PNG=${fastFiles.length}`);
    }
    if (Number(fastResize.resizeElapsedMs) > 4_000) {
      throw new Error(`rapid window resize 응답 정지: ${fastResize.resizeElapsedMs}ms/${fastSizes.length}단계`);
    }
    fs.writeFileSync(
      path.join(fastResizeDir, "composition-samples.json"),
      `${JSON.stringify(fastResize.samples ?? [], null, 2)}\n`,
    );
    if (native) {
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
    observeFrameSequence(
      fastFiles.map((file) => path.join(fastResizeDir, file)),
      `${engine}/window-fast`,
      scale,
      { requireInput: false, compareDomEpoch: true, chromeAnchors: [CHROME_MARKERS.railAdd] },
    );
    must(await rpc("capture.calibration", { visible: false }, win), "DOM compositor calibration hide");
    frameCount += fastFiles.length;
    must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }), "window resize final layout settled");
    if (native) {
      assertPaneComposition(
        must(await rpc("webview.pane.composition.wait", { settleTimeoutMs: 8_000 }, win, { timeoutMs: 12_000 }),
          "window resize final pane composition"),
        labels,
      );
    }
    await assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale,
      path.join(engineEvidence, "resize-window-restored.png"), `${engine}/window-restored`);
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "window-resize-restored");
    await assertImePersisted(rpc, win, plugin, tabIds, "window-resize-restored");

    // 탭 패널 경계 resize — 실제 gutter pointer path를 양방향으로 움직이고 전 구간을 캡처한다.
    const resizeTree = must(await rpc("ui.tree", { rects: true }, win), "resize ui.tree");
    const gutter = (resizeTree.nodes ?? []).find((node) =>
      String(node.nodePath ?? "").startsWith("gutter/") && Number(node.rect?.h) > Number(node.rect?.w) * 4,
    );
    if (!gutter?.address) throw new Error("세로 pane gutter가 노출되지 않았다");
    for (const [direction, dx] of [["wider", 80], ["restored", -80]]) {
      const dir = path.join(engineEvidence, `resize-pane-${direction}`);
      const dragged = must(await rpc("ui.input.drag", {
        from: gutter.address, dx, steps: 12, durationMs: 240,
        recordDir: dir, recordFrames: FRAMES_PER_CLICK, recordIntervalMs: 16,
      }, win, { timeoutMs: 60_000 }), `pane resize ${direction}`);
      const files = fs.readdirSync(dir).filter((file) => /^f\d{4}\.png$/.test(file)).sort();
      if (Number(dragged.recording?.frames ?? 0) !== FRAMES_PER_CLICK || files.length !== FRAMES_PER_CLICK) {
        throw new Error(`pane resize ${direction}: 캡처 ${files.length}/${FRAMES_PER_CLICK}`);
      }
      observeFrameSequence(
        files.map((file) => path.join(dir, file)),
        `${engine}/pane-${direction}`,
        scale,
        { chromeAnchors: [CHROME_MARKERS.railAdd] },
      );
      must(await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
        `pane resize ${direction} layout settled`);
      if (native) {
        const composition = must(await rpc(
          "webview.pane.composition.wait",
          { settleTimeoutMs: 8_000 },
          win,
          { timeoutMs: 12_000 },
        ), `pane resize ${direction} composition settled`);
        assertPaneComposition(composition, labels);
        fs.writeFileSync(
          path.join(engineEvidence, `resize-pane-${direction}-composition.json`),
          `${JSON.stringify(composition, null, 2)}\n`,
        );
      }
      await assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale,
        path.join(engineEvidence, `resize-pane-${direction}.png`), `${engine}/pane-${direction}`);
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `pane-resize-${direction}`);
      frameCount += files.length;
    }

    await assertChromeOverlayContract(rpc, win, engineEvidence, scale);

    const finalPath = path.join(engineEvidence, "final.png");
    must(await rpc("window.snapshot", { path: finalPath }, win), "final snapshot");
    assertFrameMarkers(finalPath, `${engine}/final`, scale);
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "final-ledger");
    console.log(`✓ ${engine} GREEN — 한글 IME 2개 · 교차 클릭 ${CYCLES * 2}회 · 급격한 창 resize ${fastSizes.length}단계/${fastResize.resizeElapsedMs}ms · 패널 resize 왕복 · 연속 프레임 ${frameCount}장`);
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
  prepareEvidence();
  const client = await openClient(SOCKET);
  const page = await startHtmlFixture(() => fixtureHtml());
  let frames = 0;
  try {
    for (const engine of ENGINES) frames += await runEngine(client, page, engine);
    console.log(`\n✓ browser-matrix GREEN — ${ENGINES.length}개 구현 · 한글 IME ${ENGINES.length * 2}개 · 프레임 ${frames}장`);
    console.log(`증거: ${EVIDENCE_ROOT}`);
  } finally {
    client.close();
    await closeHtmlFixture(page.server);
  }
}

await main().catch((error) => {
  console.error(`✗ browser-matrix RED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
