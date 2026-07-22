import { beforeEach, describe, expect, it } from "vitest";
import { effectiveRailStation } from "../lib/railPlacement";
import { splitLeaf, type SplitTree } from "./splitTree";
import {
  leftRailGrid,
  useSessions,
  type ProjectTab,
  type ViewGroup,
} from "./sessions";

const group = (id: string): ViewGroup => ({
  id,
  activeViewId: `v-${id}`,
  views: [
    {
      id: `v-${id}`,
      kind: "plugin",
      title: id,
      pluginId: "fixture",
      view: "content",
    },
  ],
});

function projectFixture(): ProjectTab {
  useSessions.getState().bootstrapFirstProject("/test/root");
  const base = useSessions.getState().tabs[0];
  const db = group("db");
  const design = group("design");
  const ghostty = group("ghostty");
  const terminal = group("terminal");
  const kanban = group("kanban");
  const layout: SplitTree<ViewGroup> = {
    type: "split",
    id: "root",
    dir: "row",
    sizes: [1 / 3, 1 / 3, 1 / 3],
    children: [
      splitLeaf(db),
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
            children: [splitLeaf(design), splitLeaf(ghostty)],
          },
          splitLeaf(terminal),
        ],
      },
      splitLeaf(kanban),
    ],
  };
  return {
    ...base,
    leftRailPlacement: { mode: "flow" },
    contents: [
      {
        ...base.contents[0],
        activeGroupId: ghostty.id,
        layout,
      },
    ],
  };
}

beforeEach(() => {
  useSessions.setState({ tabs: [], activeId: "" });
});

describe("FLOW 가까운 쪽 화면 투영과 정본 보존", () => {
  it("ghostty 포커스는 표시 rect만 design 앞으로 바꾸고 세션 트리는 유지한다", () => {
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });

    const grid = leftRailGrid(project, true);
    const design = grid.cells.find((cell) => cell.id === "design")!;
    const ghostty = grid.cells.find((cell) => cell.id === "ghostty")!;
    expect(ghostty.rect.left).toBeCloseTo(100 / 3);
    expect(design.rect.left).toBeCloseTo(50);
    expect(effectiveRailStation(grid.cells, grid.focusId, { mode: "flow" }))
      .toBeCloseTo(100 / 3);
    expect(useSessions.getState().tabs[0].contents[0].layout).toBe(canonical);
  });

  it("비영향 terminal로 포커스를 옮기면 원래 design→ghostty 배열로 복귀한다", () => {
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });
    useSessions.getState().setActiveGroup(project.id, "terminal");

    const current = useSessions.getState().tabs[0];
    const grid = leftRailGrid(current, true);
    const design = grid.cells.find((cell) => cell.id === "design")!;
    const ghostty = grid.cells.find((cell) => cell.id === "ghostty")!;
    expect(design.rect.left).toBeCloseTo(100 / 3);
    expect(ghostty.rect.left).toBeCloseTo(50);
    expect(current.contents[0].layout).toBe(canonical);
  });

  it("탭 최대화는 [사이드바|기능창] 전체 평면을 만들고 복원 시 원본 배열을 되살린다", () => {
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });

    expect(useSessions.getState().maximizeView(project.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const maximized = useSessions.getState().tabs[0];
    const grid = leftRailGrid(maximized, true);
    expect(grid.cells).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(effectiveRailStation(grid.cells, grid.focusId, { mode: "flow" })).toBe(0);
    expect(maximized.sidebarOpen).toBe(true);
    expect(maximized.contents[0].layout).toEqual(canonical);

    expect(useSessions.getState().restoreView(project.id)).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const restored = useSessions.getState().tabs[0];
    expect(restored.contents[0].maximizedViewId).toBeUndefined();
    expect(restored.contents[0].layout).toEqual(canonical);
  });
});
