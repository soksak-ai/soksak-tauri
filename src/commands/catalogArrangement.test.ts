// 배치의 공개 표면. 해는 (그리드, 포커스)의 순수 함수이므로 명령의 답은 해결기 결과와
// 정확히 같아야 한다 — 두 값이 갈리면 화면과 계약 중 하나가 거짓말을 하고 있다는 뜻이다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", () => ({ invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { projectArrangement, useSessions, type Project, type Pane } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { splitLeaf } from "../state/splitTree";
import { prepareLayoutMove } from "../lib/layoutTransitionHost";
import { __resetLayoutTransitionJournalForTest } from "../lib/layoutTransitionJournal";

const group = (id: string): Pane => ({
  id,
  activeTabId: `v-${id}`,
  tabs: [
    { id: `v-${id}`, kind: "plugin", title: id, pluginId: "fixture", view: "content" },
  ],
});

function project(activePaneId: string): Project {
  return {
    id: "t1",
    title: "P",
    root: "/tmp/arrangement",
    sidebarOpen: true,
    leftRailPlacement: { mode: "flow" },
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    spaces: [
      {
        id: "c1",
        title: "1",
        activePaneId,
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [splitLeaf(group("g1")), splitLeaf(group("g2"))],
        },
      },
    ],
    activeSpaceId: "c1",
  };
}

registerCatalog();

beforeEach(() => {
  __resetLayoutTransitionJournalForTest();
  useSessions.setState({ projects: [project("g2")], activeId: "t1" });
});

describe("layout.arrangement", () => {
  it("녹화와 독립된 유한 layout 거래 장부를 명령으로 노출한다", async () => {
    const prepared = await prepareLayoutMove([{ viewId: "v-g1", dx: 120 }]);
    await prepared.commit();
    const result = await execute("layout.transactions", {}, {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        entries: [{
          transactionId: "layout-1",
          phase: "committed",
          moves: [{ viewId: "v-g1", dx: 120 }],
        }],
      },
    });
  });

  it("해결기의 답을 그대로 노출한다 — 명령과 화면이 같은 계산을 쓴다", async () => {
    const result = await execute("layout.arrangement", {}, {});
    expect(result.ok).toBe(true);
    const solved = projectArrangement(useSessions.getState().projects[0])!;
    const data = result.data as {
      station: number;
      switched: boolean;
      cleanLines: number[];
      cells: Array<{ id: string; railSide: string }>;
    };
    expect(data.station).toBe(solved.station);
    expect(data.cleanLines).toEqual(solved.cleanLines);
    expect(data.switched).toBe(solved.swapped);
    expect(data.cells.map((cell) => cell.id)).toEqual(solved.cells.map((cell) => cell.id));
  });

  it("포커스가 station 의 입력이다 — 다른 패널을 활성하면 답이 따라온다", async () => {
    const at = (await execute("layout.arrangement", {}, {})) as { data?: { station: number } };
    expect(at.data?.station).toBe(50); // g2 포커스

    useSessions.getState().setActiveGroup("t1", "g1");
    const moved = (await execute("layout.arrangement", {}, {})) as { data?: { station: number } };
    expect(moved.data?.station).toBe(0);
  });

  it("레일이 가로지르는 패널만 railSide 가 바뀐다 — 폭은 절대 변하지 않는다", async () => {
    const before = (await execute("layout.arrangement", {}, {})) as {
      data?: { cells: Array<{ id: string; railSide: string; rect: { width: number } }> };
    };
    useSessions.getState().setActiveGroup("t1", "g1");
    const after = (await execute("layout.arrangement", {}, {})) as {
      data?: { cells: Array<{ id: string; railSide: string; rect: { width: number } }> };
    };
    const side = (
      d: { cells: Array<{ id: string; railSide: string }> } | undefined,
      id: string,
    ) => d?.cells.find((cell) => cell.id === id)?.railSide;
    expect(side(before.data, "g1")).toBe("before");
    expect(side(after.data, "g1")).toBe("after"); // 레일이 g1 을 가로질렀다
    expect(side(before.data, "g2")).toBe("after");
    expect(side(after.data, "g2")).toBe("after"); // 무관 — 이동 없음
    for (const id of ["g1", "g2"]) {
      expect(after.data?.cells.find((c) => c.id === id)?.rect.width).toBe(
        before.data?.cells.find((c) => c.id === id)?.rect.width,
      );
    }
  });
});

// 구조 변경 응답의 arrangement 동봉은 라이브 게이트가 검증한다(scripts/e2e/slot-freeze.mjs):
// 분할·병합은 실제 뷰 레지스트리를 요구하므로 jsdom 픽스처에서는 명령이 INTERNAL 로 떨어진다 —
// 계약을 약하게 만드는 대신 실제 앱에서 판정한다.
