import { decodePng } from "./png.mjs";

export const browserImplementations = Object.freeze({
  browser: Object.freeze({
    plugin: "soksak-plugin-browser-native",
    surface: "framework-native",
  }),
  "browser-chromium": Object.freeze({
    plugin: "soksak-plugin-browser-chromium",
    surface: "engine-windowed",
  }),
  "browser-chromium-offscreen": Object.freeze({
    plugin: "soksak-plugin-browser-chromium-offscreen",
    surface: "engine-offscreen",
  }),
});

export const fixtureMarkers = Object.freeze(["#ff00ff", "#00ffff"]);
export const fixtureInputMarkers = Object.freeze(["#ffff00", "#00ff00"]);
export const fixtureMotionMarkers = Object.freeze(["#00ffff", "#ffff00"]);
export const fixtureMotionMarkerSize = Object.freeze({ width: 12, height: 12 });
export const fixtureInputMarkerSize = Object.freeze({ minWidth: 64, height: 24 });
export const compositorCalibrationMarker = "#0000ff";
export const compositorCalibrationSize = Object.freeze({ width: 40, height: 40 });
// hostile resize의 최소 2-pane viewport에도 잘리지 않는 고정 ruler. 작아지는 반응형 marker가
// 아니라 언제나 같은 64 CSS px이므로 캡처에서 확대/압축된 옛 프레임을 엄격히 검출할 수 있다.
export const fixtureMarkerSize = Object.freeze({ width: 64, height: 40 });

/** window.info는 물리 픽셀, window.snapshot은 구현이 선택한 PNG 픽셀을 반환한다.
 * 두 값을 섞어 deviceScale을 추측하지 않고 실제 산출물의 CSS-px당 PNG-px 배율을 계산한다. */
export function snapshotCssScale(bytes, windowInfo) {
  const image = decodePng(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const deviceScale = Number(windowInfo?.scale);
  const cssWidth = Number(windowInfo?.w) / deviceScale;
  const cssHeight = Number(windowInfo?.h) / deviceScale;
  const x = image.w / cssWidth;
  const y = image.h / cssHeight;
  if (![deviceScale, cssWidth, cssHeight, x, y].every(Number.isFinite)
      || deviceScale <= 0 || cssWidth <= 0 || cssHeight <= 0 || x <= 0 || y <= 0) {
    throw new Error(`snapshot 좌표계 산출 불가: ${JSON.stringify({ image: { w: image.w, h: image.h }, windowInfo })}`);
  }
  if (Math.abs(x - y) > 0.02) {
    throw new Error(`snapshot 비등방 배율: ${x}x${y}`);
  }
  return (x + y) / 2;
}

export function markerEvidence(bytes, hex, tolerance = 24, sampleStep = 1) {
  const image = decodePng(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const target = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const step = Math.max(1, Math.round(sampleStep));
  const gridWidth = Math.ceil(image.w / step);
  const gridHeight = Math.ceil(image.h / step);
  const matches = new Uint8Array(gridWidth * gridHeight);
  let total = 0;
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = gx * step;
      const y = gy * step;
      const i = (y * image.w + x) * image.ch;
      const rgb = image.ch >= 3
        ? [image.px[i], image.px[i + 1], image.px[i + 2]]
        : [image.px[i], image.px[i], image.px[i]];
      // 조명은 표면 위 native/DOM 합성 평면이다. 창이 비활성인 무포커스 캡처에서는 AppKit도
      // 함께 합성하므로 원색의 절대 RGB는 보존되지 않지만 색상 채널의 우세 관계는 보존된다.
      // 큰 marker의 hue를 세면 필요한 focus lighting을 유지하면서도 표면 생존을 판정할 수 있다.
      const [r, g, b] = rgb;
      const kind = target[0] === 0 && target[1] === 0 && target[2] === 255 ? "blue"
        : target[0] === 255 && target[1] === 0 && target[2] === 0 ? "red"
        : target[0] === 255 && target[1] === 0 && target[2] === 255 ? "magenta"
        : target[0] === 0 && target[1] === 255 && target[2] === 255 ? "cyan"
          : target[0] === 255 && target[1] === 255 ? "yellow" : "green";
      const hit = kind === "blue"
        ? b - r >= 64 && b - g >= 64 && Math.abs(r - g) <= tolerance
        : kind === "red"
        ? r - g >= 48 && r - b >= 48 && Math.abs(g - b) <= tolerance * 2
        : kind === "magenta"
        ? r - g >= 48 && b - g >= 48 && Math.abs(r - b) <= tolerance * 2
        : kind === "cyan"
          ? g - r >= 48 && b - r >= 48 && Math.abs(g - b) <= tolerance * 2
          : kind === "yellow"
            ? r - b >= 48 && g - b >= 48 && Math.abs(r - g) <= tolerance * 2
            : g - r >= 48 && g - b >= 48;
      if (hit) {
        matches[gy * gridWidth + gx] = 1;
        total += 1;
      }
    }
  }
  let largest = { count: 0, x: 0, y: 0, width: 0, height: 0 };
  const components = [];
  const stack = [];
  for (let start = 0; start < matches.length; start += 1) {
    if (!matches[start]) continue;
    matches[start] = 0;
    stack.push(start);
    let count = 0;
    let minX = gridWidth, maxX = 0, minY = gridHeight, maxY = 0;
    while (stack.length) {
      const at = stack.pop();
      const x = at % gridWidth;
      const y = Math.floor(at / gridWidth);
      count += 1;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const next of [at - 1, at + 1, at - gridWidth, at + gridWidth]) {
        if (next < 0 || next >= matches.length || !matches[next]) continue;
        const nx = next % gridWidth;
        if (Math.abs(nx - x) > 1) continue;
        matches[next] = 0;
        stack.push(next);
      }
    }
    const component = {
      count,
      x: minX * step,
      y: minY * step,
      width: (maxX - minX + 1) * step,
      height: (maxY - minY + 1) * step,
    };
    components.push(component);
    if (count > largest.count) largest = component;
  }
  components.sort((a, b) => b.count - a.count);
  return { total, largest, components };
}

