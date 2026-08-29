// @vitest-environment jsdom
// 레일 공통 양식(§12) — 슬롯 프레임: 호스트 소유 헤더(기능 아이콘·제목 + 레일 모양 토글) +
// 본문(플러그인 교체 영역). 재결부는 생성이 아니라 이사 — 도착 애니메이션 클래스가 붙는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));
// 프레임이 시험 대상 — 본문 호스트는 스텁으로 치환(플러그인 마운트 무관).
vi.mock("./PluginViewHost", () => ({
  PluginViewHost: ({ viewKey }: { viewKey: string }) => (
    <div data-testid="body-host">{viewKey}</div>
  ),
}));

import { ProjectionSlots } from "./ProjectionSlots";
import { useProjection } from "../state/projection";
import { useSessions, type Project, type Tab } from "../state/sessions";
import { useSettings } from "../state/settings";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";

const provider: PluginViewProvider = { mount: () => {} };

function decl(id: string, over: Partial<ContributedView> = {}): ContributedView {
  return {
    id,
    title: { ko: `${id}-제목`, en: `${id}-title` },
    icon: "🌲",
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
    root: "<local-evidence>/p1",
    spaces: [
      {
        id: "c1",
        title: "1",
        layout: { type: "leaf", value: { id: "g1", tabs, activeTabId } },
        activePaneId: "g1",
      },
    ],
    activeSpaceId: "c1",
  } as unknown as Project;
}

function registerFn(plug: string, content: string, railView: string) {
  useViewRegistry.getState().register(
    plug,
    decl(content, {
      sidebar: {
        left: [{ ref: `self.${railView}`, instance: "shared" }],
        right: [],
        template: "stack",
      },
    }),
    provider,
  );
  useViewRegistry.getState().register(
    plug,
    decl(railView, { placements: ["rail"], defaultPlacement: "rail" }),
    provider,
  );
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ projects: [], activeId: "" });
  useSettings.setState({ language: "ko" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const render = (commitProjection = true) =>
  act(() => {
    root.render(
      <ProjectionSlots
        projectId="p1"
        root="<local-evidence>/p1"
        paneId={null}
        side="left"
        commitProjection={commitProjection}
      />,
    );
  });

describe("레일 슬롯 공통 양식(§12)", () => {
  it("live 슬롯은 호스트 헤더(아이콘+제목)와 본문으로 렌더된다 — 내부만 기능의 것", () => {
    registerFn("termplug", "term", "tree");
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    render();
    const header = host.querySelector<HTMLElement>(".projection-header");
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain("tree-제목");
    expect(header!.textContent).toContain("🌲");
    const body = host.querySelector<HTMLElement>(".projection-card");
    expect(body).not.toBeNull();
    expect(body!.querySelector("[data-testid=body-host]")).not.toBeNull();
  });

  it("좌측 첫 슬롯 헤더의 토글이 railLook 을 pane↔ground 로 바꾸고 영속된다", () => {
    registerFn("termplug", "term", "tree");
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    render();
    expect(useSettings.getState().railLook).toBe("ground"); // 기본값 = SIDEBAR-CHROME(디자인 정본)
    const toggle = host.querySelector<HTMLElement>('[data-node="projection/left/look"]');
    expect(toggle).not.toBeNull();
    act(() => toggle!.click());
    expect(useSettings.getState().railLook).toBe("pane");
    act(() => toggle!.click());
    expect(useSettings.getState().railLook).toBe("ground");
  });

  it("영역 인계는 슬롯 표시만 바꾸고 레일 셸에 효과 클래스를 만들지 않는다(§12-④)", () => {
    registerFn("termplug", "term", "tree");
    registerFn("kanplug", "board", "nav");
    useSessions.setState({
      projects: [
        tab(
          [pluginView("v1", "termplug", "term"), pluginView("v2", "kanplug", "board")],
          "v1",
        ),
      ],
      activeId: "p1",
    });
    render();
    // 활성 뷰 전환 → 해소가 termplug.tree → kanplug.nav 로 바뀜(재결부).
    act(() => {
      useSessions.setState((s) => ({
        projects: s.projects.map((t) => ({
          ...t,
          spaces: t.spaces.map((c) => ({
            ...c,
            layout: { ...c.layout, value: { ...(c.layout as { value: object }).value, activeTabId: "v2" } },
          })),
        })),
      }) as never);
    });
    const slots = host.querySelector<HTMLElement>(".projections")!;
    expect(slots.className).toBe("projections"); // 셸은 불투명 유지 — 내용 슬롯만 인계한다.
  });
});

describe("호스트 헤더 결부 이름(§12-①)", () => {
  it("헤더에 결부 뷰 이름이 박힌다 — 별도 '연결됨' 배지 불요", () => {
    // 관계 표시 단순화(사용자 결정): 떠다니는 "연결됨 · 이름" 배지를 없애고, 사이드바가
    // 누구를 섬기는지는 호스트 헤더의 이름 한 곳이 말한다.
    registerFn("termplug", "term", "tree");
    useSessions.setState({
      projects: [tab([pluginView("v1", "termplug", "term")], "v1")],
      activeId: "p1",
    });
    render();
    const bound = host.querySelector<HTMLElement>(".projection-bound");
    expect(bound?.textContent).toBe("v1"); // viewDisplayTitle(결부 뷰)
  });
});

describe("영역 인계(§12-④)", () => {
  it("출발 표상은 이전 identity를 유지하고 도착 표상은 현재 identity를 사용한다", () => {
    registerFn("termplug", "term", "tree");
    registerFn("kanplug", "board", "nav");
    useSessions.setState({
      projects: [
        tab(
          [pluginView("v1", "termplug", "term"), pluginView("v2", "kanplug", "board")],
          "v1",
        ),
      ],
      activeId: "p1",
    });
    render();
    render(false);
    act(() => {
      useSessions.setState((s) => ({
        projects: s.projects.map((t) => ({
          ...t,
          spaces: t.spaces.map((c) => ({
            ...c,
            layout: { ...c.layout, value: { ...(c.layout as { value: object }).value, activeTabId: "v2" } },
          })),
        })),
      }) as never);
    });
    const slotOf = (title: string) =>
      [...host.querySelectorAll<HTMLElement>(".projection")].find((el) =>
        el.querySelector(".projection-title")!.textContent === title,
      )!;
    // 출발 표상은 pane에 완전히 가려질 때까지 A를 유지한다.
    expect(slotOf("nav-제목").style.display).toBe("none");
    expect(slotOf("tree-제목").style.display).not.toBe("none");
    // 도착 표상은 시작부터 B를 사용한다. 자체 타이머는 없다.
    render(true);
    expect(slotOf("tree-제목").style.display).toBe("none");
    expect(slotOf("nav-제목").style.display).not.toBe("none");
    expect(slotOf("tree-제목").className).toBe("projection");
    expect(slotOf("nav-제목").className).toBe("projection");
  });
});
