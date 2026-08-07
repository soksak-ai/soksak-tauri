// @vitest-environment node
// Electron screen 좌표는 플랫폼별 계약이다. 전역 DIP에 scaleFactor를 곱한 값을 모든 OS의
// screen physical 좌표라고 부르지 않는다.
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const { createDisplayGeometry } = require_("../../frameworks/electron/displayGeometry.cjs");

describe("Electron display geometry", () => {
  it("Windows screen physical rect는 Electron의 dipToScreenRect 결과를 그대로 사용한다", () => {
    const display = {
      id: 8,
      scaleFactor: 1.25,
      bounds: { x: 1920, y: 0, width: 1536, height: 864 },
    };
    const dipToScreenRect = vi.fn(() => ({ x: 2400, y: 13, width: 627, height: 502 }));
    const screen = { getDisplayMatching: () => display, dipToScreenRect };
    const geometry = createDisplayGeometry({ screen, platform: "win32" });
    const win = {};
    const snapshot = geometry.snapshot(win, { x: 1920, y: 10, width: 502, height: 402 });
    const physical = geometry.rectToPhysical(
      win,
      { x: 1920, y: 10, width: 502, height: 402 },
      snapshot,
    );

    expect(snapshot).toMatchObject({ id: 8, scaleFactor: 1.25 });
    expect(physical).toEqual({
      coordinateSpace: "screen-physical",
      method: "electron.screen.dipToScreenRect",
      rect: { x: 2400, y: 13, width: 627, height: 502 },
    });
    expect(dipToScreenRect).toHaveBeenCalledWith(
      win,
      { x: 1920, y: 10, width: 502, height: 402 },
    );
  });

  it("macOS는 display-local임을 밝히고 분수 모서리 기준으로만 물리 rect를 계산한다", () => {
    const display = {
      id: 2,
      scaleFactor: 1.25,
      bounds: { x: 1000, y: 20, width: 1200, height: 900 },
    };
    const geometry = createDisplayGeometry({
      screen: { getDisplayMatching: () => display },
      platform: "darwin",
    });
    const snapshot = geometry.snapshot({}, { x: 1000.48, y: 20.48, width: 502, height: 402 });

    expect(geometry.rectToPhysical(
      {},
      { x: 1000.48, y: 20.48, width: 502, height: 402 },
      snapshot,
    )).toEqual({
      coordinateSpace: "display-local-physical",
      method: "display-local-edge-rounding",
      rect: { x: 1, y: 1, width: 627, height: 502 },
    });
  });

  it("Wayland는 지원되지 않는 전역 physical rect를 지어내지 않는다", () => {
    const display = {
      id: 4,
      scaleFactor: 1.5,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
    };
    const geometry = createDisplayGeometry({
      screen: { getDisplayMatching: () => display },
      platform: "linux",
      sessionType: "wayland",
    });
    const snapshot = geometry.snapshot({}, { x: 0, y: 0, width: 800, height: 600 });

    expect(geometry.rectToPhysical({}, { x: 0, y: 0, width: 800, height: 600 }, snapshot)).toEqual({
      coordinateSpace: "unavailable",
      method: "unsupported-wayland",
      rect: null,
    });
  });
});

// 규칙 — 모듈 평가 중에 프레임워크를 만지지 않는다.
//
// Electron 의 `screen` 은 app 'ready' 전에 만지면 던진다. createDisplayGeometry 가 인자를
// 받자마자 `screen.getDisplayMatching` 을 확인해서, main.cjs 가 모듈 평가 중 그것을 부르는
// 순간 앱이 적재조차 못 했다 — 실측 2026-08-08:
// `Error: The 'screen' module can't be used before the app 'ready' event`
// 로 Electron 이 뜨지 못했고, 인수의 절반이 통째로 측정 불가였다.
//
// 계약은 그대로다(screen 이 그 능력을 답해야 한다). 확인 시점만 실제로 쓰는 자리로 옮긴다.
describe("screen 계약 확인 시점", () => {
  it("만들 때는 screen 을 만지지 않는다", () => {
    let touched = 0;
    const screen = new Proxy({}, { get() { touched += 1; return () => ({}); } });
    createDisplayGeometry({ screen });
    expect(touched).toBe(0);
  });

  it("쓸 때 그 능력이 없으면 이름을 달고 거절한다", () => {
    const geometry = createDisplayGeometry({ screen: {} });
    expect(() => geometry.snapshot(null, { x: 0, y: 0, width: 1, height: 1 }))
      .toThrow(/getDisplayMatching/);
  });
});
