// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  RAIL_BORDER_ADJACENT_TOLERANCE_PX,
  boxDriftPx,
  borderGapsPx,
  drawnBorderSide,
  isBorderBox,
  parseBorderBox,
} from "./rail-border-geometry.mjs";

const rail = (x) => ({ x, y: 0, w: 20, h: 700 });

describe("rail border geometry", () => {
  it("relation 노드가 낸 네 수를 상자로 읽고, 모양이 아니면 null 이다", () => {
    expect(parseBorderBox("500,0,20,700")).toEqual({ x: 500, y: 0, w: 20, h: 700 });
    expect(parseBorderBox(" 500 , 0 , 20 , 700 ")).toEqual({ x: 500, y: 0, w: 20, h: 700 });
    for (const value of [null, undefined, "", "500,0,20", "500,0,20,700,1", "a,0,20,700", 500]) {
      expect(parseBorderBox(value)).toBeNull();
    }
  });

  it("상자는 네 수가 전부 유한하고 폭·높이가 양수일 때만 상자다", () => {
    expect(isBorderBox({ x: 0, y: 0, w: 20, h: 700 })).toBe(true);
    expect(isBorderBox({ x: 0, y: 0, w: 0, h: 700 })).toBe(false);
    expect(isBorderBox({ x: 0, y: 0, w: 20, h: -1 })).toBe(false);
    expect(isBorderBox({ x: Number.NaN, y: 0, w: 20, h: 700 })).toBe(false);
    expect(isBorderBox(null)).toBe(false);
  });

  it("보더가 그려진 변을 선언이 아니라 두 상자 사이 거리로 센다", () => {
    // 판의 오른쪽 변이 레일의 왼쪽 변에 닿는다 — 판은 레일의 왼쪽에 있다.
    expect(drawnBorderSide(rail(500), { x: 0, y: 0, w: 500, h: 700 })).toBe("left");
    // 판의 왼쪽 변이 레일의 오른쪽 변에 닿는다 — 판은 레일의 오른쪽에 있다.
    expect(drawnBorderSide(rail(0), { x: 20, y: 0, w: 500, h: 700 })).toBe("right");
    // 어느 변에도 닿지 않는다.
    expect(drawnBorderSide(rail(0), { x: 520, y: 0, w: 500, h: 700 })).toBe("detached");
    // 상자가 없으면 잰 것이 없다 — 없음과 붙어있음을 같은 값으로 표현하지 않는다.
    expect(drawnBorderSide(null, { x: 0, y: 0, w: 500, h: 700 })).toBeNull();
    expect(drawnBorderSide(rail(0), null)).toBeNull();
  });

  it("레일이 허용오차보다 얇으면 어느 변인지 셀 수 없다고 답한다", () => {
    expect(drawnBorderSide({ x: 100, y: 0, w: 1, h: 700 }, { x: 0, y: 0, w: 100, h: 700 }))
      .toBe("ambiguous");
  });

  it("반올림 1px 은 붙은 것이고 2px 은 떨어진 것이다", () => {
    expect(RAIL_BORDER_ADJACENT_TOLERANCE_PX).toBe(1);
    expect(drawnBorderSide(rail(500), { x: 0, y: 0, w: 499, h: 700 })).toBe("left");
    expect(drawnBorderSide(rail(500), { x: 0, y: 0, w: 498, h: 700 })).toBe("detached");
    expect(borderGapsPx(rail(500), { x: 0, y: 0, w: 498, h: 700 })).toEqual({ left: 2, right: 478 });
    expect(borderGapsPx(null, { x: 0, y: 0, w: 498, h: 700 })).toBeNull();
  });

  it("같은 자리로 돌아왔는지는 축마다 가장 큰 차이 하나로 답한다", () => {
    expect(boxDriftPx({ x: 0, y: 0, w: 500, h: 700 }, { x: 0, y: 0, w: 500, h: 700 })).toBe(0);
    expect(boxDriftPx({ x: 1, y: 0, w: 500, h: 700 }, { x: 0, y: 0, w: 500, h: 697 })).toBe(3);
    expect(boxDriftPx({ x: 0, y: 0, w: 500, h: 700 }, null)).toBeNull();
  });
});
