// 세로 불분할 명제 — 세로 클린 라인은 전 높이에서 하나의 정체성을 가진다. 제스처 종류와
// 무관하게(드래그·더블클릭 균등화) 어느 세그먼트를 잡든 라인 전체가 함께 움직이고, 제스처는
// 라인을 이동시킬 수 있을 뿐 쪼갤 수 없다. 순수 로직의 단일 소유는 여기 — GroupArea
// 제스처 핸들러·복원(windowSnapshot)은 소비만 한다.
//
// 라인 = x 가 허용오차 안에서 같고 y 구간이 서로 겹치지 않는 세로(row) 디바이더 세그먼트들.
// 같은 y 구간을 공유하는 디바이더는 나란한 다른 라인이지 한 라인의 세그먼트가 아니다 — 이
// 규칙이 조상/자손 디바이더도 배제하므로(자손의 y 는 조상 divider y 의 부분집합) 한 묶음의
// 세그먼트들은 항상 서로 독립인 split 에 산다(한 번의 일괄 적용이 정확하다).
//
// 두 eps 는 역할이 다르다 — 값이 아니라 적용 시점이 경계다:
// · LINE_GROUP_EPS(0.75) = 런타임 규칙. 제스처 시작 시 "같은 라인"으로 묶는 범위.
// · LINE_SNAP_EPS(1.5) = 1회 레거시 치유. vlNormalized 마커 없는 구 스냅샷의 최초
//   복원에서만 토막 라인을 스냅한다(windowSnapshot 이 게이트). 이후 복원은 무변환이라
//   사용자가 런타임 규칙 밖(0.75~1.5)에 둔 별개 라인을 복원이 되쓰지 않는다.

import { computeSplitLayout, type LayoutDivider } from "../lib/splitLayout";
import { resizeSplitTree, type SplitTree } from "./splitTree";

// 패널 최소 분율(해당 split 스팬 기준) — 드래그 클램프와 정규화 가드의 단일 소스.
export const MIN_PANE_FRAC = 0.08;
// 동반 묶음 판정 허용오차(%p) — 제스처 시작 시 같은 라인으로 잡는 범위(런타임 규칙).
export const LINE_GROUP_EPS = 0.75;
// 복원 정규화 허용오차(%p) — 마커 없는 구 스냅샷의 토막 라인을 공통 x 로 스냅하는 범위
// (1회 레거시 치유 전용 — 런타임 경로에서 쓰지 않는다).
export const LINE_SNAP_EPS = 1.5;

const TINY = 1e-9;

export interface LineMove {
  splitId: string;
  sizes: number[];
}

// y 구간이 겹치는가(경계 맞닿음은 겹침이 아니다).
const yOverlaps = (a: LayoutDivider, b: LayoutDivider): boolean =>
  a.rect.top < b.rect.top + b.rect.height - TINY &&
  b.rect.top < a.rect.top + a.rect.height - TINY;

// 제스처 시작 시 앵커와 한 라인을 이루는 세로 디바이더 묶음(앵커 포함, top 오름차순).
// y 가 겹치는 후보(나란한 딴 라인)는 앵커 x 에 가까운 것만 남는다. 허용 구간이 앵커의
// 시작 x 를 담지 못하는 세그먼트(최소폭에 눌린 이웃)는 애초에 묶지 않는다 — 남는 묶음은
// 앵커를 포함하면서 교집합이 시작 x 를 담는 최대 유효 부분집합이고(클램프 공집합 불가),
// 일단 묶인 세그먼트는 제스처가 절대 찢지 않는다.
export function collectLineGroup(
  dividers: LayoutDivider[],
  anchorSplitId: string,
  anchorIndex: number,
  eps: number = LINE_GROUP_EPS,
): LayoutDivider[] {
  const rows = dividers.filter((d) => d.dir === "row");
  const anchor = rows.find(
    (d) => d.splitId === anchorSplitId && d.index === anchorIndex,
  );
  if (!anchor) return [];
  const anchorX = anchor.rect.left;
  const reachesAnchorX = (d: LayoutDivider): boolean => {
    const r = lineGroupRange([d]);
    return anchorX >= r.min - TINY && anchorX <= r.max + TINY;
  };
  const candidates = rows
    .filter(
      (d) =>
        d !== anchor &&
        Math.abs(d.rect.left - anchorX) <= eps &&
        reachesAnchorX(d),
    )
    .sort(
      (a, b) =>
        Math.abs(a.rect.left - anchorX) - Math.abs(b.rect.left - anchorX) ||
        a.rect.top - b.rect.top,
    );
  const group = [anchor];
  for (const c of candidates) {
    if (group.every((m) => !yOverlaps(m, c))) group.push(c);
  }
  return group.sort((a, b) => a.rect.top - b.rect.top);
}

