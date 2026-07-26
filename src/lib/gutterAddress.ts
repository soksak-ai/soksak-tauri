// 골(gutter) 주소 해소 — 배치 트리 내부 노드를 부르지 않고 이음선을 지목하는 유일한 길.
//
// [규칙] 내부(split) 노드는 이름이 없다(IDENTITY §4). 그런데 이음선은 조작 대상이므로 불려야
// 한다. 정리가 그 둘을 화해시킨다: **모든 골은 어떤 pane 의 right/bottom 모서리와 일치한다.**
// 노드 N(축 A)의 자식 cᵢ·cᵢ₊₁ 사이 이음선은 cᵢ 의 뒤쪽 면이고, cᵢ 의 부분트리에는 그 면에 닿는
// leaf 가 반드시 있다 — cᵢ 가 N 과 같은 축이면 마지막 자식으로, 수직이면 아무 자식으로 내려가면
// 되고 재귀는 유한하다. 그래서 이름 없는 것을 부를 필요 자체가 없다.
//
// 정본은 **그 골에 닿는 문서순 첫 pane** 의 right|bottom 이다(다른 pane 의 모서리는 별칭이고,
// 응답은 항상 정본형으로 되돌린다). 문서순 첫 leaf 를 고르므로 수직 갈래에서는 첫 자식으로
// 내려간다 — 정리의 "아무 자식"을 정본이 하나로 좁힌 지점이 여기다.
//
// left|top 은 입력 별칭이다: 그 pane 의 앞쪽 이음선을 뜻하고, 같은 골의 정본은 앞 형제 쪽에서
// 나온다. 별칭을 해소만 하고 되돌려주지는 않는다(정본형 단일화).
//
// 이 파일은 순수 함수만 담는다 — 트리를 읽고 값을 돌려줄 뿐 DOM·스토어를 모른다. GroupArea 가
// data-node 주소와 hover 키를, 명령 층이 파라미터 해소를 같은 함수로 받는다(기준 두 벌 금지).

import type { SplitTree } from "../state/splitTree";

/** 정본 두 방향 + 입력 별칭 두 방향. */
export type GutterSide = "right" | "bottom" | "left" | "top";
export type CanonicalSide = "right" | "bottom";

/** row 분할의 이음선은 세로선이라 왼쪽 칸의 right 변, col 은 위쪽 칸의 bottom 변이다. */
export const canonicalSide = (dir: "row" | "col"): CanonicalSide =>
  dir === "row" ? "right" : "bottom";

/** 그 방향이 사는 분할 축. right|left = row(세로 이음선), bottom|top = col. */
export const axisOfSide = (side: GutterSide): "row" | "col" =>
  side === "right" || side === "left" ? "row" : "col";

/** 정본 방향인가 — 아니면 앞쪽 이음선을 가리키는 별칭이다. */
export const isCanonicalSide = (side: GutterSide): side is CanonicalSide =>
  side === "right" || side === "bottom";

/** 주소 문자열 한 곳 — 형식을 두 군데서 조립하면 갈라진다. */
export const gutterAddress = (paneId: string, side: CanonicalSide): string =>
  `gutter/${paneId}/${side}`;

/** 부분트리에서 그 축의 뒤쪽 면에 닿는 문서순 첫 leaf. 위 정리의 재귀 그대로. */
function firstLeafOnTrailingFace<L>(node: SplitTree<L>, axis: "row" | "col"): L {
  if (node.type === "leaf") return node.value;
  const next =
    node.dir === axis
      ? node.children[node.children.length - 1] // 같은 축 — 뒤쪽 면은 마지막 자식이 갖는다
      : node.children[0]; // 수직 — 모든 자식이 닿으므로 문서순 첫 자식이 정본
  return firstLeafOnTrailingFace(next, axis);
}

/** splitId 로 split 노드 찾기(내부용 — 이 id 는 밖으로 나가지 않는다). */
function splitNodeById<L>(
  node: SplitTree<L>,
  splitId: string,
): Extract<SplitTree<L>, { type: "split" }> | null {
  if (node.type === "leaf") return null;
  if (node.id === splitId) return node;
  for (const c of node.children) {
    const hit = splitNodeById(c, splitId);
    if (hit) return hit;
  }
  return null;
}

/**
 * 내부 좌표(splitId, index) → 정본 골 주소의 두 조각. 렌더러만 쓴다 — 렌더러는 트리를 이미
 * 손에 들고 있고, 그 자리에서 이름 있는 좌표로 바꿔 DOM 에 새긴다. 밖으로는 결과만 나간다.
 */
export function gutterOwnerOf<L>(
  tree: SplitTree<L>,
  splitId: string,
  index: number,
  idOf: (leaf: L) => string,
): { pane: string; side: CanonicalSide } | null {
  const node = splitNodeById(tree, splitId);
  if (!node) return null;
  if (index < 0 || index >= node.children.length - 1) return null; // 마지막 자식 뒤엔 골이 없다
  return {
    pane: idOf(firstLeafOnTrailingFace(node.children[index], node.dir)),
    side: canonicalSide(node.dir),
  };
}

/** 뿌리→그 leaf 경로. 각 칸은 "이 split 의 몇 번째 자식으로 내려갔는가". */
function pathToLeaf<L>(
  node: SplitTree<L>,
  paneId: string,
  idOf: (leaf: L) => string,
): { node: Extract<SplitTree<L>, { type: "split" }>; childIndex: number }[] | null {
  if (node.type === "leaf") return idOf(node.value) === paneId ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const below = pathToLeaf(node.children[i], paneId, idOf);
    if (below) return [{ node, childIndex: i }, ...below];
  }
  return null;
}

/**
 * 골 주소 → 내부 좌표. 역사상은 유일하다: pane 의 부분트리가 마지막 자식이 아닌 **가장 가까운
 * 같은 축 조상**이 그 골을 소유한다(별칭 방향이면 첫 자식이 아닌 조상, 그 앞 이음선).
 * 못 풀면 null — 그 pane 의 그 변에는 골이 없다(배치 바깥 모서리).
 */
export function resolveGutter<L>(
  tree: SplitTree<L>,
  paneId: string,
  side: GutterSide,
  idOf: (leaf: L) => string,
): { splitId: string; index: number } | null {
  const path = pathToLeaf(tree, paneId, idOf);
  if (!path) return null;
  const axis = axisOfSide(side);
  const trailing = isCanonicalSide(side);
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, childIndex } = path[i];
    if (node.dir !== axis) continue;
    if (trailing) {
      if (childIndex < node.children.length - 1) {
        return { splitId: node.id, index: childIndex };
      }
    } else if (childIndex > 0) {
      return { splitId: node.id, index: childIndex - 1 };
    }
  }
  return null;
}

/**
 * 별칭을 정본형으로 되돌린다 — 응답은 언제나 정본 하나를 말한다(IDENTITY §4·§6).
 * 못 풀리는 변은 null.
 */
export function canonicalGutter<L>(
  tree: SplitTree<L>,
  paneId: string,
  side: GutterSide,
  idOf: (leaf: L) => string,
): { pane: string; side: CanonicalSide } | null {
  const inner = resolveGutter(tree, paneId, side, idOf);
  if (!inner) return null;
  return gutterOwnerOf(tree, inner.splitId, inner.index, idOf);
}
