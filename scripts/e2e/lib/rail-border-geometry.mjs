/**
 * 보더가 어느 변에 그려졌는지는 선언이 아니라 두 상자 사이의 거리다.
 *
 * relation 노드는 data-rail / data-box 로 실제로 그린 레일 상자와 판 상자를 호스트 상대 px 로
 * 낸다(정수 반올림). borderMode 와 pathCount 는 같은 한 계산이 자기를 이름으로 부른 것이라
 * 나란히 놓아도 서로를 증명하지 못한다 — 여기서는 거리를 센다.
 */

/** 상자 좌표는 정수 px 로 반올림되어 나온다 — 인접 판정 허용오차는 그 반올림 하나뿐이다. */
export const RAIL_BORDER_ADJACENT_TOLERANCE_PX = 1;

const BOX_KEYS = Object.freeze(["x", "y", "w", "h"]);

/** "x,y,w,h" 한 문자열을 상자로 읽는다. 모양이 아니면 null 이다 — 0 으로 둔갑시키지 않는다. */
export function parseBorderBox(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== BOX_KEYS.length) return null;
  const numbers = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (!numbers.every(Number.isFinite)) return null;
  return Object.fromEntries(BOX_KEYS.map((key, index) => [key, numbers[index]]));
}

export function isBorderBox(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!BOX_KEYS.every((key) => Number.isFinite(value[key]))) return false;
  return value.w > 0 && value.h > 0;
}

/** 판이 레일의 왼쪽 변·오른쪽 변에서 각각 얼마나 떨어져 있는가. */
export function borderGapsPx(railBox, paneBox) {
  if (!isBorderBox(railBox) || !isBorderBox(paneBox)) return null;
  return {
    left: Math.abs((paneBox.x + paneBox.w) - railBox.x),
    right: Math.abs(paneBox.x - (railBox.x + railBox.w)),
  };
}

/**
 * 그려진 변을 거리로 센다.
 *
 * left  = 판의 오른쪽 변이 레일의 왼쪽 변에 닿는다(판이 레일 왼쪽).
 * right = 판의 왼쪽 변이 레일의 오른쪽 변에 닿는다(판이 레일 오른쪽).
 * 두 변에 동시에 닿는 답은 없다: 그러려면 판 폭이 레일 폭의 음수여야 한다.
 * 상자가 없으면 잰 것이 없다 — null 이다. 안 잰 것과 붙어 있는 것은 같은 값이 될 수 없다.
 */
export function drawnBorderSide(
  railBox,
  paneBox,
  tolerance = RAIL_BORDER_ADJACENT_TOLERANCE_PX,
) {
  const gaps = borderGapsPx(railBox, paneBox);
  if (gaps === null) return null;
  if (gaps.left <= tolerance) return "left";
  if (gaps.right <= tolerance) return "right";
  return "detached";
}

/** 같은 자리로 돌아왔는가 — 네 축 중 가장 큰 차이 하나로 답한다. */
export function boxDriftPx(left, right) {
  if (!isBorderBox(left) || !isBorderBox(right)) return null;
  return Math.max(...BOX_KEYS.map((key) => Math.abs(left[key] - right[key])));
}
