import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "./ViewTabs";
import { allGroups, useSessions } from "../state/sessions";
import { splitLeaf } from "../state/splitTree";
import { startExecutor } from "../commands/executor";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: () => {},
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
  useSessions.getState().bootstrapFirstProject("/test/root");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("기능 탭 최대화 문법", () => {
  // 더블클릭은 이제 tab.maximize **명령**을 탄다 — UI 와 CLI·AI 가 같은 경로여야 두 경로가
  // 갈리지 않는다. 그래서 이 검사도 카탈로그를 세우고 명령이 끝나기를 기다린다.
  it("탭 더블클릭은 그 기능 뷰를 최대화한다", async () => {
    const base = useSessions.getState().projects[0];
    const content = base.spaces[0];
    const viewId = "v-max";
    const group = {
      ...allGroups(content.layout)[0],
      activeTabId: viewId,
      tabs: [
        {
          id: viewId,
          kind: "plugin" as const,
          title: "Feature",
          pluginId: "fixture",
          view: "content",
        },
      ],
    };
    const project = {
      ...base,
      spaces: [{ ...content, activePaneId: group.id, layout: splitLeaf(group) }],
    };
    useSessions.setState({ projects: [project], activeId: project.id });
    startExecutor(); // 명령 카탈로그 — 없으면 REGISTRY_EMPTY 로 답하고 아무 일도 안 난다

    act(() => {
      root.render(
        <ViewTabs
          projectId={project.id}
          group={group}
          onTabPointerDown={() => {}}
        />,
      );
    });
    act(() => {
      host.querySelector(".tab")!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });

    // 명령은 비동기다 — 마이크로태스크가 비워질 때까지 기다린 뒤에 사실을 잰다.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      useSessions.getState().projects[0].spaces[0].maximizedTabId,
    ).toBe(viewId);
  });
});
