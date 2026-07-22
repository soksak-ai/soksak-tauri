import type { RailLook } from "../state/settings";

// 레일 세로 경계선의 소유권 — ground(바닥)는 자기 선을 긋지 않는다: 경계 표현은 이웃
// (pane 카드 윤곽·디바이더)의 것이고, 레일이 선을 더하면 이중선이 된다. pane(분할창처럼)은
// 내부 스테이션에서만 양측 1px(가장자리는 바깥쪽 생략 — §B2).
export function railEdgeWidths(
  look: RailLook,
  open: boolean,
  station: number,
): { left: number; right: number } {
  if (!open || look === "ground") return { left: 0, right: 0 };
  return { left: station > 0 ? 1 : 0, right: station < 100 ? 1 : 0 };
}
