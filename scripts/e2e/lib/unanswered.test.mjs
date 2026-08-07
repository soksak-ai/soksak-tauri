// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isUnanswered } from "./unanswered.mjs";

// 규칙 — 안 답한 자리는 한 자리가 판별한다.
//
// 자기 궤적을 가진 구현은 코어 원장이 답하는 값을 다 답하지 못한다. 계약이 그 자리를 null 로
// 두는 것은 지어내지 않기 위해서이고, 판정은 그 null 을 "틀린 값" 으로 읽으면 안 된다.
//
// 이 판별을 자리마다 손으로 쓰면 반드시 하나가 빠진다 — 실측 2026-08-08: B05 한 게이트에서만
// 여섯 겹이 차례로 드러났다(궤적 필드 → 시계 → 사건 필드 → 표면 정체 → 사각형 → 프레임 순번).
describe("isUnanswered", () => {
  it("null·undefined 는 안 답한 것이다", () => {
    expect(isUnanswered(null)).toBe(true);
    expect(isUnanswered(undefined)).toBe(true);
  });

  it("값이 있으면 답한 것이다 — 틀린 값도 답한 것이다", () => {
    for (const answered of [0, "", false, Number.NaN, "열림", -1]) {
      expect(isUnanswered(answered), String(answered)).toBe(false);
    }
  });

  // 껍데기만 보면 안쪽의 null 이 그대로 샌다.
  it("모든 축이 빈 사각형은 안 답한 것이다", () => {
    expect(isUnanswered({ x: null, y: null, w: null, h: null }, ["x", "y", "w", "h"])).toBe(true);
  });

  it("일부만 빈 사각형은 잘못 답한 것이다", () => {
    expect(isUnanswered({ x: 1, y: null, w: null, h: null }, ["x", "y", "w", "h"])).toBe(false);
  });

  it("축을 선언하지 않으면 객체는 답한 것이다", () => {
    expect(isUnanswered({ x: null })).toBe(false);
  });
});
