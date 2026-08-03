import { describe, expect, it } from "vitest";
import { nativeMoveTarget } from "./nativeMotion";

describe("Tauri native child 이동 계약", () => {
  it("DOM FLIP의 시작 오프셋을 현재 native frame에서 한 번만 접어 최종 frame을 만든다", () => {
    expect(
      nativeMoveTarget(
        { x: 620, y: 112, w: 212, h: 458 },
        "410px",
      ),
    ).toEqual({ x: 210, y: 112, w: 212, h: 458 });
  });

  it("위상이 아닌 값과 px가 아닌 값은 native animation을 만들지 않는다", () => {
    expect(nativeMoveTarget({ x: 620, y: 112, w: 212, h: 458 }, "0px")).toBeNull();
    expect(nativeMoveTarget({ x: 620, y: 112, w: 212, h: 458 }, "calc(10%)")).toBeNull();
  });
});
