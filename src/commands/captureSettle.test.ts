// @vitest-environment jsdom
// 캡처 정착 계약 — window.snapshot 이 비전면 창(timeline 정지)에서도 정확한 최종 프레임을 내도록,
// 유한 반복 애니메이션만 끝 상태로 정착하고 무한 반복은 건드리지 않는다.
import { describe, it, expect } from "vitest";
import { isFiniteAnimation, settleAnimationsForCapture } from "./captureSettle";

describe("isFiniteAnimation", () => {
  it("유한 반복은 true, 무한/미정은 false", () => {
    expect(isFiniteAnimation(1)).toBe(true);
    expect(isFiniteAnimation(3)).toBe(true);
    expect(isFiniteAnimation(Infinity)).toBe(false);
    expect(isFiniteAnimation(undefined)).toBe(false);
  });
});

type FakeAnim = { id: string; effect: { getComputedTiming: () => { iterations: number } }; finish: () => void };
function fakeDoc(anims: FakeAnim[]): Document {
  return {
    getAnimations: () => anims as unknown as Animation[],
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    documentElement: { offsetHeight: 0 },
  } as unknown as Document;
}

describe("settleAnimationsForCapture", () => {
  it("유한 반복(진입 전이)만 finish 하고 무한 반복(스피너)은 건드리지 않는다", () => {
    const finished: string[] = [];
    const mk = (id: string, iterations: number): FakeAnim => ({
      id,
      effect: { getComputedTiming: () => ({ iterations }) },
      finish: () => finished.push(id),
    });
    settleAnimationsForCapture(fakeDoc([mk("fade-in", 1), mk("spinner", Infinity)]));
    expect(finished).toEqual(["fade-in"]);
  });

  it("한 애니메이션의 finish 가 throw 해도(이미 끝남) 나머지를 정착한다", () => {
    const finished: string[] = [];
    const bad: FakeAnim = {
      id: "bad",
      effect: { getComputedTiming: () => ({ iterations: 1 }) },
      finish: () => {
        throw new Error("InvalidStateError");
      },
    };
    const good: FakeAnim = {
      id: "good",
      effect: { getComputedTiming: () => ({ iterations: 1 }) },
      finish: () => finished.push("good"),
    };
    settleAnimationsForCapture(fakeDoc([bad, good]));
    expect(finished).toEqual(["good"]);
  });
});
