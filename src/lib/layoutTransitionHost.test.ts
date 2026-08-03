import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
  registerLayoutTransitionHost,
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
});
