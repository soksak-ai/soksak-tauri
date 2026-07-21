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

const group = (id: string): ViewGroup => ({ id, views: [], activeViewId: "" });

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

registerCatalog();

beforeEach(() => {
  useSessions.setState({ tabs: [project()], activeId: "t1" });
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
});
