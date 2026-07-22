import { describe, expect, it } from "vitest";
import type { SplitTree } from "../state/splitTree";
import { leavesOf } from "../state/splitTree";
import { computeSplitLayout } from "./splitLayout";
import { cleanRailLines, isCleanRailStation } from "./railPlacement";
import { projectFocusedPanelNearRail } from "./railFocusLayout";

type Panel = { id: string };
const leaf = (id: string): SplitTree<Panel> => ({
  type: "leaf",
  value: { id },
});

// [db | col([design | ghostty], terminal) | kanban]
// ghostty의 50% 왼쪽 선은 terminal이 가로지르므로 깨끗하지 않다. 같은 row에서
// design과 자리를 교환하면 ancestor의 33.33% 깨끗한 선에 바로 붙는다.
const fixture = (): SplitTree<Panel> => ({
  type: "split",
  id: "root",
  dir: "row",
  sizes: [1 / 3, 1 / 3, 1 / 3],
  children: [
    leaf("db"),
    {
      type: "split",
      id: "middle",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [leaf("design"), leaf("ghostty")],
        },
        leaf("terminal"),
      ],
    },
    leaf("kanban"),
  ],
});

const order = (tree: SplitTree<Panel>): string[] =>
  leavesOf(tree).map((panel) => panel.id);

describe("FLOW 포커스 패널 근접 투영", () => {
  it("옵션이 꺼져 있으면 막힌 ghostty도 원본 트리와 객체 정체성을 유지한다", () => {
    const original = fixture();
    expect(projectFocusedPanelNearRail(original, "ghostty", false)).toBe(original);
  });

  it("막힌 ghostty를 같은 row의 design과 화면에서만 교환해 깨끗한 앞 선에 붙인다", () => {
    const original = fixture();
    const before = structuredClone(original);
    const projected = projectFocusedPanelNearRail(original, "ghostty", true);

    expect(projected).not.toBe(original);
    expect(order(projected)).toEqual(["db", "ghostty", "design", "terminal", "kanban"]);
    expect(original).toEqual(before); // 저장 트리는 절대 변이하지 않는다.

    const layout = computeSplitLayout(projected);
    const target = layout.cells.find((cell) => cell.value.id === "ghostty")!;
    const clean = cleanRailLines(layout.cells.map((cell) => cell.rect));
    expect(isCleanRailStation(clean, target.rect.left)).toBe(true);
  });

  it("이미 깨끗한 design·terminal·kanban 포커스에는 배열을 건드리지 않는다", () => {
    const original = fixture();
    expect(projectFocusedPanelNearRail(original, "design", true)).toBe(original);
    expect(projectFocusedPanelNearRail(original, "terminal", true)).toBe(original);
    expect(projectFocusedPanelNearRail(original, "kanban", true)).toBe(original);
  });

  it("ghostty에서 비영향 패널로 포커스를 옮기면 정본에서 다시 계산되어 원래 배열로 복귀한다", () => {
    const original = fixture();
    const ghosttyProjection = projectFocusedPanelNearRail(original, "ghostty", true);
    expect(order(ghosttyProjection)).toEqual(["db", "ghostty", "design", "terminal", "kanban"]);

    const restored = projectFocusedPanelNearRail(original, "terminal", true);
    expect(restored).toBe(original);
    expect(order(restored)).toEqual(["db", "design", "ghostty", "terminal", "kanban"]);
  });

  it("교환해도 깨끗한 선에 닿지 못하는 구조라면 잘못된 재배치를 적용하지 않는다", () => {
    const original: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.25, 0.75],
          children: [
            leaf("prefix"),
            {
              type: "split",
              id: "nested",
              dir: "row",
              sizes: [0.5, 0.5],
              children: [leaf("a"), leaf("target")],
            },
          ],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [0.4, 0.6],
          children: [leaf("b"), leaf("c")],
        },
      ],
    };
    expect(projectFocusedPanelNearRail(original, "target", true)).toBe(original);
  });

  it("서로 다른 폭의 형제는 콘텐츠를 늘이거나 줄이지 않도록 교환하지 않는다", () => {
    const original: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.3, 0.7],
          children: [leaf("a"), leaf("target")],
        },
        leaf("bottom"),
      ],
    };
    expect(projectFocusedPanelNearRail(original, "target", true)).toBe(original);
  });
});
