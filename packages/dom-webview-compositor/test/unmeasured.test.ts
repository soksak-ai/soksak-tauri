// 관측자의 생존은 판정의 입력이 될 수 없다.
//
// `presentation-frame` 표본은 rAF 가 낸다. 같은 파일이 이미 적는 사실 — WebKit 은 가려지거나
// 포커스 없는 창에서 rAF 를 멈춘다. 그것은 관측의 한계이지 DOM 이 안 움직였다는 증거가 아니다.
// 그런데 표본이 없을 때 판정은 `slot:samples=0/3` 을 실패로 적었다. 그러면 다른 창이 위에 있느냐가
// green/red 를 가른다 — 제품은 그대로인데 판정이 뒤집힌다.
//
// 잰 값과 못 잼은 다른 답이다. 재지 못한 것을 실패로 적으면 없는 사실을 만든 것이다.
import { describe, expect, it } from "vitest";
import { compositionTimelineVerdict } from "../src/index";

const rect = (x: number) => ({ x, y: 0, w: 100, h: 50 });
const sample = (sequence: number, at: number, x: number) => ({
  sequence, sampledAtUnixMs: at, frame: rect(x),
});

const timeline = (over: Record<string, unknown> = {}) => ({
  startAtUnixMs: 1_000,
  durationMs: 100,
  timingFunction: [0, 0, 1, 1] as [number, number, number, number],
  coordinateSpace: { scaleFactor: 2 },
  from: rect(0),
  to: rect(100),
  slot: [sample(0, 1_000, 0), sample(1, 1_050, 50), sample(2, 1_100, 100)],
  renderer: [sample(0, 1_000, 0), sample(1, 1_050, 50), sample(2, 1_100, 100)],
  surface: [sample(0, 1_000, 0), sample(1, 1_050, 50), sample(2, 1_100, 100)],
  ...over,
});

describe("관측 부재와 판정 실패는 다른 답이다", () => {
  it("표본이 없는 producer 는 실패가 아니라 못 잰 것으로 답한다", () => {
    const verdict = compositionTimelineVerdict(timeline({ slot: [] }) as never);
    expect(verdict.unmeasured).toEqual(["slot"]);
    expect(verdict.errors).toEqual([]);
  });

  it("표본이 있는 producer 는 같은 문턱으로 그대로 판정한다", () => {
    const drifted = timeline({
      slot: [sample(0, 1_000, 0), sample(1, 1_050, 60), sample(2, 1_100, 100)],
    });
    const verdict = compositionTimelineVerdict(drifted as never);
    expect(verdict.unmeasured).toEqual([]);
    expect(verdict.errors.some((e: string) => e.startsWith("slot[1]"))).toBe(true);
  });

  it("전부 재였고 어긋남이 없으면 ok 다", () => {
    const verdict = compositionTimelineVerdict(timeline() as never);
    expect(verdict.unmeasured).toEqual([]);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
