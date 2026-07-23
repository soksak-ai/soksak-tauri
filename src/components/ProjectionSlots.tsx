// 레일 투영 슬롯(plans/sidebar-projection-spec.md R1·R5) — 결부 뷰의 사이드바 선언을
// 레일에 렌더한다. live 슬롯 = PluginViewHost(인스턴스 동일성 = instanceKey — shared 는
// 결부가 오가도 같은 인스턴스 유지, per-view 는 결부 뷰별 분리), degraded = 빈 슬롯 + 안내,
// satisfied-by-pin = 렌더 없음(핀 스택이 그 인스턴스를 이미 렌더 — R4 흡수).
// keep-alive: 한 번 산 인스턴스는 display 토글로 유지(R1 — 구조 상태 보존).

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { projectionFor } from "../state/projectionWiring";
import { useProjection } from "../state/projection";
import { findViewById, useSessions, viewDisplayTitle } from "../state/sessions";
import { useSettings } from "../state/settings";
import { useViewRegistry, getRegisteredView } from "../plugins/viewRegistry";
import { usePlugins } from "../state/plugins";
import { useContractSelection } from "../state/contractSelection";
import { localize, useT } from "../i18n";

export const ProjectionSlots = memo(function ProjectionSlots({
  projectId,
  root,
  paneId,
  side,
  commitProjection = true,
}: {
  projectId: string;
  root: string | null;
  paneId: string | null;
  side: "left" | "right";
  /** 레일 스테이션과 함께 전환하는 부모 표시 커밋. false면 현재 identity를 유지한다. */
  commitProjection?: boolean;
}) {
  const t = useT();
  // 해소 입력 전부를 구독 — 활성 체인(sessions)·등록(viewRegistry)·핀(projection)·활성 플러그인.
  const tab = useSessions((s) => s.tabs.find((x) => x.id === projectId));
  const regVersion = useViewRegistry((s) => s.version);
  const entry = useProjection((s) => s.byProject[projectId]);
  const plugins = usePlugins((s) => s.plugins);
  // 계약 구현체 선택 변화도 슬롯 해소를 바꾼다(A6 — 사용자가 구현체 교체).
  const selection = useContractSelection((s) => s.selected);
  const proj = useMemo(
    () => projectionFor(projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, tab, regVersion, entry, plugins, selection],
  );

  // keep-alive 누적: instanceKey → resolvedRef.
  const mountedRef = useRef(new Map<string, string>());
  const sideProj = side === "left" ? proj?.left : (proj?.right ?? null);
  const slots = sideProj?.slots ?? [];
  const absorbed = new Set(
    slots
      .filter((s) => s.status === "satisfied-by-pin" && s.instanceKey)
      .map((s) => s.instanceKey as string),
  );
  for (const s of slots) {
    if (s.status === "live" && s.instanceKey && s.resolvedRef) {
      mountedRef.current.set(s.instanceKey, s.resolvedRef);
    }
  }
  // 정리 3종: 등록 해제 ref(유령), 핀 흡수 instanceKey(단일 렌더 — 핀 스택이 소유, A9),
  // 죽은 결부 뷰의 per-view 인스턴스(key 3번째 조각 = viewId).
  const liveViewIds = new Set<string>();
  if (tab) {
    for (const c of tab.contents) {
      const walk = (n: { type: string; value?: { views: { id: string }[] }; children?: unknown[] }) => {
        if (n.type === "leaf" && n.value) for (const v of n.value.views) liveViewIds.add(v.id);
        else if (n.children) for (const ch of n.children) walk(ch as never);
      };
      walk(c.layout as never);
    }
  }
  for (const [key, ref] of [...mountedRef.current]) {
    const perViewId = key.split("|")[2];
    if (
      !getRegisteredView(ref) ||
      absorbed.has(key) ||
      (perViewId !== undefined && !liveViewIds.has(perViewId))
    ) {
      mountedRef.current.delete(key);
    }
  }

  const liveKeys = new Set(
    slots
      .filter((s) => s.status === "live" && s.instanceKey)
      .map((s) => s.instanceKey as string),
  );
  // 이행기 규율: "미선언"(undeclared) 은 배너 없이 조용히 접는다 — 배너는 선언했는데
  // 해소가 실패한 경우(조치 가능한 정보)에만. 미선언 배너는 A1 파서 강제(§7 4단계)와
  // 함께 활성화한다 — 그 전의 배너는 관용이 아니라 소음이다.
  const degraded = slots.filter(
    (s) => s.status === "degraded" && s.source !== "undeclared",
  );

  const railLook = useSettings((s) => s.railLook);
  const setRailLook = useSettings((s) => s.setRailLook);

  // 영역 인계(§12-④) — 이 컴포넌트는 독립 타이머를 소유하지 않는다.
  // 출발 표상은 commitProjection=false로 이전 identity를 유지하고, 새로 놓인 도착
  // 표상은 현재 identity를 즉시 사용한다. pane의 FLIP이 둘을 가리고 드러낸다.
  const fingerprint = [...liveKeys].sort().join(",");
  const [shownFingerprint, setShownFingerprint] = useState(fingerprint);
  const shownKeys = new Set(
    shownFingerprint ? shownFingerprint.split(",") : [],
  );
  useLayoutEffect(() => {
    if (!commitProjection || shownFingerprint === fingerprint) return;
    setShownFingerprint(fingerprint);
  }, [commitProjection, fingerprint, shownFingerprint]);

  // 보이는 것이 없으면 영역을 접는다 — keep-alive 마운트는 유지하되 레이아웃을 차지하지
  // 않게(display:none). 완전 무마운트면 렌더 자체 생략.
  const visible = shownKeys.size > 0 || degraded.length > 0;
  if (!visible && mountedRef.current.size === 0) {
    return null;
  }

  // §12-④ 이동은 여기서 만들지 않는다 — 재결부의 콘텐츠 스왑에 등장/퇴장 효과는 금지.
  // 실이동은 레일 프레임(.sidebar)의 좌표 주행(transition)이 유일한 표현이다.
  let first = true;

  return (
    <div
      className="proj-slots"
      style={visible ? undefined : { display: "none" }}
      data-node={`projection/${side}`}
    >
      {[...mountedRef.current].map(([instanceKey, refKey]) => {
        const live = shownKeys.has(instanceKey);
        const decl = getRegisteredView(refKey)?.decl;
        const showToggle = live && side === "left" && first;
        if (live) first = false;
        // 결부 뷰 이름 — 사이드바가 누구를 섬기는지는 호스트 헤더의 이 한 곳이 말한다
        // (떠다니는 "연결됨" 배지 폐지 — 관계 표시 단순화, 사용자 결정).
        const boundId = instanceKey.split("|")[2] ?? proj?.binding.viewId ?? null;
        const boundView = boundId && tab ? findViewById([tab], boundId) : null;
        return (
          <div
            key={instanceKey}
            className="proj-slot"
            style={{ display: live ? "flex" : "none" }}
          >
            {/* 공통 양식(§12-①②) — 헤더는 호스트의 것(기능 정체 표시 + 레일 조작), 본문만 기능이 교체한다. */}
            <div className="proj-frame-header" data-node={`projection/${side}/frame/${refKey}`}>
              <span className="proj-frame-icon">{decl?.icon ?? ""}</span>
              <span className="proj-frame-title">{decl ? localize(decl.title) : refKey}</span>
              {boundView && (
                <span className="proj-frame-bound">{viewDisplayTitle(boundView)}</span>
              )}
              {showToggle && (
                <button
                  type="button"
                  className="proj-look-toggle"
                  data-node="projection/left/look"
                  title={t("projection.look.toggle")}
                  onClick={() => setRailLook(railLook === "pane" ? "ground" : "pane")}
                >
                  {railLook === "pane" ? "▦" : "▬"}
                </button>
              )}
            </div>
            <div className="proj-frame-body">
              <PluginViewHost
                viewKey={refKey}
                projectId={projectId}
                root={root}
                region={side}
                paneId={paneId}
                boundViewId={instanceKey.split("|")[2] ?? proj?.binding.viewId ?? null}
              />
            </div>
          </div>
        );
      })}
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