export function markerPixels(bytes, hex, tolerance = 24, sampleStep = 1) {
  return markerEvidence(bytes, hex, tolerance, sampleStep).total;
}

/** 같은 색의 DOM slot anchor와 페이지 surface marker가 한 프레임에서 같은 x에 있는지 판정한다. */
export function motionMarkerAlignment(bytes, hex, scale, tolerance = 4) {
  const expected = Number(scale) * fixtureMotionMarkerSize.width;
  const candidates = markerEvidence(bytes, hex, 24, 1).components
    .filter((component) =>
      Math.abs(component.width - expected) <= tolerance
      && Math.abs(component.height - expected) <= tolerance)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);
  if (candidates.length !== 2) {
    return { ok: false, errors: [`motion-markers=${candidates.length}/2`], candidates };
  }
  const dx = Math.abs(candidates[0].x - candidates[1].x);
  return {
    ok: dx <= tolerance,
    errors: dx <= tolerance ? [] : [`motion-x=${candidates[0].x}/${candidates[1].x} dx=${dx}`],
    candidates,
  };
}

/** 정사각 DOM ruler의 고유비를 유지한 component만 합성 배율 근거로 쓴다.
 * WindowServer crop이나 네이티브 표면에 일부 가려진 조각은 존재 증거일 뿐 epoch 증거가 아니다. */
export function completeCalibrationComponents(components, tolerance = 4) {
  return components.filter((component) =>
    Math.abs(Number(component.width) - Number(component.height)) <= tolerance);
}

