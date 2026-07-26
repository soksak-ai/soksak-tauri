// 워크스페이스 직렬화 — 레이아웃을 plain JSON 스냅샷으로(영속·복원, A2). 두 트리(PaneNode·
// SidebarLayout)는 splitTree.ts 의 serializeSplitTree 동일 경로로 직렬화된다(중복 없음).
//
// [RULE] 와이어 키는 구형을 유지한다(contents·views·activeViewId·activeGroupId·activeContentId·
// maximizedViewId·railBindingViewId) — 마이그레이션(P0-5)이 옮긴다. 메모리 필드는 이미 새 어휘
// (spaces·tabs·activeTabId·activePaneId·activeSpaceId·maximizedTabId·railBindingTabId)이므로 이
// 파일의 serialize/deserialize 안에서만 둘을 잇는다. 기존 사용자 스냅샷은 그대로 열린다.
//
// [RULE] leaf payload id(group/pane)·view id·content id 는 보존한다 → active 참조
// (activeContentId/activeGroupId/activeViewId/focusedPaneId/maximizedViewId)가 무손상으로 동작.
// split id 만 복원 시 재생성(트리 구조에만 쓰이고 참조 대상이 아니므로 serializeSplitTree 가 생략).
// live status·live 세션(PTY/webview)은 직렬화하지 않는다 — 복원 후 뷰가 재보고/재마운트.

import {
  serializeSplitTree,
  deserializeSplitTree,
  type SplitSnapshot,
} from "./splitTree";
import type { SidebarGroup } from "./sidebarLayout";
import type { Project, Space, Pane, Tab } from "./sessions";
import type { Pins } from "./projection";
import { DEFAULT_RAIL_PLACEMENT,
  normalizeRailPlacement,
  type RailPlacement,
} from "../lib/railPlacement";
import { normalizeVerticalLines } from "./verticalLines";

// ── 스냅샷 타입 ───────────────────────────────────────────────────────────────

type ViewSnapshot =
  | {
      id: string;
      kind: "file";
      title: string;
      customLabel?: string;
      path: string;
      mode: "code" | "preview";
    }
  | {
      id: string;
      kind: "plugin";
      title: string;
      // 사용자 지정 탭 라벨(view.rename) — 사용자 의도라 영속한다. 옵션(구 스냅샷 호환).
      customLabel?: string;
      pluginId: string;
      view: string;
      // 탭 아이콘(콘텐츠 사실 — 파비콘 URL). 옵션(구 스냅샷 호환).
      icon?: string;
      // B3 — 관찰된 cwd(복원 spawn 위치)·마지막 활동 시각(hydration 우선순위). 옵션(구 스냅샷 호환).
      cwd?: string;
      lastActivity?: number;
      legacyPaneId?: string;
      // B3 — 플러그인 관찰 상태(setRestoreState — 예: 브라우저 URL). 복원 마운트의 restore.state.
      state?: unknown;
    };

interface ViewGroupSnapshot {
  id: string;
  activeViewId: string;
  views: ViewSnapshot[];
}

interface ContentSnapshot {
  id: string;
  title: string;
  activeGroupId: string;
  railBindingViewId?: string;
  maximizedViewId?: string;
  layout: SplitSnapshot<ViewGroupSnapshot>;
}

export interface ProjectSnapshot {
  id: string;
  title: string;
  root: string;
  shell?: string;
  color?: string;
  // 세로 라인 정규화 마이그레이션 마커 — 직렬화는 항상 기록한다. 마커 없는 구 스냅샷만
  // 복원 시 1회 normalizeVerticalLines 로 치유하고, 마커 있는 복원은 무변환(동형)이다 —
  // 사용자가 드래그 규칙(LINE_GROUP_EPS) 밖에 둔 별개 라인을 복원이 되쓰지 않는다.
  vlNormalized?: true;
  // 배치 1회 마이그레이션 마커 — 레일 이주가 폐지돼 있던 동안 직렬화가 placement 미설정
  // 프로젝트에도 정박(pin@0)을 적어 넣었다. 마커 없는 스냅샷의 placement 는 그 시대의
  // 기본값일 수 있으므로 한 번 버린다(제거 조건: 마커 없는 스냅샷이 현장에서 사라졌을 때).
  railPlacementNormalized?: true;
  sidebarOpen: boolean;
  // 레일 프레임 위치 PIN. projection.pins(ref 고정)과 직교. 옵션은 구 스냅샷 호환.
  leftRailPlacement?: RailPlacement;
  rightOpen: boolean;
  rightView: string | null;
  leftLayout: SplitSnapshot<SidebarGroup>;
  activeContentId: string;
  contents: ContentSnapshot[];
  // 레일 핀(§4.5) — 프로젝트와 함께 영속.
  projection?: { pins: Pins };
}

