import { afterEach, expect, it, vi } from "vitest";
import {
  __resetPresentationClockForTest,
  presentationNowUnixMs,
  presentationUnixMsFromDocumentTime,
} from "./presentationClock";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPresentationClockForTest();
});

it("OS wall clock 보정과 무관하게 document monotonic epoch만 사용한다", () => {
  const now = vi.fn().mockReturnValueOnce(25).mockReturnValueOnce(40);
  vi.stubGlobal("performance", { timeOrigin: 1_000, now });
  vi.stubGlobal("Date", { now: vi.fn().mockReturnValueOnce(99_000).mockReturnValueOnce(4) });

  expect(presentationNowUnixMs()).toBe(1_025);
  expect(presentationNowUnixMs()).toBe(1_040);
});

it("timeOrigin이 없는 환경도 최초 monotonic 원점을 한 번만 고정한다", () => {
  const now = vi.fn().mockReturnValueOnce(20).mockReturnValueOnce(35);
  const wall = vi.fn().mockReturnValueOnce(2_000).mockReturnValueOnce(90_000);
  vi.stubGlobal("performance", { timeOrigin: Number.NaN, now });
  vi.stubGlobal("Date", { now: wall });

  expect(presentationNowUnixMs()).toBe(2_000);
  expect(presentationNowUnixMs()).toBe(2_015);
  expect(wall).toHaveBeenCalledOnce();
});

it("실행 중 wall clock 보정이 timeOrigin 을 움직여도 표시 epoch 는 안 따라간다", () => {
  // WebKit 은 `performance.timeOrigin` 을 상수로 들지 않는다 — 읽을 때마다 지금 wall clock 에서
  // 되계산한다(MonotonicTime::approximateWallTime). 그래서 OS 시각 보정이 그대로 이 값에 실린다.
  //
  // 실측(2026-08-07, buildId 02e65703, tauri/darwin, slot-freeze 12 전이): 한 실행 도중 wall clock
  // 이 4.12s 뒤로 밟히자 이 시계가 그만큼 뒤로 물러섰고, uptime 에 고정된 native presentation
  // clock 과 갈라져 B04·B05 가 두 engine 에서 red 가 됐다. 같은 결함의 반대 부호(system sleep
  // 67분)는 `scripts/e2e/lib/browser-gate-b04-observed.test.mjs` 가 붙들고 있다.
  const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(200);
  let timeOrigin = 1_000_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  expect(presentationNowUnixMs()).toBe(1_000_100);
  timeOrigin -= 4_120;
  expect(presentationNowUnixMs()).toBe(1_000_200);
});

it("wall clock 이 뒤로 밟혀도 표시 시각은 뒤로 안 간다", () => {
  const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(11);
  let timeOrigin = 5_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  const before = presentationNowUnixMs();
  timeOrigin -= 60_000;
  expect(presentationNowUnixMs()).toBeGreaterThan(before);
});

it("display frame 시각과 now 는 같은 원점 위에 있다", () => {
  // 한 원장에 두 함수가 함께 실린다(framework 표시 원장). 원점이 갈리면 그 원장 안에서
  // 표시 시각과 관측 시각이 서로 다른 시계의 값이 된다.
  const now = vi.fn().mockReturnValue(50);
  let timeOrigin = 700_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  expect(presentationNowUnixMs()).toBe(700_050);
  timeOrigin += 9_000;
  expect(presentationUnixMsFromDocumentTime(50)).toBe(700_050);
});