// 묶음이 함께 갈 수 있는 x 구간 = 각 세그먼트 허용 구간의 교집합. 각 구간은 자기 현재 x 를
// 항상 포함한다 — 이미 minFrac 미만인 이웃은 더 줄이지만 않으면 되므로 하한이 0(max(0,…)).
export function lineGroupRange(
  group: LayoutDivider[],
  minFrac: number = MIN_PANE_FRAC,
): { min: number; max: number } {
  let min = 0;
  let max = 100;
  for (const d of group) {
    min = Math.max(
      min,
      d.rect.left - Math.max(0, d.sizes[d.index] - minFrac) * d.spanPct,
    );
    max = Math.min(
      max,
      d.rect.left + Math.max(0, d.sizes[d.index + 1] - minFrac) * d.spanPct,
    );
  }
  return { min, max };
}

// 묶음 전체를 targetX 로(교집합 클램프) — split 별 새 sizes. 반환 x = 실제 이동한 공통 x.
// 세그먼트별 시작 x 가 허용오차 안에서 달라도 전부 같은 x 로 합류한다(라인 통일).
export function moveLineGroup(
  group: LayoutDivider[],
  targetX: number,
  minFrac: number = MIN_PANE_FRAC,
): { x: number; moves: LineMove[] } {
  if (group.length === 0) return { x: targetX, moves: [] };
  const range = lineGroupRange(group, minFrac);
  // collectLineGroup 이 공집합을 차단하지만 임의 묶음 입력에 대한 방어 — 이동하지 않는다.
  if (range.min > range.max + TINY) return { x: group[0].rect.left, moves: [] };
  const x = Math.min(range.max, Math.max(range.min, targetX));
  const sizesBySplit = new Map<string, number[]>();
  for (const d of group) {
    if (d.spanPct <= 0) continue;
    const sizes = sizesBySplit.get(d.splitId) ?? [...d.sizes];
    const delta = (x - d.rect.left) / d.spanPct;
    sizes[d.index] += delta;
    sizes[d.index + 1] -= delta;
    sizesBySplit.set(d.splitId, sizes);
  }
  return {
    x,
    moves: [...sizesBySplit].map(([splitId, sizes]) => ({ splitId, sizes })),
  };
}

// 더블클릭 균등화 — 앵커 divider 의 인접 두 패널이 반반이 되는 목표 x 를 계산해 라인 묶음
// 전체를 그 x 로 이동시킨다(교집합 클램프 포함). 명제는 제스처 종류와 무관하다 — 균등화도
// 드래그와 같은 collectLineGroup+moveLineGroup 경로라 라인이 찢어지지 않는다. 목표가
// 교집합 밖이면 정확한 반반보다 라인 불분할이 우선한다(클램프된 공통 x 에 함께 선다).
export function equalizeLineGroup(
  dividers: LayoutDivider[],
  anchorSplitId: string,
  anchorIndex: number,
): { x: number; moves: LineMove[] } {
  const group = collectLineGroup(dividers, anchorSplitId, anchorIndex);
  const anchor = group.find(
    (d) => d.splitId === anchorSplitId && d.index === anchorIndex,
  );
  if (!anchor) return { x: 0, moves: [] };
  const half = (anchor.sizes[anchorIndex] + anchor.sizes[anchorIndex + 1]) / 2;
  const targetX =
    anchor.rect.left + (half - anchor.sizes[anchorIndex]) * anchor.spanPct;
  return moveLineGroup(group, targetX);
}

