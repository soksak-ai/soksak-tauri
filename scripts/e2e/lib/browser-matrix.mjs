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
      const kind = target[0] === 255 && target[1] === 0 && target[2] === 255 ? "magenta"
        : target[0] === 0 && target[1] === 255 && target[2] === 255 ? "cyan"
          : target[0] === 255 && target[1] === 255 ? "yellow" : "green";
      const hit = kind === "magenta"
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
  let largest = { count: 0, width: 0, height: 0 };
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
    if (count > largest.count) largest = { count, width: (maxX - minX + 1) * step, height: (maxY - minY + 1) * step };
  }
  return { total, largest };
}

export function markerPixels(bytes, hex, tolerance = 24, sampleStep = 1) {
  return markerEvidence(bytes, hex, tolerance, sampleStep).total;
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

/** 세 구현이 같은 문서·같은 입력 사건을 실행하는 정적 fixture. */
export function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Browser Boundary</title>
    <style>
      html,body{margin:0;min-height:100%;background:#10202c;color:#f7f4df;font:24px system-ui}
      main{min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#10202c 0 50%,#e0704f 50%)}
      section{padding:16px;border:8px solid #f7f4df;background:#16394a;box-shadow:20px 20px 0 #10202c;max-width:520px}
      h1{font-size:48px;margin:0 0 8px}p{margin:0 0 20px}
      label{display:grid;gap:8px;font-size:18px}input{box-sizing:border-box;width:100%;font:28px system-ui;padding:10px 12px;border:4px solid #e0704f;background:#fff;color:#10202c}
      #marker{width:160px;height:40px;margin:0 0 16px;background:var(--marker,#ff00ff)}
      #typed-marker{height:24px;margin-top:10px;background:#000}
      output{display:block;min-height:1.4em;margin-top:10px;font-size:18px;color:#f7f4df}
      @media(max-height:520px){h1{font-size:36px}p{font-size:20px;margin-bottom:10px}label{gap:4px}input{font-size:24px;padding:6px 8px}#marker{margin-bottom:10px}output{margin-top:4px}#typed-marker{margin-top:4px}}
    </style></head><body>
    <main><section><h1>Browser Boundary</h1><p>DOM slot ↔ live browser surface</p><div id="marker"></div>
      <label>IME input<input id="ime" autocomplete="off" spellcheck="false"></label>
      <output id="events">beforeinput:0 input:0</output><div id="typed-marker"></div>
    </section></main>
    <script>
      window.__browserFixture = { beforeInput: 0, inputEvents: 0, values: [] };
      const slot = Number(new URLSearchParams(location.search).get("slot") || 0);
      document.documentElement.style.setProperty("--marker", ${JSON.stringify(fixtureMarkers)}[slot] || ${JSON.stringify(fixtureMarkers)}[0]);
      const ime = document.getElementById("ime");
      const events = document.getElementById("events");
      const typedMarker = document.getElementById("typed-marker");
      const render = () => { events.textContent = "beforeinput:" + window.__browserFixture.beforeInput + " input:" + window.__browserFixture.inputEvents; };
      ime.addEventListener("beforeinput", () => { window.__browserFixture.beforeInput += 1; render(); });
      ime.addEventListener("input", () => { window.__browserFixture.inputEvents += 1; window.__browserFixture.values.push(ime.value); typedMarker.style.background=${JSON.stringify(fixtureInputMarkers)}[slot]; render(); });
    </script></body></html>`;
}
