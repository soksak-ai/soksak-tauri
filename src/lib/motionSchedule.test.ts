// 위상 착지 예약도 모션 컨트롤러를 통과한다.
//
// RED 근거(사용자 실측, 2026-07-26): "멈춰지지가 않네" — 정지를 눌러도 이동이 끝나 버렸다.
// playbackRate·pause 는 문서 타임라인 위의 애니메이션만 잡는데 위상 착지는 setTimeout 이
// 세고 있었다. 화면은 얼었지만 타이머는 계속 세다가 착지를 선언해, 멈춰 보려던 그 순간을
// 관측 도구가 지웠다. 예약이 같은 타임라인에 얹히는지를 여기서 못 박는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMotionDebugForTest, scheduleMotion, setMotionDebug } from "./motionDebug";

class FakeEffect {
  constructor(
    public target: unknown,
    public frames: unknown,
    public timing: { duration: number },
  ) {}
  getComputedTiming() {
    return { duration: this.timing.duration, progress: 0 };
  }
}
class FakeAnimation {
  static made: FakeAnimation[] = [];
  id = "";
  playbackRate = 1;
  playState = "idle";
  onfinish: (() => void) | null = null;
  paused = false;
  constructor(public effect: FakeEffect) {
    FakeAnimation.made.push(this);
  }
  play() {
    this.playState = "running";
    this.paused = false;
  }
  pause() {
    this.playState = "paused";
    this.paused = true;
  }
  cancel() {
    this.playState = "idle";
  }
  /** 화면이 실제로 쓰는 시간만큼 지나 착지 */
  finish() {
    this.onfinish?.();
  }
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};

beforeEach(() => {
  __resetMotionDebugForTest();
  FakeAnimation.made = [];
  saved = { Animation: g.Animation, KeyframeEffect: g.KeyframeEffect };
  g.Animation = FakeAnimation;
  g.KeyframeEffect = FakeEffect;
  Object.defineProperty(document, "timeline", { value: {}, configurable: true });
});
afterEach(() => {
  g.Animation = saved.Animation;
  g.KeyframeEffect = saved.KeyframeEffect;
});

describe("scheduleMotion — 예약은 화면과 같은 시계를 탄다", () => {
  it("선언 길이를 그대로 싣는다 — 배수를 호출자가 곱하면 이중이 된다", () => {
    setMotionDebug({ scale: 20 });
    scheduleMotion(340, () => {});
    expect(FakeAnimation.made[0].effect.timing.duration).toBe(340);
  });

  it("배수는 재생 속도로 걸린다 — 화면 전이와 같은 축", () => {
    setMotionDebug({ scale: 20 });
    scheduleMotion(340, () => {});
    expect(FakeAnimation.made[0].playbackRate).toBe(1 / 20);
  });

  it("정지 중에는 예약도 멈춘다 — 얼어붙은 순간을 착지가 지우지 않는다", () => {
    setMotionDebug({ hold: true });
    const done = vi.fn();
    scheduleMotion(340, done);
    expect(FakeAnimation.made[0].paused).toBe(true);
    expect(done).not.toHaveBeenCalled();
  });

  it("기본값에서는 타임라인을 건드리지 않는다 — 관측 도구가 프로덕션을 바꾸지 않는다", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleMotion(340, done);
    expect(FakeAnimation.made).toHaveLength(0);
    vi.advanceTimersByTime(340);
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("이동 도중에 누른 정지가 그 이동에 걸린다 — 남은 만큼 타임라인으로 옮긴다", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleMotion(340, done);
    expect(FakeAnimation.made).toHaveLength(0); // 평시 — 타이머로 달린다
    setMotionDebug({ hold: true });
    expect(FakeAnimation.made).toHaveLength(1); // 관측이 켜지며 이관
    expect(FakeAnimation.made[0].paused).toBe(true);
    vi.advanceTimersByTime(10_000); // 옮겨 갔으니 옛 타이머는 더 이상 착지시키지 않는다
    expect(done).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("이관된 예약은 남은 길이만 싣는다 — 처음부터 다시 달리지 않는다", () => {
    vi.useFakeTimers();
    const started = performance.now();
    scheduleMotion(340, () => {});
    vi.advanceTimersByTime(170);
    vi.setSystemTime(new Date(Date.now() + 170));
    setMotionDebug({ scale: 20 });
    const left = FakeAnimation.made[0].effect.timing.duration;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(340);
    expect(performance.now()).toBeGreaterThanOrEqual(started);
    vi.useRealTimers();
  });

  it("취소하면 착지 콜백은 오지 않는다 — 관측 중(타임라인)", () => {
    setMotionDebug({ scale: 20 });
    const done = vi.fn();
    scheduleMotion(340, done)();
    FakeAnimation.made[0].finish();
    expect(done).not.toHaveBeenCalled();
  });

  it("취소하면 착지 콜백은 오지 않는다 — 평시(타이머). 위상 교체 시 유령 착지 금지", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleMotion(340, done)();
    vi.advanceTimersByTime(10_000);
    expect(done).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("위상 시계의 0 은 화면이 움직이기 시작한 순간이다", () => {
  // RED 근거(실측, 2026-07-26): 예약은 React 이펙트에서 세기 시작하는데 화면은 다음 페인트
  // 뒤에 움직인다. 평시 시차 5~44ms(340ms의 최대 13%) — 그만큼 활강 끝머리가 잘린 채 착지가
  // 선언된다. 화면이 첫 움직임을 알릴 때 예약을 그만큼 뒤로 물려 둘의 0 을 맞춘다.
  it("첫 움직임이 늦은 만큼 착지도 늦춰진다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const done = vi.fn();
    scheduleMotion(340, done);
    vi.advanceTimersByTime(40); // 화면은 아직 안 움직였다
    document.dispatchEvent(new Event("animationstart", { bubbles: true }));
    vi.advanceTimersByTime(300); // 예약대로였다면 여기서 착지했다
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60); // 시차만큼 뒤로 물린 자리
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
