// 좌 레일 위치 계약. 패널 그리드는 0..100 논리 평면을 유지하고, 레일은 그 평면의
// 깨끗한 세로선에 고정 px 폭의 불연속 구간으로 삽입된다. DOM 포커스나 픽셀 측정은
// 위치의 정본이 아니다: FLOW 입력은 세션 활성 체인의 panel id다.

// 레일은 정박한다 — flow(포커스 추종 이주)는 폐지됐다. 간접 사건(다른 뷰 포커스)이 무관
// 표면(브라우저 등)의 기하를 바꾸는 기능이었고, 기하 소유권 불변식(NATIVE-SURFACES §2)과
// 투영 공리(레일은 서 있는 뼈대 — 포커스는 그 내용만 갈아입는다) 양쪽을 위반했다.
// 레거시 저장값 { mode: "flow" } 는 파서가 현 위치 pin 으로 정규화한다(화면 튐 없음).
export type RailPlacement = { mode: "pin"; station: number };

export interface RailRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RailCell {
  id: string;
  rect: RailRect;
}

export interface RailCssRect extends RailRect {
  /** `railWidthPx`에 곱해 logical left에 더할 계수. */
  railLeft: number;
  /** `railWidthPx`에 곱해 logical width에 더할 계수(항상 0 이하). */
  railWidth: number;
}

export const DEFAULT_RAIL_PLACEMENT: RailPlacement = { mode: "pin", station: 0 };
export const RAIL_EPSILON = 0.01;

