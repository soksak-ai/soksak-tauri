// 모션 관측 — 설정이 아니라 효과를 고정한다.
//
// RED 근거(실사고 2026-07-26): 처음 판은 :root 에 --motion-scale 커스텀 프로퍼티만 세웠다.
// 상태를 읽으면 20 이 나오고 명령도 20 을 답했지만, 그 변수를 소비하는 선언이 하나도 없어
// 화면은 조금도 느려지지 않았다. "설정이 적용됐다"가 "느려졌다"를 대신한 것이다 — 오늘 내내
// 문제였던 바로 그 대체. 그래서 여기서 단언하는 것은 실제 애니메이션의 playbackRate 다.
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetMotionDebugForTest,
  applyMotionTo,
  motionDebugState,
  setMotionDebug,
  type Retimable,
} from "./motionDebug";

// jsdom 에는 Web Animations 가 없다. 브라우저의 playbackRate 구현은 내 것이 아니므로 그것을
// 테스트하지 않는다 — 내가 지는 책임은 "어떤 값을, 언제 쥐는가" 이고 그것을 직접 단언한다.
function fake(): Retimable & { paused: boolean } {
  return {
    playbackRate: 1,
    paused: false,
    get playState() {
      return this.paused ? "paused" : "running";
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
    },
  };
}

describe("motionDebug — 느려진다는 말이 실제 속도여야 한다", () => {
  beforeEach(() => {
    __resetMotionDebugForTest();
    document.body.innerHTML = "";
  });

  it("배수를 올리면 애니메이션의 속도가 그 역수로 내려간다", () => {
    setMotionDebug({ scale: 20 });
    const a = fake();
    applyMotionTo(a);
    expect(a.playbackRate).toBeCloseTo(1 / 20);
  });

  it("1 로 되돌리면 보통 속도로 복귀한다", () => {
    setMotionDebug({ scale: 50 });
    const a = fake();
    applyMotionTo(a);
    expect(a.playbackRate).toBeCloseTo(1 / 50);
    setMotionDebug({ scale: 1 });
    applyMotionTo(a);
    expect(a.playbackRate).toBe(1);
  });

  it("정지는 실제로 멈추고, 해제는 다시 돌린다", () => {
    setMotionDebug({ hold: true });
    const a = fake();
    applyMotionTo(a);
    expect(a.playState).toBe("paused");
    setMotionDebug({ hold: false });
    applyMotionTo(a);
    expect(a.playState).not.toBe("paused");
  });

  it("상태는 하나다 — 읽은 값이 적용한 값이다", () => {
    setMotionDebug({ scale: 5, hold: true });
    expect(motionDebugState()).toEqual({ scale: 5, hold: true });
  });

  it("범위 밖 배수는 무시한다 — 상태가 망가지지 않는다", () => {
    setMotionDebug({ scale: 20 });
    setMotionDebug({ scale: 0 });
    setMotionDebug({ scale: 9999 });
    expect(motionDebugState().scale).toBe(20);
  });
});
