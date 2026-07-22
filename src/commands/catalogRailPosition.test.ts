// 좌 레일 위치 공개 표면. 레일 위치는 프로젝트 상태이지만, 클라이언트가
// 스토어 내부를 읽지 않고 state.tree/명령으로 관찰·제어할 수 있어야 한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute, getSpec } from "./registry";
import { useSessions, type ProjectTab, type ViewGroup } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useSettings } from "../state/settings";
import { leavesOf, splitLeaf } from "../state/splitTree";

const group = (id: string, viewId?: string): ViewGroup => ({
  id,
  views: viewId
    ? [{
        id: viewId,
        kind: "plugin",
        title: id,
        pluginId: "test.plugin",
        view: "main",
      }]
    : [],
  activeViewId: viewId ?? "",
});

function project(
  placement?: ProjectTab["leftRailPlacement"],
): ProjectTab {
  return {
    id: "t1",
    title: "P",
    root: "/tmp/rail-position",
    sidebarOpen: true,
    ...(placement ? { leftRailPlacement: placement } : {}),
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    contents: [
      {
        id: "c1",
        title: "1",
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", value: group("g1") },
            { type: "leaf", value: group("g2") },
          ],
        },
        activeGroupId: "g2",
      },
    ],
    activeContentId: "c1",
  };
}

function nearProject(): ProjectTab {
  const base = project({ mode: "flow" });
  return {
    ...base,
    contents: [
      {
        ...base.contents[0],
        activeGroupId: "ghostty",
        layout: {
          type: "split",
          id: "root",
          dir: "row",
          sizes: [1 / 3, 1 / 3, 1 / 3],
          children: [
            splitLeaf(group("db")),
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
                  children: [
                    splitLeaf(group("design")),
                    splitLeaf(group("ghostty")),
                  ],
                },
                splitLeaf(group("terminal")),
              ],
            },
            splitLeaf(group("kanban")),
          ],
        },
      },
    ],
  };
}

registerCatalog();

beforeEach(() => {
  useSessions.setState({ tabs: [project()], activeId: "t1" });
  useSettings.getState().setRailFocusNear(false);
});

type Position = {
  mode: "flow" | "pin";
  station?: number;
  effectiveStation: number;
  cleanLines: number[];
};

function resultPosition(result: Awaited<ReturnType<typeof execute>>): Position {
  return (result.data as { leftRailPosition: Position }).leftRailPosition;
}

