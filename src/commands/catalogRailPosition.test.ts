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
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions, type Project, type Pane } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { splitLeaf } from "../state/splitTree";

const group = (id: string, viewId?: string): Pane => ({
  id,
  tabs: viewId
    ? [{
        id: viewId,
        kind: "plugin",
        title: id,
        pluginId: "test.plugin",
        view: "main",
      }]
    : [],
  activeTabId: viewId ?? "",
});

function project(
  placement?: Project["leftRailPlacement"],
): Project {
  return {
    id: "t1",
    title: "P",
    root: "<local-evidence>/rail-position",
    sidebarOpen: true,
    ...(placement ? { leftRailPlacement: placement } : {}),
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    spaces: [
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
        activePaneId: "g2",
      },
    ],
    activeSpaceId: "c1",
  };
}

/** 행별 세로선이 안 맞는 배치 — ghostty 의 왼쪽 50 은 terminal 이 가로질러 막혀 있다. */
function switchProject(): Project {
  const base = project({ mode: "flow" });
  return {
    ...base,
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "ghostty",
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
  useSessions.setState({ projects: [project()], activeId: "t1" });
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
  it("생략 호출은 FLOW 현재 상태를 읽는다 — 레일은 포커스 패널의 왼쪽 선에 선다", async () => {
    const result = await execute("sidebar.left.position", {}, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 50, // 활성 패널 g2 의 왼쪽 선
      cleanLines: [0, 50, 100],
    });
  });

  it("PIN station 생략은 FLOW 의 현재 유효선을 그 자리에 고정한다", async () => {
    const result = await execute("sidebar.left.position", { mode: "pin" }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "pin",
      station: 50,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("PIN station 지정은 가장 가까운 clean line 으로 snap 해 저장한다", async () => {
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
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("기존 dirty PIN 은 조용히 재저장하지 않고 persisted/effective 를 구분해 읽는다", async () => {
    useSessions.setState({
      projects: [project({ mode: "pin", station: 31 })],
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
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 31,
    });
  });

  it("FLOW 명령은 고정 station 을 제거하고 포커스 추종을 즉시 복원한다", async () => {
    useSessions.setState({
      projects: [project({ mode: "pin", station: 0 })],
      activeId: "t1",
    });

    const result = await execute("sidebar.left.position", { mode: "flow" }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "flow",
    });
  });

  it("논리 평면 밖 station 과 FLOW+station 모호성을 구조적 오류로 거부한다", async () => {
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

describe("state.tree — 해가 공개 사실이다", () => {
  it("고정 레일 관계를 좌·우·비인접 동일 기준으로 노출한다", async () => {
    const withBinding = project({ mode: "pin", station: 0 });
    withBinding.spaces[0] = {
      ...withBinding.spaces[0],
      activePaneId: "g2",
      railBindingTabId: "v-g2",
      layout: {
        type: "split",
        id: "s1",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { type: "leaf", value: group("g1", "v-g1") },
          { type: "leaf", value: group("g2", "v-g2") },
        ],
      },
    };
    useSessions.setState({ projects: [withBinding], activeId: "t1" });
    const detached = await execute("state.tree", {}, {});
    const relation = (detached.data as { projects: Array<{ spaces: Array<{ railRelation: unknown }> }> })
      .projects[0].spaces[0].railRelation;
    expect(relation).toEqual({
      boundTabId: "v-g2",
      boundPaneId: "g2",
      relationId: "rail-relation/c1/g2/v-g2",
      placement: "pin",
      connected: false,
      side: "detached",
      borderMode: "independent",
      pathCount: 2,
    });
  });

  it("명시 결부가 없어도 화면과 같이 활성 판의 활성 탭을 유효 결부로 노출한다", async () => {
    const withoutLock = project({ mode: "pin", station: 0 });
    withoutLock.spaces[0] = {
      ...withoutLock.spaces[0],
      activePaneId: "g1",
      layout: {
        type: "split",
        id: "s1",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { type: "leaf", value: group("g1", "v-g1") },
          { type: "leaf", value: group("g2", "v-g2") },
        ],
      },
    };
    useSessions.setState({ projects: [withoutLock], activeId: "t1" });

    const tree = await execute("state.tree", {}, {});
    const treeRelation = (tree.data as {
      projects: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).projects[0].spaces[0].railRelation;
    const panes = await execute("pane.list", {}, {});
    const paneRelation = (panes.data as { railRelation: unknown }).railRelation;

    expect(treeRelation).toEqual({
      boundTabId: "v-g1",
      boundPaneId: "g1",
      relationId: "rail-relation/c1/g1/v-g1",
      placement: "pin",
      connected: true,
      side: "right",
      borderMode: "union",
      pathCount: 1,
    });
    expect(paneRelation).toEqual(treeRelation);
  });

  it("사이드바가 닫히면 결부와 그림이 없는 none/0 상태를 명시한다", async () => {
    const closed = project({ mode: "pin", station: 0 });
    closed.sidebarOpen = false;
    closed.spaces[0] = {
      ...closed.spaces[0],
      activePaneId: "g1",
      layout: {
        type: "leaf",
        value: group("g1", "v-g1"),
      },
    };
    useSessions.setState({ projects: [closed], activeId: "t1" });

    const tree = await execute("state.tree", {}, {});
    const relation = (tree.data as {
      projects: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).projects[0].spaces[0].railRelation;
    expect(relation).toEqual({
      boundTabId: null,
      boundPaneId: null,
      relationId: "rail-relation/c1/none",
      placement: "pin",
      connected: false,
      side: "detached",
      borderMode: "none",
      pathCount: 0,
    });
  });

  it("PIN 양방향 maximize/restore 뒤 station·split·관계 방향이 정확히 복원된다", async () => {
    for (const [paneId, tabId, side] of [
      ["g1", "v-g1", "left"],
      ["g2", "v-g2", "right"],
    ] as const) {
      const pinned = project({ mode: "pin", station: 50 });
      pinned.spaces[0] = {
        ...pinned.spaces[0],
        activePaneId: paneId,
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", value: group("g1", "v-g1") },
            { type: "leaf", value: group("g2", "v-g2") },
          ],
        },
      };
      useSessions.setState({ projects: [pinned], activeId: "t1" });

      const read = async () => {
        const result = await execute("state.tree", {}, {});
        return (result.data as {
          projects: Array<{
            leftRailPosition: Position;
            spaces: Array<{
              layout: unknown;
              canonicalLayout: unknown;
              railRelation: { side: string; relationId: string };
            }>;
          }>;
        }).projects[0];
      };

      const before = await read();
      expect(before.leftRailPosition).toMatchObject({
        mode: "pin",
        station: 50,
        effectiveStation: 50,
      });
      expect(before.spaces[0].railRelation.side).toBe(side);

      expect(useSessions.getState().maximizeView("t1", tabId)).toMatchObject({ ok: true });
      const maximized = await read();
      expect(maximized.spaces[0].railRelation.side).toBe(side);
      expect(maximized.leftRailPosition.station).toBe(50);

      expect(useSessions.getState().restoreView("t1")).toMatchObject({ ok: true });
      const restored = await read();
      expect(restored.leftRailPosition).toEqual(before.leftRailPosition);
      expect(restored.spaces[0].layout).toEqual(before.spaces[0].layout);
      expect(restored.spaces[0].canonicalLayout).toEqual(
        before.spaces[0].canonicalLayout,
      );
      expect(restored.spaces[0].railRelation).toEqual(
        before.spaces[0].railRelation,
      );
    }
  });
  it("명령 조회와 동일한 계산으로 위치를 노출한다", async () => {
    useSessions.setState({
      projects: [project({ mode: "pin", station: 31 })],
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

  it("행 불일치 스위칭을 표시 layout·panes 에 노출하고 정본은 함께 보고한다", async () => {
    const original = switchProject();
    useSessions.setState({ projects: [original], activeId: original.id });

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      projects: Array<{
        leftRailPosition: Position;
        spaces: Array<{
          layout: { children: unknown[] };
          canonicalLayout: { children: unknown[] };
          projection: {
            kind: string;
            applied: boolean;
            focusedPaneId: string;
            swappedPanes: string[];
          };
          panes: Array<{ id: string; rect: { left: number } }>;
        }>;
      }>;
    }).projects[0];

    expect(space.leftRailPosition.effectiveStation).toBeCloseTo(100 / 3, 1);
    const first = space.spaces[0];
    expect(first.projection).toEqual({
      kind: "switched",
      applied: true,
      focusedPaneId: "ghostty",
      swappedPanes: ["design", "ghostty"],
    });
    expect(first.canonicalLayout).not.toEqual(first.layout);
    expect(first.panes.find((pane) => pane.id === "ghostty")?.rect.left).toBe(33.3);
    expect(first.panes.find((pane) => pane.id === "design")?.rect.left).toBe(50);
    // 세션 정본은 절대 바뀌지 않는다 — 표시만 스위칭된다.
    expect(useSessions.getState().projects[0].spaces[0].layout).toBe(
      original.spaces[0].layout,
    );
  });

  it("최대화는 공개 layout/panes 도 실제 [sidebar|feature] 평면으로 노출한다", async () => {
    const original = switchProject();
    useSessions.setState({ projects: [original], activeId: original.id });
    // fixture 그룹은 뷰가 없으므로 공개 상태를 직접 세팅해 직렬화만 검증한다.
    useSessions.setState((s) => ({
      projects: s.projects.map((t) => ({
        ...t,
        spaces: t.spaces.map((c) => ({
          ...c,
          activePaneId: "ghostty",
          maximizedTabId: "v-max",
        })),
      })),
    }));

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      projects: Array<{ spaces: Array<{
        layout: { pane: string };
        canonicalLayout: { children: unknown[] };
        projection: { kind: string; applied: boolean; focusedPaneId: string; swappedPanes: string[] };
        panes: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }>;
      }> }>;
    }).projects[0].spaces[0];
    expect(space.layout).toEqual({ pane: "ghostty" });
    expect(space.panes).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 }, active: true, activeTabId: "", tabs: [] },
    ]);
    expect(space.projection).toEqual({
      kind: "maximized",
      applied: true,
      focusedPaneId: "ghostty",
      swappedPanes: [],
    });
    expect(space.canonicalLayout.children).toHaveLength(3);
  });
});
