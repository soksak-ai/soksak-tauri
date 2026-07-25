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
import { execute } from "./registry";
import { useSessions, type ProjectTab, type ViewGroup } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useSettings } from "../state/settings";
import { splitLeaf } from "../state/splitTree";

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
  const base = project({ mode: "pin", station: 0 });
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

    });

describe("state.tree leftRailPosition", () => {
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
  it("정박 단일 계약 — 포커스는 위치의 입력이 아니고, 레거시 FLOW 는 정규화된다", async () => {
    // 이주(flow)·근접 투영 폐지: 간접 사건(다른 뷰 포커스)이 패널 기하를 바꾸지 않는다
    // (NATIVE-SURFACES §2 기하 소유권). 레거시 호출은 현 유효선 정박으로 이행된다.
    const t0 = useSessions.getState().tabs[0];
    const before = (await execute("sidebar.left.position", {}, {})) as {
      data?: { leftRailPosition?: { effectiveStation: number } };
    };
    const at = before.data?.leftRailPosition?.effectiveStation ?? 0;
    const legacy = (await execute(
      "sidebar.left.position",
      { mode: "flow" },
      {},
    )) as { ok?: boolean; code?: string };
    expect(legacy.code ?? "OK").toBe("OK");
    // 응답 봉투가 저장 결과의 단일 진실 — 픽스처 프로젝트 id 에 의존하지 않는다.
    const now = (await execute("sidebar.left.position", {}, {})) as {
      data?: { leftRailPosition?: { mode: string; effectiveStation: number } };
    };
    expect(now.data?.leftRailPosition?.mode).toBe("pin");
    expect(now.data?.leftRailPosition?.effectiveStation).toBe(at);
    void t0;
  });

});