const clampStation = (value: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

function epsilonUnique(values: number[], eps: number): number[] {
  const sorted = values.map(clampStation).sort((a, b) => a - b);
  const result: number[] = [];
  let cluster: number[] = [];
  const flush = () => {
    if (cluster.length === 0) return;
    result.push(cluster.reduce((sum, value) => sum + value, 0) / cluster.length);
    cluster = [];
  };
  for (const value of sorted) {
    if (cluster.length === 0 || value - cluster[cluster.length - 1] <= eps) {
      cluster.push(value);
    } else {
      flush();
      cluster.push(value);
    }
  }
  flush();
  return result;
}

/** 어떤 패널 내부도 가로지르지 않는 전체 높이 세로선. */
export function cleanRailLines(
  rects: RailRect[],
  eps: number = RAIL_EPSILON,
): number[] {
  const candidates = epsilonUnique(
    [0, 100, ...rects.flatMap((rect) => [rect.left, rect.left + rect.width])],
    eps,
  );
  return candidates.filter((x) =>
    rects.every(
      (rect) => x <= rect.left + eps || x >= rect.left + rect.width - eps,
    ),
  );
}


/** 그립/PIN 정규화: 가장 가까운 깨끗한 선. 동률이면 앞(왼쪽) 선. */
export function snapRailStation(lines: number[], wanted: number): number {
  const sorted = epsilonUnique(lines, RAIL_EPSILON);
  if (sorted.length === 0) return 0;
  const target = clampStation(wanted);
  let best = sorted[0];
  let distance = Math.abs(target - best);
  for (const line of sorted.slice(1)) {
    const nextDistance = Math.abs(target - line);
    if (nextDistance < distance) {
      best = line;
      distance = nextDistance;
    }
  }
  return best;
}

/** 커밋된 PIN이 실제 깨끗한 선과 정확히 일치하는지 검사한다. */
export function isCleanRailStation(
  lines: number[],
  station: number,
  eps: number = RAIL_EPSILON,
): boolean {
  return (
    Number.isFinite(station) &&
    lines.some((line) => Math.abs(line - station) <= eps)
  );
}

export function effectiveRailStation(
  cells: RailCell[],
  // focusId 는 계약상 무시된다 — 포커스는 레일 위치의 입력이 아니다(이주 폐지의 뜻).
  // 시그니처는 호출측 호환을 위해 유지하고, 값을 읽지 않음을 여기 명시한다.
  _focusId: string | null | undefined,
  placement: RailPlacement | undefined,
  fallback = 0,
): number {
  // 정박 단일 산식 — 요청 station 을 그리드의 깨끗한 선에 스냅한다. 포커스는 입력이 아니다
  // (그것이 flow 폐지의 뜻이다): 같은 배치는 어떤 포커스에서도 같은 선을 답한다.
  return snapRailStation(
    cleanRailLines(cells.map((cell) => cell.rect)),
    placement?.station ?? fallback,
  );
}

type RailSide = "before" | "after";

function sideOf(
  rect: Pick<RailRect, "left" | "width">,
  station: number,
  eps: number = RAIL_EPSILON,
): RailSide {
  const right = rect.left + rect.width;
  if (right <= station + eps) return "before";
  if (rect.left >= station - eps) return "after";
  throw new Error(
    `rail station ${station} crosses panel ${rect.left}..${right}`,
  );
}

/**
 * CSS용 무측정 사상. 최종 left/width는 각각
 * `calc(left% + railLeft * railWidthPx)` / `calc(width% + railWidth * railWidthPx)`.
 */
export function projectRailCssRect(
  rect: RailRect,
  station: number,
): RailCssRect {
  const side = sideOf(rect, station);
  return {
    ...rect,
    railLeft: (side === "after" ? 1 : 0) - rect.left / 100,
    railWidth: -rect.width / 100,
  };
}

export interface RailCssTransition {
  source: RailCssRect;
  target: RailCssRect;
}

/**
 * FLOW 전환의 두 기하를 한 계약으로 투영한다. 출발 station은 출발 rect에,
 * 도착 station은 도착 rect에만 적용한다. 패널 배열과 레일 선이 같은 렌더에서
 * 함께 바뀔 때 서로 다른 시점의 값을 섞으면 유효했던 출발 선이 도착 패널을
 * 가로지르게 되므로, 호출자가 두 project 호출을 따로 조립하지 못하게 한다.
 */
export function projectRailCssTransition(
  sourceRect: RailRect,
  sourceStation: number,
  targetRect: RailRect,
  targetStation: number,
): RailCssTransition {
  return {
    source: projectRailCssRect(sourceRect, sourceStation),
    target: projectRailCssRect(targetRect, targetStation),
  };
}

/**
 * divider처럼 레일을 가로질러도 되는 장식 span의 CSS 사상. 패널에는 사용 금지.
 * 레일을 가로지르는 span은 물리 gap까지 포함하고, 실제 rail frame이 그 위를 덮는다.
 */
export function projectRailCssSpan(
  rect: RailRect,
  station: number,
): RailCssRect {
  const right = rect.left + rect.width;
  if (right <= station + RAIL_EPSILON || rect.left >= station - RAIL_EPSILON) {
    return projectRailCssRect(rect, station);
  }
  return {
    ...rect,
    railLeft: -rect.left / 100,
    railWidth: 1 - rect.width / 100,
  };
}

/** 픽셀 기준 참조 사상(테스트·UI drag 계산용). top/height는 세로 논리값 그대로다. */
export function projectRailRect(
  rect: RailRect,
  station: number,
  hostWidthPx: number,
  railWidthPx: number,
): RailRect {
  const side = sideOf(rect, station);
  const panelWidth = Math.max(0, hostWidthPx - railWidthPx);
  return {
    left:
      (panelWidth * rect.left) / 100 +
      (side === "after" ? railWidthPx : 0),
    top: rect.top,
    width: (panelWidth * rect.width) / 100,
    height: rect.height,
  };
}

export function railLeftPx(
  hostWidthPx: number,
  railWidthPx: number,
  station: number,
): number {
  return (
    (Math.max(0, hostWidthPx - railWidthPx) * clampStation(station)) / 100
  );
}

/** 그립이 가리키는 물리 left를 고정폭 레일의 논리 station(0..100)으로 되돌린다. */
export function railStationFromLeftPx(
  railLeft: number,
  hostWidthPx: number,
  railWidthPx: number,
): number {
  const panelWidth = Math.max(0, hostWidthPx - railWidthPx);
  if (panelWidth === 0) return 0;
  return clampStation((railLeft / panelWidth) * 100);
}

/**
 * 레일이 삽입된 물리 x(컨테이너 좌측 기준)를 연속 논리 패널 px로 되돌린다.
 * 레일 내부는 패널이 아니므로 null(R8 레일 불가침).
 */
export function unprojectRailX(
  physicalX: number,
  hostWidthPx: number,
  railWidthPx: number,
  station: number,
): number | null {
  const railLeft = railLeftPx(hostWidthPx, railWidthPx, station);
  if (physicalX < railLeft) return physicalX;
  if (physicalX > railLeft + railWidthPx) return physicalX - railWidthPx;
  return null;
}

export function normalizeRailPlacement(value: unknown): RailPlacement {
  const placement = (value ?? {}) as { mode?: unknown; station?: unknown };
  if (
    typeof placement.station === "number" &&
    Number.isFinite(placement.station) &&
    placement.station >= 0 &&
    placement.station <= 100
  ) {
    return { mode: "pin", station: placement.station };
  }
  // 레거시 flow(또는 손상된 값) — 정박 기본선으로 정규화한다. 이주 기능은 폐지됐다.
  return DEFAULT_RAIL_PLACEMENT;
}
