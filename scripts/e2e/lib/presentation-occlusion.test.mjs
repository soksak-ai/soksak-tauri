// 규칙 — 표시 보장은 앱이 선언한다.
//
// 가려진 창에서 표시 시계가 멈추면 표시 표본이 거래 창에 하나도 안 들어오고, 그 자리는
// 못 잼(blocked)이 된다. 그런데 이 앱은 가려져도 그리는 보장을 이미 낼 수 있다
// (`window.occlusion {"enabled":false}`). 그러면 그 축은 blocked 로 남을 자리가 아니라
// green/red 로 판정될 자리다 — 낼 수 있는 보장을 안 내고 못 잼으로 넘기는 것은 기준 회피다.
//
// 보장은 OS 표면(UI 스크립팅·보조 접근)에 기대지 않고 창을 전면화하지도 않는다. 그래서
// 사용자 창의 포커스를 뺏지 않고, 끝나면 원상 복구한다.
import { describe, expect, it, vi } from "vitest";
import { withPresentationOcclusionOff } from "./presentation-occlusion.mjs";

const ok = (webviews) => vi.fn(async () => ({ occlusion: false, webviews }));

describe("표시 궤적 무장 — 가려져도 그린다", () => {
  it("궤적을 여는 동안 occlusion 을 끄고, 끝나면 원상 복구한다", async () => {
    const calls = [];
    const setOcclusion = vi.fn(async (enabled) => {
      calls.push(enabled);
      return { occlusion: enabled, webviews: 3 };
    });
    const result = await withPresentationOcclusionOff(
      { setOcclusion, surfaces: 2 },
      async () => "궤적",
    );
    expect(result).toBe("궤적");
    expect(calls).toEqual([false, true]);
  });

  it("본문이 던져도 원상 복구는 한다 — 사용자 창에 우리 상태를 남기지 않는다", async () => {
    const calls = [];
    const setOcclusion = vi.fn(async (enabled) => {
      calls.push(enabled);
      return { occlusion: enabled, webviews: 3 };
    });
    await expect(withPresentationOcclusionOff(
      { setOcclusion, surfaces: 2 },
      async () => { throw new Error("궤적 실패"); },
    )).rejects.toThrow("궤적 실패");
    expect(calls).toEqual([false, true]);
  });

  // 설명이 `webviews` 를 낸 이유가 이것이다 — "capture automation can reject a main-only
  // partial arm". 적게 무장된 것을 성공으로 읽으면 그 다음 표본 부재는 창이 가려졌는지가
  // 아니라 우리가 무장을 덜 한 것이고, 그 사실이 blocked 라는 이름 뒤로 숨는다.
  it("main 만 무장된 부분 무장을 성공으로 읽지 않는다", async () => {
    const setOcclusion = ok(1);
    await expect(withPresentationOcclusionOff(
      { setOcclusion, surfaces: 2 },
      async () => "닿으면 안 된다",
    )).rejects.toThrow("presentation occlusion arm=1/3");
  });

  it("하나도 무장 못 했으면 0 을 성공으로 읽지 않는다", async () => {
    await expect(withPresentationOcclusionOff(
      { setOcclusion: ok(0), surfaces: 1 },
      async () => "닿으면 안 된다",
    )).rejects.toThrow("presentation occlusion arm=0/2");
  });

  it("무장에 실패하면 본문을 열지 않는다 — 못 잼을 못 잼이 아닌 것처럼 만들지 않는다", async () => {
    const body = vi.fn(async () => "닿으면 안 된다");
    await expect(withPresentationOcclusionOff(
      { setOcclusion: ok(1), surfaces: 2 },
      body,
    )).rejects.toThrow();
    expect(body).not.toHaveBeenCalled();
  });

  it("선언한 표면 수가 없으면 무장 수를 판정할 수 없다 — 그대로 거절한다", async () => {
    await expect(withPresentationOcclusionOff(
      { setOcclusion: ok(3), surfaces: 0 },
      async () => "닿으면 안 된다",
    )).rejects.toThrow("presentation occlusion surfaces=positive/0");
  });
});
