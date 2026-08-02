import { railBoundBox } from "./lib/railBoundBox";
import { currentWindow, appInfo, invoke, dragRegion, engineProvision } from "./framework";
import { execute } from "./commands/registry";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listenThisWindow } from "./lib/windowEvents";
import { addProjectClaimed, closeProjectReleased, useOtherWindowProjects } from "./state/projectRegistry";
import { removeRecentProject, useRecentProjects } from "./state/recentProjects";
import { rafThrottle } from "./lib/rafThrottle";
import { railEdgeWidths } from "./ui/railEdges";
import { parkedStyle } from "./lib/layerPark";
import { emitPluginEvent } from "./plugins/hooks";
import { resolveTerminalProgram } from "./plugins/terminalEngine";
import { startPointerOrderRepair } from "./lib/pointerOrderRepair";
import { applyWindowZoom, isPrimaryModifier, routeZoom } from "./lib/zoomIntent";
import { beginLayoutMotion, endLayoutMotion } from "./lib/layoutMotion";
import { registerRailPlane, requestRailHoleClipSync } from "./lib/railHoleClipHost";
import {
  canGlideViews,
  disposeSlotFreezeHost,
  ensureSlotFreezeHost,
  scheduleSlotSettleCapture,
} from "./lib/slotFreezeHost";
import {
  activeSessionViewId,
  startViewFocusSync,
  transferViewFocus,
} from "./plugins/viewFocus";
import { browserViewIdFromLabel } from "./lib/webviewLabels";
import {
  CONTENT_VIEW_EVENT,
  activatedLabelOf,
  relayFrameworkContentViewEvents,
} from "./lib/contentViewEvents";
import { LeftSidebarHost } from "./components/LeftSidebarHost";
import { RailGridSurface } from "./components/RailGridSurface";
import { RailLinkOverlay } from "./components/RailLinkOverlay";
import { PluginSidebar } from "./components/PluginSidebar";
import { ContentTabs } from "./components/ContentTabs";
import { GroupArea, HEADER_PX, PANE_INSET } from "./components/GroupArea";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { Icon } from "./ui/icons/Icon";
import { validateProjectRoot } from "./lib/projectRoot";
// 워드마크 로고 — fill 이 currentColor 상속이라 테마를 자동 추종(정적 신뢰 에셋).
import logoRaw from "./assets/soksak_logo.svg?raw";
import { SettingsModal } from "./components/SettingsModal";
import { ConfirmCloseModal } from "./components/ConfirmCloseModal";
import { RemoteConfirmModal } from "./components/RemoteConfirmModal";
import { RecoverySetupModal } from "./components/RecoverySetupModal";
import { RecoveryEnterModal } from "./components/RecoveryEnterModal";
import { wireRemoteConfirm } from "./state/remoteConfirmWire";
import { installRemoteConfirmDevTrigger } from "./state/remoteConfirmDev";
import { ConsentPreviewHost } from "./components/ConsentPreviewHost";
import { NotifyHost } from "./ui/NotifyHost";
import { MotionDebug } from "./components/MotionDebug";
import { PluginHeaderActions } from "./ui/PluginHeaderActions";
import { useUi } from "./state/ui";
import { useGutterHover } from "./state/gutterHover";
import { useT } from "./i18n";
import { useBootPhase } from "./state/bootPhase";
import { reportDomHoles } from "./lib/domHoles";
import {
  allGroups,
  cwdTabOf as resolveCwdTab,
  projectArrangement,
  useSessions,
  webviewDisplayName,
  type Project,
} from "./state/sessions";
import {
  useSettings,
  type TabPosition,
  type RightSidebarMode,
} from "./state/settings";
import { useTheme } from "./state/theme";
import { getPtyIo, hasPtyObservation } from "./terminal/ptyObservationStore";
import {
  DEFAULT_RAIL_PLACEMENT,
  railStationFromLeftPx,
  snapRailStation,
} from "./lib/railPlacement";
import { railGeometryScopeId, railPresentationLayers } from "./lib/railMotion";
import { useArrangementPhase } from "./components/useArrangementPhase";
import { arrangementMoves, viewIdsOfMoves } from "./lib/railArrangement";
import "./App.css";

// 파일 경로를 셸·Claude Code 양쪽에서 안전하게: 영숫자와 안전문자 외에는 백슬래시
// 이스케이프(공백 포함). 결과가 ...img.png 처럼 따옴표 없이 확장자로 끝나 Claude Code
// 의 이미지 확장자 정규식과 셸 둘 다에 맞는다.
const shellEscape = (p: string) => p.replace(/[^A-Za-z0-9_./@%+:,=-]/g, "\\$&");

// 좌측 사이드바(파일 트리) 폭 범위(CSS px). 실제 폭은 드래그로 조절(전역, localStorage 영속).
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 320;
// 우측 플러그인 사이드바 폭 범위.
const RIGHT_MIN = 200;
const RIGHT_MAX = 640;
const RIGHT_DEFAULT = 300;
// 좌측 프로젝트 레일 폭.
// 제품 레이아웃 계약: 프로젝트 레일 기본 54px, 드래그 44–110px.
const RAIL_MIN = 44;
const RAIL_MAX = 110;
const RAIL_DEFAULT = 54;

// 드래그로 폭을 조절하는 패널 공용 훅(localStorage 영속). dir = 패널이 붙은 쪽:
// left(기본) 는 우측 핸들을 오른쪽으로 끌면 폭이 늘고, right 는 좌측 핸들이라 부호 반전.
function useResizableWidth(
  key: string,
  def: number,
  min: number,
  max: number,
  dir: "left" | "right" = "left",
) {
  const [w, setW] = useState<number>(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  // begin 은 참조 안정(useCallback) — memo 된 ProjectPlane 에 prop 으로 내려가도
  // 경계를 깨지 않는다(원칙 2). 현재 폭은 ref 로 읽는다.
  const wRef = useRef(w);
  wRef.current = w;
  const begin = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wRef.current;
    const sign = dir === "left" ? 1 : -1;
    // 폭 상태 갱신은 프레임당 1회(원칙 4) — App 수준 상태라 리렌더 비용이 크다.
    const commitW = rafThrottle((next: number) => setW(next));
    const onMove = (ev: MouseEvent) =>
      commitW(
        Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX))),
      );
    const onUp = () => {
      commitW.flush(); // 리스너 제거 전에 — 마지막 프레임 유실 = 스냅백.
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      endLayoutMotion("resize");
      setW((cur) => {
        localStorage.setItem(key, String(cur));
        return cur;
      });
    };
    // 폭 드래그도 레이아웃 모션 위상(홀 클립·native 추종) — 사이드바·레일·우측 공통.
    beginLayoutMotion("resize");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // key/min/max/dir 은 호출 지점마다 상수.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, min, max, dir]);
  return [w, begin] as const;
}