// ── serialize ─────────────────────────────────────────────────────────────────

function serializeView(v: Tab): ViewSnapshot {
  switch (v.kind) {
    case "file":
      return {
        id: v.id,
        kind: "file",
        title: v.title,
        ...(v.customLabel ? { customLabel: v.customLabel } : {}),
        path: v.path,
        mode: v.mode,
      };
    case "plugin":
      // command(자동 실행)는 영속하지 않는다 — 복원된 터미널은 명령을 재실행하지 않는다(A6:
      // live PTY 복원 불가, 재실행은 부작용). 새로 열 때만 autorun 한다.
      return {
        id: v.id,
        kind: "plugin",
        title: v.title,
        ...(v.customLabel ? { customLabel: v.customLabel } : {}),
        ...(v.icon ? { icon: v.icon } : {}),
        pluginId: v.pluginId,
        view: v.view,
        // B3 — 마지막 cwd·활동 시각·플러그인 상태는 복원의 실질.
        ...(v.cwd ? { cwd: v.cwd } : {}),
        ...(v.lastActivity ? { lastActivity: v.lastActivity } : {}),
        ...(v.legacyPaneId ? { legacyPaneId: v.legacyPaneId } : {}),
        ...(v.state !== undefined ? { state: v.state } : {}),
      };
  }
}

const serializeViewGroup = (g: Pane): ViewGroupSnapshot => ({
  id: g.id,
  activeViewId: g.activeTabId,
  views: g.tabs.map(serializeView),
});

const serializeContent = (c: Space): ContentSnapshot => ({
  id: c.id,
  title: c.title,
  activeGroupId: c.activePaneId,
  ...(c.railBindingTabId ? { railBindingViewId: c.railBindingTabId } : {}),
  ...(c.maximizedTabId ? { maximizedViewId: c.maximizedTabId } : {}),
  layout: serializeSplitTree(c.layout, serializeViewGroup), // PaneNode(leaf=Pane)
});

export function serializeProject(
  p: Project,
  projection?: { pins: Pins },
): ProjectSnapshot {
  return {
    ...(projection ? { projection } : {}),
    id: p.id,
    title: p.title,
    root: p.root,
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.color ? { color: p.color } : {}),
    vlNormalized: true,
    railPlacementNormalized: true,
    sidebarOpen: p.sidebarOpen,
    leftRailPlacement: p.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT,
    rightOpen: p.rightOpen,
    rightView: p.rightView,
    // 사이드바 레이아웃(SplitTree<SidebarGroup>) — leaf 페이로드는 plain JSON.
    leftLayout: serializeSplitTree(p.leftLayout, (g) => g),
    activeContentId: p.activeSpaceId,
    contents: p.spaces.map(serializeContent),
  };
}

// ── deserialize (split id 만 재생성; 나머지 id·active 참조 보존) ────────────────

// 저장 세션 마이그레이션 — 플러그인 rename 전 스냅샷의 옛 pluginId 를 새 id 로 치환한다. 훅이
// 없으면 rename 후 옛 스냅샷 복원이 조용히 미해결 뷰로 열화한다(그리는 provider "<옛 id>.content"
// 가 사라짐). view id(관례 content)는 rename 대상이 아니라 그대로 둔다.
// [제거 조건] 옛 id 를 담은 스냅샷이 현장에서 소멸(재저장으로 새 id 로 갱신)하면 해당 항목 제거.
const LEGACY_PLUGIN_IDS: Record<string, string> = {
  // 터미널 seam 정규화(NAMING §4) — 엔진명 없는 옛 id → 엔진명(xterm) 단 새 id.
  "soksak-plugin-terminal": "soksak-plugin-terminal-xterm",
};

