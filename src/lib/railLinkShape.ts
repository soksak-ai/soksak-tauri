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

/** SVG viewport 경계에 놓인 stroke의 바깥 절반이 clip되지 않도록 외곽선만 안으로 넣는다. */
export function insetClippedEdges(
  points: Point[],
  width: number,
  height: number,
  inset: number,
): Point[] {
  const amount = Math.max(0, inset);
  return points.map(({ x, y }) => ({
    x: x <= 0 ? amount : x >= width ? Math.max(amount, width - amount) : x,
    y: y <= 0 ? amount : y >= height ? Math.max(amount, height - amount) : y,
  }));
}

// 비인접 억제 허용오차(논리 %p). 결부 셀은 항상 clean line(레일 station)에서 시작하므로
// 이보다 큰 간격은 부동소수 오차가 아니라 상자가 아직 레일에 안 닿은 중간 상태다.
export const RAIL_LINK_ADJACENT_TOLERANCE = 1;

/**
 * 레일과 결부 상자를 한 테두리로 그릴 것인가 — 관계면 렌더 게이트.
 *
 * 결부 상자는 **레일에서 시작한다**(App 이 그렇게 만든다: 레일부터 결합 판의 오른쪽 끝까지).
 * 그래서 여기서 모드를 알 필요가 없다 — 당기든 레일이 가든 상자의 왼쪽 변은 station 이다.
 * 간격이 벌어졌다면 그것은 아직 안 온 중간 상태이므로 억제한다.
 */
export function railLinkAdjacent(station: number, target: RailRect): boolean {
  return Math.abs(target.left - station) <= RAIL_LINK_ADJACENT_TOLERANCE;
}

/** 논리 패널 rect와 고정폭 레일을 같은 px 좌표계로 해소한다. */
export function railLinkBoxes(
  hostWidth: number,
  hostHeight: number,
  railWidth: number,
  station: number,
  target: RailRect,
  /** 오른쪽에서 판을 밀고 들어온 폭(밀기 사이드바). 안 빼면 칸이 호스트 밖으로 나간다. */
  rightInset = 0,
): { rail: PixelBox; panel: PixelBox } | null {
  if (hostWidth <= 0 || hostHeight <= 0 || railWidth <= 0) return null;
  const projected = projectRailRect(target, station, hostWidth, railWidth, rightInset);
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
  const paneRight = panel.x + panel.width;
  const paneBottom = panel.y + panel.height;
  return compact([
    { x: rail.x, y: rail.y },
    { x: railRight, y: rail.y },
    { x: railRight, y: panel.y },
    { x: paneRight, y: panel.y },
    { x: paneRight, y: paneBottom },
    { x: railRight, y: paneBottom },
    { x: railRight, y: rail.y + rail.height },
    { x: rail.x, y: rail.y + rail.height },
  ]);
}

const fmt = (value: number) => Number(value.toFixed(2)).toString();

interface RoundedCorner {
  current: Point;
  before: Point;
  after: Point;
}

// 코너 라운딩 산출 — 닫힌 경로·분리 경로가 같은 기하를 공유한다(형태 불변 계약).
function roundedCorners(points: Point[], radius: number): RoundedCorner[] {
  return points.map((current, index) => {
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
}

/** 직교 다각형을 테마 radius로 라운딩한 SVG path. */
export function roundedOrthogonalPath(points: Point[], radius: number): string {
  if (points.length < 3) return "";
  if (radius <= 0) {
    return `${points.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p.x)} ${fmt(p.y)}`).join(" ")} Z`;
  }
  const corners = roundedCorners(points, radius);
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


/** B안(변 점선)의 라운드 보존 분리 — 최우측 수직 변을 찾아, 점선은 그 변의 두 코너
 * 아크 "사이" 직선 구간만, 실선은 코너 아크를 포함한 나머지 전부(열린 경로)로 나눈다.
 * 합치면 원래 라운드 외곽선과 동일한 형태다(형태 불변 계약 — 직각 모서리 금지). */
export function splitRightEdgeRounded(
  points: Point[],
  radius: number,
): { solid: string; edge: [Point, Point] } | null {
  if (points.length < 3) return null;
  const maxX = Math.max(...points.map((p) => p.x));
  const eps = 1e-6;
  let start = -1;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.abs(a.x - maxX) < eps && Math.abs(b.x - maxX) < eps) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const corners = roundedCorners(points, Math.max(radius, 0));
  const a = corners[start]; // 변의 시작 코너 — 아크는 실선 소유, after 가 점선 시작점.
  const b = corners[(start + 1) % points.length]; // 변의 끝 코너 — before 가 점선 끝점.
  const parts: string[] = [`M ${fmt(b.before.x)} ${fmt(b.before.y)}`];
  for (let k = 1; k <= points.length; k += 1) {
    const c = corners[(start + k) % points.length];
    if (k > 1) parts.push(`L ${fmt(c.before.x)} ${fmt(c.before.y)}`);
    parts.push(
      `Q ${fmt(c.current.x)} ${fmt(c.current.y)} ${fmt(c.after.x)} ${fmt(c.after.y)}`,
    );
  }
  return { solid: parts.join(" "), edge: [a.after, b.before] };
}