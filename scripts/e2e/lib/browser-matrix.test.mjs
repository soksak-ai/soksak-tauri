// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  browserImplementations,
  fixtureHtml,
  parseBrowserEngines,
  fixtureMarkers,
  fixtureInputMarkers,
  markerEvidence,
  markerPixels,
  unwrapEvalValue,
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
});

describe("공통 브라우저 fixture", () => {
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
