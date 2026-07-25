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
    leftRailPlacement: { mode: "pin", station: 0 },
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

describe("근접 투영 폐지 — 포커스는 배치를 바꾸지 않는다", () => {
  it("포커스가 어디든 표시 rect는 정본 배열 그대로다(투영 교체 없음)", () => {
    // 폐지 전 계약: 포커스 패널을 레일 옆으로 옮겨 표시했다(design↔ghostty 교체) — 간접
    // 사건이 모든 패널의 기하를 바꾸는 기능이라 폐지했다(NATIVE-SURFACES §2 기하 소유권).
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });

    const grid = leftRailGrid(project, true); // 인자는 무시된다(폐지)
    const design = grid.cells.find((cell) => cell.id === "design")!;
    const ghostty = grid.cells.find((cell) => cell.id === "ghostty")!;
    expect(design.rect.left).toBeCloseTo(100 / 3); // 정본 순서 유지
    expect(ghostty.rect.left).toBeCloseTo(50);
    expect(grid.projected).toBe(false);
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
    expect(effectiveRailStation(grid.cells, grid.focusId, { mode: "pin", station: 0 })).toBe(0);
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
