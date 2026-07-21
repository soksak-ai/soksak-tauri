// projection 실배선(plans/sidebar-projection-spec.md §4) — 순수 코어(projection.ts)에
// 실제 레지스트리를 주입한다. 레지스트리·스토어를 직접 읽는 것은 이 모듈뿐이다.
//   - boundViewOf: 세션 활성 체인 → BoundView(A8 — 결부 정본은 활성 체인).
//   - realProjectionDeps: 계약 해소(contractResolve)·rail 등록 검증(viewRegistry)·
//     consumes 게이트(plugins manifest).
//   - projectionFor: 읽기 시점 파생 — 저장하지 않는다(이중진실 0).
//   - startProjectionTracking: 세션 구독 → focusHistory 기록·정리 + projection.changed 발화.

import { leavesOf } from "./splitTree";
import { sidebarViewKeys } from "./sidebarLayout";
import { useSessions, type ProjectTab } from "./sessions";
import {
  resolveProjection,
  useProjection,
  type BoundView,
  type Projection,
  type ProjectionDeps,
} from "./projection";
import { usePlugins } from "./plugins";
import {
  getRegisteredView,
  useViewRegistry,
  viewsForPlacement,
} from "../plugins/viewRegistry";
import { resolveFileViewer } from "../plugins/fileViewerRegistry";
import { resolveContractImplementer } from "../plugins/contractResolve";
import { emitPluginEvent } from "../plugins/hooks";

// 활성 체인의 말단(활성 콘텐츠 뷰) → 선언 요약. plugin 뷰 = 등록 decl 의 sidebar,
// file 뷰 = 담당 fileViewer 의 sidebar(§3.1). 뷰 없음 = null(빈 프로젝트).
export function boundViewOf(project: ProjectTab): BoundView | null {
  const content =
    project.contents.find((c) => c.id === project.activeContentId) ??
    project.contents[0];
  if (!content) return null;
  const groups = leavesOf(content.layout);
  const group = groups.find((g) => g.id === content.activeGroupId) ?? groups[0];
  const view = group?.views.find((v) => v.id === group.activeViewId);
  if (!view) return null;
  if (view.kind === "plugin") {
    const reg = getRegisteredView(`${view.pluginId}.${view.view}`);
    return {
      viewId: view.id,
      ownerPluginId: view.pluginId,
      sidebar: reg?.decl.sidebar ?? null,
    };
  }
  const viewer = resolveFileViewer(view.path);
  if (!viewer) return { viewId: view.id, ownerPluginId: "", sidebar: null };
  return {
    viewId: view.id,
    ownerPluginId: viewer.pluginId,
    sidebar: viewer.decl.sidebar ?? null,
  };
}

export function realProjectionDeps(): ProjectionDeps {
  return {
    resolveContract: (req) => resolveContractImplementer(req),
    isRailView: (key) => {
      const reg = getRegisteredView(key);
      return !!reg && reg.decl.placements.includes("rail");
    },
    consumesOf: (pluginId) => {
      const p = usePlugins.getState().plugins[pluginId];
      return (p?.manifest.consumes ?? []).map((c) => c.id);
    },
  };
}

// 프로젝트의 현재 투영 — 읽기 시점 파생. 미존재 프로젝트 = null.
export function projectionFor(projectId: string): Projection | null {
  const tab = useSessions.getState().tabs.find((t) => t.id === projectId);
  if (!tab) return null;
  const pins =
    useProjection.getState().byProject[projectId]?.pins ?? { left: [], right: [] };
  return resolveProjection(projectId, boundViewOf(tab), pins, realProjectionDeps());
}

// 세션 구독 — 결부 관측(R1: 그룹 내 탭 전환 포함) + 이력 정리 + 프로젝트 회수 + 이벤트.
// 창당 1회(main 부트). 반환 = 해지.
export function startProjectionTracking(): () => void {
  const last = new Map<string, string | null>();

  const sync = (tabs: ProjectTab[]) => {
    const proj = useProjection.getState();
    const alive = new Set(tabs.map((t) => t.id));
    for (const pid of Object.keys(proj.byProject)) {
      if (!alive.has(pid)) proj.dropProject(pid);
    }
    for (const pid of [...last.keys()]) {
      if (!alive.has(pid)) last.delete(pid);
    }
    for (const t of tabs) {
      // §7.1 핀 마이그레이션: 첫 관측 시 기존 배치(leftLayout)의 뷰들을 핀으로 채용하고,
      // 레거시 sidebar-left placement 뷰는 등장 시 자동 핀(오늘의 UX 유지). rail 뷰는
      // 투영 모델이므로 자동 핀하지 않는다. seen 이 unpin 의사를 지킨다.
      if ((proj.byProject[t.id]?.seen.left ?? []).length === 0) {
        const adopted = sidebarViewKeys(t.leftLayout);
        if (adopted.length > 0) {
          useProjection.getState().adoptPins(t.id, "left", adopted);
        }
      }
      for (const { key } of viewsForPlacement("sidebar-left")) {
        useProjection.getState().autoPin(t.id, "left", key);
      }
      const vid = boundViewOf(t)?.viewId ?? null;
      if (last.get(t.id) !== vid) {
        last.set(t.id, vid);
        if (vid) useProjection.getState().noteBinding(t.id, vid);
        emitPluginEvent("projection.changed", { projectId: t.id, viewId: vid });
      }
      // 죽은 뷰를 승계 재료에서 제거(R6).
      const entry = useProjection.getState().byProject[t.id];
      if (entry && entry.focusHistory.length > 0) {
        const ids = new Set<string>();
        for (const c of t.contents) {
          for (const g of leavesOf(c.layout)) {
            for (const v of g.views) ids.add(v.id);
          }
        }
        for (const v of entry.focusHistory) {
          if (!ids.has(v)) useProjection.getState().forgetView(t.id, v);
        }
      }
    }
  };

  sync(useSessions.getState().tabs);
  const offSessions = useSessions.subscribe((s) => sync(s.tabs));
  // 레지스트리 변화(플러그인 활성/비활성)도 결부 해소·레거시 자동 핀에 영향 — 같은 sweep.
  const offRegistry = useViewRegistry.subscribe(() =>
    sync(useSessions.getState().tabs),
  );
  return () => {
    offSessions();
    offRegistry();
  };
}
