// 보더가 감싸는 상자 — **레일부터 결합 판의 오른쪽 끝까지.**
//
// 좁은 경우와 넓은 경우는 다른 규칙이 아니다. 결합 판이 레일 옆에 있으면(당김) 그 상자는 판
// 자신이고, 레일이 못 가 사이에 다른 판이 끼면(레일 이동) 그 상자는 낀 것들까지 품는다.
// 같은 식의 두 해다 — 모드로 분기하면 두 규칙이 되고, 한쪽만 고쳐지는 날이 온다.
//
// 실측 2026-08-02: 넓은 경우에 보더가 통째로 안 그려졌다. 결합 판의 rect 를 그대로 넘겨서
// 그 왼쪽 변이 레일에서 떨어져 있었고, 인접 판정이 "아직 안 온 중간 상태"로 읽어 억제했다.
import type { RailRect } from "./railPlacement";

/**
 * 레일(station)에서 결합 판의 오른쪽 끝까지를 한 상자로.
 *
 * 세로 범위는 결합 판의 것이다 — 레일은 늘 전체 높이이므로, 가로만 늘리면 레일과 그 판을
 * 잇는 테두리가 된다. 결합 판이 레일 뒤(왼쪽)면 감쌀 것이 없다: 그대로 돌려준다.
 */
export function railBoundBox(station: number, bound: RailRect): RailRect {
  const right = bound.left + bound.width;
  if (right <= station) return bound;
  return { left: station, top: bound.top, width: right - station, height: bound.height };
}
