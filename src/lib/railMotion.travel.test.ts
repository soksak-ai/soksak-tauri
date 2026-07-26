// 위상 지속의 두 시계는 한 배수를 따른다.
//
// RED 근거(설계 결함, 2026-07-26): 관측 배수를 Web Animations 의 playbackRate 로만 걸었더니
// CSS 전이만 늦고 위상을 닫는 JS 타이머는 340ms 그대로였다. 20배로 늦추면 화면이 5% 진행한
// 시점에 JS 가 착지를 선언한다 — 보려던 중간 상태가 관측 도구 때문에 사라진다. 관측 장치가
// 관측 대상을 바꾸면 그건 관측이 아니다.
//
// 지속의 단일 진실이 RAIL_TRAVEL_MS 하나이므로 배수도 거기서 곱한다. CSS 변수 주입과 JS
// 타이머가 같은 함수를 부르는 한 둘은 갈라질 수 없다.
import { beforeEach, describe, expect, it } from "vitest";
import {
  RAIL_TRAVEL_MS,
  railTravelDeclaredMs,
  railTravelMs,
  railTravelWallMs,
} from "./railMotion";
import { __resetMotionDebugForTest, setMotionDebug } from "./motionDebug";

describe("railTravelMs — 배수는 지속의 단일 진실에서 곱해진다", () => {
  beforeEach(() => __resetMotionDebugForTest());

  it("기본값에서는 상수 그대로다 — 프로덕션 경로 불변", () => {
    expect(railTravelMs()).toBe(RAIL_TRAVEL_MS);
  });

  it("배수를 올리면 지속도 그만큼 늘어난다", () => {
    setMotionDebug({ scale: 20 });
    expect(railTravelMs()).toBe(RAIL_TRAVEL_MS * 20);
  });

  it("되돌리면 상수로 복귀한다", () => {
    setMotionDebug({ scale: 50 });
    setMotionDebug({ scale: 1 });
    expect(railTravelMs()).toBe(RAIL_TRAVEL_MS);
  });
});

describe("두 시계의 짝 — 화면이 쓰는 시간과 위상이 닫히는 시간은 같다", () => {
  beforeEach(() => __resetMotionDebugForTest());

  // RED 근거(실사고, 2026-07-26): playbackRate 로 이미 늘어난 전이의 **선언까지** 배수로 곱해
  // 화면은 배수의 제곱만큼 늦었는데 위상 타이머는 한 번만 곱했다. 20배에서 이동이 5% 진행한
  // 자리에 위상이 닫혀 레이어가 갈리며 튀었다 — 사용자 실측: "느려지다 중단되고 되돌아간다".
  for (const scale of [1, 5, 20, 50]) {
    it(`${scale}배에서 화면 시간과 타이머가 어긋나지 않는다`, () => {
      setMotionDebug({ scale });
      expect(railTravelWallMs()).toBe(railTravelMs());
    });
  }

  it("CSS 로 나가는 선언은 배수와 무관하게 맨 길이다 — 늘리는 축은 playbackRate 하나", () => {
    setMotionDebug({ scale: 20 });
    expect(railTravelDeclaredMs()).toBe(RAIL_TRAVEL_MS);
  });
});