function migratePluginId(id: string): string {
  return LEGACY_PLUGIN_IDS[id] ?? id;
}

function deserializeView(s: ViewSnapshot, _newSplitId: () => string): Tab {
  switch (s.kind) {
    case "file":
      return {
        id: s.id,
        kind: "file",
        title: s.title,
        ...(s.customLabel ? { customLabel: s.customLabel } : {}),
        path: s.path,
        mode: s.mode,
      };
    case "plugin":
      // command 미복원 — 복원된 터미널은 명령을 재실행하지 않는다(A6).
      return {
        id: s.id,
        kind: "plugin",
        title: s.title,
        ...(s.customLabel ? { customLabel: s.customLabel } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
        pluginId: migratePluginId(s.pluginId),
        view: s.view,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
        ...(s.legacyPaneId ? { legacyPaneId: s.legacyPaneId } : {}),
        ...(s.state !== undefined ? { state: s.state } : {}),
      };
  }
}

const deserializeViewGroup = (
  s: ViewGroupSnapshot,
  newSplitId: () => string,
): Pane => ({
  id: s.id,
  activeTabId: s.activeViewId,
  tabs: s.views.map((v) => deserializeView(v, newSplitId)),
});

const deserializeContent = (
  s: ContentSnapshot,
  newSplitId: () => string,
  normalize: boolean,
): Space => {
  const layout = deserializeSplitTree(
    s.layout,
    (g) => deserializeViewGroup(g, newSplitId),
    newSplitId,
  );
  return {
    id: s.id,
    title: s.title,
    activePaneId: s.activeGroupId,
    ...(s.railBindingViewId ? { railBindingTabId: s.railBindingViewId } : {}),
    ...(s.maximizedViewId ? { maximizedTabId: s.maximizedViewId } : {}),
    // 스냅샷당 1회 마이그레이션(세로 불분할 명제) — vlNormalized 마커 없는 구 스냅샷만
    // 동반 드래그 이전에 토막 난 세로 라인(예: 상단 40.6/하단 39.5)을 최상단 세그먼트의
    // x 로 스냅해 치유한다. 마커 있는 복원은 무변환 — 사용자 레이아웃을 되쓰지 않는다.
    // [제거 조건] 마커 없는 스냅샷이 현장에서 소멸(재저장으로 마커 기록)하면 게이트 제거.
    layout: normalize ? normalizeVerticalLines(layout) : layout,
  };
};

// newSplitId 는 호출부(sessions)가 주입 — split id 생성기. 보존 id 와의 충돌 방지는 호출부가
// 복원 후 카운터를 보존 최대치 위로 올려 처리(A5).
export function deserializeProject(
  s: ProjectSnapshot,
  newSplitId: () => string,
): Project {
  return {
    id: s.id,
    title: s.title,
    root: s.root,
    ...(s.shell ? { shell: s.shell } : {}),
    ...(s.color ? { color: s.color } : {}),
    sidebarOpen: s.sidebarOpen,
    // 마커 없는 구 스냅샷은 저장값을 신뢰하지 않는다 — 폐지 시대의 기본값(pin@0)과 사용자가
    // 고른 정박을 구분할 방법이 없으므로 1회 기본(flow)으로 되돌린다. 마커가 있으면 그대로 존중.
    leftRailPlacement: s.railPlacementNormalized
      ? normalizeRailPlacement(s.leftRailPlacement)
      : DEFAULT_RAIL_PLACEMENT,
    rightOpen: s.rightOpen,
    rightView: s.rightView,
    leftLayout: deserializeSplitTree(s.leftLayout, (g) => g, newSplitId),
    activeSpaceId: s.activeContentId,
    spaces: s.contents.map((c) =>
      deserializeContent(c, newSplitId, !s.vlNormalized),
    ),
  };
}