// split id → 깊이(루트 0) — 정규화의 조상 우선 적용 순서.
function splitDepths<L>(tree: SplitTree<L>): Map<string, number> {
  const depths = new Map<string, number>();
  const walk = (n: SplitTree<L>, depth: number): void => {
    if (n.type === "leaf") return;
    depths.set(n.id, depth);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(tree, 0);
  return depths;
}

// 복원 1회 정규화(자가 치유) — eps 이내로 어긋난 세로 라인들을 공통 x(최상단 세그먼트의 x)로
// 스냅한다. 동반 드래그 이전의 토막 리사이즈가 남긴 오염을 데이터에서 바로잡는 멱등 변환.
// 스냅이 어느 패널을 "줄이면서 minFrac 미만"으로 만들면 그 세그먼트는 건드리지 않는다
// (치유가 파괴가 되면 안 된다). 변화가 없으면 원본 참조를 그대로 반환한다.
export function normalizeVerticalLines<L>(
  tree: SplitTree<L>,
  eps: number = LINE_SNAP_EPS,
  minFrac: number = MIN_PANE_FRAC,
): SplitTree<L> {
  if (tree.type === "leaf") return tree;
  const rows = computeSplitLayout(tree)
    .dividers.filter((d) => d.dir === "row")
    .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
  // x 근접 클러스터(클러스터 최솟값 기준 eps) → 라인 후보.
  const clusters: LayoutDivider[][] = [];
  for (const d of rows) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && d.rect.left - cluster[0].rect.left <= eps) cluster.push(d);
    else clusters.push([d]);
  }
  // 스냅 계획: 앵커 = 최상단 세그먼트, target = 앵커 x. 이미 정렬된 세그먼트도 계획에
  // 남긴다 — 조상 라인의 스냅이 자손 라인을 통째로 밀어도 적용 시점 재계산이 도로 안착시킨다.
  const plans: { splitId: string; index: number; targetX: number }[] = [];
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const anchor = [...cluster].sort(
      (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
    )[0];
    const targetX = anchor.rect.left;
    const members: LayoutDivider[] = [];
    for (const c of [...cluster].sort(
      (a, b) =>
        Math.abs(a.rect.left - targetX) - Math.abs(b.rect.left - targetX) ||
        a.rect.top - b.rect.top,
    )) {
      if (members.every((m) => !yOverlaps(m, c))) members.push(c);
    }
    if (members.length < 2) continue;
    for (const m of members) {
      plans.push({ splitId: m.splitId, index: m.index, targetX });
    }
  }
  if (plans.length === 0) return tree;
  // 적용은 조상 split 우선 — 조상 sizes 변경이 자손 디바이더 x 를 옮기므로, 얕은 것부터
  // 확정하고 매 적용 전 레이아웃을 다시 계산해 각 세그먼트를 정확히 target 에 안착시킨다.
  const depth = splitDepths(tree);
  plans.sort(
    (a, b) => (depth.get(a.splitId) ?? 0) - (depth.get(b.splitId) ?? 0),
  );
  let current: SplitTree<L> = tree;
  let changed = false;
  for (const plan of plans) {
    const d: LayoutDivider | undefined = computeSplitLayout(
      current,
    ).dividers.find(
      (v) =>
        v.dir === "row" && v.splitId === plan.splitId && v.index === plan.index,
    );
    if (!d || d.spanPct <= 0) continue;
    const delta = (plan.targetX - d.rect.left) / d.spanPct;
    if (Math.abs(delta) <= TINY) continue;
    const sizes: number[] = [...d.sizes];
    const nextA = sizes[plan.index] + delta;
    const nextB = sizes[plan.index + 1] - delta;
    const shrinksBelowMin = (next: number, cur: number) =>
      next < cur - TINY && next < minFrac - TINY;
    if (
      shrinksBelowMin(nextA, sizes[plan.index]) ||
      shrinksBelowMin(nextB, sizes[plan.index + 1])
    ) {
      continue;
    }
    sizes[plan.index] = nextA;
    sizes[plan.index + 1] = nextB;
    current = resizeSplitTree(current, plan.splitId, sizes);
    changed = true;
  }
  return changed ? current : tree;
}
