import {
  projectRailRect,
  railLeftPx,
  type RailRect,
} from "./railPlacement";

export interface Point {
  x: number;
  y: number;
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 논리 패널 rect와 고정폭 레일을 같은 px 좌표계로 해소한다. */
export function railLinkBoxes(
  hostWidth: number,
  hostHeight: number,
  railWidth: number,
  station: number,
  target: RailRect,
): { rail: PixelBox; panel: PixelBox } | null {
  if (hostWidth <= 0 || hostHeight <= 0 || railWidth <= 0) return null;
  const projected = projectRailRect(target, station, hostWidth, railWidth);
  return {
    rail: {
      x: railLeftPx(hostWidth, railWidth, station),
      y: 0,
      width: railWidth,
      height: hostHeight,
    },
    panel: {
      x: projected.left,
      y: (target.top / 100) * hostHeight,
      width: projected.width,
      height: (target.height / 100) * hostHeight,
    },
  };
}

function compact(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    if (point.x === previous.x && point.y === previous.y) return false;
    return !(
      (previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)
    );
  });
}

/**
 * 전체 높이 rail과 바로 오른쪽 panel의 합집합 외곽선. 떨어진 패널은 중간 패널을
 * 관계 표면으로 오인시키므로 null이다.
 */
export function railLinkPolygon(
  rail: PixelBox,
  panel: PixelBox,
  epsilon = 0.5,
): Point[] | null {
  const railRight = rail.x + rail.width;
  if (Math.abs(panel.x - railRight) > epsilon) return null;
  const panelRight = panel.x + panel.width;
  const panelBottom = panel.y + panel.height;
  return compact([
    { x: rail.x, y: rail.y },
    { x: railRight, y: rail.y },
    { x: railRight, y: panel.y },
    { x: panelRight, y: panel.y },
    { x: panelRight, y: panelBottom },
    { x: railRight, y: panelBottom },
    { x: railRight, y: rail.y + rail.height },
    { x: rail.x, y: rail.y + rail.height },
  ]);
}

const fmt = (value: number) => Number(value.toFixed(2)).toString();

/** 직교 다각형을 테마 radius로 라운딩한 SVG path. */
export function roundedOrthogonalPath(points: Point[], radius: number): string {
  if (points.length < 3) return "";
  if (radius <= 0) {
    return `${points.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p.x)} ${fmt(p.y)}`).join(" ")} Z`;
  }
  const corners = points.map((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const beforeLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const afterLength = Math.hypot(next.x - current.x, next.y - current.y);
    const r = Math.min(radius, beforeLength / 2, afterLength / 2);
    const toward = (other: Point, distance: number): Point => ({
      x: current.x + ((other.x - current.x) / Math.hypot(other.x - current.x, other.y - current.y)) * distance,
      y: current.y + ((other.y - current.y) / Math.hypot(other.x - current.x, other.y - current.y)) * distance,
    });
    return { current, before: toward(previous, r), after: toward(next, r) };
  });
  const last = corners[corners.length - 1];
  return [
    `M ${fmt(last.after.x)} ${fmt(last.after.y)}`,
    ...corners.flatMap(({ current, before, after }) => [
      `L ${fmt(before.x)} ${fmt(before.y)}`,
      `Q ${fmt(current.x)} ${fmt(current.y)} ${fmt(after.x)} ${fmt(after.y)}`,
    ]),
    "Z",
  ].join(" ");
}
