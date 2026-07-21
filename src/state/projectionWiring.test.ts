// projection 실배선(§4) — 세션 활성 체인 → BoundView, 실 레지스트리 deps, 추적 구독.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import {
  boundViewOf,
  projectionFor,
  startProjectionTracking,
} from "./projectionWiring";
import { useProjection } from "./projection";
import { useSessions, type ProjectTab, type View } from "./sessions";
import { initialSidebarLayout } from "./sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import { useFileViewerRegistry } from "../plugins/fileViewerRegistry";
import { usePlugins, type PluginRuntime } from "./plugins";
import { onPluginEvent } from "../plugins/hooks";
import { parseManifest, type ContributedView } from "../plugins/spec";

const provider: PluginViewProvider = { mount: () => {} };
const TREE_CONTRACT = "soksak-spec-plugin-sidebar-file-tree";

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
    ...over,
  };
}

function runtime(raw: Record<string, unknown>): PluginRuntime {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-spec-plugin@0.0.1",
      name: "F",
      version: "0.0.1",
      description: "fixture",
      permissions: [],
      ...raw,
    },
    raw.id as string,
  );
  if (!manifest) throw new Error(validation.errors.join("; "));
  return { manifest, dir: `/tmp/${manifest.id}`, source: "dev", status: "enabled" };
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
  useFileViewerRegistry.setState({ viewers: {}, version: 0 });
  usePlugins.setState({ plugins: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ tabs: [], activeId: "" });
});

describe("boundViewOf — 세션 활성 체인 → BoundView(A8)", () => {
  it("plugin 뷰: 등록 decl 의 sidebar 선언을 나른다", () => {
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
    const t = tab([pluginView("v1", "termplug", "term")], "v1");
    const bound = boundViewOf(t);
    expect(bound).toMatchObject({ viewId: "v1", ownerPluginId: "termplug" });
    expect(bound?.sidebar?.left[0]).toMatchObject({ ref: "self.tree" });
  });

  it("file 뷰: 담당 fileViewer 의 sidebar 선언을 나른다(§3.1)", () => {
    useFileViewerRegistry.getState().register(
      "edplug",
      {
        id: "code",
        extensions: ["ts"],
        sidebar: {
          left: [{ ref: "self.outline", instance: "shared" }],
          right: [],
          template: "stack",
        },
      },
      { mount: () => {} },
    );
    const fileView: View = { id: "v2", kind: "file", title: "b.ts", path: "/a/b.ts", mode: "code" };
    const bound = boundViewOf(tab([fileView], "v2"));
    expect(bound).toMatchObject({ viewId: "v2", ownerPluginId: "edplug" });
    expect(bound?.sidebar?.left[0]).toMatchObject({ ref: "self.outline" });
  });

  it("담당 뷰어 없는 file 뷰 → 선언 부재(null sidebar)", () => {
    const fileView: View = { id: "v3", kind: "file", title: "x.zzz", path: "/x.zzz", mode: "code" };
    const bound = boundViewOf(tab([fileView], "v3"));
    expect(bound?.sidebar).toBeNull();
  });
});

describe("projectionFor — 실 deps(계약 해소·rail 검증·consumes 게이트)", () => {
  it("계약 슬롯이 활성 구현체의 rail 뷰로 live 해소된다", () => {
    usePlugins.setState({
      plugins: {
        termplug: runtime({ id: "termplug", consumes: [{ id: TREE_CONTRACT, range: "^0.0.1" }] }),
        filetree: runtime({ id: "filetree", implements: [{ id: TREE_CONTRACT, version: "0.0.1" }] }),
      },
    });
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ contract: TREE_CONTRACT, range: "^0.0.1", view: "tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "filetree",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    const p = projectionFor("p1");
    expect(p?.left.slots[0]).toMatchObject({
      resolvedRef: "filetree.tree",
      instanceKey: "p1|filetree.tree",
      status: "live",
    });
  });

  it("consumes 미선언이면 같은 구성이 degraded(계약-핀 게이트)", () => {
    usePlugins.setState({
      plugins: {
        termplug: runtime({ id: "termplug" }),
        filetree: runtime({ id: "filetree", implements: [{ id: TREE_CONTRACT, version: "0.0.1" }] }),
      },
    });
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ contract: TREE_CONTRACT, range: "^0.0.1", view: "tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "filetree",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    expect(projectionFor("p1")?.left.slots[0].status).toBe("degraded");
  });

  it("미존재 프로젝트 → null", () => {
    expect(projectionFor("nope")).toBeNull();
  });
});

describe("startProjectionTracking — 결부 관측·이벤트(R1·§4.3)", () => {
  it("활성 뷰 전환마다 noteBinding + projection.changed 발화(탭 전환 포함)", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("v1", "termplug", "term");
    const v2 = pluginView("v2", "termplug", "term");
    useSessions.setState({ tabs: [tab([v1, v2], "v1")], activeId: "p1" });

    const events: { projectId: string; viewId: string | null }[] = [];
    const off = onPluginEvent("projection.changed", (e) => void events.push(e));
    const stop = startProjectionTracking();

    // 그룹 내 활성 탭 전환 = 결부 변경(A8).
    const t = useSessions.getState().tabs[0];
    useSessions.setState({
      tabs: [
        {
          ...t,
          contents: [
            {
              ...t.contents[0],
              layout: { type: "leaf", value: { id: "g1", views: [v1, v2], activeViewId: "v2" } },
            },
          ],
        },
      ],
    });

    expect(events.some((e) => e.projectId === "p1" && e.viewId === "v2")).toBe(true);
    expect(useProjection.getState().byProject.p1.focusHistory[0]).toBe("v2");

    stop();
    off.dispose();
  });

  it("뷰 소멸 → focusHistory 정리, 프로젝트 소멸 → 상태 회수", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("v1", "termplug", "term");
    const v2 = pluginView("v2", "termplug", "term");
    useSessions.setState({ tabs: [tab([v1, v2], "v1")], activeId: "p1" });
    const stop = startProjectionTracking();

    const t = useSessions.getState().tabs[0];
    // v2 활성 → v1 로 복귀 → 이력 [v1, v2]
    useSessions.setState({
      tabs: [{ ...t, contents: [{ ...t.contents[0], layout: { type: "leaf", value: { id: "g1", views: [v1, v2], activeViewId: "v2" } } }] }],
    });
    const t2 = useSessions.getState().tabs[0];
    useSessions.setState({
      tabs: [{ ...t2, contents: [{ ...t2.contents[0], layout: { type: "leaf", value: { id: "g1", views: [v1, v2], activeViewId: "v1" } } }] }],
    });
    expect(useProjection.getState().byProject.p1.focusHistory).toEqual(["v1", "v2"]);

    // v2 닫힘 → 이력에서 제거(R6 재료 정리).
    const t3 = useSessions.getState().tabs[0];
    useSessions.setState({
      tabs: [{ ...t3, contents: [{ ...t3.contents[0], layout: { type: "leaf", value: { id: "g1", views: [v1], activeViewId: "v1" } } }] }],
    });
    expect(useProjection.getState().byProject.p1.focusHistory).toEqual(["v1"]);

    // 프로젝트 닫힘 → 회수.
    useSessions.setState({ tabs: [], activeId: "" });
    expect(useProjection.getState().byProject.p1).toBeUndefined();
    stop();
  });
});
