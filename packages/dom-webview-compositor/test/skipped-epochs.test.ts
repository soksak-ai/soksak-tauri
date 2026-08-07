// 표시 열의 구멍은 프레임 단위로 센다.
//
// 옛 판정은 `gaps.at(-1) > cadence * 1.75` 였다. cadence 17ms 에서 29.75ms — 프레임 하나가
// 통째로 빠지는 값(2 × cadence = 34ms)보다 아래다. 그래서 "한 프레임이 13ms 늦은 것"이 문턱을
// 넘고, 지터가 green/red 를 갈랐다. 축이 흔들린 게 아니라 문턱이 신호 아래 그어져 있었다.
//
// 기준은 새로 만들지 않는다. native 표시 원장이 이미 쓰는 규칙을 그대로 적용한다
// (frameworks/tauri/src/webview/presentation_trace.rs: displayed_at > previous + interval/2
//  → skipped = round(delta / interval).max(1)). 고정 주기로 나누지 않고 그 판이 실어 보낸
// refreshIntervalMs 를 쓴다 — 가변 주사율에서 정상 프레임이 건너뜀으로 둔갑하지 않도록.
import { describe, expect, it } from "vitest";
import { compositionTimelineVerdict } from "../src/index";

const rect = (x: number) => ({ x, y: 0, w: 100, h: 50 });
const at = (sequence: number, sampledAtUnixMs: number, x: number) => ({
  sequence, sampledAtUnixMs, frame: rect(x),
});

/** 16.68ms 표시 주기 위의 한 활강. skip 목록의 자리에서 프레임을 빼고 나머지는 그대로 둔다. */
function timelineWith(skipAt: number[] = []) {
  const interval = 16.68;
  const start = 1_000;
  const durationMs = 340;
  const frames: { sequence: number; sampledAtUnixMs: number; frame: ReturnType<typeof rect> }[] = [];
  let sequence = 0;
  for (let step = 0; step * interval <= durationMs; step += 1) {
    if (skipAt.includes(step)) continue;
    const elapsed = step * interval;
    frames.push(at(sequence, start + elapsed, (elapsed / durationMs) * 100));
    sequence += 1;
  }
  return {
    clocks: { window: "unix-anchored-monotonic", slot: "unix-anchored-monotonic", renderer: "unix-anchored-monotonic", surface: "unix-anchored-monotonic" },
    startAtUnixMs: start,
    durationMs,
    timingFunction: [0, 0, 1, 1] as [number, number, number, number],
    coordinateSpace: { scaleFactor: 2 },
    refreshIntervalMs: interval,
    from: rect(0),
    to: rect(100),
    slot: frames,
    renderer: frames,
    surface: frames,
  };
}

describe("표시 열의 구멍은 프레임 단위다", () => {
  it("한 프레임도 안 빠지면 통과한다", () => {
    const verdict = compositionTimelineVerdict(timelineWith() as never);
    expect(verdict.errors.filter((e: string) => e.includes("skipped-display-epochs"))).toEqual([]);
  });

  it("한 프레임이 빠지면 그 수를 이름에 싣는다", () => {
    const verdict = compositionTimelineVerdict(timelineWith([5]) as never);
    expect(verdict.errors).toContain("slot:skipped-display-epochs=1");
  });

  it("두 프레임이 연달아 빠지면 2 로 센다", () => {
    const verdict = compositionTimelineVerdict(timelineWith([5, 6]) as never);
    expect(verdict.errors).toContain("slot:skipped-display-epochs=2");
  });

  it("주기의 절반 안쪽 지터는 건너뜀이 아니다", () => {
    const jittered = timelineWith();
    jittered.slot = jittered.slot.map((sample, index) => (
      index === 5 ? { ...sample, sampledAtUnixMs: sample.sampledAtUnixMs + 8 } : sample
    ));
    const verdict = compositionTimelineVerdict(jittered as never);
    expect(verdict.errors.filter((e: string) => e.includes("skipped-display-epochs"))).toEqual([]);
  });
});
