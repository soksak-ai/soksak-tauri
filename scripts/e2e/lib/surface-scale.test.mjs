// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  capturedScaleObservation,
  displayScaleFact,
  usableFrameScale,
} from "./surface-scale.mjs";

describe("배율은 창의 사실이다", () => {
  it("window.info가 말한 배율을 그대로 읽는다", () => {
    expect(displayScaleFact({ w: 2400, h: 1600, scale: 2 })).toBe(2);
    expect(displayScaleFact({ scale: "1.5" })).toBe(1.5);
  });

  it("사실이 없으면 1로 대체하지 않고 던진다", () => {
    expect(() => displayScaleFact({ w: 2400, h: 1600 })).toThrow(/scale이 없다/);
    expect(() => displayScaleFact({ scale: 0 })).toThrow(/배율이 아니다/);
    expect(() => displayScaleFact({ scale: null })).toThrow(/배율이 아니다/);
    expect(() => displayScaleFact(null)).toThrow(/window\.info/);
  });

  it("캡처에서 나온 맨 숫자는 사실 자리에 들어가지 못한다", () => {
    expect(() => displayScaleFact(2)).toThrow(/window\.info/);
    expect(() => displayScaleFact([2])).toThrow(/array/);
  });
});

describe("캡처에서 잰 배율은 맞대 볼 뿐 사실을 바꾸지 않는다", () => {
  it("허용오차 안이면 통과로 보고한다", () => {
    expect(capturedScaleObservation(2, 2.01)).toMatchObject({ ok: true, error: null });
  });

  it("어긋나면 사실을 바꾸는 대신 이름을 남긴다", () => {
    const observation = capturedScaleObservation(2, 1);
    expect(observation.fact).toBe(2);
    expect(observation.captured).toBe(1);
    expect(observation.ok).toBe(false);
    expect(observation.error).toMatch(/captured scale 1 vs window fact 2/);
  });

  it("캡처를 못 재면 0도 1도 만들지 않는다", () => {
    expect(capturedScaleObservation(2, null)).toEqual({
      fact: 2, captured: null, delta: null, ok: false, error: null,
    });
    expect(capturedScaleObservation(2, Number.NaN).captured).toBe(null);
  });
});

describe("쓸 수 없는 배율을 조용히 곱하지 않는다", () => {
  it("양의 유한값만 프레임 기하에 쓴다", () => {
    expect(usableFrameScale(2)).toBe(true);
    expect(usableFrameScale(0)).toBe(false);
    expect(usableFrameScale(null)).toBe(false);
    expect(usableFrameScale(Number.NaN)).toBe(false);
  });
});
