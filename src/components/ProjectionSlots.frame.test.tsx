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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
// 프레임이 시험 대상 — 본문 호스트는 스텁으로 치환(플러그인 마운트 무관).
vi.mock("./PluginViewHost", () => ({
  PluginViewHost: ({ viewKey }: { viewKey: string }) => (
    <div data-testid="body-host">{viewKey}</div>
  ),
}));

import { ProjectionSlots } from "./ProjectionSlots";
import { useProjection } from "../state/projection";
import { useSessions, type ProjectTab, type View } from "../state/sessions";
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
  } as unknown as ProjectTab;
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
  useSessions.setState({ tabs: [], activeId: "" });
  useSettings.setState({ language: "ko" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const render = () =>
  act(() => {
    root.render(
      <ProjectionSlots projectId="p1" root="/tmp/p1" paneId={null} side="left" />,
    );
  });

describe("레일 슬롯 공통 양식(§12)", () => {
  it("live 슬롯은 호스트 헤더(아이콘+제목)와 본문으로 렌더된다 — 내부만 기능의 것", () => {
    registerFn("termplug", "term", "tree");
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    render();
    const header = host.querySelector<HTMLElement>(".proj-frame-header");
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain("tree-제목");
    expect(header!.textContent).toContain("🌲");
    const body = host.querySelector<HTMLElement>(".proj-frame-body");
    expect(body).not.toBeNull();
    expect(body!.querySelector("[data-testid=body-host]")).not.toBeNull();
  });

  it("좌측 첫 슬롯 헤더의 토글이 railLook 을 pane↔ground 로 바꾸고 영속된다", () => {
    registerFn("termplug", "term", "tree");
    useSessions.setState({ tabs: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    render();
    expect(useSettings.getState().railLook).toBe("ground"); // 기본값 = SIDEBAR-CHROME(디자인 정본)
    const toggle = host.querySelector<HTMLElement>('[data-node="projection/left/look"]');
    expect(toggle).not.toBeNull();
    act(() => toggle!.click());
    expect(useSettings.getState().railLook).toBe("pane");
    act(() => toggle!.click());
    expect(useSettings.getState().railLook).toBe("ground");
  });

  it("내용 인계 효과는 슬롯에만 붙고 레일 셸 컨테이너에는 붙지 않는다(§12-④)", () => {
    registerFn("termplug", "term", "tree");
    registerFn("kanplug", "board", "nav");
    useSessions.setState({
      tabs: [
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
        tabs: s.tabs.map((t) => ({
          ...t,
          contents: t.contents.map((c) => ({
            ...c,
            layout: { ...c.layout, value: { ...(c.layout as { value: object }).value, activeViewId: "v2" } },
          })),
        })),
      }) as never);
    });
    const slots = host.querySelector<HTMLElement>(".proj-slots")!;
    expect(slots.className).toBe("proj-slots"); // 셸은 불투명 유지 — 내용 슬롯만 인계한다.
  });
});

describe("여정 디졸브(§12-④) — A1 → A0 → B0 → B1 순차 교체", () => {
  it("교체 순간 옛 내용은 leaving, 새 내용은 entering 상태로 같은 여정을 공유한다", () => {
    vi.useFakeTimers();
    registerFn("termplug", "term", "tree");
    registerFn("kanplug", "board", "nav");
    useSessions.setState({
      tabs: [
        tab(
          [pluginView("v1", "termplug", "term"), pluginView("v2", "kanplug", "board")],
          "v1",
        ),
      ],
      activeId: "p1",
    });
    render();
    act(() => {
      useSessions.setState((s) => ({
        tabs: s.tabs.map((t) => ({
          ...t,
          contents: t.contents.map((c) => ({
            ...c,
            layout: { ...c.layout, value: { ...(c.layout as { value: object }).value, activeViewId: "v2" } },
          })),
        })),
      }) as never);
    });
    const slotOf = (title: string) =>
      [...host.querySelectorAll<HTMLElement>(".proj-slot")].find((el) =>
        el.querySelector(".proj-frame-title")!.textContent === title,
      )!;
    // 출발 즉시: 옛 내용은 먼저 소거되고 새 내용은 중립 구간까지 투명하게 기다린다.
    expect(slotOf("nav-제목").style.display).not.toBe("none");
    expect(slotOf("nav-제목").className).toContain("entering");
    expect(slotOf("tree-제목").className).toContain("leaving");
    expect(slotOf("tree-제목").style.display).not.toBe("none");
    // 여정(280ms) 종료 후: 퇴장 슬롯은 접히고 도착 슬롯의 효과 클래스도 제거된다.
    act(() => vi.advanceTimersByTime(320));
    expect(slotOf("tree-제목").style.display).toBe("none");
    expect(slotOf("tree-제목").className).not.toContain("leaving");
    expect(slotOf("nav-제목").className).not.toContain("entering");
    vi.useRealTimers();
  });
});
