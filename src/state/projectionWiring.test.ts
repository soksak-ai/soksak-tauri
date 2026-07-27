// projection 실배선(§4) — 세션 활성 체인 → BoundView, 실 레지스트리 deps, 추적 구독.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../platform", () => ({ invoke: vi.fn(async () => undefined) }));

import {
  boundViewOf,
  projectionFor,
  startProjectionTracking,
} from "./projectionWiring";
import { useProjection } from "./projection";
import { useSessions, type Project, type Tab } from "./sessions";
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
    resident: false,
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
  useFileViewerRegistry.setState({ viewers: {}, version: 0 });
  usePlugins.setState({ plugins: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ projects: [], activeId: "" });
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
    const fileView: Tab = { id: "v2", kind: "file", title: "b.ts", path: "/a/b.ts", mode: "code" };
    const bound = boundViewOf(tab([fileView], "v2"));
    expect(bound).toMatchObject({ viewId: "v2", ownerPluginId: "edplug" });
    expect(bound?.sidebar?.left[0]).toMatchObject({ ref: "self.outline" });
  });

  it("담당 뷰어 없는 file 뷰 → 선언 부재(null sidebar)", () => {
    const fileView: Tab = { id: "v3", kind: "file", title: "x.zzz", path: "/x.zzz", mode: "code" };
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    expect(projectionFor("p1")?.left.slots[0].status).toBe("degraded");
  });

  it("미존재 프로젝트 → null", () => {
    expect(projectionFor("nope")).toBeNull();
  });
});

describe("startProjectionTracking — 스페이스별 단일 결부", () => {
  it("같은 rail 인스턴스를 공유해도 결부 대상은 현재 활성 뷰로 이동한다", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("v1", "termplug", "term");
    const v2 = pluginView("v2", "termplug", "term");
    useSessions.setState({ projects: [tab([v1, v2], "v1")], activeId: "p1" });

    const events: { projectId: string; viewId: string | null }[] = [];
    const off = onPluginEvent("projection.changed", (e) => void events.push(e));
    const stop = startProjectionTracking();
    expect(projectionFor("p1")?.binding.viewId).toBe("v1");

    // 그룹 내 활성 탭 전환 = 결부 변경(A8).
    const t = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [
        {
          ...t,
          spaces: [
            {
              ...t.spaces[0],
              layout: { type: "leaf", value: { id: "g1", tabs: [v1, v2], activeTabId: "v2" } },
            },
          ],
        },
      ],
    });

    expect(projectionFor("p1")?.binding.viewId).toBe("v2");
    expect(events.some((e) => e.projectId === "p1" && e.viewId === "v2")).toBe(true);
    expect(useProjection.getState().byProject.p1.focusHistory[0]).toBe("v2");

    stop();
    off.dispose();
  });

  it("뷰 소멸 → focusHistory 정리, 프로젝트 소멸 → 상태 회수", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("v1", "termplug", "term");
    const v2 = pluginView("v2", "termplug", "term");
    useSessions.setState({ projects: [tab([v1, v2], "v1")], activeId: "p1" });
    const stop = startProjectionTracking();

    const t = useSessions.getState().projects[0];
    // v2 활성 → v1 로 복귀 → 이력 [v1, v2]
    useSessions.setState({
      projects: [{ ...t, spaces: [{ ...t.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [v1, v2], activeTabId: "v2" } } }] }],
    });
    const t2 = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [{ ...t2, spaces: [{ ...t2.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [v1, v2], activeTabId: "v1" } } }] }],
    });
    expect(useProjection.getState().byProject.p1.focusHistory).toEqual(["v1", "v2"]);

    // v2 닫힘 → 이력에서 제거(R6 재료 정리).
    const t3 = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [{ ...t3, spaces: [{ ...t3.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [v1], activeTabId: "v1" } } }] }],
    });
    expect(useProjection.getState().byProject.p1.focusHistory).toEqual(["v1"]);

    // 프로젝트 닫힘 → 회수.
    useSessions.setState({ projects: [], activeId: "" });
    expect(useProjection.getState().byProject.p1).toBeUndefined();
    stop();
  });
});