// 프로젝트 1개의 본문(좌측 사이드바 + 컨텐츠 + 우측 플러그인 사이드바).
// memo 경계 = project 데이터 경계(원칙 2, docs/PERFORMANCE.md): 프로젝트 X 의
// store 쓰기는 프로젝트 Y 의 객체 정체성을 보존(mapProject)하므로 Y 서브트리는
// 리렌더되지 않는다. 모든 prop 은 참조/값 안정이어야 한다 — 커스텀 비교자 금지.
const ProjectPlane = memo(function ProjectPlane({
  project,
  isActiveProject,
  sidebarW,
  rightW,
  rightMode,
  contentTabPosition,
  startResize,
  startRightResize,
}: {
  project: Project;
  isActiveProject: boolean;
  sidebarW: number;
  rightW: number;
  rightMode: RightSidebarMode;
  contentTabPosition: TabPosition;
  startResize: (e: React.MouseEvent) => void;
  startRightResize: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const setLeftRailPlacement = useSessions((s) => s.setLeftRailPlacement);
  const railPlaneRef = useRef<HTMLDivElement>(null);
  const placement = project.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
  const activeContent =
    project.spaces.find((content) => content.id === project.activeSpaceId) ??
    project.spaces[0];
  // 미해소 포커스 렌더에서 station 이 0 으로 붕괴하지 않게 직전 확정값을 폴백으로 준다.
  const lastStationRef = useRef(0);
  // 배치는 해결기가 푼다 — station·배열·만들어진 인접·이동량의 단일 진실(재계산 금지).
  // 붙이는 방법을 **구독**해서 넘긴다 — getState 로 몰래 읽으면 설정을 바꿔도 다시 안 그린다.
  const railPullFocused = useSettings((s) => s.railPullFocused);
  const solved = projectArrangement(project, lastStationRef.current, railPullFocused);
  lastStationRef.current = solved?.station ?? 0;
  const railGeometryScope = railGeometryScopeId(
    activeContent?.id,
    solved?.cleanLines ?? [0, 100],
  );
  // 배치 위상(§12-④) — pane 복도만 340ms 로 수축·확장하고 출발·도착 레일을 그 아래 바닥에 둔다.
  // 위상 추적은 이 훅 하나뿐이고, **화면에 무엇이 서 있는지도 위상이 소유한다**(주행 중 도착한
  // 해는 대기열에서 기다린다 — 표시를 즉시 갈면 달리는 애니메이션이 튄다).
  // 내용 identity — 패널별 뷰 구성. 위상은 기하만 붙잡으므로 내용 변화는 이 서명으로 알려
  // 즉시 반영하게 한다(뷰 열림·닫힘·탭 전환이 화면에 안 나타나던 결함의 봉합점).
  const contentKey = useMemo(
    () =>
      activeContent
        ? allGroups(activeContent.layout)
            .map(
              (group) =>
                `${group.id}:${group.activeTabId}:${group.tabs.map((v) => v.id).join("+")}`,
            )
            .join("|")
        : "",
    [activeContent],
  );
  const phase = useArrangementPhase(
    solved,
    railGeometryScope,
    contentKey,
    // 여정 모드 판정 — 위상이 시작에 한 번 묻는다(매 렌더 재평가 금지).
    (from, to) => canGlideViews(viewIdsOfMoves(from.displayLayout, arrangementMoves(from, to))),
  );
  const arrangement = phase.displayed;
  const railCells = arrangement?.cells ?? [];
  const railCleanLines = arrangement?.cleanLines ?? [0, 100];
  const effectiveStation = arrangement?.station ?? 0;
  // **결합의 기본은 포커스다.** 명시 결합(railBindingTabId)은 그것을 덮어쓰는 락이지,
  // 결합이 있으려면 반드시 있어야 하는 값이 아니다. 락만 볼 때는 아무도 그 값을 안 세우면
  // 결합 자체가 없어 보더가 통째로 안 그려졌다(실측 2026-08-02).
  //
  // 같은 규칙이 이미 투영 배선에 있다(boundViewInContent: 락이 없으면 활성 판). 두 자리가
  // 서로 다른 기본값을 쓰면 "관계가 있다고 보는 쪽"과 "그리는 쪽"이 갈린다.
  // **결합은 화면이 그리는 해를 따른다.** 포커스는 클릭 즉시 바뀌지만 기하는 위상이 받아들일
  // 때 바뀐다. 새 결합에 옛 기하를 붙이면 그 상자는 어느 해의 것도 아니다 — 한 프레임 동안
  // 엉뚱한 폭이 그려지고 그것이 "움찔"로 보인다(실측 2026-08-02: pan-aecvk3 활성 직후 폭
  // 1369 를 한 번 그리고 456 으로 돌아왔다. 사용자 녹화에서 보더가 좁은 상자와 넓은 상자를
  // 몇 프레임 왕복). 해가 자기 포커스를 답하므로(focusId) 그것을 읽는다.
  // 명시 잠금(railBindingTabId)은 다른 축이다 — 기하를 안 바꾸므로 지연이 없다.
  const boundGroup = activeContent
    ? (allGroups(activeContent.layout).find((group) =>
        activeContent.railBindingTabId
          ? group.tabs.some((view) => view.id === activeContent.railBindingTabId)
          : group.id === (arrangement?.focusId ?? activeContent.activePaneId),
      ) ?? allGroups(activeContent.layout)[0])
    : undefined;
  const boundView = activeContent?.railBindingTabId
    ? boundGroup?.tabs.find((view) => view.id === activeContent.railBindingTabId)
    : (boundGroup?.tabs.find((view) => view.id === boundGroup.activeTabId) ??
      boundGroup?.tabs[0]);
  const boundCell = boundGroup
    ? railCells.find((cell) => cell.id === boundGroup.id)
    : undefined;
  const [dragStation, setDragStation] = useState<number | null>(null);
  const renderedStation = dragStation ?? effectiveStation;
  // 레일 시각 모드(§12-⑤) — pane(분할창처럼) | ground(바닥 평면). 토글은 슬롯 프레임 헤더.
  const railLook = useSettings((s) => s.railLook);
  // 위상이 실제로 움직이는 뷰들 — 해가 지시한 패널(그룹)의 뷰만. 동결도 veil 도 이 집합으로만
  // 간다: 움직이지 않는 표면은 위상 내내 라이브로 남고 통지조차 받지 않는다.
  const movingViewIds = useMemo(() => {
    if (!activeContent || phase.moves.length === 0) return [];
    return viewIdsOfMoves(
      phase.from?.displayLayout ?? activeContent.layout,
      phase.moves,
    );
  }, [activeContent, phase.from, phase.moves]);
  const movingKey = movingViewIds.join(",");
  // 활강의 전제(§4.6-5) — 이동하는 홀 표면을 전부 스탠드인으로 덮을 수 있을 때만 활강한다.
  // 덮을 수 없는 표면이 끼면 그 표면은 위상 내내 샘플링 추종으로 끌려가고 그 스터터가 애초의
  // 불만이었다. 덮을 수 없으면 활강하지 않는다 — 즉시 스냅은 못생겨도 결코 추하지 않다.
  //
  // 판정은 **위상이 시작에 한 번** 한다(phase.glide). 매 렌더 재평가는 위상 한복판에 레일 표상을
  // 1장↔2장으로 바꾸고, 그 1장 렌더에서 서 있던 사이드바가 새 투영으로 커밋된 뒤 빠지는 자리로
  // 밀려난다 — 빠지는 자리가 새 투영을 든 채 닫히던 실측 결함의 진원.
  const railTraveling = dragStation === null && phase.traveling && phase.glide;
  // 위상이 아직 받아들이지 않은 변화 — 포커스는 이미 바뀌었지만 여정은 다음 커밋에 시작된다.
  // 그 한 렌더 동안 서 있는 레일이 새 투영을 커밋하면, 다음 커밋에 그 인스턴스가 빠지는 자리가
  // 되면서 **새 투영을 든 채 닫힌다**(실측: 즐겨찾기가 서 있던 자리에서 파일트리가 닫혔다).
  // 표시의 주인은 위상이다 — 기하와 마찬가지로 내용도 위상이 받아들일 때 바뀐다.
  const arrangementPending =
    !!solved &&
    !!phase.displayed &&
    arrangementMoves(phase.displayed, solved).length > 0;
  // 빠질 자리와 생길 자리 — 출발선 레이어는 서 있던 인스턴스(그것이 닫힌다), 도착선 레이어는
  // 새것(그것이 열려 상주가 된다). 레일 자신은 평행이동하지 않는다: 패널이 덮고 드러내는 것이
  // 곧 닫힘·열림이다(세대 전진은 착지에서만 — useArrangementPhase).
  const railLayers = railPresentationLayers(
    phase.generation,
    phase.from?.station ?? renderedStation,
    renderedStation,
    railTraveling,
  );
  // 위상 신호(§4.6) — 이동하는 표면을 코어가 스탠드인으로 덮는 근거. 위상 중 네이티브 표면은
  // 움직이지 않으므로(스탠드인이 시각을 전담) 여기서 네이티브를 구동하지 않는다.
  useLayoutEffect(() => {
    if (!railTraveling) return;
    beginLayoutMotion("move", movingViewIds, `rail-travel:${movingKey}`);
    return () => endLayoutMotion("move");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railTraveling, movingKey]);
  // 사이드바는 홀(브라우저 네이티브 표면) 위에 칠하지 않는다 — 상시 계약(사용자 규정:
  // 겹치면 언제나 사이드바가 브라우저 아래). DOM 표면은 z(레일 0 < 셀 1)로 성립하지만
  // 홀 뷰의 네이티브 표면은 DOM 전체 뒤라 클립 제외만이 유일한 방법이다(railHoleClip).
  // 정적 상태는 매 커밋에서, 애니메이션 중간 프레임은 모션 위상 rAF 가 갱신한다.
  // 소유자는 창이다(railHoleClipHost). pane 은 자기 평면을 맡기고 커밋마다 동기를 요청만
  // 한다 — 문서 스캔도 위상 rAF 도 창에 하나뿐이라 프로젝트 수에 비례하지 않는다.
  useLayoutEffect(() => {
    const plane = railPlaneRef.current;
    return plane ? registerRailPlane(plane) : undefined;
  }, []);
  useLayoutEffect(() => {
    requestRailHoleClipSync();
  });
  // pane 그리드 행 계약 소비 — 레일 헤더가 pane 그룹 헤더와 같은 행에 앉도록
  // 같은 소스(GroupArea 상수 + 테마 paneStyle)의 치수를 레일 서브트리에 주입한다.
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const railPaneInset = PANE_INSET[paneStyle] ?? 0;

  // 핀 = 현 위치 정박 / 해제 = 포커스 추종(flow). 레일이 기능 탭에 붙는 것이 기본이다.
  const toggleRailPin = useCallback(() => {
    setLeftRailPlacement(
      project.id,
      placement.mode === "pin"
        ? { mode: "flow" }
        : { mode: "pin", station: effectiveStation },
    );
  }, [effectiveStation, placement.mode, project.id, setLeftRailPlacement]);

  const startRailStationDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !project.sidebarOpen) return;
      e.preventDefault();
      e.stopPropagation();
      const plane = railPlaneRef.current;
      const rail = e.currentTarget.closest<HTMLElement>(".sidebar");
      if (!plane || !rail) return;
      const planeRect = plane.getBoundingClientRect();
      const offset = e.clientX - rail.getBoundingClientRect().left;
      let next = effectiveStation;
      const resolve = (clientX: number) => {
        const raw = railStationFromLeftPx(
          clientX - planeRect.left - offset,
          planeRect.width,
          sidebarW,
        );
        return snapRailStation(railCleanLines, raw);
      };
      const onMove = (ev: MouseEvent) => {
        next = resolve(ev.clientX);
        setDragStation((current) => (current === next ? current : next));
      };
      const onUp = (ev: MouseEvent) => {
        next = resolve(ev.clientX);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        endLayoutMotion("move");
        setDragStation(null);
        // 드래그 착지는 주행 위상이 아니다 — 표시 기준점을 손 위치에 동기화한다.
        phase.rebase();
        setLeftRailPlacement(project.id, { mode: "pin", station: next });
      };
      // 손 드래그도 레이아웃 모션 위상 — 자동 주행과 같은 신호(홀 클립·native 추종)를 받는다.
      beginLayoutMotion("move", undefined, "station-drag");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [
      effectiveStation,
      phase.rebase,
      project.id,
      project.sidebarOpen,
      railCleanLines,
      setLeftRailPlacement,
      sidebarW,
    ],
  );
  // 콘텐츠 탭 전환 시 비활성 슬롯은 화면 밖으로 파킹된다(parkedStyle transform). 그 파킹/언파킹은
  // 이 렌더 커밋에서 DOM 에 반영되므로, 커밋 직후(useLayoutEffect, paint 전) 코어가 layout.reflow 를
  // 발화한다 → 네이티브 webview 를 소유한 플러그인(브라우저)이 최종 앵커로 bounds 를 1회 재스냅해
  // 클릭에 즉시 반응한다. 전환 신호(view.activated)는 store diff 마이크로태스크라 커밋 전이라 여기서
  // 못 쓴다(그걸로 측정하면 옛 위치를 읽어 webview 가 한 박자 늦는다).
  //
  // 탭 전환(패널 안에서 활성 뷰 교체)도 이 에지다 — contentKey 가 그것을 싣는다. 빠져 있으면 두
  // 결함이 함께 온다: ① 새로 활성이 된 뷰는 스냅이 없어 다음 여정의 활강 전제가 깨지고 그리드가
  // 통째로 순간이동한다 ② 파킹에서 돌아온 표면이 최종 앵커로 재스냅되지 않아 한 박자 늦는다
  // (사용자 실측: 브라우저 탭이 여럿인 패널에서 다른 탭을 고르면 이질감과 깜빡임).
  useLayoutEffect(() => {
    emitPluginEvent("layout.reflow", { activeSpaceId: project.activeSpaceId });
    scheduleSlotSettleCapture(); // 레이아웃 정착 에지 — 슬롯 동결 스냅 갱신(디바운스)
  }, [
    contentKey,
    activeContent?.activePaneId,
    activeContent?.maximizedTabId,
    project.activeSpaceId,
    project.sidebarOpen,
    isActiveProject,
    renderedStation,
    railTraveling,
    sidebarW,
    contentTabPosition,
  ]);
  return (
    <div
      className="project-plane"
      // 주소 공리 A1 의 앵커 — 이 평면 안의 크롬 노드는 프로젝트마다 한 벌씩 산다.
      // 주소가 프로젝트를 실어야 rail/left 가 하나로 풀린다(collectExposed 가 읽는다).
      data-project-plane={project.id}
      data-project-active={isActiveProject ? "1" : undefined}
      // 비활성 프로젝트도 화면 밖으로 파킹한다(R12 단일 진실) — visibility:hidden 은 DOM 만 감추고
      // GPU 레이어(터미널 WebGL)와 네이티브 child(브라우저 webview)는 그대로 합성된다. 콘텐츠·뷰 슬롯과
      // 같은 헬퍼를 쓰는 이유가 그것이다(층 간 일치). 프로젝트를 전환해도 이전 브라우저가 화면에
      // 남던 결함이 이 층의 누락이었다.
      style={parkedStyle(isActiveProject)}
    >
      {/* 상위 콘텐츠 탭은 rail 밖에 남고, 선택된 패널 grid만 rail과 좌표계를 공유한다. */}
      <div
        className={`content${contentTabPosition === "left" ? " space-tabs-left" : ""}`}
      >
        {project.rootMissing && (
          <div className="root-missing-banner" data-node="banner/root-missing">
            {t("project.rootMissing", { root: project.root })}
          </div>
        )}
        <ContentTabs
          project={project}
          vertical={contentTabPosition === "left"}
        />
        <RailGridSurface
          traveling={railTraveling}
          relationOverlay={
            project.sidebarOpen && activeContent && boundGroup && boundView && boundCell ? (
              <RailLinkOverlay
                contentId={activeContent.id}
                boundViewId={boundView.id}
                boundPaneId={boundGroup.id}
                railWidth={sidebarW}
                railStation={renderedStation}
                // 보더가 감싸는 상자는 **레일부터 결합 판의 오른쪽 끝까지**다. 결합 판이
                // 레일 옆이면 그 판 자신이 되고(좁은 경우), 사이에 다른 판이 끼면 그것까지
                // 품는다(넓은 경우) — 같은 식의 두 해다.
                targetRect={railBoundBox(renderedStation, boundCell.rect)}
                projected={arrangement?.swapped ?? false}
              />
            ) : undefined
          }
          railPlane={
            <div
              ref={railPlaneRef}
              className="left-rail-plane"
              style={
                {
                  "--pane-inset": `${railPaneInset}px`,
                  "--header-h": `${HEADER_PX}px`,
                } as React.CSSProperties
              }
            >
              {railLayers.map((layer) => (
                <div
                  // key = identity. 출발선 레이어는 서 있던 인스턴스의 key 를 그대로 받아
                  // **원래 있던 그것이 닫힌다**. 도착선만 새 key 로 열리고, 착지에 상주 세대가
                  // 그 key 로 전진해 재마운트 없이 상주가 된다(useArrangementPhase).
                  key={layer.key}
                  className={`sidebar rail-${railLook}`}
                  // 빠지는 자리도 관측면이다 — 주소가 없으면 "원래 있던 것이 닫힌다"를 밖에서
                  // 잴 방법이 없다. 상주·도착은 rail/left, 출발은 rail/left/leaving.
                  data-node={layer.role === "source" ? "rail/left/leaving" : "rail/left"}
                  data-rail-role={layer.role}
                  // 세로 경계의 소유자는 station 에 달렸다(가장자리는 바깥쪽 변 생략 — §B2).
                  // 판정 축이 인라인 스타일 안에만 있으면 계약이 그 법을 말할 수 없다 —
                  // 축을 밖에서 읽을 수 있게 발행한다(borderContract rail-pane-* 가 소비).
                  data-station={layer.station}
                  aria-hidden={!layer.interactive || undefined}
                  onMouseDown={
                    layer.interactive
                      ? (e) => {
                          // §12-① 헤더 = 이동 손잡이 — 프레임 헤더 아무 곳이나 잡으면 스테이션 드래그.
                          // 헤더 위 상호작용 컨트롤(버튼)은 제외.
                          const t = e.target as HTMLElement;
                          if (
                            t.closest(".projection-header") &&
                            !t.closest("button")
                          ) {
                            startRailStationDrag(e);
                          }
                        }
                      : undefined
                  }
                  style={
                    {
                      left: `calc(${layer.station}% - ${(sidebarW * layer.station) / 100}px)`,
                      width: project.sidebarOpen ? sidebarW : 0,
                      borderLeftWidth: railEdgeWidths(
                        railLook,
                        project.sidebarOpen,
                        layer.station,
                        paneStyle,
                      ).left,
                      borderRightWidth: railEdgeWidths(
                        railLook,
                        project.sidebarOpen,
                        layer.station,
                        paneStyle,
                      ).right,
                      pointerEvents: layer.interactive ? "auto" : "none",
                    } as React.CSSProperties
                  }
                >
                  <LeftSidebarHost
                    project={project}
                    paneId={cwdTabOf(project) ?? ""}
                    commitProjection={layer.commitProjection && !arrangementPending}
                  />
                  {project.sidebarOpen && layer.interactive && (
                    <div className="left-rail-controls">
                      <button
                        type="button"
                        className={`left-rail-pin${placement.mode === "pin" ? " active" : ""}`}
                        title={
                          placement.mode === "pin"
                            ? "PIN 해제 — 포커스 추종"
                            : "현재 위치에 PIN"
                        }
                        onClick={toggleRailPin}
                      >
                        <Icon
                          name={placement.mode === "pin" ? "pin-filled" : "pin"}
                          size="sm"
                        />
                      </button>
                    </div>
                  )}
                  {project.sidebarOpen && layer.interactive && (
                    <div
                      className="sidebar-resizer"
                      data-native-drag
                      onMouseDown={startResize}
                      title="사이드바 폭 조절"
                    />
                  )}
                </div>
              ))}
            </div>
          }
        >
          {project.spaces.map((c) => {
            const isActiveContent = c.id === project.activeSpaceId;
            return (
              <div
                key={c.id}
                className="space-plane"
                // 비활성 콘텐츠는 화면 밖으로 파킹(R12 단일 진실) — visibility:hidden 만으로는 그 안의
                // 터미널 WebGL 캔버스가 GPU 레이어로 합성돼 활성 콘텐츠의 브라우저 홀로 비친다. 뷰 슬롯
                // (GroupArea)과 동일 규칙을 같은 헬퍼로 적용(층 간 일치).
                style={parkedStyle(isActiveContent)}
              >
                <GroupArea
                  content={c}
                  projectId={project.id}
                  surfaceActive={isActiveProject && isActiveContent}
                  // 배치는 해가 정한다 — 비활성 콘텐츠는 자기 정본 배열 그대로(레일 없음).
                  // 레일이 못 간 만큼 가려진 칸 — 움직이지 않지만 흐려야 어느 판이 활성인지 보인다.
                  //
                  // 화면이 그리는 해에서 가져온다 — railCells·결부와 같은 자리다. 한 상자는
                  // 한 해에서 나온다: 새 사실에 옛 기하를 붙이면 그 그림은 어느 해의 것도
                  // 아니다. 포커스만 바뀐 해도 위상이 즉시 받아들인다(arrangementKey 가 그
                  // 사실까지 서명한다 — 안 그러면 여기서 영영 옛 값을 읽는다).
                  betweenIds={isActiveContent ? (arrangement?.betweenIds ?? []) : []}
                  // 흐림도 같은 해를 따른다 — 기하가 위상을 따르는데 흐림만 즉시 바뀌면,
                  // 여정 시작 순간에 동결 사진이 못 쓰게 되고 표면을 덮을 것이 없어진다.
                  focusedPaneId={isActiveContent ? arrangement?.focusId : undefined}
                  displayLayout={
                    isActiveContent ? arrangement?.displayLayout : undefined
                  }
                  moves={isActiveContent && railTraveling ? phase.moves : undefined}
                  travel={
                    isActiveContent && railTraveling
                      ? {
                          from: phase.from?.station ?? renderedStation,
                          to: renderedStation,
                        }
                      : undefined
                  }
                  railStation={isActiveContent ? renderedStation : 0}
                  // 최대화 사실은 station 과 **같은 해**에서 온다 — 섞으면 렌더가 던진다.
                  displayMaximizedId={isActiveContent ? (arrangement?.maximizedId ?? null) : undefined}
                  railWidthPx={
                    isActiveContent && project.sidebarOpen ? sidebarW : 0
                  }
                />
              </div>
            );
          })}
        </RailGridSurface>
      </div>

      {/* 우측 플러그인 사이드바(⌥⌘B). 닫히면 width 0(언마운트 X — keep-alive). */}
      {project.rightOpen && (
        <div
          className="sidebar-right-resizer"
          style={{ right: rightW - 2 }}
          onMouseDown={startRightResize}
          title={t("plugin.sidebar.resize")}
        />
      )}
      <div
        className={`sidebar-right${project.rightOpen ? " open" : ""}${rightMode === "push" ? " push" : ""}`}
        style={{
          width: project.rightOpen ? rightW : 0,
          borderLeftWidth: project.rightOpen ? 1 : 0,
        }}
      >
        <PluginSidebar projectId={project.id} />
      </div>
    </div>
  );
});

