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
    const dom = await prepareLayoutMove([{ viewId: "v1", dx: 120 }]);
    expect(dom.mode).toBe("glide");
    const commit = vi.fn(async () => {});
    const cancel = vi.fn();
    const prepareMove = vi.fn(async () => ({ mode: "snap" as const, commit, cancel }));
    registerLayoutTransitionHost({ prepareMove });
    const native = await prepareLayoutMove([{ viewId: "v1", dx: 120 }]);
    expect(native).toEqual({ mode: "snap", commit, cancel });
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
