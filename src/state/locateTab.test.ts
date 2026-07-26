// locateTab — 탭 id(플러그인이 app.pty.spawn 에 넘긴 그 키) → {projectId, viewId}. 순수함수.
// 파라미터 이름 paneId 는 플러그인 계약면의 옛 이름이라 아직 그대로다(docs/NAMING.md 이행표).
import { describe, expect, it } from "vitest";
import { locateTab, type Project, type Tab } from "./sessions";

// 플러그인 터미널 뷰: PTY 키 = 탭 id(코어 터미널 제거 후 단일 키).
const term = (viewId: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title: "T",
  pluginId: "soksak-plugin-terminal-xterm",
  view: "content",
});

const tab = (id: string, tabs: Tab[]): Project => ({
  id,
  title: id,
  sidebarOpen: false,
  rightOpen: false,
  rightView: null,
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
  root: "/r",
  spaces: [
    {
      id: "c1",
      title: "1",
      layout: {
        type: "leaf",
        value: { id: "g1", tabs, activeTabId: tabs[0]?.id ?? "" },
      },
      activePaneId: "g1",
    },
  ],
  activeSpaceId: "c1",
});

describe("locateTab", () => {
  it("탭 id 로 그 터미널 탭을 찾는다", () => {
    const tabs = [tab("t1", [term("v1")])];
    expect(locateTab(tabs, "v1")).toEqual({ projectId: "t1", viewId: "v1" });
  });

  it("여러 뷰 중 일치하는 view.id 를 찾는다", () => {
    const tabs = [tab("t1", [term("v1"), term("v2")])];
    expect(locateTab(tabs, "v2")).toEqual({ projectId: "t1", viewId: "v2" });
  });

  it("없는 탭은 null", () => {
    const tabs = [tab("t1", [term("v1")])];
    expect(locateTab(tabs, "nope")).toBeNull();
  });
});
