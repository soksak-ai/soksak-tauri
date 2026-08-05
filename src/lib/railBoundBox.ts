import type { RailRect } from "./railPlacement";

/**
 * FLOW 이동 중 레일과 결합 판 사이를 한 투영 상자로 만든다. PIN은 이 함수를 쓰지 않고
 * 실제 판 rect를 보존해야 한다. 그렇지 않으면 떨어진 판 사이의 공간이 가짜 합성면이 된다.
 */
export function flowRailBoundBox(station: number, bound: RailRect): RailRect {
  const right = bound.left + bound.width;
  if (right <= station) {
    return { left: bound.left, top: bound.top, width: station - bound.left, height: bound.height };
  }
  return { left: station, top: bound.top, width: right - station, height: bound.height };
}
