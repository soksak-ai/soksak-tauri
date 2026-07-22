import type { SplitTree } from "../state/splitTree";
import { computeSplitLayout } from "./splitLayout";
import { cleanRailLines, isCleanRailStation } from "./railPlacement";

type Identified = { id: string };

function swapRowSiblingCandidates<L extends Identified>(
  node: SplitTree<L>,
  targetId: string,
): SplitTree<L>[] {
  if (node.type === "leaf") return [];
  if (node.dir === "row") {
    const targetIndex = node.children.findIndex(
      (child) => child.type === "leaf" && child.value.id === targetId,
    );
    if (targetIndex > 0) {
      // 이 정책은 패널 대 패널 교환만 한다. subtree를 통째로 옮기거나 중첩 구조를
      // 재작성하지 않는다. 후보는 **가까운 왼쪽 형제부터**(최소 이동) — 채택자는
      // 처음으로 깨끗한 선에 닿는 후보에서 멈추므로, 멀리 있는 포커스라도 비참여
      // 패널들은 제자리에 남는다.
      const out: SplitTree<L>[] = [];
      for (let j = targetIndex - 1; j >= 0; j -= 1) {
        const sibling = node.children[j];
        if (sibling.type !== "leaf") continue;
        if (Math.abs(node.sizes[j] - node.sizes[targetIndex]) >= 1e-9) continue;
        const children = [...node.children];
        [children[j], children[targetIndex]] = [
          children[targetIndex],
          children[j],
        ];
        out.push({ ...node, children });
      }
      return out;
    }
  }
  for (let i = 0; i < node.children.length; i += 1) {
    const subs = swapRowSiblingCandidates(node.children[i], targetId);
    if (subs.length === 0) continue;
    return subs.map((child) => {
      const children = [...node.children];
      children[i] = child;
      return { ...node, children };
    });
  }
  return [];
}

function targetHasCleanLeft<L extends Identified>(
  tree: SplitTree<L>,
  targetId: string,
): boolean {
  const { cells } = computeSplitLayout(tree);
  const target = cells.find((cell) => cell.value.id === targetId);
  if (!target) return false;
  const cleanLines = cleanRailLines(cells.map((cell) => cell.rect));
  return isCleanRailStation(cleanLines, target.rect.left);
}

/**
 * FLOW의 선택적 화면 투영. 포커스 패널의 왼쪽 선이 다른 패널에 막힌 경우에만
 * 같은 row의 직접 형제와 자리를 바꾸고, 그 결과가 실제 깨끗한 선일 때만 채택한다.
 * 교환은 가까운 왼쪽 형제부터 — 비참여 패널은 제자리(최소 이동).
 * 정본 SplitTree는 쓰거나 변이하지 않으므로 다른 포커스로 바뀌면 원본 배열이 즉시 복원된다.
 */
export function projectFocusedPanelNearRail<L extends Identified>(
  canonical: SplitTree<L>,
  focusId: string,
  enabled: boolean,
): SplitTree<L> {
  if (!enabled || targetHasCleanLeft(canonical, focusId)) return canonical;
  // 후보를 가까운 왼쪽 형제부터 시도해 처음 깨끗해지는 배열에서 멈춘다 — 이동은 항상
  // 최소다(전역 재배열 금지). 어떤 후보도 깨끗한 선에 닿지 못하면 원본 그대로.
  for (const candidate of swapRowSiblingCandidates(canonical, focusId)) {
    if (targetHasCleanLeft(candidate, focusId)) return candidate;
  }
  return canonical;
}
