// 플러그인 뷰 단일 호스트 — 배치(우측/좌측 사이드바·콘텐츠) 불문 동일 컴포넌트(§0-6).
// provider.mount/unmount 는 try/catch 경계(§0-4): mount 실패는 에러 카드, provider
// 부재(플러그인 비활성/제거)는 플레이스홀더. 잔존 DOM 은 호스트가 정리한다.

import { moduleState } from "../lib/moduleState";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  getRegisteredView,
  useViewRegistry,
  type PluginViewContext,
} from "../plugins/viewRegistry";
import { formatAddress, type Region } from "../commands/address";
import { viewHostAnchors } from "../plugins/viewHostAnchors";
import { bindingIdentity } from "../plugins/viewContext";
import { registerMountedViewFocus } from "../plugins/viewFocus";
import { useSessions } from "../state/sessions";
import { useBootPhase } from "../state/bootPhase";
import { useT } from "../i18n";

// 컨테이너 세대 카운터 — 등록(reg) 세대마다 증가. 모듈 전역이라 창 내 모든 호스트가 공유해도
// 값은 key 유일성에만 쓰여 충돌이 없다.
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화가
// 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
const ms = moduleState("components/PluginViewHost.#state", () => ({
  containerGeneration: 0,
}));
// memo 경계(원칙 2).
export const PluginViewHost = memo(function PluginViewHost({
  viewKey,
  projectId,
  root,
  region,
  paneId = null,
  viewId = null,
  boundViewId = null,
  command = null,
  restore = null,
  instanceId = null,
}: {
  viewKey: string; // "<pluginId>.<viewId>"
  projectId: string;
  root: string | null;
  region: Region; // left|content|right — 컨테이너 절대 주소의 영역 세그먼트
  // 이 뷰가 추종할 터미널 pane(cwd 추종 대상). 미지정=null(계약 A13/S7). 사이드바 호스트가 cwdTabOf 전달.
  paneId?: string | null;
  // 콘텐츠 배치면 sessions view.id(status 보고 대상), 사이드바면 null(close guard 무관 → setStatus no-op).
  viewId?: string | null;
  // 레일 투영 마운트가 섬기는 결부 콘텐츠 뷰 id(§4.4-lite) — ProjectionSlots 만 전달.
  boundViewId?: string | null;
  // 이 뷰가 마운트 시 받을 자동 실행 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 실행). 없으면 null.
  command?: string | null;
  // 복원 seam(B3) — 재시작 복원 마운트면 관찰됐던 런타임(cwd·state). 새 뷰는 미지정(null).
  restore?: { cwd: string | null; state: unknown } | null;
  // 주소 유일성 축(공리 A1) — 같은 viewKey 가 한 영역에 두 번 마운트될 때 이것이 둘을 가른다.
  // 미지정이면 viewId 를 쓴다. 마운트 자리가 자기 인스턴스를 알므로 호스트가 추측하지 않는다.
  instanceId?: string | null;
}) {
  // 이 뷰 컨테이너의 절대 주소(노드 스캔의 baseAddress). project 는 경로(슬래시 충돌)라 활성 기준 생략 —
  // <region>/view/<viewKey>. win 생략=현재 창. 안정 세그먼트(region·qualifiedViewId)라 멱등. ui.tree 가 읽는다.
  const viewAddr = formatAddress({
    region,
    view: viewKey,
    tab: instanceId ?? viewId ?? undefined,
  });
  const t = useT();
  // version 구독 → 등록/해제 시 재평가. RegisteredView 객체는 변경 없으면 동일 참조
  // (zustand spread) — 무관한 version 증가로는 remount 되지 않는다.
  useViewRegistry((s) => s.version);
  const reg = getRegisteredView(viewKey);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // provider 가 라이브 update 를 구현하면 paneId 변경을 remount 대신 update 로 전달한다(아래 deps 참조).
  const supportsUpdate = typeof reg?.provider.update === "function";

  // 최신 ctx 를 ref 로 보관 — mount/update effect 가 deps 를 늘리지 않고 최신값을 읽는다.
  const ctxRef = useRef<PluginViewContext | null>(null);
  ctxRef.current = {
    projectId,
    root,
    paneId,
    viewId: viewId ?? null,
    boundViewId: boundViewId ?? null,
    command: command ?? null,
    restore: restore ?? null,
    // 이 창의 그 뷰 탭 배지(per-window — 창마다 자체 store). 데이터 변경 시 플러그인이 재계산.
    setBadge: (badge) => useViewRegistry.getState().setViewBadge(viewKey, badge),
    // status 보고(R1) — 콘텐츠 배치(viewId 有)만 sessions view.status 로. 사이드바는 no-op.
    setStatus: (status) =>
      viewId
        ? void useSessions.getState().setViewStatus(projectId, viewId, status)
        : undefined,
    // 탭 제목 동적 갱신 — 콘텐츠 배치(viewId 有)만. 사이드바는 no-op.
    setTitle: (title) =>
      viewId
        ? useSessions.getState().setViewTitle(projectId, viewId, title)
        : undefined,
    // 탭 아이콘(콘텐츠 사실 — 파비콘 등) — 콘텐츠 배치만. 빈 값 = 해제.
    setIcon: (icon) =>
      viewId
        ? useSessions.getState().setViewIcon(projectId, viewId, icon)
        : undefined,
    // 플러그인 관찰 상태(B3) — 뷰 레코드로 영속(뷰와 수명 동기). 콘텐츠 배치만.
    setRestoreState: (state) =>
      viewId
        ? useSessions.getState().setViewRuntime(projectId, viewId, { state })
        : undefined,
  };

  // 결부 정체성 — ctx 의 binding 축 값 전부(viewContext 의 축 선언이 단일 진실). 필드 이름을
  // 여기 나열하지 않는다: 나열하면 새 필드가 조용히 빠지고, 빠진 필드는 "결부는 바뀌었는데
  // 화면은 옛 것"이 된다(실측 — boundViewId 가 어느 축에도 없어 shared 투영이 남의 내용을 그렸다).
  const binding = bindingIdentity(ctxRef.current!);

  // 구조 mount/unmount. **결부는 update 를 구현한 provider 면 deps 에서 제외**(별도 effect 가 푸시) —
  // 인스턴스를 유지하겠다는 선언이 update 이고, 그 선언이 있으면 재생성하지 않는다. 미구현
  // provider 에게 남은 정직한 길은 재생성뿐이다: 남의 결부 데이터를 계속 그리는 것보다 구조
  // 상태를 잃는 편이 옳다. viewKey/reg(=provider 교체)는 결부와 무관하게 항상 remount.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg) return;
    setError(null);
    try {
      reg.provider.mount(el, ctxRef.current!);
    } catch (e) {
      console.error(`플러그인 뷰 mount 실패(${viewKey}):`, e);
      setError(String(e));
      el.replaceChildren(); // 부분 렌더 잔재 제거
      return;
    }
    const unregisterFocus = viewId
      ? registerMountedViewFocus(
          viewId,
          el,
          reg.provider,
          () => ctxRef.current!,
        )
      : null;
    return () => {
      // Abort deferred focus before provider teardown so a stale async mount can
      // never focus after this container has ceased to own the view.
      unregisterFocus?.();
      try {
        reg.provider.unmount?.(el);
      } catch (e) {
        console.error(`플러그인 뷰 unmount 실패(${viewKey}):`, e);
      }
      el.replaceChildren(); // unmount 미구현 provider 대비 — 호스트가 정리 보장
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg, viewKey, supportsUpdate ? "" : binding]);

  // 결부 라이브 갱신 — 마운트된 뷰에 새 ctx 푸시(remount 없이). update 미구현이면 위 effect 가
  // 결부를 deps 에 포함해 remount 하므로 여기선 no-op. mount 직후에도 1회 도나 update 는 멱등.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg || !supportsUpdate) return;
    try {
      reg.provider.update!(el, ctxRef.current!);
    } catch (e) {
      console.error(`플러그인 뷰 update 실패(${viewKey}):`, e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, supportsUpdate, reg]);

  // 컨테이너 세대 — 구조 remount(mount effect 의 deps 와 동일 축)는 항상 새 컨테이너 DOM 을
  // 만든다. attachShadow 는 비가역이라 재활용 노드는 이전 세대의 shadow root(와 불완전한
  // provider.unmount 가 남긴 DOM/GL 잔재)를 다음 마운트에 물려준다. React key 로 노드를
  // 갈아끼워 세대를 격리한다 — 어떤 provider 도 이전 세대의 잔재 위에 마운트되지 않는다.
  const generation = useMemo(() => ++ms.containerGeneration, [reg]);
  const containerKey = [
    generation,
    viewKey,
    supportsUpdate ? "" : binding,
  ].join("\u0000");

  // 부트 위상 — ready 전의 미등록은 "부재"가 아니라 "아직"이다(빈칸 착각 방지 계약).
  const bootPhase = useBootPhase((s) => s.phase);
  // 컨테이너는 항상 렌더(ref 유지) — 에러/부재는 위에 겹쳐 보여 재등록 시 복구 가능.
  const overlay = !reg ? (
    bootPhase !== "ready" ? (
      <div className="plugin-loading">{t("plugin.view.loading")}</div>
    ) : (
      <div className="plugin-empty">{t("plugin.view.missing")}</div>
    )
  ) : error ? (
    <div className="plugin-error">
      <div className="plugin-error-title">{t("plugin.view.error")}</div>
      <div className="plugin-error-msg">{error}</div>
    </div>
  ) : null;

  return (
    <div className="plugin-body">
      <div
        key={containerKey}
        // 옛 이름을 함께 싣는다 — commands 층 셀렉터(catalogDom)가 아직 그것으로 이 루트를
        // 찾는다. 제거 조건: catalogDom 의 `.plugin-view-container` 셀렉터 3곳이 `.tab-viewer`
        // 로 이행하면 두 번째 토큰을 지운다(검증 = ui.tree 가 뷰 노드를 계속 싣는지).
        className={`tab-viewer plugin-view-container${reg?.decl.transparent ? " transparent" : ""}`}
        {...viewHostAnchors(viewAddr, viewId)}
        ref={containerRef}
        style={overlay ? { display: "none" } : undefined}
      />
      {overlay}
    </div>
  );
});
