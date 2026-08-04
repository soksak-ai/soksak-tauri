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
import {
  browserImplementations,
  browserSurfaceInvariant,
  fixtureHtml,
  fixtureInputMarkers,
  compositorCalibrationMarker,
  fixtureMarkerSize,
  fixtureMarkers,
  hostileWindowResizeSizes,
  markerEvidence,
  parseBrowserEngines,
  unwrapEvalValue,
  viewportAlignment,
  transitionFrameAlignment,
} from "./lib/browser-matrix.mjs";

const SOCKET = requireSocket();
const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "slot-freeze");
const EVIDENCE_ROOT = path.join(os.homedir(), ".soksak-e2e", "evidence", "slot-freeze", "current");
const ENGINES = parseBrowserEngines(process.env.BROWSER_ENGINES ?? process.env.BROWSER_ENGINE);
const CYCLES = 3;
const FRAMES_PER_CLICK = 48;
const FAST_RESIZE_FRAMES = 64;
const MARKER_SAMPLE_STEP = 2;
// 장식의 동색 픽셀 합계가 아니라 넓고 이어진 fixture 직사각형 하나를 요구한다.
const MIN_MARKER_WIDTH = 100;
const MIN_MARKER_HEIGHT = 16;
const MIN_MARKER_COMPONENT = 200;
const IME_TEXTS = ["한글 입력 왼쪽", "한글 입력 오른쪽"];

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

function assertNativeLighting(data, activeLabel, labels) {
  const surfaces = new Map((data.engine?.surfaces ?? []).map((surface) => [surface.label, surface]));
  const errors = [];
  for (const label of labels) {
    const surface = surfaces.get(label);
    const expected = label === activeLabel ? 0 : 0.5;
    if (!surface) { errors.push(`${label}:missing`); continue; }
    if (surface.dim !== expected) errors.push(`${label}:requested=${surface.dim}/${expected}`);
    const lighting = surface.lighting ?? {};
    if (lighting.appliedAlpha !== expected) errors.push(`${label}:applied=${lighting.appliedAlpha}/${expected}`);
    if (!lighting.frameMatchesSurface) errors.push(`${label}:frame`);
    if (!lighting.siblingOrder?.veilAboveSurface) errors.push(`${label}:stack`);
  }
  if (errors.length) throw new Error(`native lighting 불일치 — ${errors.join(", ")}`);
}