describe("projection.changed 지문 발화(§4.3) — 슬롯 해소 변화·부트 무발화", () => {
  it("슬롯 degraded→live 전환(결부 불변)에도 발화하고, 첫 sync(부트)는 무발화", () => {
    // 터미널: self 참조 선언 — 대상 rail 뷰는 아직 미등록(degraded).
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });

    const events: { projectId: string; viewId: string | null }[] = [];
    const off = onPluginEvent("projection.changed", (e) => void events.push(e));
    const stop = startProjectionTracking();
    expect(events).toEqual([]); // 부트 관측은 발화하지 않는다(복원 리플레이 금지)

    // rail 대상 등록 → 같은 결부에서 슬롯이 degraded→live — 발화해야 한다.
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    expect(events.some((e) => e.projectId === "p1" && e.viewId === "v1")).toBe(true);

    stop();
    off.dispose();
  });
});

describe("R6 승계 — 결부 뷰 닫힘 시 같은 스페이스의 focusHistory 최근 생존 뷰", () => {
  it("A(g1)→B(g2)→A 순서 후 A 를 닫으면 결부는 인접탭 C 가 아니라 B", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const vA = pluginView("vA", "termplug", "term");
    const vB = pluginView("vB", "termplug", "term");
    const vC = pluginView("vC", "termplug", "term");
    const t: Project = {
      ...tab([], ""),
      spaces: [
        {
          id: "c1",
          title: "1",
          activePaneId: "g1",
          layout: {
            type: "split",
            id: "s1",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { type: "leaf", value: { id: "g1", tabs: [vA, vC], activeTabId: "vA" } },
              { type: "leaf", value: { id: "g2", tabs: [vB], activeTabId: "vB" } },
            ],
          },
        },
      ],
    };
    useSessions.setState({ projects: [t], activeId: "p1" });
    const stop = startProjectionTracking();

    // 결부 이력 만들기: A → B → A (활성 그룹 전환).
    const setActive = (gid: string) => {
      const cur = useSessions.getState().projects[0];
      useSessions.setState({
        projects: [{ ...cur, spaces: [{ ...cur.spaces[0], activePaneId: gid }] }],
      });
    };
    setActive("g2"); // B 결부
    setActive("g1"); // A 결부
    expect(useProjection.getState().byProject.p1.focusHistory.slice(0, 2)).toEqual(["vA", "vB"]);

    const r = useSessions.getState().closeView("p1", "vA");
    expect(r.ok).toBe(true);
    const content = useSessions.getState().projects[0].spaces[0];
    expect(content.activePaneId).toBe("g2"); // R6: 최근 생존 = B(g2)
    stop();
  });
});

describe("재결부 — 활성 콘텐츠 뷰가 스페이스 결부를 정한다(③)", () => {
  it("다른 기능 뷰 활성화 시 슬롯이 그 기능의 선언으로 교체된다", () => {
    useViewRegistry.getState().register(
      "kanplug",
      decl("board", {
        sidebar: { left: [{ ref: "self.tree", instance: "per-view" }], right: [], template: "stack" },
      }),
      provider,
    );
    useViewRegistry.getState().register("kanplug", decl("tree", { placements: ["rail"], defaultPlacement: "rail" }), provider);
    useViewRegistry.getState().register(
      "runplug",
      decl("runbook", {
        sidebar: { left: [{ ref: "self.list", instance: "per-view" }], right: [], template: "stack" },
      }),
      provider,
    );
    useViewRegistry.getState().register("runplug", decl("list", { placements: ["rail"], defaultPlacement: "rail" }), provider);

    const vA = pluginView("vA", "kanplug", "board");
    const vB = pluginView("vB", "runplug", "runbook");
    useSessions.setState({ projects: [tab([vA, vB], "vA")], activeId: "p1" });
    const stop = startProjectionTracking();
    expect(projectionFor("p1")?.left.slots[0]?.resolvedRef).toBe("kanplug.tree");

    // 활성 탭 전환 = 기능 전환 → 결부·슬롯 교체.
    const t = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [{ ...t, spaces: [{ ...t.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [vA, vB], activeTabId: "vB" } } }] }],
    });
    expect(projectionFor("p1")?.left.slots[0]?.resolvedRef).toBe("runplug.list");
    stop();
  });
});
