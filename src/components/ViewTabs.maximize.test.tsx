import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "./ViewTabs";
import { allGroups, useSessions } from "../state/sessions";
import { splitLeaf } from "../state/splitTree";

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
  it("탭 더블클릭은 그 기능 뷰를 최대화한다", () => {
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
      host.querySelector(".view-tab")!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });

    expect(
      useSessions.getState().projects[0].spaces[0].maximizedTabId,
    ).toBe(viewId);
  });
});
