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

  it("재결부의 콘텐츠 스왑에 등장/퇴장 효과 클래스가 붙지 않는다 — 이동은 레일 프레임의 실좌표 주행뿐(§12-④)", () => {
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
    expect(slots.className).toBe("proj-slots"); // 효과 클래스 없음 — hide→show 연출 금지
  });
});

describe("반환점 교체(§12-④) — 이동 중 재결부는 여정의 절반에서 내용이 갈아탄다", () => {
  it("midSwap 중엔 옛 내용 유지 → 140ms 에 새 내용", () => {
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
    act(() => {
      root.render(
        <ProjectionSlots projectId="p1" root="/tmp/p1" paneId={null} side="left" midSwap />,
      );
    });
    const shown = () =>
      [...host.querySelectorAll<HTMLElement>(".proj-slot")]
        .filter((el) => el.style.display !== "none")
        .map((el) => el.querySelector(".proj-frame-title")!.textContent);
    expect(shown()).toEqual(["tree-제목"]);
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
    expect(shown()).toEqual(["tree-제목"]); // 출발은 옛 내용으로
    act(() => vi.advanceTimersByTime(150));
    expect(shown()).toEqual(["nav-제목"]); // 반환점에서 교체
    vi.useRealTimers();
  });
});
