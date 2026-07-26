// ui.projection.* / ui.intent.open 명령 계약(§4.2·R2·R4).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { registerProjectionCatalog } from "./catalogProjection";
import { execute, getSpec } from "./registry";
import { useProjection } from "../state/projection";
import { useSessions, type Project, type Tab } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";

registerProjectionCatalog();

const provider: PluginViewProvider = { mount: () => {} };

function decl(id: string, over: Partial<ContributedView> = {}): ContributedView {
  return {
    id,
    title: id,
    icon: "x",
    placements: ["content"],
    defaultPlacement: "content",
    transparent: false,
    nativeSurface: false,
    decoration: false,
    resident: false,
    ...over,
  };
}

function pluginView(id: string, pluginId: string, view: string): Tab {
  return { id, kind: "plugin", title: id, pluginId, view };
}

function tab(tabs: Tab[], activeTabId: string): Project {
  return {
    id: "p1",
    title: "P",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: "/tmp/p1",
    spaces: [
      {
        id: "c1",
        title: "1",
        layout: { type: "leaf", value: { id: "g1", tabs, activeTabId } },
        activePaneId: "g1",
      },
    ],
    activeSpaceId: "c1",
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ projects: [], activeId: "" });
});

describe("ui.projection.state", () => {
  it("활성 프로젝트의 결부·슬롯·핀을 반환한다", async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ ref: "self.tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });

    const r = (await execute("ui.projection.state", {}, {})) as { ok: boolean; code: string; data: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      projectId: "p1",
      binding: { viewId: "v1" },
    });
    const left = r.data.left as { slots: { resolvedRef: string; status: string }[] };
    expect(left.slots[0]).toMatchObject({ resolvedRef: "termplug.tree", status: "live" });
  });

  it("미존재 프로젝트 → TARGET_NOT_FOUND", async () => {
    const r = (await execute("ui.projection.state", { project: "nope" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("ui.projection.pin / unpin — 좌 레일은 투영 전용(핀 축 없음)", () => {
  it("좌측 핀은 상주형이어도 INVALID_PARAMS — 좌 레일은 결부 투영 전용", async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail", resident: true }),
      provider,
    );
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree" }, {})) as { ok: boolean; code: string; message: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
    expect(String(r.message)).toContain("투영 전용");
  });

  it("unpin 은 잔존 핀(구 스냅샷) 청소용으로 살아 있고 멱등이다", async () => {
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    useProjection.getState().pin("p1", "left", "gone.tree"); // 구 스냅샷 잔존 시뮬레이션
    const r1 = (await execute("ui.projection.unpin", { ref: "gone.tree" }, {})) as { ok: boolean };
    expect(r1.ok).toBe(true);
    const st = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect((st.data.pins as { left: string[] }).left).toEqual([]);
    const r2 = (await execute("ui.projection.unpin", { ref: "gone.tree" }, {})) as { ok: boolean };
    expect(r2.ok).toBe(true); // 멱등
  });
});

describe("ui.intent.open — R2(결부 문맥 배치·멱등 재사용)", () => {
  it("상대경로는 경계에서 거부한다 — 조용히 받으면 죽은 탭으로 영속된다(실측 RED)", async () => {
    // 계약은 절대경로(params.path: "Absolute file path")다. 상대경로가 통과하면 그 문자열이
    // 탭에 영속되고 복원이 "No such file or directory" 죽은 탭으로 깨어난다(2026-07-26 실측:
    // "README.md" 로 열린 탭이 재시작 후 사망 — 사용자 화면으로 발견됐다).
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.intent.open", { path: "README.md" }, {})) as {
      ok: boolean;
      code?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("파일을 결부 그룹에 탭으로 열고, 같은 리소스는 기존 뷰를 재사용한다", async () => {
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r1 = (await execute("ui.intent.open", { path: "/tmp/p1/a.md" }, {})) as { ok: boolean; data: Record<string, unknown> };
    expect(r1.ok).toBe(true);
    expect(r1.data.existing).toBe(false);
    const r2 = (await execute("ui.intent.open", { path: "/tmp/p1/a.md" }, {})) as { ok: boolean; data: Record<string, unknown> };
    expect(r2.ok).toBe(true);
    expect(r2.data.existing).toBe(true);
    expect(r2.data.viewId).toBe(r1.data.viewId);
  });

  it("스펙(getSpec) — path 필수 파라미터 선언", () => {
    const spec = getSpec("ui.intent.open")!;
    expect(spec.params.path?.required).toBe(true);
  });
});

describe("배치① 명령 정합 — 우측 핀 거부·alias 핀·확장 상태", () => {
  it('side:"right" 핀은 우측 핀 스택 렌더러가 생기기 전까지 INVALID_PARAMS', async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree", side: "right" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });


  it("state 는 binding.groupId·contentId 와 focusHistory 를 포함한다(§4.1)", async () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    useProjection.getState().noteBinding("p1", "v1");
    const r = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect(r.data.binding).toMatchObject({ viewId: "v1", groupId: "g1", contentId: "c1" });
    expect(r.data.focusHistory).toEqual(["v1"]);
  });
});

