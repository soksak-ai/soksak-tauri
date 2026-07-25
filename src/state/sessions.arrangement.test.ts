import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf, type SplitTree } from "./splitTree";
import {
  projectArrangement,
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

describe("세션 배치 — 표시는 해가 정하고 정본은 불변이다", () => {
  it("막힌 포커스(ghostty)는 스위칭된 배열로 표시되고 세션 트리는 그대로다", () => {
    // 픽스처: [db | col([design | ghostty], terminal) | kanban]. ghostty 의 왼쪽 50 은
    // terminal 이 가로질러 막혀 있다 — 사용자 규칙대로 앞으로 스위칭해 33.33 선에 붙는다.
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });

    const solved = projectArrangement(useSessions.getState().tabs[0])!;
    expect(solved.swapped).toBe(true);
    expect(solved.cells.find((cell) => cell.id === "ghostty")!.rect.left).toBeCloseTo(100 / 3);
    expect(solved.cells.find((cell) => cell.id === "design")!.rect.left).toBeCloseTo(50);
    expect(solved.station).toBeCloseTo(100 / 3);
    expect(useSessions.getState().tabs[0].contents[0].layout).toBe(canonical);
  });

  it("막히지 않은 포커스로 옮기면 정본 배열이 그대로 표시된다", () => {
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });
    useSessions.getState().setActiveGroup(project.id, "terminal");

    const solved = projectArrangement(useSessions.getState().tabs[0])!;
    expect(solved.swapped).toBe(false);
    expect(solved.displayLayout).toBe(canonical);
    expect(solved.cells.find((cell) => cell.id === "design")!.rect.left).toBeCloseTo(100 / 3);
    expect(solved.cells.find((cell) => cell.id === "ghostty")!.rect.left).toBeCloseTo(50);
  });

  it("탭 최대화는 [사이드바|기능창] 단일 평면이고 복원은 원본 배열을 되살린다", () => {
    const project = projectFixture();
    const canonical = project.contents[0].layout;
    useSessions.setState({ tabs: [project], activeId: project.id });

    expect(useSessions.getState().maximizeView(project.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const maximized = useSessions.getState().tabs[0];
    const solved = projectArrangement(maximized)!;
    expect(solved.cells).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(solved.station).toBe(0);
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

  it("사이드바가 닫히면 붙을 레일이 없다 — 스위칭하지 않는다", () => {
    const project = projectFixture();
    useSessions.setState({
      tabs: [{ ...project, sidebarOpen: false }],
      activeId: project.id,
    });
    const solved = projectArrangement(useSessions.getState().tabs[0])!;
    expect(solved.swapped).toBe(false);
  });
});
