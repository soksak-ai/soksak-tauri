import type { SplitTree } from "../state/splitTree";
import { computeSplitLayout } from "./splitLayout";
import { cleanRailLines, isCleanRailStation } from "./railPlacement";

type Identified = { id: string };

function swapDirectRowSiblingToFront<L extends Identified>(
  node: SplitTree<L>,
  targetId: string,
): SplitTree<L> | null {
  if (node.type === "leaf") return null;
  if (node.dir === "row") {
    const targetIndex = node.children.findIndex(
      (child) => child.type === "leaf" && child.value.id === targetId,
    );
    // 이 정책은 패널 대 패널 교환만 한다. subtree를 통째로 옮기거나 중첩 구조를
    // 재작성하지 않는다.
    if (
      targetIndex > 0 &&
      node.children[0]?.type === "leaf" &&
      Math.abs(node.sizes[0] - node.sizes[targetIndex]) < 1e-9
    ) {
      const children = [...node.children];
      [children[0], children[targetIndex]] = [
        children[targetIndex],
        children[0],
      ];
      return { ...node, children };
    }
  }
  for (let i = 0; i < node.children.length; i += 1) {
    const child = swapDirectRowSiblingToFront(node.children[i], targetId);
    if (!child) continue;
    const children = [...node.children];
    children[i] = child;
    return { ...node, children };
  }
  return null;
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
 * 정본 SplitTree는 쓰거나 변이하지 않으므로 다른 포커스로 바뀌면 원본 배열이 즉시 복원된다.
 */
export function projectFocusedPanelNearRail<L extends Identified>(
  canonical: SplitTree<L>,
  focusId: string,
  enabled: boolean,
): SplitTree<L> {
  if (!enabled || targetHasCleanLeft(canonical, focusId)) return canonical;
  const candidate = swapDirectRowSiblingToFront(canonical, focusId);
  if (!candidate || !targetHasCleanLeft(candidate, focusId)) return canonical;
  return candidate;
}
