// 배치 해결기 — 좌 레일의 위치와 패널 배열은 (그리드, 포커스)의 순수 함수다.
//
// 이 계산은 여기 하나뿐이다. station·스위칭·만들어진 인접·이동량을 같은 해에서 뽑지 않으면
// 서로 어긋나고, 그 어긋남이 "때로는 되고 때로는 안 되는" 결함으로 나타난다(흩어진 재계산이
// 실제 원인이었다). 소비자는 해를 읽을 뿐 다시 계산하지 않는다.
//
// 불변식: 해의 station 은 그 해의 셀들에 대해 항상 깨끗한 선이다(어떤 패널도 가로지르지 않음).
// 그래서 소비자는 projectRailCssRect 를 안전하게 쓸 수 있다.

import { leavesOf, type SplitTree } from "../state/splitTree";
import { computeSplitLayout, type Rect } from "./splitLayout";
import {
  RAIL_EPSILON,
  cleanRailLines,
  isCleanRailStation,
  projectRailCssRect,
  projectRailCssSpan,
  snapRailStation,
  type RailPlacement,
} from "./railPlacement";

const FULL_RECT: Rect = { left: 0, top: 0, width: 100, height: 100 };

// 이동 판정 하한 — 이 아래는 리사이즈·균등화가 남긴 float 오차다. 오차를 이동으로 세면
// 탭 전환마다 유령 주행 위상이 열려 화면의 모든 표면이 위상 비용을 문다(실사고).
const MOVE_EPSILON_PCT = 0.05;
const MOVE_EPSILON_RAIL = 0.005;

export interface ArrangementCell {
  id: string;
  rect: Rect;
}

export interface Arrangement<L> {
  /** 레일이 삽입되는 논리 세로선(0..100). 해의 셀들에 대해 항상 깨끗하다. */
  station: number;
  cleanLines: number[];
  /** 화면에 그릴 배열. 스위칭이 없으면 정본과 객체 정체성이 같다. */
  displayLayout: SplitTree<L>;
  /** 인접이 교환으로 만들어졌는가 — 점선 봉합의 단일 근거(자연 인접은 무표시). */
  swapped: boolean;
  cells: ArrangementCell[];
  focusId: string | null;
}

export interface ArrangementMove {
  id: string;
  /** 컨테이너 폭 기준 % 이동(배열 교환). */
  dLeftPct: number;
  /** 레일 폭 배수 이동(삽입 지점 변화). */
  dRailUnits: number;
}

/** 포커스 패널의 왼쪽 선이 이미 전 높이 깨끗한 선인가. 없는 포커스는 배열을 흔들 근거가 아니다. */
function focusedLeftIsClean<L extends { id: string }>(
  tree: SplitTree<L>,
  focusId: string,
): boolean {
  const { cells } = computeSplitLayout(tree);
  const target = cells.find((cell) => cell.value.id === focusId);
  if (!target) return true;
  return isCleanRailStation(
    cleanRailLines(cells.map((cell) => cell.rect)),
    target.rect.left,
  );
}

/**
 * 교환 후보 — 같은 row 의 **직접 leaf 형제**와 자리를 맞바꾼 트리들. 가까운 왼쪽부터 낸다.
 * 이동은 항상 최소여야 한다: 채택자가 처음 깨끗해지는 후보에서 멈추므로 멀리 있는 포커스라도
 * 비참여 패널은 제자리다. sizes 도 함께 교환한다 — 폭이 다른 형제라도 각 패널은 자기 폭
 * 그대로 위치만 맞바꾸므로 어떤 콘텐츠도 늘거나 줄지 않는다.
 * subtree 를 통째로 옮기거나 중첩 구조를 재작성하지 않는다.
 */
