// 사이드바 투영 코어(plans/sidebar-projection-spec.md §4·R1~R7).
// 패널 포커스는 rail 위치만 정한다. 투영 콘텐츠 결부는 Space가 소유한다:
//   - 스토어: focusHistory(승계 재료)·pins.
//     프로젝트 키로 분리(R7: 스코프 = 창 × 프로젝트).
//   - 해소: resolveProjection 순수 파생 — 결부 뷰의 sidebar 선언 → 레일 슬롯.
// 배선(실제 deps: viewRegistry·contractResolve·plugins)은 소비 지점에서 주입한다 — 이
// 모듈은 레지스트리를 직접 읽지 않는다(테스트 가능·강결합 0).

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import type { ContributedSidebar, SidebarInstance, SidebarSlot } from "../plugins/spec";

export type SlotStatus = "live" | "degraded" | "satisfied-by-pin";

export interface ProjectionSlot {
  // 선언 원형: "self:<owner>.<viewId>" | "contract:<계약 id>" | "undeclared"(선언 부재).
  source: string;
  resolvedRef: string | null; // "<pluginId>.<viewId>" — degraded 면 null 가능
  instance: SidebarInstance;
  // 인스턴스 동일성(A9): shared=(project|ref), per-view=(project|ref|viewId). degraded=null.
  instanceKey: string | null;
  status: SlotStatus;
}

export interface ProjectionSide {
  slots: ProjectionSlot[];
  // 코어 소유 템플릿 어휘(A5). 슬롯 1개 이하 = single, 2개 이상 = 선언 템플릿.
  template: "single" | "stack" | "tabs";
}

// 결부 뷰의 선언 요약 — 소비 지점이 세션 Tab 에서 만들어 넘긴다.
// plugin 뷰: ownerPluginId = 그 플러그인. file 뷰: 담당 fileViewer 의 플러그인(§3.1).
export interface BoundView {
  viewId: string;
  // 결부 문맥(§4.1) — 결부 뷰가 속한 그룹·스페이스. UI 암묵 경로의 영향 범위(A6).
  groupId: string | null;
  contentId: string | null;
  ownerPluginId: string;
  sidebar: ContributedSidebar | null; // null = 선언 부재 → 좌 degraded(R5)
}

export interface ProjectionDeps {
  // 계약 → 활성 구현체 pluginId(0개면 null). contractResolve.resolveContractImplementer 배선.
  resolveContract(req: { id: string; range: string }): string | null;
  // 전역 뷰키가 rail 배치로 등록돼 있는가 — 해소 실패(미등록·비활성·rail 아님)의 판정.
  isRailView(key: string): boolean;
  // 소유 플러그인의 consumes 계약 id 목록 — 계약-핀 게이트(§3.2).
  consumesOf(pluginId: string): string[];
}

export interface Pins {
  left: string[];
  right: string[];
}

export interface Projection {
  binding: {
    viewId: string | null;
    groupId: string | null;
    contentId: string | null;
  };
  left: ProjectionSide;
  right: ProjectionSide | null; // 우 미선언 = null(A1 — 우는 선택)
  pins: Pins;
}

const NULL_BINDING = { viewId: null, groupId: null, contentId: null };

const EMPTY_SIDE: ProjectionSide = { slots: [], template: "single" };

function resolveSlot(
  projectId: string,
  boundViewId: string,
  owner: string,
  slot: SidebarSlot,
  pinned: string[],
  deps: ProjectionDeps,
): ProjectionSlot {
  let source: string;
  let resolvedRef: string | null = null;
  let live = false;

  if (slot.ref !== undefined) {
    const viewId = slot.ref.slice("self.".length);
    resolvedRef = `${owner}.${viewId}`;
    source = `self:${resolvedRef}`;
    live = deps.isRailView(resolvedRef);
  } else {
    const contract = slot.contract as string;
    source = `contract:${contract}`;
    // 계약-핀 게이트(§3.2): 소비 선언 없는 참조는 해소 거부 → 강등.
    if (deps.consumesOf(owner).includes(contract)) {
      const impl = deps.resolveContract({ id: contract, range: slot.range as string });
      if (impl) {
        resolvedRef = `${impl}.${slot.view as string}`;
        live = deps.isRailView(resolvedRef);
      }
    }
  }

  if (!live) {
    return { source, resolvedRef, instance: slot.instance, instanceKey: null, status: "degraded" };
  }
  const instanceKey =
    slot.instance === "shared"
      ? `${projectId}|${resolvedRef}`
      : `${projectId}|${resolvedRef}|${boundViewId}`;
  // 핀 흡수(R4): shared 슬롯의 ref 가 이미 핀에 있으면 핀이 렌더를 흡수한다(단일 렌더).
  const status: SlotStatus =
    slot.instance === "shared" && pinned.includes(resolvedRef as string)
      ? "satisfied-by-pin"
      : "live";
  return { source, resolvedRef, instance: slot.instance, instanceKey, status };
}

function resolveSide(
  projectId: string,
  boundViewId: string,
  owner: string,
  slots: SidebarSlot[],
  template: "stack" | "tabs",
  pinned: string[],
  deps: ProjectionDeps,
): ProjectionSide {
  const resolved = slots.map((s) =>
    resolveSlot(projectId, boundViewId, owner, s, pinned, deps),
  );
  return { slots: resolved, template: resolved.length >= 2 ? template : "single" };
}

