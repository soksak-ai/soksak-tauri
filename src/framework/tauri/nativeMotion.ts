import { surfaceRectOf } from "../../lib/surfaceRect";

export interface NativeFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * DOM FLIP은 최종 레이아웃을 먼저 놓고 `--flip-x = old - new`에서 0까지 보간한다.
 * 네이티브 child는 현재(old) frame만 알고 있으므로 같은 델타를 한 번 접으면 최종 frame이다.
 * 프레임 샘플링이나 CSS 진행률 추측은 하지 않는다.
 */
export function nativeMoveTarget(
  current: NativeFrame,
  flipX: string,
): NativeFrame | null {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/.exec(flipX.trim());
  if (!match) return null;
  const dx = Number(match[1]);
  if (!Number.isFinite(dx) || Math.abs(dx) < 0.5) return null;
  return { ...current, x: Math.round(current.x - dx) };
}

export function nativeMoveTargetOf(
  slot: HTMLElement,
  current: NativeFrame,
): NativeFrame | null {
  const moving = slot.closest<HTMLElement>(".tab-body.flip-move");
  if (!moving) return null;
  return nativeMoveTarget(current, getComputedStyle(moving).getPropertyValue("--flip-x"));
}

/** 정착 감사에서 DOM의 실제 최종 rect를 같은 정수 경계 계약으로 읽는다. */
export function settledNativeFrameOf(slot: HTMLElement): NativeFrame {
  return surfaceRectOf(slot.getBoundingClientRect());
}
