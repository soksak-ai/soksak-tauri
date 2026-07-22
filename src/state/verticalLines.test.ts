import { describe, it, expect } from "vitest";
import { computeSplitLayout } from "../lib/splitLayout";
import { cleanRailLines } from "../lib/railPlacement";
import { resizeSplitTree, splitLeaf, type SplitTree } from "./splitTree";
import {
  LINE_GROUP_EPS,
  LINE_SNAP_EPS,
  MIN_PANE_FRAC,
  collectLineGroup,
  lineGroupRange,
  moveLineGroup,
  normalizeVerticalLines,
} from "./verticalLines";

// 세로 불분할 명제 — 세로 클린 라인은 전 높이에서 하나의 정체성을 가진다. 어느 세그먼트를
// 끌든 라인 전체가 함께 움직이고, 드래그는 라인을 이동시킬 수 있을 뿐 쪼갤 수 없다.
// 여기 테스트는 L=string 으로 순수 로직(묶음 수집·교집합 클램프·이동·복원 정규화)을 강제한다.

function split<L>(
  id: string,
  dir: "row" | "col",
  sizes: number[],
  children: SplitTree<L>[],
): SplitTree<L> {
  return { type: "split", id, dir, sizes, children };
}

const leaf = (v: string): SplitTree<string> => splitLeaf(v);

// col[위 row, 아래 row] — 세로 라인이 위/아래 두 세그먼트로 나뉘는 최소 픽스처.
const stacked = (topSizes: number[], botSizes: number[]): SplitTree<string> =>
  split("c", "col", [0.5, 0.5], [
    split("top", "row", topSizes, [leaf("a"), leaf("b")]),
    split("bot", "row", botSizes, [leaf("d"), leaf("e")]),
  ]);

const rowDividersOf = <L,>(tree: SplitTree<L>) =>
  computeSplitLayout(tree).dividers.filter((d) => d.dir === "row");

describe("collectLineGroup — 드래그 시작 시 라인 묶음", () => {
  it("같은 x 의 위·아래 세그먼트를 한 묶음으로 잡는다(top 오름차순)", () => {
    const { dividers } = computeSplitLayout(stacked([0.4, 0.6], [0.4, 0.6]));
    const group = collectLineGroup(dividers, "top", 0);
    expect(group.map((d) => d.splitId)).toEqual(["top", "bot"]);
    // 아래 세그먼트를 끌어도 같은 묶음이다 — 어느 세그먼트든 라인 전체.
    const fromBot = collectLineGroup(dividers, "bot", 0);
    expect(fromBot.map((d) => d.splitId)).toEqual(["top", "bot"]);
  });

  it("허용오차 이내(0.6)는 묶고 밖(1.1)은 묶지 않는다", () => {
    const near = computeSplitLayout(stacked([0.406, 0.594], [0.4, 0.6])).dividers;
    expect(collectLineGroup(near, "top", 0)).toHaveLength(2);
    const far = computeSplitLayout(stacked([0.406, 0.594], [0.395, 0.605])).dividers;
    expect(
      collectLineGroup(far, "top", 0, LINE_GROUP_EPS).map((d) => d.splitId),
    ).toEqual(["top"]);
  });

  it("col 디바이더는 묶음에 들어가지 않는다", () => {
    const tree = split("r", "row", [0.4, 0.6], [
      leaf("a"),
      split("c", "col", [0.5, 0.5], [leaf("b"), leaf("d")]),
    ]);
    const { dividers } = computeSplitLayout(tree);
    const group = collectLineGroup(dividers, "r", 0);
    expect(group.every((d) => d.dir === "row")).toBe(true);
    expect(group).toHaveLength(1);
  });

  it("같은 y 구간을 공유하는 나란한 디바이더(같은 split)는 한 라인이 아니다", () => {
    const tree = split("r", "row", [0.4, 0.006, 0.594], [
      leaf("a"),
      leaf("b"),
      leaf("d"),
    ]);
    const { dividers } = computeSplitLayout(tree);
    // 40 과 40.6 — x 는 허용오차 안이지만 둘 다 전 높이(같은 y)라 별개의 나란한 라인.
    expect(collectLineGroup(dividers, "r", 0)).toHaveLength(1);
  });

  it("교집합이 앵커 시작 x 를 포함 못 하는 퇴화면 앵커 단독으로 물러난다", () => {
    // 아래 세그먼트의 오른쪽 이웃이 정확히 minFrac — 92.0 오른쪽으로 한 발도 못 간다.
    // 앵커(92.5)를 묶으면 교집합 상한(92.0)이 시작 x 아래로 내려가 클램프가 시작점을 끌어당긴다.
    const { dividers } = computeSplitLayout(stacked([0.925, 0.075], [0.92, 0.08]));
    expect(collectLineGroup(dividers, "top", 0).map((d) => d.splitId)).toEqual([
      "top",
    ]);
  });
});