describe("sidebar.left.position", () => {
  it("명령 카탈로그에서 발견되고, 생략 호출은 FLOW 현재 상태를 읽는다", async () => {
    expect(getSpec("sidebar.left.position")).toBeDefined();

    const result = await execute("sidebar.left.position", {}, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
  });

  it("PIN station 생략은 FLOW의 현재 effective station을 그 자리에 고정한다", async () => {
    const result = await execute(
      "sidebar.left.position",
      { mode: "pin" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "pin",
      station: 50,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().tabs[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("PIN station 지정은 가장 가까운 clean line으로 snap해 저장한다", async () => {
    const result = await execute(
      "sidebar.left.position",
      { mode: "pin", station: 31 },
      {},
    );
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toMatchObject({
      mode: "pin",
      station: 50,
      effectiveStation: 50,
    });
    expect(useSessions.getState().tabs[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("기존 dirty PIN은 조용히 재저장하지 않고 persisted/effective station을 구분해 읽는다", async () => {
    useSessions.setState({
      tabs: [project({ mode: "pin", station: 31 })],
      activeId: "t1",
    });

    const result = await execute("sidebar.left.position", {}, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "pin",
      station: 31,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().tabs[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 31,
    });
  });

  it("FLOW 명령은 고정 station을 제거하고 포커스 추종을 즉시 복원한다", async () => {
    useSessions.setState({
      tabs: [project({ mode: "pin", station: 0 })],
      activeId: "t1",
    });

    const result = await execute(
      "sidebar.left.position",
      { mode: "flow" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().tabs[0].leftRailPlacement).toEqual({
      mode: "flow",
    });
  });

  it("논리 평면 밖 station과 FLOW+station 모호성을 구조적 오류로 거부한다", async () => {
    const outside = await execute(
      "sidebar.left.position",
      { mode: "pin", station: 101 },
      {},
    );
    expect(outside).toMatchObject({ ok: false, code: "INVALID_PARAMS" });

    const ambiguous = await execute(
      "sidebar.left.position",
      { mode: "flow", station: 50 },
      {},
    );
    expect(ambiguous).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

describe("state.tree leftRailPosition", () => {
  it("레일 결부의 view·panel·실제 인접 여부를 공개한다", async () => {
    const linked = project({ mode: "flow" });
    linked.contents[0] = {
      ...linked.contents[0],
      railBindingViewId: "v2",
      layout: {
        type: "split",
        id: "s1",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          splitLeaf(group("g1", "v1")),
          splitLeaf(group("g2", "v2")),
        ],
      },
    };
    useSessions.setState({ tabs: [linked], activeId: linked.id });
    const result = await execute("state.tree", {}, {});
    const relation = (result.data as {
      projects: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).projects[0].spaces[0].railRelation;
    expect(relation).toEqual({
      boundViewId: "v2",
      boundPanelId: "g2",
      connected: true,
    });

    linked.sidebarOpen = false;
    useSessions.setState({ tabs: [linked], activeId: linked.id });
    const closed = await execute("panel.list", { space: "c1" }, {});
    expect((closed.data as { railRelation: { connected: boolean } }).railRelation.connected)
      .toBe(false);
  });

  it("명령 조회와 동일한 계산을 사용해 위치 사실을 노출한다", async () => {
    useSessions.setState({
      tabs: [project({ mode: "pin", station: 31 })],
      activeId: "t1",
    });
    const result = await execute("state.tree", {}, {});
    expect(result.ok).toBe(true);
    const projects = (result.data as {
      projects: Array<{ leftRailPosition: Position }>;
    }).projects;
    expect(projects[0].leftRailPosition).toEqual({
      mode: "pin",
      station: 31,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
  });

  it("근접 배치를 표시 rect와 layout에 노출하되 세션 정본은 바꾸지 않고 포커스 이탈 시 복귀한다", async () => {
    const original = nearProject();
    const canonical = original.contents[0].layout;
    useSessions.setState({ tabs: [original], activeId: original.id });
    useSettings.getState().setRailFocusNear(true);

    const projected = await execute("state.tree", {}, {});
    const firstSpace = (projected.data as {
      projects: Array<{
        spaces: Array<{
          layout: { children: unknown[] };
          canonicalLayout: { children: unknown[] };
          projection: {
            kind: "focus-near" | "canonical" | "maximized";
            applied: boolean;
            focusedPanelId: string;
            swappedPanels: string[];
          };
          panels: Array<{ id: string; rect: { left: number } }>;
        }>;
      }>;
    }).projects[0].spaces[0];
    expect(firstSpace.projection).toEqual({
      kind: "focus-near",
      applied: true,
      focusedPanelId: "ghostty",
      swappedPanels: ["design", "ghostty"],
    });
    expect(firstSpace.canonicalLayout).not.toEqual(firstSpace.layout);
    expect(firstSpace.panels.find((panel) => panel.id === "ghostty")?.rect.left)
      .toBe(33.3);
    expect(firstSpace.panels.find((panel) => panel.id === "design")?.rect.left)
      .toBe(50);
    expect(leavesOf(useSessions.getState().tabs[0].contents[0].layout).map((g) => g.id))
      .toEqual(["db", "design", "ghostty", "terminal", "kanban"]);
    expect(useSessions.getState().tabs[0].contents[0].layout).toBe(canonical);

    useSessions.getState().setActiveGroup(original.id, "terminal");
    const restored = await execute("state.tree", {}, {});
    const restoredPanels = (restored.data as {
      projects: Array<{ spaces: Array<{
        projection: { kind: string; applied: boolean; swappedPanels: string[] };
        panels: Array<{ id: string; rect: { left: number } }>
      }> }>;
    }).projects[0].spaces[0].panels;
    expect(restoredPanels.find((panel) => panel.id === "design")?.rect.left).toBe(33.3);
    expect(restoredPanels.find((panel) => panel.id === "ghostty")?.rect.left).toBe(50);
  });

  it("최대화는 공개 layout/panels도 실제 [sidebar|feature] 평면으로 노출한다", async () => {
    const original = nearProject();
    useSessions.setState({ tabs: [original], activeId: original.id });
    useSettings.getState().setRailFocusNear(true);
    useSessions.getState().maximizeView(original.id, "");
    // fixture 그룹은 뷰가 없으므로 공개 상태를 직접 세팅해 유실/숨김 직렬화만 검증한다.
    useSessions.setState((s) => ({
      tabs: s.tabs.map((t) => ({
        ...t,
        contents: t.contents.map((c) => ({ ...c, activeGroupId: "ghostty", maximizedViewId: "v-max" })),
      })),
    }));

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      projects: Array<{ spaces: Array<{
        layout: { panel: string };
        canonicalLayout: { children: unknown[] };
        projection: { kind: string; applied: boolean; focusedPanelId: string; swappedPanels: string[] };
        panels: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }>;
      }> }>;
    }).projects[0].spaces[0];
    expect(space.layout).toEqual({ panel: "ghostty" });
    expect(space.panels).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 }, active: true, activeViewId: "", views: [] },
    ]);
    expect(space.projection).toEqual({
      kind: "maximized",
      applied: true,
      focusedPanelId: "ghostty",
      swappedPanels: [],
    });
    expect(space.canonicalLayout.children).toHaveLength(3);
  });
});
