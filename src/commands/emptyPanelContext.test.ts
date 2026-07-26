// 빈 pane(탭 0개)이 활성일 때의 컨텍스트 해석 — 실측 재현: 활성 pane 의 탭을 모두 옮기거나 닫아
// 탭이 비면 activeChain 이 tab=undefined 인 Location 을 돌려주고, state.context 가
// INTERNAL(TypeError) 로 죽었다. 계약: 해석 불가는 구조적 오류(TARGET_NOT_FOUND)로 답한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { allGroups, useSessions } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import type { ContributedProgram } from "../plugins/spec";

// tab.open 검증용 최소 프로그램 — 테스트 환경엔 플러그인 로더가 없어 직접 등록한다.
useProgramRegistry
  .getState()
  .register("test-plugin", {
    id: "terminal",
    kind: "view",
    view: "term",
    title: { en: "Terminal", ko: "터미널" },
  } as ContributedProgram);

useSessions.getState().bootstrapFirstProject("/tmp/soksak-emptypanel");
registerCatalog();
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().projects));
const pristineActive = useSessions.getState().activeId;

beforeEach(() => {
  useSessions.setState({
    projects: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

/** 활성 스페이스의 활성 pane 을 탭 0개로 만든다(실측 상태의 재현). */
function emptyActivePane(): void {
  const projects = structuredClone(useSessions.getState().projects);
  const project = projects.find((t) => t.id === useSessions.getState().activeId)!;
  const space =
    project.spaces.find((c) => c.id === project.activeSpaceId) ?? project.spaces[0];
  const panes = allGroups(space.layout);
  const g = panes.find((x) => x.id === space.activePaneId) ?? panes[0];
  g.tabs = [];
  g.activeTabId = "";
  useSessions.setState({ projects });
}

/** 정상 사슬 재현 — 활성 pane 에 탭 하나를 연다(부트스트랩은 테스트 환경에서 탭을 만들지 않는다). */
function openOneTab(): void {
  const s = useSessions.getState();
  const r = s.openPluginView(s.activeId, "p", "test-view", "T");
  if (!r.ok) throw new Error("openPluginView 실패");
}

describe("빈 pane 컨텍스트", () => {
  it("state.context 는 죽지 않고 pane 까지의 위치를 답한다(tabId 없음)", async () => {
    emptyActivePane();
    const r = await execute("state.context", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ projectId: expect.any(String), paneId: expect.any(String) });
    expect((r.data as Record<string, unknown>).tabId).toBeUndefined();
  });

  it("빈 pane 에도 tab.open 으로 탭을 추가할 수 있다", async () => {
    emptyActivePane();
    // 이 테스트가 보는 것은 상태 변화다 — 렌더러가 없는 환경이라 마운트는 오지 않는다.
    // 기본값(마운트를 기다려 쓸 수 있는 뷰를 답한다)은 그대로 두고 여기서만 상한을 0 으로 둔다.
    const r = await execute("tab.open", { program: "terminal", mountTimeoutMs: 0 }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ paneId: expect.any(String), tabId: expect.any(String) });
  });

  it("빈 pane 에서 tab.maximize 는 구조적 오류로 답한다(탭 없음)", async () => {
    emptyActivePane();
    const r = await execute("tab.maximize", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });

  it("정상 상태에서는 위치 사슬을 돌려준다", async () => {
    openOneTab();
    const r = await execute("state.context", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      projectId: expect.any(String),
      spaceId: expect.any(String),
      paneId: expect.any(String),
      tabId: expect.any(String),
    });
  });
});

describe("pane.split 기본 program 없음", () => {
  it("program 미지정 시 빈 pane 을 만든다 — 코어는 터미널을 기본으로 심지 않는다", async () => {
    const r = await execute("pane.split", { side: "right" }, {});
    expect(r.ok).toBe(true);
    // 새 pane 은 생기되(paneId) 탭은 없다(tabId 부재 = 블랭크). 코어 program-무지.
    expect(r.data).toMatchObject({ paneId: expect.any(String) });
    expect((r.data as Record<string, unknown>).tabId).toBeUndefined();
  });

  it("program 을 명시하면 그 탭으로 채운다(블랭크 아님)", async () => {
    const r = await execute("pane.split", { side: "right", program: "terminal" }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      paneId: expect.any(String),
      tabId: expect.any(String),
    });
  });
});
