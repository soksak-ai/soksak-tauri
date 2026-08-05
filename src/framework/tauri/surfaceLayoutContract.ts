import { surfaceRectOf } from "../../lib/surfaceRect";

export interface SurfaceLayoutContract {
  viewportW: number;
  viewportH: number;
  rootX: number;
  rootY: number;
  rootW: number;
  rootH: number;
  leftRatio: number;
  topRatio: number;
  widthRatio: number;
  heightRatio: number;
  fixedX: number;
  fixedY: number;
  fixedW: number;
  fixedH: number;
}

const percentageVariable = (style: CSSStyleDeclaration, name: string): number | null => {
  const raw = style.getPropertyValue(name).trim();
  if (!raw.endsWith("%")) return null;
  const value = Number.parseFloat(raw.slice(0, -1));
  return Number.isFinite(value) ? value / 100 : null;
};

/**
 * GroupArea의 공개 grid 변수와 실제 surface slot 사이의 고정 chrome을 하나의 affine
 * 계약으로 만든다. Tauri AppKit 어댑터는 이 식만 재실행하며 DOM 구조나 플러그인을 해석하지 않는다.
 */
export function surfaceLayoutContractOf(surface: HTMLElement): SurfaceLayoutContract | null {
  const tabBody = surface.closest<HTMLElement>(".tab-body");
  const root = tabBody?.closest<HTMLElement>(".space");
  if (!tabBody || !root) return null;
  const style = getComputedStyle(tabBody);
  const leftRatio = percentageVariable(style, "--l");
  const topRatio = percentageVariable(style, "--t");
  const widthRatio = percentageVariable(style, "--w");
  const heightRatio = percentageVariable(style, "--h");
  if ([leftRatio, topRatio, widthRatio, heightRatio].some((value) => value === null)) return null;

  const frame = surfaceRectOf(surface.getBoundingClientRect());
  const rootFrame = surfaceRectOf(root.getBoundingClientRect());
  const l = leftRatio!;
  const t = topRatio!;
  const w = widthRatio!;
  const h = heightRatio!;
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    rootX: rootFrame.x,
    rootY: rootFrame.y,
    rootW: rootFrame.w,
    rootH: rootFrame.h,
    leftRatio: l,
    topRatio: t,
    widthRatio: w,
    heightRatio: h,
    fixedX: frame.x - rootFrame.x - l * rootFrame.w,
    fixedY: frame.y - rootFrame.y - t * rootFrame.h,
    fixedW: frame.w - w * rootFrame.w,
    fixedH: frame.h - h * rootFrame.h,
  };
}
