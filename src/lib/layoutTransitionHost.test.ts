import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
  registerLayoutTransitionHost,
  viewLayoutMoves,
} from "./layoutTransitionHost";

describe("layoutTransitionHost", () => {
  beforeEach(__resetLayoutTransitionHostForTest);

  it("미설치 프레임워크는 DOM glide이고 설치 어댑터의 준비 완료를 그대로 기다린다", async () => {
    await expect(prepareLayoutMove([{ viewId: "v1", dx: 120 }])).resolves.toBe("glide");
    const prepareMove = vi.fn(async () => "snap" as const);
    registerLayoutTransitionHost({ prepareMove });
    await expect(prepareLayoutMove([{ viewId: "v1", dx: 120 }])).resolves.toBe("snap");
    expect(prepareMove).toHaveBeenCalledWith([{ viewId: "v1", dx: 120 }]);
  });

  it("움직이는 그룹의 모든 view를 같은 물리 이동량으로 공개한다", () => {
    expect(viewLayoutMoves(
      [{ id: "g1", dLeftPct: 25, dRailUnits: -1 }],
      [
        { id: "g1", viewIds: ["terminal-1", "browser-1"] },
        { id: "g2", viewIds: ["browser-2"] },
      ],
      800,
      60,
    )).toEqual([
      { viewId: "terminal-1", dx: 140 },
      { viewId: "browser-1", dx: 140 },
    ]);
  });
});