// 결부 뷰 → 레일 투영(순수). 결부 null = 빈 좌 슬롯 + 우 null(핀만 남는 상태, R6).
export function resolveProjection(
  projectId: string,
  bound: BoundView | null,
  pins: Pins,
  deps: ProjectionDeps,
): Projection {
  if (!bound) {
    return { binding: NULL_BINDING, left: EMPTY_SIDE, right: null, pins };
  }
  if (!bound.sidebar) {
    // 선언 부재 = degraded 슬롯(R5) — 빈 슬롯 + 안내를 렌더할 자리.
    return {
      binding: { viewId: bound.viewId, groupId: bound.groupId, contentId: bound.contentId },
      left: {
        slots: [
          {
            source: "undeclared",
            resolvedRef: null,
            instance: "shared",
            instanceKey: null,
            status: "degraded",
          },
        ],
        template: "single",
      },
      right: null,
      pins,
    };
  }
  const { sidebar, ownerPluginId, viewId, groupId, contentId } = bound;
  const left = resolveSide(
    projectId, viewId, ownerPluginId, sidebar.left, sidebar.template, pins.left, deps,
  );
  const right =
    sidebar.right.length === 0
      ? null
      : resolveSide(
          projectId, viewId, ownerPluginId, sidebar.right, sidebar.template, pins.right, deps,
        );
  return { binding: { viewId, groupId, contentId }, left, right, pins };
}

// ── 스토어 — 사용자 소유 상태만(focusHistory·pins). 해소 결과는 저장하지 않는다(파생). ──

const HISTORY_CAP = 50;

interface ProjectEntry {
  focusHistory: string[]; // 최근순. 세션 로컬(§4.5 — 복원 대상 아님)
  pins: Pins; // 프로젝트와 함께 영속(§4.5)
}

interface ProjectionStore {
  byProject: Record<string, ProjectEntry>;
  // 결부 관측 기록 — 세션 활성 체인 변경 시 소비 지점이 호출한다(최근순 dedupe).
  noteBinding(projectId: string, viewId: string): void;
  // 뷰 닫힘 — 승계 재료에서 제거(R6).
  forgetView(projectId: string, viewId: string): void;
  // 핀(R4) — 멱등. 핀 가능 검증(rail 뷰 존재·shared/상주형)은 명령 계층 소유.
  pin(projectId: string, side: "left" | "right", ref: string): void;
  unpin(projectId: string, side: "left" | "right", ref: string): void;
  // 복원 씨딩(§4.5·R9) — 스냅샷의 pins 를 부재 시에만 심는다(라이브 클로버 금지).
  seedProject(projectId: string, entry: { pins: Pins }): void;
  // 프로젝트 닫힘 — 상태 회수.
  dropProject(projectId: string): void;
}

const emptyEntry = (): ProjectEntry => ({
  focusHistory: [],
  pins: { left: [], right: [] },
});

function withPin(entry: ProjectEntry, side: "left" | "right", ref: string): ProjectEntry {
  if (entry.pins[side].includes(ref)) return entry;
  return {
    ...entry,
    pins: { ...entry.pins, [side]: [...entry.pins[side], ref] },
  };
}

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useProjection = moduleState("state/projection#store", () =>
  create<ProjectionStore>((set) => ({
  byProject: {},

  noteBinding: (projectId, viewId) =>
    set((s) => {
      const entry = s.byProject[projectId] ?? emptyEntry();
      if (entry.focusHistory[0] === viewId) return s;
      const focusHistory = [
        viewId,
        ...entry.focusHistory.filter((v) => v !== viewId),
      ].slice(0, HISTORY_CAP);
      return {
        byProject: { ...s.byProject, [projectId]: { ...entry, focusHistory } },
      };
    }),

  forgetView: (projectId, viewId) =>
    set((s) => {
      const entry = s.byProject[projectId];
      if (!entry || !entry.focusHistory.includes(viewId)) return s;
      return {
        byProject: {
          ...s.byProject,
          [projectId]: {
            ...entry,
            focusHistory: entry.focusHistory.filter((v) => v !== viewId),
          },
        },
      };
    }),

  pin: (projectId, side, ref) =>
    set((s) => {
      const entry = s.byProject[projectId] ?? emptyEntry();
      const next = withPin(entry, side, ref);
      if (next === entry && s.byProject[projectId]) return s; // 멱등
      return { byProject: { ...s.byProject, [projectId]: next } };
    }),

  unpin: (projectId, side, ref) =>
    set((s) => {
      const entry = s.byProject[projectId];
      if (!entry || !entry.pins[side].includes(ref)) return s; // 멱등
      return {
        byProject: {
          ...s.byProject,
          [projectId]: {
            ...entry,
            pins: { ...entry.pins, [side]: entry.pins[side].filter((r) => r !== ref) },
          },
        },
      };
    }),

  seedProject: (projectId, entry) =>
    set((s) => {
      if (s.byProject[projectId]) return s; // 라이브 상태 우선 — 복원은 첫 씨딩만
      return {
        byProject: {
          ...s.byProject,
          [projectId]: {
            focusHistory: [],
            pins: { left: [...entry.pins.left], right: [...entry.pins.right] },
          },
        },
      };
    }),

  dropProject: (projectId) =>
    set((s) => {
      if (!s.byProject[projectId]) return s;
      const byProject = { ...s.byProject };
      delete byProject[projectId];
      return { byProject };
    }),
})),
);