function assertNativeComposition(data, labels, beforeWrites) {
  const errors = ["missing", "misplaced", "stacked"].flatMap((key) =>
    (data.verdict?.[key] ?? []).map((item) => `${key}:${JSON.stringify(item)}`),
  );
  if (data.engine?.preservesContentDuringLiveResize !== false) {
    errors.push(`window:preservesContentDuringLiveResize=${data.engine?.preservesContentDuringLiveResize}`);
  }
  const placements = new Map((data.placement ?? []).map((item) => [item.label, item]));
  for (const label of labels) {
    const placement = placements.get(label);
    if (!placement?.opened || !placement.slotPresent) errors.push(`placement:${label}:not-open-or-no-slot`);
    if (placement?.syncPending || placement?.precommitPending) errors.push(`placement:${label}:pending`);
    if (placement?.desiredVisible !== placement?.appliedVisible) errors.push(`placement:${label}:visibility`);
    if (beforeWrites.has(label)) {
      const delta = Number(placement?.boundsWrites ?? 0) - Number(beforeWrites.get(label));
      if (delta < 0 || delta > 1) errors.push(`placement:${label}:boundsWrites+${delta}`);
    }
  }
  if (errors.length) throw new Error(`native composition 불일치 — ${errors.join(", ")}`);
  return new Map((data.placement ?? []).map((item) => [item.label, Number(item.boundsWrites ?? 0)]));
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

function assertFrameMarkers(file, name, scale, { requireInput = true, compareDomEpoch = false } = {}) {
  const bytes = fs.readFileSync(file);
  const domEvidence = compareDomEpoch
    ? markerEvidence(bytes, compositorCalibrationMarker, 24, MARKER_SAMPLE_STEP).largest
    : null;
  if (compareDomEpoch && (domEvidence.count < MIN_MARKER_COMPONENT || domEvidence.width < 40 || domEvidence.height < MIN_MARKER_HEIGHT)) {
    throw new Error(`${name}: DOM compositor calibration 소실(${JSON.stringify(domEvidence)})`);
  }
  const kinds = [["page", fixtureMarkers]];
  if (requireInput) kinds.push(["input", fixtureInputMarkers]);
  for (const [kind, markers] of kinds) {
    for (let slot = 0; slot < markers.length; slot += 1) {
      const evidence = markerEvidence(bytes, markers[slot], 24, MARKER_SAMPLE_STEP).largest;
      if (evidence.count < MIN_MARKER_COMPONENT || evidence.width < (compareDomEpoch ? 40 : MIN_MARKER_WIDTH) || evidence.height < MIN_MARKER_HEIGHT) {
        throw new Error(`${name}: slot ${slot} ${kind} marker 소실(${JSON.stringify(evidence)})`);
      }
      if (kind === "page" && compareDomEpoch) {
        const aligned = transitionFrameAlignment({ browser: evidence, dom: domEvidence });
        if (!aligned.ok) throw new Error(`${name}: slot ${slot} browser-only stretch — ${aligned.errors.join(", ")}`);
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

function assertSentinelMarkers(file, name) {
  const bytes = fs.readFileSync(file);
  for (const [kind, marker] of [["page", fixtureMarkers[0]], ["input", fixtureInputMarkers[0]]]) {
    const evidence = markerEvidence(bytes, marker, 24, MARKER_SAMPLE_STEP).largest;
    if (evidence.count < MIN_MARKER_COMPONENT || evidence.width < MIN_MARKER_WIDTH || evidence.height < MIN_MARKER_HEIGHT) {
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
    const markerPixels = markerEvidence(bytes, fixtureMarkers[index], 24, MARKER_SAMPLE_STEP).largest;
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
    await rpc(`plugin.${plugin}.input.type`, { viewId: tabId, selector: "#ime", text }, win),
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
        selector: "#ime", timeoutMs: 8_000, viewId: sentinelTabId,
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
    must(await rpc("program.wait", { id: engine, timeoutMs: 20_000 }, win), `program.wait ${engine}`);
    const calibration = must(
      await rpc("capture.calibration", { visible: true }, win),
      "DOM compositor calibration show",
    );
    if (!calibration.visible || calibration.rect?.w !== 64 || calibration.rect?.h !== 40) {
      throw new Error(`DOM compositor calibration 계약 불일치: ${JSON.stringify(calibration)}`);
    }
    const originalWindow = must(await rpc("window.info", {}, win), "window.info");
    const scale = Number(originalWindow.scale ?? 1);
    must(await rpc("plugin.settings.set", { id: plugin, key: "homeUrl", value: page.url, scope: "project" }, win), "fixture homeUrl");
    homeOverride = true;

    const panes = must(await rpc("pane.list", {}, win), "pane.list").panes ?? [];
    if (!panes.length) must(await rpc("space.create", {}, win), "space.create");
    const left = must(await rpc("tab.open", { program: engine }, win), "left tab.open");
    const right = must(await rpc("pane.split", { side: "right", program: engine }, win), "right pane.split");
    const tabIds = [left.tabId, right.tabId];
    if (tabIds.some((id) => typeof id !== "string")) throw new Error(`브라우저 탭 id 누락: ${JSON.stringify(tabIds)}`);
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
          { selector: "#ime", timeoutMs: 8_000, viewId: tabId },
          win,
          { timeoutMs: 30_000 },
        ),
        `browser ready ${tabId}`,
      );
      const identity = must(await rpc(`plugin.${plugin}.dom.text`, { selector: "h1", viewId: tabId }, win), `browser identity ${tabId}`);
      if (identity.text !== "Browser Boundary") throw new Error(`${tabId}: 페이지 신원 불일치(${JSON.stringify(identity.text)})`);
      await verifyIme(rpc, win, plugin, tabId, IME_TEXTS[index]);
      // tab.open + pane.split은 두 view를 먼저 선언하므로 엔진도 둘을 병렬 생성할 수 있다.
      // 부분 prefix를 기대하지 않고 선언된 전체 view 집합과 엔진 장부의 일대일성을 검사한다.
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `create-${index}`);
    }

    const tree = must(await rpc("ui.tree", {}, win), "ui.tree");
    const addresses = tabIds.map((id) => addressForTab(tree, id));
    const native = implementation.surface === "framework-native";
    const windowed = implementation.surface === "engine-windowed";
    const labels = tabIds.map((id) => `b-${win}-${id}`);
    let writes = new Map();
    let baselineReady = false;
    if (native) {
      const initial = must(await rpc("webview.composition", {}, win), "initial composition");
      writes = new Map((initial.placement ?? []).map((item) => [item.label, Number(item.boundsWrites ?? 0)]));
      assertTauriSurfaceResizePolicy(initial, "initial native composition");
    } else if (windowed) {
      const initial = must(await rpc("webview.composition", {}, win), "initial windowed composition");
      assertTauriSurfaceResizePolicy(initial, "initial windowed composition");
    }
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "first-paint-ledger");
    const firstPaintPath = path.join(engineEvidence, "first-paint.png");
    must(await rpc("window.snapshot", { path: firstPaintPath }, win), "first paint snapshot");
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
      assertSentinelMarkers(sentinelPath, `${engine}/cross-window-sentinel`);
    }

    let frameCount = 0;
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      for (let side = 0; side < addresses.length; side += 1) {
        const name = `${String(cycle * 2 + side + 1).padStart(2, "0")}-${side ? "right" : "left"}`;
        const dir = path.join(engineEvidence, name);
        const clicked = must(await rpc("ui.input.click", {
          address: addresses[side], recordDir: dir, recordFrames: FRAMES_PER_CLICK,
          recordIntervalMs: 16, recordLeadMs: 700,
        }, win, { timeoutMs: 60_000 }), `교차 클릭 ${name}`);
        const captured = Number(clicked.recording?.frames ?? 0);
        if (captured !== FRAMES_PER_CLICK) throw new Error(`${name}: 캡처 ${captured}/${FRAMES_PER_CLICK}`);
        const files = fs.readdirSync(dir).filter((file) => /^f\d{4}\.png$/.test(file)).sort();
        if (files.length !== FRAMES_PER_CLICK) throw new Error(`${name}: PNG ${files.length}/${FRAMES_PER_CLICK}`);
        for (const file of files) assertFrameMarkers(path.join(dir, file), `${engine}/${name}/${file}`, scale);
        frameCount += files.length;

        if (native) {
          const current = must(await rpc("webview.composition", {}, win), `composition ${name}`);
          writes = assertNativeComposition(current, labels, baselineReady ? writes : new Map());
          baselineReady = true;
          assertNativeLighting(must(await rpc("webview.surfaces", {}, win), `surfaces ${name}`), labels[side], labels);
        } else if (windowed) {
          await assertWindowedComposition(rpc, win, plugin, tabIds, addresses);
        }
        await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `cross-click-${name}`);
        console.log(`✓ ${name}: ${FRAMES_PER_CLICK} frames · 두 live marker · ${native ? "DOM/native exact" : windowed ? "DOM/CEF exact" : "DOM/native-offscreen exact"}`);
      }
    }

    // 전체 창 경계 resize — 녹화를 먼저 열고 큰 폭의 축소/확대를 짧은 간격으로 반복한다.
    // 최종 정합만 맞고 도중에 blank/stale/hang이면 프레임 생존 또는 거래 시간에서 RED다.
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
    // 최소 높이에서는 입력 아래의 상태 marker가 정상적으로 viewport 밖에 놓일 수 있다. 전이 중에는
    // 상단의 고정 ruler로 live frame을 판정하고, 원복 직후 실제 input 값·event ledger를 다시 읽는다.
    for (const file of fastFiles) assertFrameMarkers(
      path.join(fastResizeDir, file), `${engine}/window-fast/${file}`, scale,
      { requireInput: false, compareDomEpoch: true },
    );
    must(await rpc("capture.calibration", { visible: false }, win), "DOM compositor calibration hide");
    frameCount += fastFiles.length;
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
      for (const file of files) assertFrameMarkers(path.join(dir, file), `${engine}/pane-${direction}/${file}`, scale);
      await assertViewportComposition(rpc, win, plugin, tabIds, addresses, scale,
        path.join(engineEvidence, `resize-pane-${direction}.png`), `${engine}/pane-${direction}`);
      await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, `pane-resize-${direction}`);
      frameCount += files.length;
    }

    const finalPath = path.join(engineEvidence, "final.png");
    must(await rpc("window.snapshot", { path: finalPath }, win), "final snapshot");
    assertFrameMarkers(finalPath, `${engine}/final`, scale);
    await assertEngineSurfaceLedger(rpc, win, implementation, tabIds, "final-ledger");
    console.log(`✓ ${engine} GREEN — 한글 IME 2개 · 교차 클릭 ${CYCLES * 2}회 · 급격한 창 resize ${fastSizes.length}단계/${fastResize.resizeElapsedMs}ms · 패널 resize 왕복 · 연속 프레임 ${frameCount}장`);
    return frameCount;
  } finally {
    if (win && homeOverride) {
      await rpc("plugin.settings.reset", { id: plugin, key: "homeUrl", scope: "project" }, win).catch(() => {});
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

main().catch((error) => {
  console.error(`✗ browser-matrix RED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