// 프로젝트의 사이드바(파일트리)가 따라갈 터미널 pane(= 현재 cwd 출처). 순수 resolver 는
// sessions.cwdTabOf — 여기서는 PTY 관찰 predicate(hasPtyObservation)를 주입해 호출한다.
// 코어/플러그인 터미널 구분 없음 — PTY substrate 를 구동하는(관찰을 가진) 뷰면 따라간다.
const cwdTabOf = (project: Project): string | undefined =>
  resolveCwdTab(project, hasPtyObservation);

// 빌드 정체성 배지: DEV(dev identity) / DEBUG(디버그 번들 soksak-debug) / 없음(릴리스).
// 축은 identity 다 — 로드 방식(HMR/번들)이 아니다. 예전엔 "DEV=HMR 일 때만"이어서 같은
// dev identity 라도 번들 빌드는 무배지 = 릴리스와 시각 구분 불가였다(실측: 사용자가
// "dev 빌드가 아니네?"라고 오인). HMR 은 dev identity 에서만 도니 DEV 로 즉시, 번들은
// 앱 이름(getName)으로 가른다 — productName 이 soksak-dev / soksak-debug / soksak 로
// 정체성을 인코딩한다.
function BuildBadge() {
  const [label, setLabel] = useState<string | null>(
    import.meta.env.DEV ? "DEV" : null,
  );
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let alive = true;
    appInfo
      .name()
      .then((name) => {
        if (!alive) return;
        if (name.includes("debug")) setLabel("DEBUG");
        else if (name.includes("dev")) setLabel("DEV");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  // 배지는 모션 관측 패널의 손잡이다 — 개발 정체성에서만 존재하므로 릴리스에는 그 표면이
  // 아예 없다. 사람이 여기서 느리게 돌리고 멈춘 뒤, 같은 순간을 ui.snapshot.dom 이 읽는다.
  const [debugOpen, setDebugOpen] = useState(false);
  if (!label) return null;
  return (
    <span className="dev-badge-wrap">
      <button
        type="button"
        data-node="dev-badge"
        className={`dev-badge${label === "DEBUG" ? " debug" : ""}${debugOpen ? " on" : ""}`}
        title="모션 관측(배속·정지)"
        onClick={() => setDebugOpen((v) => !v)}
      >
        {label}
      </button>
      {debugOpen && <MotionDebug onClose={() => setDebugOpen(false)} />}
    </span>
  );
}

// webview 복구 소진 배지 — 코어(webview_health)가 이 창에 emit_to 한 건강 전이 중
// open(자동 복구 상한 소진)만 비차단 배지로 알린다. 블로킹 다이얼로그 금지 — 멀티윈도우에서
// 한 child 의 크래시가 전체를 모달로 막지 못하게 한다. "다시 불러오기" = webview.recover
// 와 동일 코어 경로(브레이커 reset + 제자리 reload). recovering/closed 전이가 오면 그
// label 의 배지를 걷는다(정상 복귀·복구 재개 모두 배지 사유 소멸).
// 부트 위상 배지 — 복원·플러그인 준비가 진행 중임을 창 구석에 은은히 알린다(빈칸 착각 방지).
// ready 가 되면 사라진다. 클릭 불가·비차단(pointer-events 없음).
function BootPhaseBadge() {
  const phase = useBootPhase((s) => s.phase);
  const t = useT();
  if (phase === "ready") return null;
  return (
    <div className="boot-phase" data-node="boot-phase">
      <span className="boot-phase-dot" />
      {phase === "restoring" ? t("boot.restoring") : t("boot.activating")}
    </div>
  );
}

function WebviewHealthBadges() {
  const t = useT();
  // 배지는 사용자 표면 — raw label(b-<창>-<viewId>) 대신 탭 표시명으로 해소한다
  // (webviewDisplayName). 식별(key·data-node·recover 인자)은 label 유지 — 기계 경로 불변.
  const projects = useSessions((s) => s.projects);
  const [openLabels, setOpenLabels] = useState<string[]>([]);
  useEffect(() => {
    return listenThisWindow<{ label: string; state: string }>(
      "webview-health",
      (e) => {
        const { label, state } = e.payload;
        setOpenLabels((prev) =>
          state === "open"
            ? prev.includes(label)
              ? prev
              : [...prev, label]
            : prev.filter((l) => l !== label),
        );
      },
    );
  }, []);
  if (openLabels.length === 0) return null;
  return (
    <div className="webview-health-badges">
      {openLabels.map((label) => (
        <div key={label} className="webview-health-badge">
          <span>
            {t("webview.exhausted", { label: webviewDisplayName(label, projects) })}
          </span>
          <button
            type="button"
            data-node={`webview/recover/${label}`}
            onClick={() => {
              void invoke("webview_recover", { label }).catch((err) =>
                console.error("webview 수동 복구 실패:", err),
              );
            }}
          >
            {t("webview.recoverAction")}
          </button>
          <button
            type="button"
            aria-label={t("common.cancel")}
            onClick={() =>
              setOpenLabels((prev) => prev.filter((l) => l !== label))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  const t = useT();
  const settingsSection = useUi((s) => s.settingsSection);
  const setSettingsSection = useUi((s) => s.setSettingsSection);
  const projectTabPosition = useSettings((s) => s.projectTabPosition);
  const contentTabPosition = useSettings((s) => s.contentTabPosition);
  const rightSidebarMode = useSettings((s) => s.rightSidebarMode);

  // 테마 시스템(토큰 슬롯)이 단일 소스 — CSS 변수/구조 속성은 테마 엔진이 적용한다.
  const effectiveMode = useTheme((s) => s.effectiveMode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const reloadThemes = useTheme((s) => s.reload);
  const isDark = effectiveMode === "dark";

  // 시작 시 외부 테마(~/.soksak/themes) 1회 스캔.
  useEffect(() => {
    reloadThemes().catch((e) => console.error("테마 스캔 실패:", e));
  }, [reloadThemes]);

  // 아이콘 버튼 라운드박스 — 루트 어트리뷰트로 CSS 분기(data-pane-style 과 동형).
  const iconBox = useSettings((s) => s.iconBox);
  useEffect(() => {
    document.documentElement.dataset.iconBox = iconBox ? "on" : "off";
  }, [iconBox]);

  // 포커스 그룹 표시 스타일(outline|corners) — 루트 어트리뷰트로 CSS 분기.
  const focusIndicator = useSettings((s) => s.focusIndicator);
  useEffect(() => {
    document.documentElement.dataset.focusInd = focusIndicator;
  }, [focusIndicator]);

  // 원격 destructive confirm 배선(폰-링크 안전모델) — Rust app.emit("remote-confirm-request")를
  // store 큐에 잇고, 결정 sink 를 remote_confirm_resolve 로 잇는다(데스크톱 단일 권위). 부팅 1회.
  useEffect(() => wireRemoteConfirm(), []);
  // 코어 소유 이동-동결(§4.6 시행) — 창에 엔진 하나. 홀 슬롯은 창의 DOM 에 살고 모션 신호도
  // 창 단위이므로 소유자도 창이다(프로젝트마다 하나씩 만들면 같은 슬롯을 N 번 덮고 캡처도
  // N 배로 나간다). 정착 스냅 갱신은 이벤트 에지에서만 — 폴링 아님.
  useEffect(() => {
    // **따라가는 프레임워크에는 이 장치를 세우지 않는다.** 콘텐츠가 DOM 안에 살면 슬롯이
    // 움직일 때 같이 움직인다 — 덮을 것도 감출 것도 없다. 그런데도 세우면 표면을 감췄다
    // 드러내게 되고, 그 사이 한 프레임이 배경으로 빈다: 워크어라운드가 없던 결함을 만든다
    // (실측 2026-08-02 사용자 "교체가 끝나고 딱 한 프레임에서 사라졌다 다음 프레임에 나타난다").
    // 두 껍데기는 동급이다 — 한쪽의 물리를 코어의 기본으로 두지 않는다.
    if (!engineProvision.nativeChildWebview) return;
    ensureSlotFreezeHost({
      root: () => document,
      capture: async (r) => {
        const b64 = (await invoke("plugin:webview-capture|snapshot_region", {
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
        })) as string;
        return `data:image/png;base64,${b64}`;
      },
      emitVeil: (viewId, veiled, hidden) =>
        emitPluginEvent("view.veiled", { viewId, veiled, hidden }),
    });
    const boot = window.setTimeout(() => scheduleSlotSettleCapture(), 1200);
    return () => {
      window.clearTimeout(boot);
      disposeSlotFreezeHost();
    };
  }, []);

  // 활성 project/space/pane/tab 체인과 실제 키보드 포커스는 하나의 계약이다.
  // 마운트 시 자동포커스하지 않고, 최신 활성 뷰 의도만 provider 에 전달한다.
  useEffect(() => startViewFocusSync(), []);
  // 유령 홀드 복구 — 창 활성화 클릭의 mouseup 유실이 터미널 드래그 선택으로 번지는 것을 차단.
  useEffect(() => startPointerOrderRepair(), []);

  // dev 전용 mock 트리거 — 라이브 폰 없이 모달을 띄워 시각 검증(import.meta.env.DEV 게이트). 프로덕션
  // 번들(DEV=false)에선 아무것도 설치 안 한다. window.__soksakMockRemoteConfirm() 으로 mock 요청 emit.
  useEffect(() => installRemoteConfirmDevTrigger(), []);

  // 앱 UI(앱 크롬) 전역 폰트 family — 코어 소유(상속으로 실동작). 크기 축(appFontSize)은
  // 소거됐다: 죽은 반쪽(px 크롬 미스케일·표면 자체 소유)이었고, 창 줌+뷰 줌이 대체한다.
  const appFontFamily = useSettings((s) => s.appFontFamily);
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font", appFontFamily);
  }, [appFontFamily]);
  // 창 줌 복원 — 저장된 배율을 부팅 시 1회 적용(값 하나, 소비 전원).
  const windowZoom = useSettings((s) => s.windowZoom);
  useEffect(() => {
    if (windowZoom !== 1) applyWindowZoom(windowZoom);
  }, [windowZoom]);

  // 네이티브 child webview(브라우저) 위 클릭은 메인 DOM 에 이벤트가 오지 않아
  // 포커스 추적이 끊긴다 — 네이티브 모니터(browser.rs)가 emit 한 좌표를
  // elementFromPoint 로 판정해 그룹을 활성화한다. 모달 등이 위에 떠 있으면
  // 그 요소가 잡혀 자연 차단되고, DOM 클릭과 중복돼도 같은 결과라 무해.
  useEffect(() => {
    // 이 창에 emit_to 된 native-mouse* 만 받는다(전역 listen 이면 다른 창 이벤트도 받아 엉뚱한 창을
    // 건드림). lib/windowEvents 머리말 참조.
    //
    // 두 역할: (1) 포커스 — mousedown 좌표의 그룹 활성화. (2) 분할 divider 리사이즈 — 네이티브 child
    // (브라우저 등)는 OS 뷰라 그 위의 mousedown/move/up 이 DOM 에 오지 않아, 그 위를 지나는 divider 를
    // 드래그로 못 잡는다. 좌표의 divider(elementFromPoint 는 DOM 만 보므로 네이티브 위여도 divider 반환)
    // 에 합성 마우스 이벤트를 재생해 기존 드래그 로직(GroupArea 의 window mousemove/up 리스너)을 그대로
    // 구동한다 → gap 이나 child 숨김 없이, 화면을 꽉 채운 채 리사이즈. GroupArea 가 중복 시작을 가드한다
    // (divider 가 gap 위면 실제 DOM 이벤트와 이 합성이 겹칠 수 있음).
    const fire = (target: EventTarget, type: string, x: number, y: number) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "mouseup" ? 0 : 1,
          view: window, // React 위임이 SyntheticEvent 를 만들려면 view(defaultView)가 필요할 수 있다.
        }),
      );
    let dragging = false;
    const offDown = listenThisWindow<{ x: number; y: number }>("native-mousedown", (e) => {
      const { x, y } = e.payload;
      const el = document.elementFromPoint(x, y);
      // 네이티브 child 위 드래그 중계 대상: 분할 divider + [data-native-drag] 선언 요소(범용 계약 —
      // 플러그인 내부 리사이저 등). 드래그가 child 영역에 들어가면 실 이벤트는 child 가 삼키므로,
      // 여기서 mousedown 을 쏘고 move/up 을 window 로 중계해야 DOM 드래그가 이어진다.
      const divider = el?.closest<HTMLElement>(".pane-gutter, [data-native-drag]");
      if (divider) {
        dragging = true;
        fire(divider, "mousedown", x, y);
        return;
      }
      bindPaneUnder(el);
    });
    // **guest 안의 클릭은 호스트에 안 온다.** 콘텐츠 뷰는 별도 프로세스라 그 안의 mousedown 이
    // 이 문서로 넘어오지 않는다 — 그래서 브라우저를 눌러도 결합이 안 따라갔다(실측 2026-08-02,
    // Electron). 그때 호스트가 받는 유일한 사실은 **그 엘리먼트가 포커스를 받았다**는 것이다.
    //
    // OS 를 빌리지 않는다(A27). 프레임워크가 계약의 이름으로 그 사실을 내고, 좌표로 들어오든
    // 이 사건으로 들어오든 **같은 함수**를 부른다 — 경로가 갈리면 한쪽만 고쳐지고 그 어긋남은
    // 조용하다.
    // 프레임워크가 손잡이로 알린 것을 계약 모양으로 바꿔 다시 뿌린다 — 적어 두고 아무도
    // 안 부르면 없는 것과 같다.
    const offRelay = relayFrameworkContentViewEvents((name, cb) =>
      listenThisWindow<Record<string, unknown>>(name, (e) => cb(e.payload)),
    );
    const offViewFocus = listenThisWindow<{ id: number }>(CONTENT_VIEW_EVENT.activated, (e) => {
      // 손잡이(webContents id)를 사실(라벨)로 바꾸는 것은 이음매의 일이다 — 앱은 라벨만 안다.
      const label = activatedLabelOf(e.payload?.id);
      const viewId = label ? browserViewIdFromLabel(label) : null;
      const slot = viewId
        ? document.querySelector<HTMLElement>(`[data-node="layout/tab/${viewId}"]`)
        : null;
      bindPaneUnder(slot);
    });
    // 어느 길로 들어오든 칸을 짚는 **한 함수** — 좌표(네이티브 모니터)와 콘텐츠 뷰 활성화가
    // 같은 자리를 부른다. 갈리면 한쪽만 고쳐지고 그 어긋남은 오류로 안 보인다.
    function bindPaneUnder(el: Element | null) {
      const slot = el?.closest<HTMLElement>("[data-pane]");
      // 이름과 값이 같은 실체를 가리킨다 — 속성은 `data-pane`(칸 id)이다. `dataset.groupId` 는
      // 있지도 않은 `data-group-id` 를 찾아 언제나 undefined 이고, 그러면 이 아래가 통째로
      // 안 돈다(계측 2026-08-02: pane 은 잡히는데 결합이 안 일어났다).
      const groupId = slot?.dataset.pane;
      const projectId = slot?.dataset.projectId;
      if (groupId && projectId) {
        const state = useSessions.getState();
        const project = state.projects.find((item) => item.id === projectId);
        const space = project?.spaces.find(
          (item) => item.id === project.activeSpaceId,
        );
        const group = space
          ? allGroups(space.layout).find((item) => item.id === groupId)
          : null;
        const targetViewId = group?.activeTabId;
        if (targetViewId) {
          transferViewFocus(activeSessionViewId(), targetViewId, () =>
            state.setActiveGroup(projectId, groupId),
          );
        } else {
          state.setActiveGroup(projectId, groupId);
        }
      }
    }
    const offMove = listenThisWindow<{ x: number; y: number }>("native-mousemove", (e) => {
      if (dragging) {
        fire(window, "mousemove", e.payload.x, e.payload.y);
        return;
      }
      // hover(버튼 안 누름) — 네이티브 child 위에선 divider :hover 가 발동하지 않으므로, 좌표의 divider
      // (elementFromPoint 는 DOM 만 보므로 네이티브 밑의 divider 를 반환)를 store 에 기록한다. GroupArea 가
      // 그걸 강조 + 좌우 셀을 잠깐 물려 divider 를 드러낸다. divider 아니면 null(강조 해제).
      const el = document.elementFromPoint(e.payload.x, e.payload.y);
      const div = el?.closest<HTMLElement>(".pane-gutter");
      // 발행(GroupArea data-gutter-key)과 같은 이름을 읽는다 — 개명에서 이 판독부만 남아
      // dataset.dividerKey 가 항상 undefined 였다(네이티브 child 위 gutter 강조 무음 사망, 감사 적발).
      useGutterHover.getState().set(div?.dataset.gutterKey ?? null);
    });
    const offUp = listenThisWindow<{ x: number; y: number }>("native-mouseup", (e) => {
      if (!dragging) return;
      dragging = false;
      fire(window, "mouseup", e.payload.x, e.payload.y);
    });
    // 포인터 부재 — 코어가 창 resignKey·앱 resignActive 에서 낸다. hover 는 "있음"만 말하는
    // 소스에서 오므로 이 짝이 없으면 꺼질 방법이 없다: 포인터가 창 밖으로 나가면 mousemove 가
    // 끊기고, 끊긴 것과 그 자리에 멈춘 것이 구별되지 않아 강조가 영원히 남는다(실측: accent
    // 세로선이 브라우저를 가로지른 채 굳음 — ui.hit 이 divider s1:0, rect 가 네이티브 강조바와 동일).
    const offLeave = listenThisWindow("native-mouseleave", () => {
      dragging = false;
      useGutterHover.getState().set(null);
    });
    return () => {
      offDown();
      offViewFocus();
      offRelay();
      offMove();
      offUp();
      offLeave();
    };
  }, []);

  // hover/드래그 중인 divider → 코어가 그 화면 rect 에 accent 바를 브라우저 위(네이티브)에 그린다.
  // 네이티브 child 위에선 DOM 강조가 안 보이므로 유일한 길. rAF 추적 루프: 드래그(리사이즈)로 DOM
  // divider 가 움직이면 매 프레임 rect 를 재측정해 네이티브 바가 정확히 따라간다 — 1회성 배치는 드래그
  // 중 바가 제자리에 남는다(회귀). rect 가 안 변한 프레임은 IPC 를 보내지 않는다(변화시에만 invoke).
  const gutterHoverKey = useGutterHover((s) => s.key);
  useEffect(() => {
    const send = (rect: { x: number; y: number; w: number; h: number } | null) => {
      void invoke("webview_divider_highlight", { rect }).catch(() => {});
    };
    if (!gutterHoverKey) {
      send(null);
      return;
    }
    const sel = `.pane-gutter[data-gutter-key="${CSS.escape(gutterHoverKey)}"]`;
    let raf = 0;
    let last = "";
    const tick = () => {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement) {
        const r = el.getBoundingClientRect();
        const sig = `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`;
        if (sig !== last) {
          last = sig;
          send({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      send(null);
    };
  }, [gutterHoverKey]);

  // 구독 최소 원칙(docs/PERFORMANCE.md 1): 필드/액션별 셀렉터만 — bare 훅 금지.
  // zustand 액션은 create() 시점에 고정되는 안정 참조라 액션 셀렉터는 리렌더 없음.
  const projects = useSessions((s) => s.projects);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const toggleSidebar = useSessions((s) => s.toggleSidebar);
  const toggleRightSidebar = useSessions((s) => s.toggleRightSidebar);
  const addViewToGroup = useSessions((s) => s.addViewToGroup);
  const closeView = useSessions((s) => s.closeView);
  // 프로젝트 설정 모달(이름/색) 대상 프로젝트 id.
  const [projectSettingsFor, setProjectSettingsFor] = useState<string | null>(
    null,
  );
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const activeProject = projects.find((t) => t.id === activeId);

  // spawn 옵션 provider 는 main.tsx 부트(렌더 전)가 등록한다 — effect(마운트
  // 후)는 자식 pane ref 의 첫 spawn 보다 늦어 첫 터미널이 cwd 없이(홈)
  // 시작하던 잠복 버그의 원인이었다.

  // 드래그로 조절되는 패널 폭들(전역, localStorage 영속).
  const [sidebarW, startResize] = useResizableWidth(
    "sidebarW",
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  );
  const [railW, startRailResize] = useResizableWidth(
    "railW",
    RAIL_DEFAULT,
    RAIL_MIN,
    RAIL_MAX,
  );
  const [rightW, startRightResize] = useResizableWidth(
    "rightSidebarW",
    RIGHT_DEFAULT,
    RIGHT_MIN,
    RIGHT_MAX,
    "right",
  );

  // 우측 사이드바(.sidebar-right)는 풀사이즈 브라우저 webview 위에 뜬 DOM 오버레이다
  // (position:absolute, z-index 20). 그 사각형을 네이티브 hit_test 의 "홀"로 보고하면
  // 그 영역의 스크롤/클릭이 아래 브라우저로 새지 않고 DOM(사이드바)이 받는다. webview 는
  // 풀사이즈 그대로 유지된다(과거의 webview 폭 클램프 우회는 폐지 — browser.rs 참조).
  // push 모드면 사이드바가 in-flow로 영역을 차지(콘텐츠·webview가 이미 좁아짐) → 오버레이 홀 불필요.
  const rightRect =
    activeProject?.rightOpen && rightSidebarMode !== "push" ? rightW : 0;
  useLayoutEffect(() => {
    // 닫힘(rightOpen false 또는 폭 0)이면 홀 비움.
    if (!activeProject?.rightOpen || rightW <= 0) {
      requestAnimationFrame(() => reportDomHoles()); // 사이드바가 빠져도 골 홀은 남는다
      return;
    }
    // 폭 변경 등 레이아웃이 커밋된 *다음* 프레임에 측정한다 — rAF 전엔 사이드바 폭이
    // 아직 반영 전이라 rect 가 어긋난다.
    // 홀 목록의 소유자는 lib/domHoles(사이드바 + 모든 골) — 여기서는 사이드바 변화 에지에
    // 재수집만 요청한다(사각형 조립을 두 곳에서 하지 않는다).
    const report = () => reportDomHoles();
    const raf = requestAnimationFrame(report);
    // 창 리사이즈도 사이드바 rect(우변 고정·높이)를 옮긴다 — 다시 측정.
    const onWinResize = () => requestAnimationFrame(report);
    window.addEventListener("resize", onWinResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWinResize);
    };
    // rightRect = rightOpen·rightW 의 단일 파생 — 둘 중 무엇이 바뀌어도 재측정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightRect]);

  // 터미널 테마·세션 폐기는 코어가 소유하지 않는다 — 터미널 플러그인이 자기 뷰의 xterm 테마를
  // app 테마 토큰으로 적용하고, 뷰 언마운트(PluginViewHost) 시 PTY 세션을 스스로 정리한다.

  // 키보드 단축키(캡처 단계 → xterm 보다 먼저). 활성 프로젝트의 활성 뷰 기준.
  // ⌘D 좌우분할 / ⌘⇧D 상하분할 / ⌘W pane→뷰 닫기 / ⌘T 새 터미널 / ⌘B 사이드바.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      // ⌘±/0 = 줌 인텐트(3플랫폼: mac=⌘, Win/Linux=Ctrl — 나머지 단축키의 metaKey
      // 가드보다 먼저 처리해야 Ctrl 경로가 산다). 포커스가 범위를 정한다.
      if (
        isPrimaryModifier(e) &&
        !e.shiftKey &&
        !e.altKey &&
        (key === "=" || key === "+" || key === "-" || key === "0")
      ) {
        e.preventDefault();
        routeZoom(key === "-" ? "out" : key === "0" ? "reset" : "in");
        return;
      }
      if (!e.metaKey) return;
      // ⌘N 새 창(독립 작업공간) — 프로젝트 무관이라 가장 먼저 처리.
      if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invoke("window_create").catch((err) => console.error("새 창 실패:", err));
        return;
      }
      const s = useSessions.getState();
      const project = s.projects.find((t) => t.id === s.activeId);
      if (!project) return;
      const content =
        project.spaces.find((c) => c.id === project.activeSpaceId) ??
        project.spaces[0];
      if (!content) return;
      // ⌥⌘B 우측 플러그인 사이드바. ⌥ 조합은 e.key 가 합성문자("∫")라 e.code 로 판정.
      if (e.altKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        toggleRightSidebar(project.id);
        return;
      }
      const groups = allGroups(content.layout);
      const grp =
        groups.find((g) => g.id === content.activePaneId) ?? groups[0];
      const view = grp?.tabs.find((v) => v.id === grp.activeTabId);
      if (key === "w" && !e.shiftKey) {
        // ⌘W 활성 뷰 닫기(코어 터미널 pane 분할 제거 — 뷰 단위 닫기만).
        e.preventDefault();
        if (view) closeView(project.id, view.id);
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        // ⌘T = 새 터미널 탭. 코어는 특정 엔진을 모른다 — 설정된 터미널 엔진(계약 해소)으로 연다.
        // 활성 터미널 엔진이 없으면 아무것도 열지 않는다(빈 탭 남발 금지 — ⌘T 는 터미널 전용 의도).
        const terminalProgram = resolveTerminalProgram();
        if (terminalProgram) addViewToGroup(project.id, terminalProgram);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar(project.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeView, addViewToGroup, toggleSidebar, toggleRightSidebar]);

  // 파일 드래그&드롭: 활성 프로젝트의 터미널 pane(플러그인 터미널, PTY substrate)에 이스케이프
  // 경로를 주입한다. 코어가 터미널 host-div 를 소유하지 않으므로 substrate IO(getPtyIo)로 보낸다.
  useEffect(() => {
    const unlisten = currentWindow().onDragDrop((e) => {
      const event = e as { payload: { type: string; paths?: string[] } };
      if (event.payload.type !== "drop") return;
      const { paths } = event.payload;
      if (!paths || paths.length === 0) return;
      const s = useSessions.getState();
      const proj = s.projects.find((t) => t.id === s.activeId);
      const paneId = proj ? cwdTabOf(proj) : undefined;
      if (!paneId) return;
      getPtyIo(paneId)?.sendInput(paths.map(shellEscape).join(" "));
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // 프로젝트 탭 목록(상단 가로 / 좌측 세로 양쪽에서 같은 마크업 재사용).
  // 더블클릭 = 프로젝트 설정 모달(이름 + 식별 색 — 인라인 rename 대체).
  const projectTabsList = (
    <>
      {projects.map((proj) => (
        <div
          key={proj.id}
          className={`project-tab${proj.id === activeId ? " active" : ""}`}
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
        >
          {proj.color && (
            <span className="project-tab-dot" style={{ background: proj.color }} />
          )}
          <span className="project-tab-title">{proj.title}</span>
          {projects.length > 1 && (
            <button
              type="button"
              className="icon-btn icon-btn--mini project-tab-close"
              title={t("project.close")}
              onClick={(e) => {
                e.stopPropagation();
                void closeProjectReleased(proj.id); // P6: 닫기 성공 시 전역 점유 해제
              }}
            >
              <Icon name="close" size="md" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="icon-btn project-tab-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" />
      </button>
    </>
  );

  // 좌측 레일: 칩 폭 = 레일 폭 추종(적응형). 라벨은 말줄임, 최소폭(RAIL_MIN)까지
  // 줄이면 첫 글자만(말줄임 없음). 더블클릭=프로젝트 설정(이름/색), 우클릭=닫기.
  const railAtMin = railW <= RAIL_MIN;
  const otherProjects = useOtherWindowProjects();
  const recentAll = useRecentProjects();
  // 어디에도 안 열린 최근 = 전체 최근 − 내 창 root − 타창 root.
  const openRoots = new Set([
    ...projects.map((p) => p.root),
    ...otherProjects.map((o) => o.root),
  ]);
  const recentClosed = recentAll.filter((r) => !openRoots.has(r.root));
  const projectRailList = (
    <>
      {projects.map((proj) => (
        <div
          key={proj.id}
          className={`rail-chip${proj.id === activeId ? " active" : ""}`}
          title={proj.title}
          style={
            proj.color
              ? { borderColor: proj.color, color: proj.color }
              : undefined
          }
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (projects.length > 1) void closeProjectReleased(proj.id); // P6 해제 동반
          }}
        >
          <span className="rail-chip-label">
            {railAtMin ? ([...proj.title][0] ?? "") : proj.title}
          </span>
        </div>
      ))}
      {/* 다른 창의 프로젝트(전역 레지스트리) — 전 프로젝트가 한 목록으로 나열된다(내 것
          다음, "+" 앞 — 사용자 확정 순서 s,p,+). 점선·감쇠 스타일이 구분을 담당한다.
          클릭 = 소유 창 포커스(P6: 중복 오픈 대신 이동). */}
      {otherProjects.map((o) => {
        const name = o.root.split("/").filter(Boolean).pop() ?? o.root;
        return (
          <div
            key={o.root}
            className="rail-chip other"
            data-node={`rail/other/${name}`}
            title={t("project.otherWindow", { window: o.window, root: o.root })}
            onClick={() => void invoke("window_focus", { label: o.window })}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      {/* 어디에도 안 열린 최근 프로젝트 — 레일 버튼으로 제공한다.
          클릭 = 이 창에서 열기(P6 게이트 경유). root 소실은 목록에서 자가 치유(제거). */}
      {recentClosed.map((r) => {
        const name = r.alias || (r.root.split("/").filter(Boolean).pop() ?? r.root);
        return (
          <div
            key={r.root}
            className="rail-chip recent"
            data-node={`rail/recent/${name}`}
            title={t("project.recentOpen", { root: r.root })}
            onClick={() => {
              void (async () => {
                try {
                  await validateProjectRoot(r.root);
                } catch {
                  console.warn(`최근 프로젝트 root 소실 — 목록에서 제거: ${r.root}`);
                  void removeRecentProject(r.root);
                  return;
                }
                await addProjectClaimed({ root: r.root, alias: r.alias });
              })();
            }}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        className="rail-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" size="lg" />
      </button>
    </>
  );

  return (
    <div className="app-root">
      {/* 오버레이 타이틀바: 로고(최앞단 고정) + 프로젝트 탭. 빈 영역 드래그로 창 이동. */}
      <div className="titlebar" {...dragRegion}>
        {/* 로고는 신호등(82px) 바로 뒤 고정 — 탭은 항상 로고 뒤부터 쌓인다.
            pointer-events:none 으로 창 드래그를 가로채지 않는다. */}
        <span
          className="titlebar-logo"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: logoRaw }}
        />
        {/* 빌드 정체성 배지(DEV=HMR / DEBUG=디버그 번들) — 로고 바로 뒤 고정. 프로젝트
            탭(상단 모드)은 이 뒤부터 쌓인다. 릴리스(soksak)는 배지 없음. */}
        <BuildBadge />
        {projectTabPosition === "top" ? (
          <div className="project-tabs" {...dragRegion}>
            {projectTabsList}
          </div>
        ) : (
          /* 좌측 모드: 타이틀바엔 탭 없이 드래그 영역만(탭은 좌측 레일로). */
          <div className="project-tabs" {...dragRegion} />
        )}
        <div className="titlebar-right">
          <PluginHeaderActions />
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.sidebarOpen ? " active" : ""}`}
            title={t("sidebar.toggle")}
            aria-label={t("sidebar.toggle")}
            onClick={() => activeProject && toggleSidebar(activeProject.id)}
          >
            <Icon name="panel-left" />
          </button>
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.rightOpen ? " active" : ""}`}
            title={t("plugin.sidebar.toggle")}
            aria-label={t("plugin.sidebar.toggle")}
            onClick={() =>
              activeProject && toggleRightSidebar(activeProject.id)
            }
          >
            <Icon name="panel-right" />
          </button>
          <button
            type="button"
            className="icon-btn orch-open"
            data-node="orch-open"
            title={t("orch.open")}
            aria-label={t("orch.open")}
            onClick={() => void execute("window.open", { mode: "orchestrator" }, { remote: false })}
          >
            <Icon name="browser" />
          </button>
          <button
            type="button"
            className="icon-btn theme-toggle"
            data-node="theme-toggle"
            title={isDark ? t("theme.lightPreset") : t("theme.darkPreset")}
            aria-label={t("theme.toggle")}
            onClick={toggleMode}
          >
            <Icon name={isDark ? "sun" : "moon"} />
          </button>
          <button
            type="button"
            className="icon-btn settings-toggle"
            data-node="settings-open"
            title={t("settings.open")}
            aria-label={t("settings.open")}
            onClick={() => setSettingsSection("general")}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      {settingsSection !== null && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}
      <ConsentPreviewHost />
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} />
      )}
      {projectSettingsFor && (
        <ProjectSettingsModal
          projectId={projectSettingsFor}
          onClose={() => setProjectSettingsFor(null)}
        />
      )}
      <ConfirmCloseModal />
      <RemoteConfirmModal />
      <RecoverySetupModal />
      <RecoveryEnterModal />

      {/* 본문: 좌측 모드면 세로 프로젝트 레일 + 콘텐츠 행. */}
      <div className={`app-body${projectTabPosition === "left" ? " with-rail" : ""}`}>
        {projectTabPosition === "left" && (
          <>
            <div className="project-rail" style={{ width: railW }}>
              {projectRailList}
            </div>
            <div
              className="project-rail-resizer"
              onMouseDown={startRailResize}
              title={t("sidebar.resize")}
            />
          </>
        )}
        {/* 프로젝트 0개 = 예외 상태(P6 열화·복원 드롭)뿐 — 열기·생성은 컨트롤 플레인의 표면이다.
            빈 워크스페이스 창은 생성 경로가 없으므로(window.new root 필수) 안내만 남긴다. */}
        {projects.length === 0 && (
          <div className="window-empty" data-node="window/empty">
            {t("window.empty")}
          </div>
        )}
        {/* 모든 프로젝트를 마운트해 세션 유지(비활성은 visibility 로 숨김). */}
        <div className="terminal-stack">
          {projects.map((project) => (
            <ProjectPlane
              key={project.id}
              project={project}
              isActiveProject={project.id === activeId}
              sidebarW={sidebarW}
              rightW={rightW}
              rightMode={rightSidebarMode}
              contentTabPosition={contentTabPosition}
              startResize={startResize}
              startRightResize={startRightResize}
            />
          ))}
        </div>
      </div>
      {/* 인앱 알림 배너(포커스 시) — 앱 루트 최상단 오버레이. */}
      <NotifyHost />
      {/* webview 복구 소진 배지(비차단) — 코어 webview_health 전이 구독. */}
      <WebviewHealthBadges />
      {/* 부트 위상(복원·플러그인 준비) — ready 전 은은한 진행 표시. */}
      <BootPhaseBadge />
    </div>
  );
}

export default App;
