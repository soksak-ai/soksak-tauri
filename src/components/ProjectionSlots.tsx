// 레일 투영 슬롯(plans/sidebar-projection-spec.md R1·R5) — 결부 뷰의 사이드바 선언을
// 레일에 렌더한다. live 슬롯 = PluginViewHost(인스턴스 동일성 = instanceKey — shared 는
// 결부가 오가도 같은 인스턴스 유지, per-view 는 결부 뷰별 분리), degraded = 빈 슬롯 + 안내,
// satisfied-by-pin = 렌더 없음(핀 스택이 그 인스턴스를 이미 렌더 — R4 흡수).
// keep-alive: 한 번 산 인스턴스는 display 토글로 유지(R1 — 구조 상태 보존).

import { memo, useMemo, useRef } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { projectionFor } from "../state/projectionWiring";
import { useProjection } from "../state/projection";
import { useSessions } from "../state/sessions";
import { useViewRegistry, getRegisteredView } from "../plugins/viewRegistry";
import { usePlugins } from "../state/plugins";
import { useT } from "../i18n";

export const ProjectionSlots = memo(function ProjectionSlots({
  projectId,
  root,
  paneId,
  side,
}: {
  projectId: string;
  root: string | null;
  paneId: string;
  side: "left" | "right";
}) {
  const t = useT();
  // 해소 입력 전부를 구독 — 활성 체인(sessions)·등록(viewRegistry)·핀(projection)·활성 플러그인.
  const tab = useSessions((s) => s.tabs.find((x) => x.id === projectId));
  const regVersion = useViewRegistry((s) => s.version);
  const entry = useProjection((s) => s.byProject[projectId]);
  const plugins = usePlugins((s) => s.plugins);
  const proj = useMemo(
    () => projectionFor(projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, tab, regVersion, entry, plugins],
  );

  // keep-alive 누적: instanceKey → resolvedRef. 등록 해제된 ref 는 정리(유령 마운트 방지).
  const mountedRef = useRef(new Map<string, string>());
  const sideProj = side === "left" ? proj?.left : (proj?.right ?? null);
  const slots = sideProj?.slots ?? [];
  for (const s of slots) {
    if (s.status === "live" && s.instanceKey && s.resolvedRef) {
      mountedRef.current.set(s.instanceKey, s.resolvedRef);
    }
  }
  for (const [key, ref] of [...mountedRef.current]) {
    if (!getRegisteredView(ref)) mountedRef.current.delete(key);
  }

  const liveKeys = new Set(
    slots
      .filter((s) => s.status === "live" && s.instanceKey)
      .map((s) => s.instanceKey as string),
  );
  const degraded = slots.filter((s) => s.status === "degraded");

  // 렌더할 것이 전혀 없으면 영역 자체를 접는다(핀 스택이 전체를 쓴다).
  if (liveKeys.size === 0 && degraded.length === 0 && mountedRef.current.size === 0) {
    return null;
  }

  return (
    <div className="proj-slots" data-node={`projection/${side}`}>
      {[...mountedRef.current].map(([instanceKey, refKey]) => (
        <div
          key={instanceKey}
          className="proj-slot"
          style={{ display: liveKeys.has(instanceKey) ? "flex" : "none" }}
        >
          <PluginViewHost
            viewKey={refKey}
            projectId={projectId}
            root={root}
            region={side}
            paneId={paneId}
          />
        </div>
      ))}
      {degraded.map((s, i) => (
        <div key={`deg-${i}`} className="proj-slot proj-slot-degraded" data-node={`projection/${side}/degraded`}>
          {s.source === "undeclared"
            ? t("projection.degraded.undeclared")
            : t("projection.degraded.unresolved")}
        </div>
      ))}
    </div>
  );
});
