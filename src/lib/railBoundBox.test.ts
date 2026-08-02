import { describe, expect, it } from "vitest";
import { railBoundBox } from "./railBoundBox";

/** 좁은 경우와 넓은 경우는 같은 식의 두 해다 — 모드로 분기하지 않는다. */
describe("보더 상자 — 레일부터 결합 판 끝까지", () => {
  it("결합 판이 레일 옆이면 상자는 그 판 자신이다(좁은 경우)", () => {
    expect(railBoundBox(0, { left: 0, top: 0, width: 50, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 100,
    });
  });

  it("사이에 다른 판이 끼면 그것까지 품는다(넓은 경우)", () => {
    expect(railBoundBox(0, { left: 50, top: 0, width: 50, height: 50 })).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
    });
  });

  it("레일이 판 사이에 서 있으면 그 자리부터 잰다", () => {
    expect(railBoundBox(25, { left: 50, top: 0, width: 50, height: 100 })).toEqual({
      left: 25,
      top: 0,
      width: 75,
      height: 100,
    });
  });

  /** 감쌀 것이 없으면 만들지 않는다 — 없는 관계를 그리면 그것이 거짓이다. */
  it("결합 판이 레일 뒤면 그대로 둔다", () => {
    const behind = { left: 0, top: 0, width: 30, height: 100 };
    expect(railBoundBox(60, behind)).toEqual(behind);
  });
});