export function parseBrowserEngines(raw) {
  const engines = String(raw ?? Object.keys(browserImplementations).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = engines.filter((engine) => !(engine in browserImplementations));
  if (unknown.length) throw new Error(`지원하지 않는 브라우저 구현: ${unknown.join(", ")}`);
  if (!engines.length) throw new Error("검증할 브라우저 구현이 없습니다");
  return [...new Set(engines)];
}

/**
 * 한 workspace window 안에서 플러그인 view 장부와 실제 엔진 surface 장부가 같은 대상을
 * 가리키는지 판정한다. 엔진의 전역 stats에는 다른 window의 surface도 함께 보이므로 owner를
 * `plugin@window`로 범위화한다. DOM/픽셀 판정 전에 이 연결이 끊겼다면 화면은 우연히 남은
 * 프레임일 뿐 live surface가 아니다.
 */
export function browserSurfaceInvariant({
  surface,
  plugin,
  windowLabel,
  viewIds,
  expectedVisible,
  stats,
}) {
  const errors = [];
  const expectedOwner = `${plugin}@${windowLabel}`;
  const offscreen = surface === "engine-offscreen";
  const engine = offscreen ? stats?.engine : stats;
  const engineSurfaces = Array.isArray(engine?.surfaces) ? engine.surfaces : [];
  const byId = new Map(engineSurfaces.map((item) => [Number(item.id), item]));
  const engineIds = new Set((Array.isArray(engine?.ids) ? engine.ids : []).map(Number));
  const offscreenMap = new Map(
    (Array.isArray(stats?.ids) ? stats.ids : []).map((item) => [item?.viewId, Number(item?.surfaceId)]),
  );
  const mappedIds = [];

  for (let index = 0; index < viewIds.length; index += 1) {
    const viewId = viewIds[index];
    const key = offscreen ? viewId : `chromium-${viewId}`;
    const id = offscreen ? offscreenMap.get(viewId) : Number(stats?.idMap?.[key]);
    if (!Number.isFinite(id)) {
      errors.push(`${viewId}:mapping-missing`);
      continue;
    }
    mappedIds.push(id);
    const live = engineIds.has(id) && byId.has(id);
    if (!live) {
      errors.push(`${viewId}:engine-live-missing:${id}`);
      continue;
    }
    const actual = byId.get(id);
    if (actual.owner !== expectedOwner) errors.push(`${viewId}:owner=${actual.owner}/${expectedOwner}`);
    const visible = expectedVisible[index] === true;
    if (actual.hidden !== !visible) errors.push(`${viewId}:hidden=${actual.hidden}/${!visible}`);
    if (!offscreen && stats?.visibility?.[key] !== visible) {
      errors.push(`${viewId}:plugin-visible=${stats?.visibility?.[key]}/${visible}`);
    }
    if (!offscreen && visible && !actual.bounds) errors.push(`${viewId}:bounds-missing`);
    if (offscreen && actual.resize?.pending === true) errors.push(`${viewId}:resize-pending`);
    if (offscreen && actual.viewport?.matches !== true) errors.push(`${viewId}:viewport-mismatch`);
  }

  const sortedMapped = [...mappedIds].sort((a, b) => a - b);
  const ledger = (Array.isArray(stats?.ledger) ? stats.ledger : []).map(Number).sort((a, b) => a - b);
  if (JSON.stringify(ledger) !== JSON.stringify(sortedMapped)) {
    errors.push(`ledger=${JSON.stringify(ledger)}/mapped=${JSON.stringify(sortedMapped)}`);
  }
  const ownedLive = engineSurfaces
    .filter((item) => item.owner === expectedOwner)
    .map((item) => Number(item.id))
    .sort((a, b) => a - b);
  if (JSON.stringify(ownedLive) !== JSON.stringify(sortedMapped)) {
    errors.push(`owned-live=${JSON.stringify(ownedLive)}/mapped=${JSON.stringify(sortedMapped)}`);
  }
  return { ok: errors.length === 0, errors, mappedIds: sortedMapped };
}

/** 같은 원본 크기에는 언제나 같은 급격한 왕복을 만든다. 마지막 단계는 정확한 원복이다. */
export function hostileWindowResizeSizes(original) {
  const w = Math.round(Number(original.w));
  const h = Math.round(Number(original.h));
  const compact = { w: Math.max(1280, w - 720), h: Math.max(900, h - 440) };
  const wide = { w, h: Math.max(900, h - 360) };
  const tall = { w: Math.max(1400, w - 560), h };
  const mid = { w: Math.max(1360, w - 420), h: Math.max(940, h - 260) };
  const originalSize = { w, h };
  return [
    compact, originalSize, wide, tall, compact, mid, originalSize,
    tall, wide, compact, originalSize, mid, compact, originalSize,
  ].map((size) => ({ ...size }));
}

/** 플러그인 command 봉투의 eval 결과를 구현별 포장 차이 없이 페이지 반환값으로 푼다. */
export function unwrapEvalValue(result) {
  if (result && typeof result === "object" && ("active" in result || "ledger" in result)) return result;
  return result?.value;
}

/** 브라우저 구현 공통 resize 판정. DOM 슬롯과 페이지 viewport는 rounding 외 차이가 없어야 하고,
 * fixed-size marker는 캡처 픽셀에서도 같은 크기여야 한다(옛 프레임 확대/압축 금지). */
export function viewportAlignment({ slot, viewport, marker, markerPixels, scale }) {
  const errors = [];
  for (const key of ["w", "h"]) {
    if (Math.abs(Number(slot[key]) - Number(viewport[key])) > 1) {
      errors.push(`viewport.${key}=${viewport[key]}/slot.${key}=${slot[key]}`);
    }
  }
  const expectedWidth = Number(marker.width) * Number(scale);
  const expectedHeight = Number(marker.height) * Number(scale);
  if (Math.abs(Number(markerPixels.width) - expectedWidth) > 4) {
    errors.push(`marker.width=${markerPixels.width}/${expectedWidth}`);
  }
  if (Math.abs(Number(markerPixels.height) - expectedHeight) > 4) {
    errors.push(`marker.height=${markerPixels.height}/${expectedHeight}`);
  }
  return { ok: errors.length === 0, errors };
}

/** WindowServer가 창 전체의 이전 backing을 한 epoch 재투영한 것과 브라우저 표면만의 stretch를
 * 분리한다. 서로 다른 CSS 크기는 고유 크기로 정규화하고, DOM 기준자끼리 먼저 한 epoch인지 판정한다. */
export function transitionFrameAlignment({ browser, dom }) {
  const errors = [];
  const domEpochs = (Array.isArray(dom) ? dom : [dom]).filter(Boolean);
  const scale = (value, intrinsic) => ({
    width: Number(value.width) / Number(intrinsic.width),
    height: Number(value.height) / Number(intrinsic.height),
  });
  const browserScale = scale(browser, fixtureMarkerSize);
  const domScales = domEpochs.map((value) => scale(value, compositorCalibrationSize));
  const dimensions = (value) => `${Number(value.width)}x${Number(value.height)}`;
  const scaleTolerance = 4 / Math.min(fixtureMarkerSize.width, compositorCalibrationSize.width);
  const first = domScales[0];
  const torn = domScales.find((candidate) =>
    Math.abs(Number(candidate.width) - Number(first?.width)) > scaleTolerance
    || Math.abs(Number(candidate.height) - Number(first?.height)) > scaleTolerance);
  if (first && torn) errors.push(`shell-epoch-tear=${dimensions(first)}/${dimensions(torn)}`);
  const browserMatchesDom = domScales.some((candidate) =>
    Math.abs(browserScale.width - candidate.width) <= scaleTolerance
    && Math.abs(browserScale.height - candidate.height) <= scaleTolerance);
  if (first && !browserMatchesDom) {
    errors.push(`browser-only-stretch=${dimensions(browserScale)}/dom:${dimensions(first)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 세 구현이 같은 문서·같은 입력 사건을 실행하는 정적 fixture. */
export function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Browser Boundary</title>
    <style>
      html,body{margin:0;min-height:100%;background:#10202c;color:#f7f4df;font:24px system-ui}
      main{min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#10202c 0 50%,#e0704f 50%)}
      section{padding:16px;border:8px solid #f7f4df;background:#16394a;box-shadow:20px 20px 0 #10202c;max-width:520px}
      h1{font-size:48px;margin:0 0 8px}p{margin:0 0 20px}
      label{display:grid;gap:8px;font-size:18px}input{box-sizing:border-box;width:100%;font:28px system-ui;padding:10px 12px;border:4px solid #e0704f;background:#fff;color:#10202c}
      #motion-marker{position:fixed;z-index:2147483647;left:0;top:0;width:${fixtureMotionMarkerSize.width}px;height:${fixtureMotionMarkerSize.height}px;background:var(--motion-marker,#00ffff)}
      #marker{width:${fixtureMarkerSize.width}px;height:${fixtureMarkerSize.height}px;margin:0 0 16px;background:var(--marker,#ff00ff)}
      #typed-marker{height:24px;margin-top:10px;background:#000}
      output{display:block;min-height:1.4em;margin-top:10px;font-size:18px;color:#f7f4df}
      @media(max-height:520px){h1{font-size:36px}p{font-size:20px;margin-bottom:10px}label{gap:4px}input{font-size:24px;padding:6px 8px}#marker{margin-bottom:10px}output{margin-top:4px}#typed-marker{margin-top:4px}}
    </style></head><body>
    <div id="motion-marker"></div><main><section><h1>Browser Boundary</h1><p>DOM slot ↔ live browser surface</p><div id="marker"></div>
      <label>IME input<input id="ime" autocomplete="off" spellcheck="false"></label>
      <output id="events">beforeinput:0 input:0</output><div id="typed-marker"></div>
    </section></main>
    <script>
      window.__browserFixture = { beforeInput: 0, inputEvents: 0, values: [] };
      const slot = Number(new URLSearchParams(location.search).get("slot") || 0);
      document.documentElement.style.setProperty("--marker", ${JSON.stringify(fixtureMarkers)}[slot] || ${JSON.stringify(fixtureMarkers)}[0]);
      document.documentElement.style.setProperty("--motion-marker", ${JSON.stringify(fixtureMotionMarkers)}[slot] || ${JSON.stringify(fixtureMotionMarkers)}[0]);
      const ime = document.getElementById("ime");
      const events = document.getElementById("events");
      const typedMarker = document.getElementById("typed-marker");
      const render = () => { events.textContent = "beforeinput:" + window.__browserFixture.beforeInput + " input:" + window.__browserFixture.inputEvents; };
      ime.addEventListener("beforeinput", () => { window.__browserFixture.beforeInput += 1; render(); });
      ime.addEventListener("input", () => { window.__browserFixture.inputEvents += 1; window.__browserFixture.values.push(ime.value); typedMarker.style.background=${JSON.stringify(fixtureInputMarkers)}[slot]; render(); });
    </script></body></html>`;
}
