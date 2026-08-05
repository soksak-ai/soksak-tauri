import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf, type SplitTree } from "./splitTree";
import {
  projectArrangement,
  useSessions,
  type Project,
  type Pane,
} from "./sessions";

const group = (id: string): Pane => ({
  id,
  activeTabId: `v-${id}`,
  tabs: [
    {
      id: `v-${id}`,
      kind: "plugin",
      title: id,
      pluginId: "fixture",
      view: "content",
    },
  ],
});

function projectFixture(): Project {
  useSessions.getState().bootstrapFirstProject("/test/root");
  const base = useSessions.getState().projects[0];
  const db = group("db");
  const design = group("design");
  const ghostty = group("ghostty");
  const terminal = group("terminal");
  const kanban = group("kanban");
  const layout: SplitTree<Pane> = {
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
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: ghostty.id,
        layout,
      },
    ],
  };
}

beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
});

describe("세션 배치 — 표시는 해가 정하고 정본은 불변이다", () => {
  it("막힌 포커스(ghostty)는 스위칭된 배열로 표시되고 세션 트리는 그대로다", () => {
    // 픽스처: [db | col([design | ghostty], terminal) | kanban]. ghostty 의 왼쪽 50 은
    // terminal 이 가로질러 막혀 있다 — 사용자 규칙대로 앞으로 스위칭해 33.33 선에 붙는다.
    const project = projectFixture();
    const canonical = project.spaces[0].layout;
    useSessions.setState({ projects: [project], activeId: project.id });

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    expect(solved.swapped).toBe(true);
    expect(solved.cells.find((cell) => cell.id === "ghostty")!.rect.left).toBeCloseTo(100 / 3);
    expect(solved.cells.find((cell) => cell.id === "design")!.rect.left).toBeCloseTo(50);
    expect(solved.station).toBeCloseTo(100 / 3);
    expect(useSessions.getState().projects[0].spaces[0].layout).toBe(canonical);
  });

  it("막히지 않은 포커스로 옮기면 정본 배열이 그대로 표시된다", () => {
    const project = projectFixture();
    const canonical = project.spaces[0].layout;
    useSessions.setState({ projects: [project], activeId: project.id });
    useSessions.getState().setActiveGroup(project.id, "terminal");

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    expect(solved.swapped).toBe(false);
    expect(solved.displayLayout).toBe(canonical);
    expect(solved.cells.find((cell) => cell.id === "design")!.rect.left).toBeCloseTo(100 / 3);
    expect(solved.cells.find((cell) => cell.id === "ghostty")!.rect.left).toBeCloseTo(50);
  });

  it("탭 최대화는 [사이드바|기능창] 단일 평면이고 복원은 원본 배열을 되살린다", () => {
    const project = projectFixture();
    const canonical = project.spaces[0].layout;
    useSessions.setState({ projects: [project], activeId: project.id });

    expect(useSessions.getState().maximizeView(project.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const maximized = useSessions.getState().projects[0];
    const solved = projectArrangement(maximized)!;
    expect(solved.cells).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(solved.station).toBe(0);
    expect(maximized.sidebarOpen).toBe(true);
    expect(maximized.spaces[0].layout).toEqual(canonical);

    expect(useSessions.getState().restoreView(project.id)).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const restored = useSessions.getState().projects[0];
    expect(restored.spaces[0].maximizedTabId).toBeUndefined();
    expect(restored.spaces[0].layout).toEqual(canonical);
  });

  it("PIN 유효성은 임시 최대화 평면이 아니라 정본 분할의 clean line으로 판정한다", () => {
    const project = projectFixture();
    const station = projectArrangement(project)!.cleanLines.find((line) => line > 0 && line < 100);
    expect(station).toBeTypeOf("number");
    const pinned: Project = {
      ...project,
      leftRailPlacement: { mode: "pin", station: station! },
    };
    useSessions.setState({ projects: [pinned], activeId: pinned.id });

    expect(useSessions.getState().maximizeView(pinned.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "pin",
      station,
    });
  });

  it("사이드바가 닫히면 붙을 레일이 없다 — 스위칭하지 않는다", () => {
    const project = projectFixture();
    useSessions.setState({
      projects: [{ ...project, sidebarOpen: false }],
      activeId: project.id,
    });
    const solved = projectArrangement(useSessions.getState().projects[0])!;
    expect(solved.swapped).toBe(false);
  });
});

// 최대화는 "이 뷰가 공간을 채운다" 이므로, 채우는 패널은 그 뷰가 든 그룹이다. 투영이 활성
// 그룹을 대신 쓰면 두 값이 어긋나는 순간 — 다른 그룹의 탭을 더블클릭하는 순간 — 최대화된
// 뷰가 없는 패널로 접히고 화면에 아무것도 남지 않는다(실측: maximizedTabId=v35(g3 소속)
// 인데 layout={"panel":"g5"}, DOM 슬롯 0개, 창 전체 백지).
describe("최대화 — 채우는 패널은 그 뷰가 든 그룹이다", () => {
  it("최대화 뷰가 활성 그룹 밖이면 그 뷰의 그룹으로 접힌다", () => {
    const project = projectFixture();
    const content = project.spaces[0];
    // 활성 그룹은 ghostty, 최대화 대상은 kanban 의 뷰 — 어긋난 상태.
    const withMax: Project = {
      ...project,
      spaces: [{ ...content, activePaneId: "ghostty", maximizedTabId: "v-kanban" }],
    };
    useSessions.setState({ projects: [withMax], activeId: withMax.id });

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    const shown = solved.cells.filter((c) => c.rect.width > 0 && c.rect.height > 0);
    expect(shown.map((c) => c.id)).toEqual(["kanban"]);
  });

  it("최대화 뷰가 활성 그룹 안이면 그대로 그 그룹으로 접힌다", () => {
    const project = projectFixture();
    const content = project.spaces[0];
    const withMax: Project = {
      ...project,
      spaces: [{ ...content, activePaneId: "ghostty", maximizedTabId: "v-ghostty" }],
    };
    useSessions.setState({ projects: [withMax], activeId: withMax.id });

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    const shown = solved.cells.filter((c) => c.rect.width > 0 && c.rect.height > 0);
    expect(shown.map((c) => c.id)).toEqual(["ghostty"]);
  });
});
