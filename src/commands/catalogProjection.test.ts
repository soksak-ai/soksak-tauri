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
import { useSessions, type ProjectTab, type View } from "../state/sessions";
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

function pluginView(id: string, pluginId: string, view: string): View {
  return { id, kind: "plugin", title: id, pluginId, view };
}

function tab(views: View[], activeViewId: string): ProjectTab {
  return {
    id: "p1",
    title: "P",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: "/tmp/p1",
    contents: [
      {
        id: "c1",
        title: "1",
        layout: { type: "leaf", value: { id: "g1", views, activeViewId } },
        activeGroupId: "g1",
      },
    ],
    activeContentId: "c1",
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ tabs: [], activeId: "" });
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
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });

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

describe("ui.projection.pin / unpin — R4(핀 = ref, rail 뷰만)", () => {
  it("rail 미등록 ref 는 INVALID_PARAMS", async () => {
    useSessions.setState({ tabs: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "nope.tree" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("핀 추가는 멱등이고 shared 투영을 흡수한다(satisfied-by-pin)", async () => {
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
      decl("tree", { placements: ["rail"], defaultPlacement: "rail", resident: true }),
      provider,
    );
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });

    const r1 = (await execute("ui.projection.pin", { ref: "termplug.tree" }, {})) as { ok: boolean };
    expect(r1.ok).toBe(true);
    await execute("ui.projection.pin", { ref: "termplug.tree" }, {}); // 멱등

    const st = (await execute("ui.projection.state", {}, {})) as { ok: boolean; code: string; data: Record<string, unknown> };
    expect((st.data.pins as { left: string[] }).left).toEqual(["termplug.tree"]);
    const left = st.data.left as { slots: { status: string }[] };
    expect(left.slots[0].status).toBe("satisfied-by-pin");

    const r2 = (await execute("ui.projection.unpin", { ref: "termplug.tree" }, {})) as { ok: boolean };
    expect(r2.ok).toBe(true);
    const st2 = (await execute("ui.projection.state", {}, {})) as { ok: boolean; code: string; data: Record<string, unknown> };
    expect((st2.data.pins as { left: string[] }).left).toEqual([]);
  });
});

describe("ui.intent.open — R2(결부 문맥 배치·멱등 재사용)", () => {
  it("파일을 결부 그룹에 탭으로 열고, 같은 리소스는 기존 뷰를 재사용한다", async () => {
    useSessions.setState({ tabs: [tab([], "")], activeId: "p1" });
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
    useSessions.setState({ tabs: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree", side: "right" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("레거시 sidebar-left placement 뷰도 핀 가능(앨리어스 기간)", async () => {
    useViewRegistry.getState().register(
      "mailplug",
      decl("inbox", { placements: ["sidebar-left"], defaultPlacement: "sidebar-left" }),
      provider,
    );
    useSessions.setState({ tabs: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "mailplug.inbox" }, {})) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it("state 는 binding.groupId·contentId 와 focusHistory 를 포함한다(§4.1)", async () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    useProjection.getState().noteBinding("p1", "v1");
    const r = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect(r.data.binding).toMatchObject({ viewId: "v1", groupId: "g1", contentId: "c1" });
    expect(r.data.focusHistory).toEqual(["v1"]);
  });
});

describe("핀 제한(②) — resident 아닌 rail 뷰는 핀 불가", () => {
  it("resident 미선언 rail 뷰 핀 → INVALID_PARAMS(선언-투영 전용)", async () => {
    useViewRegistry.getState().register(
      "ftplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ tabs: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "ftplug.tree" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("레거시 sidebar-* placement 는 앨리어스 기간 동안 resident 간주 — 핀 가능 유지", async () => {
    useViewRegistry.getState().register(
      "mailplug",
      decl("inbox", { placements: ["sidebar-left"], defaultPlacement: "sidebar-left" }),
      provider,
    );
    useSessions.setState({ tabs: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "mailplug.inbox" }, {})) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});

describe("배치② — per-view 참조 핀 거부(R4)", () => {
  it("현재 per-view 로 투영 중인 ref 는 INVALID_PARAMS", async () => {
    useViewRegistry.getState().register(
      "dbplug",
      decl("erd", {
        sidebar: {
          left: [{ ref: "self.nav", instance: "per-view" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "dbplug",
      decl("nav", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ tabs: [tab([pluginView("v1", "dbplug", "erd")], "v1")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "dbplug.nav" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });
});
