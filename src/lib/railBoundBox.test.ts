import { describe, expect, it } from "vitest";
import { flowRailBoundBox } from "./railBoundBox";

/** 좁은 경우와 넓은 경우는 같은 식의 두 해다 — 모드로 분기하지 않는다. */
describe("보더 상자 — 레일부터 결합 판 끝까지", () => {
  it("결합 판이 레일 옆이면 상자는 그 판 자신이다(좁은 경우)", () => {
    expect(flowRailBoundBox(0, { left: 0, top: 0, width: 50, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 100,
    });
  });

  it("사이에 다른 판이 끼면 그것까지 품는다(넓은 경우)", () => {
    expect(flowRailBoundBox(0, { left: 50, top: 0, width: 50, height: 50 })).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
    });
  });

  it("레일이 판 사이에 서 있으면 그 자리부터 잰다", () => {
    expect(flowRailBoundBox(25, { left: 50, top: 0, width: 50, height: 100 })).toEqual({
      left: 25,
      top: 0,
      width: 75,
      height: 100,
    });
  });

  it("고정 레일 앞(왼쪽)의 결합 판도 판의 왼쪽부터 레일까지 한 상자로 잇는다", () => {
    expect(flowRailBoundBox(60, { left: 0, top: 0, width: 30, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 60,
      height: 100,
    });
  });
});