describe("lineGroupRange — 허용 x 구간 교집합", () => {
  it("단일 세그먼트 = minFrac 클램프 구간", () => {
    const { dividers } = computeSplitLayout(
      split("r", "row", [0.4, 0.6], [leaf("a"), leaf("b")]),
    );
    const range = lineGroupRange(dividers);
    expect(range.min).toBeCloseTo(40 - (0.4 - MIN_PANE_FRAC) * 100, 10);
    expect(range.max).toBeCloseTo(40 + (0.6 - MIN_PANE_FRAC) * 100, 10);
  });

  it("묶음은 각 세그먼트 구간의 교집합", () => {
    // 위: [8, 92], 아래: 오른쪽 이웃 0.1 → 상한 40 + (0.1-0.08)*100 = 42.
    const { dividers } = computeSplitLayout(
      split("c", "col", [0.5, 0.5], [
        split("top", "row", [0.4, 0.6], [leaf("a"), leaf("b")]),
        split("bot", "row", [0.4, 0.1, 0.5], [leaf("d"), leaf("e"), leaf("f")]),
      ]),
    );
    const group = collectLineGroup(dividers, "top", 0);
    expect(group).toHaveLength(2);
    const range = lineGroupRange(group);
    expect(range.min).toBeCloseTo(8, 10);
    expect(range.max).toBeCloseTo(42, 10);
  });

  it("이미 minFrac 미만인 이웃은 현재 x 가 경계 — 구간은 시작 x 를 항상 포함한다", () => {
    const { dividers } = computeSplitLayout(
      split("r", "row", [0.05, 0.95], [leaf("a"), leaf("b")]),
    );
    const range = lineGroupRange(dividers);
    expect(range.min).toBeCloseTo(5, 10);
    expect(range.min).toBeLessThanOrEqual(range.max);
  });
});

