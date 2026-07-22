// projection 실배선(plans/sidebar-projection-spec.md §4) — 순수 코어(projection.ts)에
// 실제 레지스트리를 주입한다. 레지스트리·스토어를 직접 읽는 것은 이 모듈뿐이다.
//   - boundViewOf: 세션 활성 체인 → 최초 결부 후보. 결부 정본은 스페이스별 store lock.
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
import { useContractSelection } from "./contractSelection";
import { emitPluginEvent } from "../plugins/hooks";

// 활성 체인의 말단(활성 콘텐츠 뷰) → 선언 요약. plugin 뷰 = 등록 decl 의 sidebar,
// file 뷰 = 담당 fileViewer 의 sidebar(§3.1). 뷰 없음 = null(빈 프로젝트).
function boundViewInContent(
  project: ProjectTab,
  contentId: string,
  viewId?: string,
): BoundView | null {
  const content =
    project.contents.find((c) => c.id === contentId) ?? null;
  if (!content) return null;
  const groups = leavesOf(content.layout);
  const activeGroup =
    groups.find((g) => g.id === content.activeGroupId) ?? groups[0];
  const group = viewId
    ? groups.find((g) => g.views.some((v) => v.id === viewId))
    : activeGroup;
  const view = viewId
    ? group?.views.find((v) => v.id === viewId)
    : group?.views.find((v) => v.id === group.activeViewId);
  if (!view) return null;
  const ctx = { groupId: group?.id ?? null, contentId: content.id };
  if (view.kind === "plugin") {
    const reg = getRegisteredView(`${view.pluginId}.${view.view}`);
    return {
      viewId: view.id,
      ...ctx,
      ownerPluginId: view.pluginId,
      sidebar: reg?.decl.sidebar ?? null,
    };
  }
  const viewer = resolveFileViewer(view.path);
  if (!viewer) return { viewId: view.id, ...ctx, ownerPluginId: "", sidebar: null };
  return {
    viewId: view.id,
    ...ctx,
    ownerPluginId: viewer.pluginId,
    sidebar: viewer.decl.sidebar ?? null,
  };
}

export function boundViewOf(project: ProjectTab): BoundView | null {
  const content =
    project.contents.find((c) => c.id === project.activeContentId) ??
    project.contents[0];
  return content ? boundViewInContent(project, content.id) : null;
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
  const content =
    tab.contents.find((c) => c.id === tab.activeContentId) ?? tab.contents[0];
  const lockedId = content?.railBindingViewId;
  const bound = content
    ? boundViewInContent(tab, content.id, lockedId) ?? boundViewInContent(tab, content.id)
    : null;
  return resolveProjection(projectId, bound, pins, realProjectionDeps());
}

// 세션 구독 — 결부 관측(R1: 그룹 내 탭 전환 포함) + 이력 정리 + 프로젝트 회수 + 이벤트.
// 창당 1회(main 부트). 반환 = 해지.
export function startProjectionTracking(): () => void {
  // 프로젝트별 지문 — 결부·슬롯 해소·핀의 요약. 지문이 바뀔 때만 발화한다(§4.3:
  // 결부·슬롯·핀 변경 — 그룹 내 탭 전환, 강등↔승격, 핀 추가/해제 전부 포함).
  const last = new Map<string, string>();

  const sync = (tabs: ProjectTab[], opts?: { silent?: boolean }) => {
    const proj = useProjection.getState();
    const alive = new Set(tabs.map((t) => t.id));
    for (const pid of Object.keys(proj.byProject)) {
      if (!alive.has(pid)) proj.dropProject(pid);
    }
    for (const pid of [...last.keys()]) {
      if (!alive.has(pid)) last.delete(pid);
    }
    // 발화는 sweep 루프 밖에서 일괄 — sweep 중 동기 emit 이 구독자를 통해 sync 를 재진입해
    // 이력·핀 갱신과 얽히는 것을 차단한다.
    const changed: { projectId: string; viewId: string | null }[] = [];
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
      const candidate = boundViewOf(t);
      const vid = candidate?.viewId ?? null;
      if (candidate?.contentId && vid) {
        // 재결부 규칙(③·fd2f66f5 조화): 활성 뷰의 해소 결과가 현재 결부의 해소와 다를
        // 때만 스페이스 결부를 교체한다 — 같은 기능·같은 해소(터미널↔터미널)는 유지되어
        // FLOW 위치만 움직이고, 다른 기능(칸반→런북)이나 per-view 문서 전환은 교체된다.
        const pinsNow =
          useProjection.getState().byProject[t.id]?.pins ?? { left: [], right: [] };
        const sideFp = (side: { slots: { source: string; resolvedRef: string | null; instanceKey: string | null }[] } | null) =>
          side?.slots.map((x) => [x.source, x.resolvedRef, x.instanceKey]) ?? null;
        const candProj = resolveProjection(
          t.id, candidate, pinsNow, realProjectionDeps(),
        );
        const curProj = projectionFor(t.id);
        const differs =
          JSON.stringify([sideFp(candProj.left), sideFp(candProj.right)]) !==
          JSON.stringify([sideFp(curProj?.left ?? null), sideFp(curProj?.right ?? null)]);
        const locked = t.contents.find((c) => c.id === candidate.contentId)
          ?.railBindingViewId;
        if (differs || !locked) {
          useSessions.getState().bindContentRail(t.id, candidate.contentId, vid);
        }
        useProjection.getState().noteBinding(t.id, vid);
      }
      const resolved = projectionFor(t.id);
      const fingerprint = JSON.stringify({
        b: resolved?.binding ?? null,
        l: resolved?.left.slots.map((x) => [x.source, x.resolvedRef, x.status]),
        r: resolved?.right?.slots.map((x) => [x.source, x.resolvedRef, x.status]) ?? null,
        p: resolved?.pins ?? null,
      });
      if (last.get(t.id) !== fingerprint) {
        last.set(t.id, fingerprint);
        changed.push({ projectId: t.id, viewId: vid });
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
    if (!opts?.silent) {
      for (const c of changed) emitPluginEvent("projection.changed", c);
    }
  };

  // 부트 관측은 지문만 심고 발화하지 않는다 — 복원이 이벤트로 리플레이되지 않게(R9).
  sync(useSessions.getState().tabs, { silent: true });
  const offSessions = useSessions.subscribe((s) => sync(s.tabs));
  // 레지스트리·계약 선택 변화도 슬롯 해소에 영향(강등↔승격·구현체 교체) — 같은 sweep.
  const offRegistry = useViewRegistry.subscribe(() =>
    sync(useSessions.getState().tabs),
  );
  const offSelection = useContractSelection.subscribe(() =>
    sync(useSessions.getState().tabs),
  );
  const offProjection = useProjection.subscribe(() =>
    sync(useSessions.getState().tabs),
  );
  return () => {
    offSessions();
    offRegistry();
    offSelection();
    offProjection();
  };
}
