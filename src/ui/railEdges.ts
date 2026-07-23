import type { RailLook } from "../state/settings";

type PaneStyle = "flat" | "card" | "floating";

// 레일 세로 경계선의 소유권 — railLook 과 테마 paneStyle 의 합성으로 결정한다.
// ground(바닥)는 원칙적으로 자기 선을 긋지 않는다: 경계 표현은 이웃(pane 카드 윤곽·
// 디바이더)의 것이라 레일이 더하면 이중선이 된다. 단 flat 테마는 이웃이 아무 윤곽도
// 그리지 않으므로 그 위임이 성립하지 않는다(실측: Bare light 에서 사이드바-기능 경계
// 무선 소실) — flat 에선 ground 레일이 자기 경계를 소유한다(양측 1px, 경계 스테이션
// 포함: flat 은 콘텐츠 가장자리에도 달리 선을 그어줄 이웃이 없다). pane(분할창처럼)은
// 내부 스테이션에서만 양측 1px(가장자리는 바깥쪽 생략 — §B2).
export function railEdgeWidths(
  look: RailLook,
  open: boolean,
  station: number,
  paneStyle: PaneStyle,
): { left: number; right: number } {
  if (!open) return { left: 0, right: 0 };
  if (look === "ground") {
    return paneStyle === "flat" ? { left: 1, right: 1 } : { left: 0, right: 0 };
  }
  return { left: station > 0 ? 1 : 0, right: station < 100 ? 1 : 0 };
}