describe("moveLineGroup — 묶음 전체가 같은 x 로", () => {
  const applyMoves = (
    tree: SplitTree<string>,
    moves: { splitId: string; sizes: number[] }[],
  ) => moves.reduce((acc, m) => resizeSplitTree(acc, m.splitId, m.sizes), tree);

  it("적용 후 두 세그먼트가 정확히 target 에 있고 sizes 합은 보존된다", () => {
    const tree = stacked([0.4, 0.6], [0.4, 0.6]);
    const { dividers } = computeSplitLayout(tree);
    const group = collectLineGroup(dividers, "top", 0);
    const { x, moves } = moveLineGroup(group, 55);
    expect(x).toBe(55);
    expect(moves).toHaveLength(2);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(55, 10);
    for (const m of moves)
      expect(m.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("교집합 밖 target 은 경계로 클램프된다", () => {
    const tree = stacked([0.4, 0.6], [0.4, 0.6]);
    const group = collectLineGroup(computeSplitLayout(tree).dividers, "top", 0);
    const { x, moves } = moveLineGroup(group, 99);
    expect(x).toBeCloseTo(92, 10);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(92, 10);
  });

  it("허용오차 안에서 어긋난 묶음도 드래그로 한 x 에 합류한다(치유)", () => {
    const tree = stacked([0.406, 0.594], [0.402, 0.598]);
    const group = collectLineGroup(computeSplitLayout(tree).dividers, "top", 0);
    expect(group).toHaveLength(2);
    const { moves } = moveLineGroup(group, 50);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(50, 10);
  });

  it("빈 묶음은 이동 없음", () => {
    expect(moveLineGroup([], 50).moves).toEqual([]);
  });
});

describe("normalizeVerticalLines — 복원 1회 정규화(자가 치유)", () => {
  it("오염된 라인(40.6/39.5)을 최상단 세그먼트의 x 로 통일한다 — 클린 라인 부활", () => {
    const torn = stacked([0.406, 0.594], [0.395, 0.605]);
    // 결함 현장: 토막 난 라인은 어떤 전고 세로선도 만들지 못한다(FLOW 레일 전멸).
    expect(
      cleanRailLines(computeSplitLayout(torn).cells.map((c) => c.rect)),
    ).toEqual([0, 100]);

    const healed = normalizeVerticalLines(torn);
    for (const d of rowDividersOf(healed)) expect(d.rect.left).toBeCloseTo(40.6, 10);
    const lines = cleanRailLines(
      computeSplitLayout(healed).cells.map((c) => c.rect),
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBeCloseTo(40.6, 10);
  });

  it("허용오차(1.5) 초과 어긋남은 다른 라인 — 건드리지 않는다(원본 참조 반환)", () => {
    const separate = stacked([0.406, 0.594], [0.389, 0.611]);
    expect(normalizeVerticalLines(separate, LINE_SNAP_EPS)).toBe(separate);
  });

  it("멱등 — 이미 정렬된 트리는 원본 참조 그대로", () => {
    const aligned = stacked([0.4, 0.6], [0.4, 0.6]);
    expect(normalizeVerticalLines(aligned)).toBe(aligned);
    const healed = normalizeVerticalLines(stacked([0.406, 0.594], [0.395, 0.605]));
    expect(normalizeVerticalLines(healed)).toBe(healed);
  });

  it("스냅이 패널을 minFrac 미만으로 줄이면 그 세그먼트는 보류한다", () => {
    // 아래 세그먼트를 39.5→40.6 으로 밀면 가운데 패널이 0.085→0.074(<0.08) — 보류.
    const tree = split("c", "col", [0.5, 0.5], [
      split("top", "row", [0.406, 0.594], [leaf("a"), leaf("b")]),
      split("bot", "row", [0.395, 0.085, 0.52], [leaf("d"), leaf("e"), leaf("f")]),
    ]);
    expect(normalizeVerticalLines(tree)).toBe(tree);
  });

  it("가로(col) 라인은 명제 밖 — 어긋나 있어도 건드리지 않는다", () => {
    const horizontal = split("r", "row", [0.5, 0.5], [
      split("lc", "col", [0.406, 0.594], [leaf("a"), leaf("b")]),
      split("rc", "col", [0.395, 0.605], [leaf("d"), leaf("e")]),
    ]);
    expect(normalizeVerticalLines(horizontal)).toBe(horizontal);
  });

  it("조상 라인 스냅이 자손 라인을 밀어도 두 라인 다 정확히 안착한다", () => {
    // 라인1 = 위 rowT(31)·아래 rowB(30) — 앵커(최상단)=31 이라 rowB 가 움직인다.
    // rowB 의 오른쪽 자식 안에 라인2(65/65.7)가 산다 — rowB 스냅이 라인2 를 통째로 밀지만
    // 조상 우선 적용 + 매 적용 전 재계산으로 라인2 는 원래 앵커 x(65)에 정확히 안착한다.
    const tree = split("root", "col", [0.5, 0.5], [
      split("rowT", "row", [0.31, 0.69], [leaf("a"), leaf("b")]),
      split("rowB", "row", [0.3, 0.7], [
        leaf("d"),
        split("inner", "col", [0.5, 0.5], [
          split("rowA", "row", [0.5, 0.5], [leaf("e"), leaf("f")]),
          split("rowC", "row", [0.51, 0.49], [leaf("g"), leaf("h")]),
        ]),
      ]),
    ]);
    const healed = normalizeVerticalLines(tree);
    const at = (id: string) =>
      rowDividersOf(healed).find((d) => d.splitId === id)!.rect.left;
    expect(at("rowT")).toBeCloseTo(31, 10);
    expect(at("rowB")).toBeCloseTo(31, 10);
    expect(at("rowA")).toBeCloseTo(65, 10);
    expect(at("rowC")).toBeCloseTo(65, 10);
  });
});