function swapCandidates<L extends { id: string }>(
  node: SplitTree<L>,
  targetId: string,
): SplitTree<L>[] {
  if (node.type === "leaf") return [];
  if (node.dir === "row") {
    const targetIndex = node.children.findIndex(
      (child) => child.type === "leaf" && child.value.id === targetId,
    );
    if (targetIndex > 0) {
      const out: SplitTree<L>[] = [];
      for (let j = targetIndex - 1; j >= 0; j -= 1) {
        if (node.children[j].type !== "leaf") continue;
        const children = [...node.children];
        [children[j], children[targetIndex]] = [
          children[targetIndex],
          children[j],
        ];
        const sizes = [...node.sizes];
        [sizes[j], sizes[targetIndex]] = [sizes[targetIndex], sizes[j]];
        out.push({ ...node, children, sizes });
      }
      return out;
    }
  }
  for (let i = 0; i < node.children.length; i += 1) {
    const subs = swapCandidates(node.children[i], targetId);
    if (subs.length === 0) continue;
    return subs.map((child) => {
      const children = [...node.children];
      children[i] = child;
      return { ...node, children };
    });
  }
  return [];
}

/** 행별 세로선이 안 맞아 막힌 포커스를 앞으로 스위칭한다. 실패하면 정본 그대로(정체성 보존). */
function switchFocusedToFront<L extends { id: string }>(
  canonical: SplitTree<L>,
  focusId: string,
): SplitTree<L> {
  if (focusedLeftIsClean(canonical, focusId)) return canonical;
  for (const candidate of swapCandidates(canonical, focusId)) {
    if (focusedLeftIsClean(candidate, focusId)) return candidate;
  }
  return canonical;
}

/** FLOW: 포커스 패널의 왼쪽 선, 막혔으면 그 앞(왼쪽)의 가장 가까운 깨끗한 선. */
function flowStation(
  cells: ArrangementCell[],
  focusId: string | null,
  cleanLines: number[],
  fallback: number,
): number {
  const focused = cells.find((cell) => cell.id === focusId);
  // 미해소 포커스는 무의견이다 — 0(맨 앞)으로 가라는 결정이 아니라 현 위치를 지키라는 뜻이다.
  // 포커스 전환의 중간 렌더마다 조회가 비어 station 이 0 으로 붕괴했고, 그 왕복이 레일 rect
  // 무변화의 유령 전역 위상을 열어 화면의 모든 브라우저에 펄스를 먹였다(실사고).
  if (!focused) return snapRailStation(cleanLines, fallback);
  let station = 0;
  for (const line of cleanLines) {
    if (line <= focused.rect.left + RAIL_EPSILON) station = line;
    else break;
  }
  return station;
}

export function solveArrangement<L extends { id: string }>(input: {
  layout: SplitTree<L>;
  focusId: string | null | undefined;
  placement: RailPlacement;
  /** 사이드바가 열려 있는가 — 닫혀 있으면 붙을 레일이 없다. */
  railOpen: boolean;
  /** 최대화된 패널 id — 있으면 밑 분할이 아니라 [레일 | 기능] 단일 평면이다. */
  maximizedId?: string | null;
  /** 미해소 포커스에서 지킬 현 위치. */
  fallbackStation?: number;
}): Arrangement<L> {
  const focusId = input.focusId ?? null;

  if (input.maximizedId) {
    const cells = [{ id: input.maximizedId, rect: FULL_RECT }];
    const cleanLines = cleanRailLines([FULL_RECT]);
    return {
      station:
        input.placement.mode === "pin"
          ? snapRailStation(cleanLines, input.placement.station)
          : 0,
      cleanLines,
      displayLayout: input.layout,
      swapped: false,
      cells,
      focusId,
    };
  }

  // 스위칭은 레일이 실제로 포커스를 따라갈 때만 뜻이 있다 — PIN 이거나 사이드바가 닫혀 있으면
  // 붙을 상대가 없으므로 배열을 건드리지 않는다.
  const displayLayout =
    input.railOpen && input.placement.mode === "flow" && focusId
      ? switchFocusedToFront(input.layout, focusId)
      : input.layout;

  const cells = computeSplitLayout(displayLayout).cells.map(({ value, rect }) => ({
    id: value.id,
    rect,
  }));
  const cleanLines = cleanRailLines(cells.map((cell) => cell.rect));

  return {
    station:
      input.placement.mode === "pin"
        ? snapRailStation(cleanLines, input.placement.station)
        : flowStation(cells, focusId, cleanLines, input.fallbackStation ?? 0),
    cleanLines,
    displayLayout,
    swapped: displayLayout !== input.layout,
    cells,
    focusId,
  };
}

