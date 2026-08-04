// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  browserImplementations,
  browserSurfaceInvariant,
  fixtureHtml,
  parseBrowserEngines,
  fixtureMarkers,
  fixtureInputMarkers,
  fixtureMarkerSize,
  markerEvidence,
  markerPixels,
  hostileWindowResizeSizes,
  unwrapEvalValue,
  viewportAlignment,
  transitionFrameAlignment,
} from "./browser-matrix.mjs";
import { encodePng } from "./png.mjs";

describe("브라우저 구현 행렬", () => {
  it("기본값은 Native·Windowed Chromium·Offscreen Chromium 전부다", () => {
    expect(parseBrowserEngines(undefined)).toEqual([
      "browser",
      "browser-chromium",
      "browser-chromium-offscreen",
    ]);
    expect(Object.keys(browserImplementations)).toEqual(parseBrowserEngines(undefined));
  });

  it("알 수 없는 구현을 조용히 건너뛰지 않는다", () => {
    expect(() => parseBrowserEngines("browser,unknown")).toThrow("지원하지 않는 브라우저 구현");
  });

  it("전체 창 resize는 큰 폭의 양방향 교차를 반복하고 정확히 원복한다", () => {
    const sizes = hostileWindowResizeSizes({ w: 2400, h: 1600 });
    expect(sizes.length).toBeGreaterThanOrEqual(12);
    expect(sizes.at(-1)).toEqual({ w: 2400, h: 1600 });
    const dw = sizes.slice(1).map((size, i) => Math.sign(size.w - sizes[i].w));
    const dh = sizes.slice(1).map((size, i) => Math.sign(size.h - sizes[i].h));
    expect(new Set(dw)).toEqual(new Set([-1, 0, 1]));
    expect(new Set(dh)).toEqual(new Set([-1, 0, 1]));
  });

  it("windowed view→surface→engine 장부가 창 owner·가시성·bounds까지 일치해야 한다", () => {
    expect(browserSurfaceInvariant({
      surface: "engine-windowed",
      plugin: "soksak-plugin-browser-chromium",
      windowLabel: "w-a",
      viewIds: ["tab-left", "tab-right"],
      expectedVisible: [true, true],
      stats: {
        ids: [11, 12, 90],
        idMap: { "chromium-tab-left": 11, "chromium-tab-right": 12 },
        ledger: [11, 12],
        visibility: { "chromium-tab-left": true, "chromium-tab-right": true },
        surfaces: [
          { id: 11, owner: "soksak-plugin-browser-chromium@w-a", hidden: false, bounds: { x: 1, y: 2, w: 300, h: 200 } },
          { id: 12, owner: "soksak-plugin-browser-chromium@w-a", hidden: false, bounds: { x: 301, y: 2, w: 300, h: 200 } },
          { id: 90, owner: "soksak-plugin-browser-chromium@w-b", hidden: false },
        ],
      },
    })).toEqual({ ok: true, errors: [], mappedIds: [11, 12] });
  });

  it("offscreen의 죽은 surface 매핑·타 창 owner·pending resize를 모두 RED로 만든다", () => {
    const verdict = browserSurfaceInvariant({
      surface: "engine-offscreen",
      plugin: "soksak-plugin-browser-chromium-offscreen",
      windowLabel: "w-a",
      viewIds: ["tab-left", "tab-right"],
      expectedVisible: [true, true],
      stats: {
        ids: [
          { viewId: "tab-left", surfaceId: 3 },
          { viewId: "tab-right", surfaceId: 7 },
        ],
        ledger: [3, 7],
        engine: {
          ids: [7],
          surfaces: [{
            id: 7,
            owner: "soksak-plugin-browser-chromium-offscreen@w-b",
            hidden: false,
            resize: { pending: true },
            viewport: { matches: false },
          }],
        },
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("tab-left:engine-live-missing:3");
    expect(verdict.errors.join("\n")).toContain("tab-right:owner");
    expect(verdict.errors.join("\n")).toContain("tab-right:resize-pending");
    expect(verdict.errors.join("\n")).toContain("tab-right:viewport-mismatch");
  });
});

describe("공통 브라우저 fixture", () => {
  it("DOM viewport와 fixed marker가 슬롯·캡처에 rounding-only로 착지해야 한다", () => {
    expect(viewportAlignment({
      slot: { w: 608, h: 262 },
      viewport: { w: 608, h: 262 },
      marker: fixtureMarkerSize,
      markerPixels: { width: 128, height: 80 },
      scale: 2,
    })).toEqual({ ok: true, errors: [] });
    expect(viewportAlignment({
      slot: { w: 900, h: 400 },
      viewport: { w: 608, h: 262 },
      marker: fixtureMarkerSize,
      markerPixels: { width: 474, height: 122 },
      scale: 2,
    }).ok).toBe(false);
  });

  it("창 합성 epoch의 전역 배율과 브라우저 고유 stretch를 구분한다", () => {
    expect(transitionFrameAlignment({
      browser: { width: 96, height: 60 },
      dom: { width: 96, height: 60 },
    })).toEqual({ ok: true, errors: [] });
    expect(transitionFrameAlignment({
      browser: { width: 96, height: 60 },
      dom: { width: 128, height: 80 },
    }).ok).toBe(false);
  });

  it("평탄/중첩 eval 봉투를 같은 페이지 반환값으로 푼다", () => {
    const page = { value: "한글", active: true, ledger: { inputEvents: 1 } };
    expect(unwrapEvalValue(page)).toEqual(page);
    expect(unwrapEvalValue({ value: page, viewId: "tab-1" })).toEqual(page);
  });

  it("엔진 중립 신원과 실제 편집 요소·입력 사건 장부를 제공한다", () => {
    const html = fixtureHtml();
    expect(html).toContain("Browser Boundary");
    expect(html).not.toContain("Native Boundary");
    expect(html).toContain('id="ime"');
    expect(html).toContain("beforeinput");
    expect(html).toContain("inputEvents");
    expect(html).toContain('id="marker"');
    expect(html).toContain('id="typed-marker"');
    expect(html).toContain(fixtureInputMarkers[0]);
    expect(html).toContain(`width:${fixtureMarkerSize.width}px;height:${fixtureMarkerSize.height}px`);
    expect(html).toContain("@media(max-height:520px)");
  });

  it("무포커스 조명 합성 뒤에도 marker hue를 표면 생존 증거로 센다", () => {
    const px = Buffer.alloc(20 * 20 * 3, 0);
    for (let i = 0; i < 120; i += 1) {
      px[i * 3] = 117;
      px[i * 3 + 1] = 25;
      px[i * 3 + 2] = 123;
    }
    const png = encodePng({ w: 20, h: 20, ch: 3, px });
    expect(markerPixels(png, fixtureMarkers[0])).toBe(120);
    expect(markerPixels(png, fixtureMarkers[1])).toBe(0);
  });

  it("밝기만 비슷한 무채색은 marker로 오인하지 않는다", () => {
    const px = Buffer.alloc(20 * 20 * 3, 117);
    const png = encodePng({ w: 20, h: 20, ch: 3, px });
    expect(markerPixels(png, fixtureMarkers[0])).toBe(0);
    expect(markerPixels(png, fixtureMarkers[1])).toBe(0);
  });

  it("DOM compositor 기준자의 순수 파랑을 별도 연결 성분으로 센다", () => {
    const px = Buffer.alloc(80 * 50 * 3, 0);
    for (let y = 5; y < 45; y += 1) for (let x = 8; x < 72; x += 1) px[(y * 80 + x) * 3 + 2] = 255;
    const evidence = markerEvidence(encodePng({ w: 80, h: 50, ch: 3, px }), "#0000ff");
    expect(evidence.largest).toEqual({ count: 2560, width: 64, height: 40 });
  });

  it("흩어진 장식 픽셀과 넓게 이어진 fixture marker를 구분한다", () => {
    const px = Buffer.alloc(180 * 50 * 3, 0);
    for (let y = 10; y < 34; y += 1) for (let x = 20; x < 160; x += 1) {
      const at = (y * 180 + x) * 3;
      px[at] = 255; px[at + 2] = 255;
    }
    const evidence = markerEvidence(encodePng({ w: 180, h: 50, ch: 3, px }), fixtureMarkers[0]);
    expect(evidence.largest.width).toBe(140);
    expect(evidence.largest.height).toBe(24);
  });
});
