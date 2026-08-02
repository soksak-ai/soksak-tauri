// 한 표면의 흐림은 **단계 하나**다.
//
// 흐려질 사유는 여럿이다 — 포커스가 아니라서(비활성), 레일과 포커스 판 사이에 껴서(가려짐).
// 그런데 화면에 칠해지는 값은 하나뿐이다. 사유마다 CSS 규칙을 세우면 그 하나를 **특이성이**
// 정한다: 짙은 단계가 옅은 단계에 지고, 아무것도 실패하지 않아서 아무도 못 본다.
//
// 실사고(2026-08-02): `.space[data-focus-dim] .tab-body.hole::after`(클래스 4) 가
// `.tab-body.hole.rail-blocked::after`(클래스 3) 를 이겨, 낀 판의 베일이 22% 가 아니라 7% —
// 비활성과 **같은 값**으로 칠해졌다. 코드에도 있고 검사도 통과하는데 화면은 그대로였다.
//
// 그러므로 단계는 여기서 정한다. 표면에는 이름 하나(`data-dim`)로 나가고, CSS 는 이름당 한
// 벌만 그린다. 규칙끼리 겨룰 자리가 없으면 특이성 사고도 없다.

/** 흐림 단계 — 표면에 `data-dim` 으로 나간다. 사유가 아니라 결과다. */
export type DimLevel = "clear" | "idle" | "blocked";

/** 흐림의 사유들 — 여기 들어와서 단계 하나로 나간다. */
export type DimInput = {
  /** 이 판이 포커스인가. */
  active: boolean;
  /** 포커스 아닌 것을 가라앉히는 설정(focusDim). */
  focusDim: boolean;
  /** 레일이 포커스 판까지 못 가서 그 사이에 낀 판인가. */
  blocked: boolean;
};

/**
 * 사유들에서 단계 하나를 정한다.
 *
 * 포커스는 무엇에도 안 흐려진다 — 보라고 고른 것이다. 낀 것은 `focusDim` 과 무관하게 흐리다:
 * "가려졌다"는 레일 축이 하는 말이지 흐림 설정이 하는 말이 아니고, 설정을 껐다고 가려진 사실이
 * 사라지지 않는다. 낀 것은 비활성보다 **더** 짙다 — 같은 값이면 "가려졌다"가 안 보인다.
 */
export function dimLevel({ active, focusDim, blocked }: DimInput): DimLevel {
  if (active) return "clear";
  if (blocked) return "blocked";
  return focusDim ? "idle" : "clear";
}

/** 이 단계가 실제로 흐린가 — "clear 가 아니다"를 곳곳에서 다시 쓰지 않는다. */
export function isDimmed(level: DimLevel): boolean {
  return level !== "clear";
}