/**
 * 두 배치 사이의 이동량. 위상 시작 시점의 시각 오프셋(옛 위치 − 새 위치)을 논리 델타로 낸다:
 * 배열 교환은 컨테이너 % 로, 삽입 지점 변화는 레일 폭 배수로. 두 축은 단위가 달라 한 숫자로
 * 접을 수 없다 — 합성은 실측 폭을 가진 소비자가 moveOffsetPx 로 한 번 한다. 두 축을 각자
 * 다른 곳에서 보간하면 둘이 동시에 바뀌는 위상(스위칭 + 주행)에서 어긋난다.
 *
 * 목록에는 실제로 움직이는 패널만 담긴다 — 델타 0 요소에 애니메이션·레이어 승격을 얹으면
 * 무관한 표면이 위상마다 재래스터 비용을 문다(실사고).
 */
export function arrangementMoves<L>(
  from: Arrangement<L>,
  to: Arrangement<L>,
): ArrangementMove[] {
  const moves: ArrangementMove[] = [];
  for (const cell of to.cells) {
    const before = from.cells.find((item) => item.id === cell.id);
    if (!before) continue; // 새로 생긴 패널은 이동이 아니라 등장이다
    const dLeftPct = before.rect.left - cell.rect.left;
    const dRailUnits =
      projectRailCssRect(before.rect, from.station).railLeft -
      projectRailCssRect(cell.rect, to.station).railLeft;
    if (
      Math.abs(dLeftPct) < MOVE_EPSILON_PCT &&
      Math.abs(dRailUnits) < MOVE_EPSILON_RAIL
    ) {
      continue;
    }
    moves.push({ id: cell.id, dLeftPct, dRailUnits });
  }
  return moves;
}

/** 논리 이동량 → 물리 오프셋(px). 컨테이너 폭은 측정값이므로 합성은 소비자가 소유한다. */
export function moveOffsetPx(
  move: ArrangementMove,
  hostWidthPx: number,
  railWidthPx: number,
): number {
  return (hostWidthPx * move.dLeftPct) / 100 + railWidthPx * move.dRailUnits;
}

/**
 * 장식 span(디바이더·드롭 표시)의 이동량. span 은 패널이 아니라 복도의 일부다 — 배열 교환에
 * 참여하지 않으므로 이동의 유일한 원천은 삽입 지점 변화이고, 레일을 관통하는 span 은 물리 gap
 * 까지 포함해 사상된다(패널 규칙과 구분).
 *
 * 이 값이 0 이면 셀은 활강하는데 span 만 t0 에 도착지로 순간이동해 위상 내내 화면이 찢긴다 —
 * 복도 동조(§12-③)의 실패 모드다. 그래서 패널 이동량과 같은 타입·같은 합성 함수를 쓴다.
 */
export function spanMoveAcross(
  rect: Rect,
  fromStation: number,
  toStation: number,
): ArrangementMove {
  return {
    id: "",
    dLeftPct: 0,
    dRailUnits:
      projectRailCssSpan(rect, fromStation).railLeft -
      projectRailCssSpan(rect, toStation).railLeft,
  };
}

/**
 * 이동량이 지시한 패널들의 뷰 id. 동결·veil·활강 전제가 모두 이 집합으로만 간다 — 움직이지
 * 않는 표면은 위상 내내 라이브로 남고 통지조차 받지 않는다. 판정과 렌더가 같은 규칙을 써야
 * "전제는 덮을 수 있다고 했는데 다른 표면이 움직인다"가 생기지 않는다.
 */
export function viewIdsOfMoves<
  L extends { id: string; tabs: ReadonlyArray<{ id: string }> },
>(layout: SplitTree<L>, moves: readonly ArrangementMove[]): string[] {
  if (moves.length === 0) return [];
  const groups = leavesOf(layout);
  return moves.flatMap(
    (move) => groups.find((g) => g.id === move.id)?.tabs.map((v) => v.id) ?? [],
  );
}
