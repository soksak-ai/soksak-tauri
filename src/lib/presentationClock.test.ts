import { afterEach, expect, it, vi } from "vitest";
import {
  __resetPresentationClockForTest,
  presentationNowUnixMs,
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
