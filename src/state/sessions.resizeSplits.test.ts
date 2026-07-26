import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf, type SplitTree } from "./splitTree";
import { computeSplitLayout } from "../lib/splitLayout";
import {
  useSessions,
  type PaneNode,
  type Project,
  type Pane,
} from "./sessions";

// 세로 불분할 명제의 스토어 경계 — 동반 드래그는 라인의 모든 split 을 resizeSplits 한 커밋으로
// 영속한다. 중간 토막 상태가 없고, 레일 충돌 검사는 최종 상태 1회(거부 시 전체 무변경).

function group(id: string, viewId: string): Pane {
  return {
    id,
    activeTabId: viewId,
    tabs: [
      {
        id: viewId,
        kind: "plugin",
        title: viewId,
        pluginId: "fixture",
        view: "content",
      },
    ],
  };
}

// col[위 row, 아래 row] — 세로 라인이 두 세그먼트로 나뉜 스페이스.
function stackedProject(): Project {
  useSessions.getState().bootstrapFirstProject("/test/root");
  const base = useSessions.getState().projects[0];
  const layout: SplitTree<Pane> = {
    type: "split",
    id: "s-stack",
    dir: "col",
    sizes: [0.5, 0.5],
    children: [
      {
        type: "split",
        id: "s-top",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [splitLeaf(group("g-tl", "v-tl")), splitLeaf(group("g-tr", "v-tr"))],
      },
      {
        type: "split",
        id: "s-bot",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [splitLeaf(group("g-bl", "v-bl")), splitLeaf(group("g-br", "v-br"))],
      },
    ],
  };
  return {
    ...base,
    spaces: [{ ...base.spaces[0], activePaneId: "g-tl", layout }],
  };
}

beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
});

describe("resizeSplits — 여러 split 을 한 커밋으로", () => {
  it("라인의 두 세그먼트가 함께 적용된다", () => {
    const project = stackedProject();
    useSessions.setState({ projects: [project], activeId: project.id });

    const result = useSessions.getState().resizeSplits(project.id, [
      { splitId: "s-top", sizes: [0.6, 0.4] },
      { splitId: "s-bot", sizes: [0.6, 0.4] },
    ]);

    expect(result).toEqual({ ok: true });
    const layout = useSessions.getState().projects[0].spaces[0].layout as Extract<
      PaneNode,
      { type: "split" }
    >;
    const rows = computeSplitLayout(layout).gutters.filter((d) => d.dir === "row");
    expect(rows.map((d) => d.rect.left)).toEqual([60, 60]);
  });

  it("최종 상태가 PIN 레일과 충돌하면 전체를 거부한다(무변경)", () => {
    const project: Project = {
      ...stackedProject(),
      leftRailPlacement: { mode: "pin", station: 50 },
    };
    useSessions.setState({ projects: [project], activeId: project.id });
    const before = useSessions.getState().projects[0];

    const result = useSessions.getState().resizeSplits(project.id, [
      { splitId: "s-top", sizes: [0.6, 0.4] },
      { splitId: "s-bot", sizes: [0.6, 0.4] },
    ]);

    expect(result).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });
    expect(useSessions.getState().projects[0]).toBe(before);
  });

  it("하나라도 없는 splitId 면 TARGET_NOT_FOUND(무변경)", () => {
    const project = stackedProject();
    useSessions.setState({ projects: [project], activeId: project.id });
    const before = useSessions.getState().projects[0];

    const result = useSessions.getState().resizeSplits(project.id, [
      { splitId: "s-top", sizes: [0.6, 0.4] },
      { splitId: "s-ghost", sizes: [0.6, 0.4] },
    ]);

    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(useSessions.getState().projects[0]).toBe(before);
  });
});
