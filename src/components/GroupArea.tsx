import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { execute } from "../commands/registry";
import { rafThrottle } from "../lib/rafThrottle";
import {
  commitViewVisibility,
  surfaceShown,
  viewSurfaceStyle,
} from "../lib/viewPark";
import { Icon } from "../ui/icons/Icon";
import { FileViewerHost } from "./FileViewerHost";
import { GroupStatusBar } from "./GroupStatusBar";
import { PluginViewHost } from "./PluginViewHost";
import { getRegisteredView } from "../plugins/viewRegistry";
import {
  activeSessionViewId,
  transferViewFocus,
} from "../plugins/viewFocus";
import { armSlotActivation } from "../lib/slotGesture";
import { beginLayoutMotion, endLayoutMotion } from "../lib/layoutMotion";
import { createRectMotionTracker } from "../lib/layoutRectMotion";
import { useGutterHover } from "../state/gutterHover";
import { ViewTabs } from "./ViewTabs";
import { computeSplitLayout, hitTestCells } from "../lib/splitLayout";
import { gutterAddress, gutterOwnerOf } from "../lib/gutterAddress";
import { useT } from "../i18n";
import { useTheme } from "../state/theme";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import {
  type Space,
  type DropZone,
  type PaneNode,
  type Tab,
  type Pane,
  allGroups,
  useSessions,
  viewDisplayTitle,
} from "../state/sessions";
import { useHydration } from "../state/hydration";
import {
  projectRailCssRect,
  projectRailCssSpan,
  unprojectRailX,
} from "../lib/railPlacement";
import {
  moveOffsetPx,
  spanMoveAcross,
  type ArrangementMove,
} from "../lib/railArrangement";
import type { SplitTree } from "../state/splitTree";
import {
  MIN_PANE_FRAC,
  collectLineGroup,
  equalizeLineGroup,
  moveLineGroup,
  type LineMove,
} from "../state/verticalLines";

// 콘텐츠 영역을 에디터 그룹으로 렌더. 핵심 원칙 둘:
// 1) 본문(터미널/에디터)을 그룹 트리 구조와 분리해 viewId 로 키된 "영속 본문 레이어"에
//    둔다 → 분할/이동/리사이즈로 트리가 바뀌어도 remount 없음(세션·에디터 완전 보존).
// 2) 드래그는 HTML5 DnD 가 아니라 포인터(mousedown/move/up)로 한다 — Tauri 네이티브
//    파일 drag-drop 과 충돌하지 않고(그건 외부 파일 전용) 실제로 동작하며, 드롭존·
//    인디케이터를 우리가 완전히 제어한다.
//
// 각 그룹 = [타이틀바(드래그=그룹 이동)] [탭바(탭 드래그=뷰 이동)] [본문] [스테이터스바].

export type Rect = { left: number; top: number; width: number; height: number }; // %
export interface Cell {
  group: Pane;
  rect: Rect;
}
interface Gutter {
  splitId: string;
  dir: "row" | "col";
  index: number;
  rect: Rect;
  spanPct: number;
  sizes: number[];
}

// 33 = 패딩4 + 칩24 + 패딩4 + 구분선1 — 내부(32)가 짝수라 칩도 짝수가 되고,
// 칩 안의 짝수 콘텐츠(아이콘 12/14, 닫기 16)까지 정수 센터링된다(절반픽셀 불가).
// 레일(App.tsx)도 같은 행 계약을 소비한다 — pane 그리드 행 치수의 단일 소유는 이 모듈.
export const HEADER_PX = 33;
const STATUS_PX = 24; // 스테이터스바 — 제품 계약 24px
const CHROME_TOP = HEADER_PX; // 본문 상단 오프셋
const DRAG_THRESHOLD = 5; // 이 픽셀 이상 움직여야 드래그로 간주(아니면 클릭)

// paneStyle 토큰별 패널 간격(절반값 — 이웃 간 합산 10/12px, 제품 divider 실폭).
export const PANE_INSET: Record<string, number> = { flat: 0, card: 5, floating: 6 };

// 최대화 시 셀/슬롯이 차지하는 전체 rect(컨텐츠 영역 기준 %).
const FULL_RECT = { left: 0, top: 0, width: 100, height: 100 };

// 홀 판정의 단일 진실 — 뷰의 transparent 선언(레지스트리 decl) 하나. 칸(.pane.hole 밴드)과
// 본문(.tab-body.hole 배경·베일·레일 클립)이 같은 함수를 소비한다. 클래스도 하나(.hole 수정자)인
// 이유가 그것이다 — 판정 축이 하나인데 이름이 둘이면 절반이 갈라진다. 제2 기준(콘텐츠 클래스 등)
// 도입 금지 — 기준이 갈라지면 절반의 소비자가 못 보는 홀이 생긴다(PLUGIN-CONTRACT §Transparent).
function isHoleView(view: Tab | undefined | null): boolean {
  return (
    view?.kind === "plugin" &&
    !!getRegisteredView(`${view.pluginId}.${view.view}`)?.decl.transparent
  );
}

// 콘텐츠 셀 레이아웃 = 공유 머신(computeSplitLayout). leaf 값(Pane)을 cell.group 으로 매핑.
// [중복 제거] 좌측 사이드바와 동일한 레이아웃/히트테스트를 공유한다(splitLayout.ts).
export function computeLayout(node: PaneNode): {
  cells: Cell[];
  gutters: Gutter[];
} {
  const { cells, gutters } = computeSplitLayout(node);
  return {
    cells: cells.map((c) => ({ group: c.value, rect: c.rect })),
    gutters,
  };
}

const titleOf = (v: Tab | undefined): string => (v ? viewDisplayTitle(v) : "");

// divider 리사이즈 드래그 중복 시작 가드. divider 가 네이티브 child 없는 gap 위면 실제 DOM mousedown
// 과, 코어 네이티브-마우스 브릿지(App.tsx)가 재생하는 합성 mousedown 이 둘 다 도착할 수 있다 — 먼저
// 온 하나만 드래그를 소유하고 나머지는 무시(window 리스너 이중 등록 방지). 한 번에 divider 하나만 드래그.
let resizeDragActive = false;

// 디바이더 드래그 제스처 사실을 두 소비자 계층에 알린다(코어는 의미를 모름 — 사실만):
// ① 플러그인 events 채널(layout.resize-gesture) — 이 창의 뷰 제공자(브라우저 플러그인 등)가
//    드래그 중 native bounds 커밋을 유예하고 freeze-frame 을 띄우는 근거.
// ② Rust 릴레이(webview_resize_gesture) — 코어 layer 밖의 엔진 사이드카(CEF) surface 에
//    같은 사실을 통지(webview_overlay_active 의 surface-occluded 패턴과 동형).
// resizeDragActive 가드 뒤에서만 호출되므로 시작/끝이 항상 짝을 이룬다.
function emitResizeGesture(active: boolean): void {
  // 단일 진실 layoutMotion 으로 위임 — 드래그·주행·FLIP 이 겹쳐도 에지 짝이 보장된다.
  if (active) beginLayoutMotion("resize");
  else endLayoutMotion("resize");
}

// 골 안정 키(hover 강조 매칭용) = 그 골의 정본 주소. App 이 이 키로 요소 rect 를 찾아 코어에
// 넘겨 네이티브 강조바를 브라우저 위에 그린다(seam=child 물림 방식은 밀림/리플로우라 폐기).
// 키가 곧 주소인 이유: 내부 split id 를 DOM 에 새기면 이름 없는 것이 밖으로 나가고(IDENTITY §4),
// 그 값은 재시작하면 무효라 스크립트가 붙잡을 데가 없다. 정본 주소는 둘 다 아니다.

// memo 경계 = content 데이터 경계(원칙 2): content X 의 store 쓰기는 content Y 의
// 객체 정체성을 보존(mapContent)하므로 다른 컨텐츠/프로젝트의 GroupArea 는 건너뛴다.
export const GroupArea = memo(function GroupArea({
  content,
  projectId,
  surfaceActive = true,
  railStation = 0,
  displayMaximizedId = undefined,
  railWidthPx = 0,
  displayLayout: solvedLayout,
  moves,
  travel,
}: {
  content: Space;
  projectId: string;
  /** 이 스페이스(콘텐츠)가 활성인가 — 뷰 유효 가시성(스페이스 && 탭) 판정에 쓰인다. */
  // 이 그룹이 실린 표면(프로젝트+스페이스)이 지금 화면에 있는가 — 뷰 가시성의 상위 두 층.
  surfaceActive?: boolean;
  /** 활성 콘텐츠 패널 평면에 삽입되는 좌 rail의 깨끗한 논리선(0..100). */
  railStation?: number;
  /**
   * 이 렌더가 **그리는** 해의 최대화 패널 id. 생짜 상태(content.maximizedTabId)를 보지 않는다.
   *
   * station 과 rect 는 한 해가 함께 정하는데 최대화 여부만 다른 시점에서 오면 옛 선에 새
   * rect 를 얹게 되고, 그 조합은 패널이 레일을 가로지르는 모양이라 투영이 던진다. 렌더 중의
   * throw 는 화면 하나가 아니라 트리 전체를 지운다(실측 2026-07-29: 반반 분할에서 브라우저를
   * 최대화하자 노출 노드가 64 → 0, 창이 백지).
   *
   * undefined 는 "해가 말해 주지 않았다" — 그때만 상태로 물러난다(비활성 콘텐츠엔 해가 없다).
   */
  displayMaximizedId?: string | null;
  /** 고정 물리폭. 0이면 기존 연속 평면. */
  railWidthPx?: number;
  /** 해결기가 푼 표시 배열. 생략하면 정본 배열(비활성 콘텐츠). */
  displayLayout?: SplitTree<Pane>;
  /** 해가 지시한 이동량 — 위상 중에만 실린다. 여기 없는 패널은 움직이지 않는다. */
  moves?: ArrangementMove[];
  /** 위상의 두 station. 장식 span(디바이더)의 이동량은 이것에서 나온다 — moves 와 같은 위상에서
   *  같이 와야 한다(하나만 오면 셀은 활강하고 복도만 순간이동해 화면이 찢긴다). */
  travel?: { from: number; to: number };
}) {
  const t = useT();
  // 명령발 rect 변화의 JS 보간(FLIP) — 커밋마다 flush 가 이전 rect 와 비교한다(layoutRectMotion).
  const rectMotion = useRef(createRectMotionTracker()).current;
  useLayoutEffect(() => {
    rectMotion.flush();
  });
  const displayLayout = solvedLayout ?? content.layout;
  const focusProjectionApplied = displayLayout !== content.layout;
  const traveling = (moves?.length ?? 0) > 0;
  const moveOf = (groupId?: string) =>
    groupId ? moves?.find((move) => move.id === groupId) : undefined;
  // B4 — 복원 hydration cold 집합 구독(평상시 빈 집합 → 리렌더 없음).
  const coldSet = useHydration((s) => s.cold);
  // 보이는 cold 뷰는 즉시 승격(렌더 중 set 금지 — effect). shown 판정과 동일 규칙.
  useEffect(() => {
    if (coldSet.size === 0) return;
    const maximizedId2 = content.maximizedTabId ?? null;
    for (const g of allGroups(displayLayout)) {
      const visibleId = maximizedId2 ?? g.activeTabId;
      if (coldSet.has(visibleId)) useHydration.getState().promote(visibleId);
    }
  }, [coldSet, content.maximizedTabId, displayLayout]);
  // 분할 패널 헤더 = 탭 모드 고정(2026-06 결정 — 설정 비노출). title 모드 분기는
  // 재노출 대비 보존: 복원하려면 useSettings((s) => s.splitHeaderMode) 로 되돌린다.
  const splitHeaderMode = "tabs" as "title" | "tabs";
  // 구조 토큰 소비: paneStyle 에 따라 패널 간격(카드/플로팅은 실폭 디바이더).
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  // 포커스 스포트라이트 실험 — 전체를 가라앉히고 선택만 명확하게(결정 시 소거).
  const focusDim = useSettings((s) => s.focusDim);
  const inset = PANE_INSET[paneStyle] ?? 0;

  // 클릭 = 활성 + 실포커스 불변식. 상태 변경 effect 에만 의존하면 "이미 활성인
  // 그룹/pane 재클릭"이 no-op 인 채 mousedown 기본동작(비포커서블 클릭 → blur)
  // 만 남아 포커스가 body 로 풀리고, 풀린 뒤엔 그 그룹을 다시 클릭해도 복구할
  // 길이 없다(분할 직후 체감되는 "꺽쇠는 붙는데 입력이 안 가는" 사고). 그래서
  // 본문/탭/타이틀 클릭은 상태와 무관하게 항상 그 그룹의 focused pane 에 실포커스
  // 뷰 내부 포커스(터미널 등)는 플러그인 뷰가 마운트/활성 시 스스로 처리한다 — 코어는
  // 그룹 활성화만 한다(코어가 더 이상 터미널 host-div 를 소유하지 않음).
  const resizeSplits = useSessions((s) => s.resizeSplits);
  const pushOverlay = useUi((s) => s.pushOverlay);
  const popOverlay = useUi((s) => s.popOverlay);
  // 플러그인 뷰(콘텐츠 배치) 호스트에 넘길 프로젝트 루트.
  const projectRoot = useSessions(
    (s) => s.projects.find((x) => x.id === projectId)?.root ?? null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  // 합성 폭은 측정값 — 논리 이동량(% · 레일 폭 배수)을 px 로 접는 유일한 지점이다.
  // 위상 중에만 읽는다(정차 중 강제 레이아웃 금지).
  const hostWidthPx = traveling ? (containerRef.current?.offsetWidth ?? 0) : 0;
  const [drag, setDrag] = useState<{ kind: "view" | "group"; id: string } | null>(
    null,
  );
  const [hover, setHover] = useState<{ groupId: string; zone: DropZone } | null>(
    null,
  );

  const { cells, gutters } = useMemo(
    () => computeLayout(displayLayout),
    [displayLayout],
  );
  // 최대화(maximizedTabId): 한 탭이 스페이스 전체를 차지. 분할 트리는
  // 불변 — 셀/프레임만 그 그룹 하나(전체 rect)로 바꿔 그리고, 나머지 그룹의
  // 슬롯은 숨김 유지(세션 보존: 터미널/webview 마운트는 절대 깨지 않는다).
  // 강조 소유자는 이 상태 하나다(divider :hover 대체) — 셀렉터 구독(원칙 1).
  const gutterHoverKey = useGutterHover((s) => s.key);
  // 해가 말했으면 그것이 진실이다. 해가 최대화를 아직 안 그리는 동안 상태만 보고 접으면
  // 그 렌더가 옛 선에 새 rect 를 얹는다(위 prop 머리말).
  const maximizedId =
    displayMaximizedId === undefined
      ? (content.maximizedTabId ?? null)
      : displayMaximizedId === null
        ? null
        : (content.maximizedTabId ?? null);
  const maxCell = maximizedId
    ? (cells.find((c) => c.group.tabs.some((v) => v.id === maximizedId)) ??
      null)
    : null;
  const displayCells = maxCell
    ? [{ group: maxCell.group, rect: FULL_RECT }]
    : cells;
  // 드래그 콜백들이 참조 안정(useCallback)을 유지하면서 최신 cells 를 읽기 위한 ref.
  // (클로저가 cells 를 직접 캡처하면 렌더마다 새 함수 → memo 경계가 깨진다)
  // 뷰 유효 가시성(표면 활성 && 탭 활성) 커밋 — 코어 단일 소유(lib/viewPark.surfaceShown). 렌더 커밋
  // 후(effect) 실행이라 파킹 스타일이 이미 적용된 시점이고, commit 은 멱등이라 비용은 변화 시에만.
  useEffect(() => {
    for (const { group } of cells) {
      for (const v of group.tabs) {
        const tabActive = maxCell ? v.id === maximizedId : v.id === group.activeTabId;
        commitViewVisibility(v.id, surfaceShown(surfaceActive, true, tabActive));
      }
    }
  });

  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // 포인터 좌표 → 어느 셀의 어느 zone 인지. 타이틀/탭/스테이터스 영역은 center(이동),
  // 본문 가장자리 ¼ 는 해당 방향 분할.
  // r 은 드래그 시작 시 1회 캡처한 컨테이너 rect — 탭 드래그 중 레이아웃은 정적이므로
  // 틱마다 getBoundingClientRect(강제 레이아웃)를 다시 읽지 않는다(원칙 5).
  // 히트테스트 = 공유 머신(hitTestCells). 콘텐츠 헤더(HEADER_PX)·상태바(STATUS_PX) 오프셋 주입.
  const hitTest = useCallback(
    (
      clientX: number,
      clientY: number,
      r: DOMRect,
      sourceGroupId?: string,
      selfCenterOnly = true,
    ): { groupId: string; zone: DropZone } | null => {
      const physicalX = clientX - r.left;
      const logicalX = unprojectRailX(
        physicalX,
        r.width,
        railWidthPx,
        railStation,
      );
      if (logicalX === null) return null;
      const logicalRect = {
        left: r.left,
        top: r.top,
        width: Math.max(0, r.width - railWidthPx),
        height: r.height,
      } as DOMRect;
      const res = hitTestCells(
        r.left + logicalX,
        clientY,
        logicalRect,
        cellsRef.current.map((c) => ({ value: c.group, rect: c.rect })),
        (g) => g.id,
        {
          chromeTop: CHROME_TOP,
          statusPx: STATUS_PX,
          sourceId: sourceGroupId,
          selfCenterOnly,
        },
      );
      return res ? { groupId: res.id, zone: res.zone } : null;
    },
    [railStation, railWidthPx],
  );

  // 포인터 드래그 시작(타이틀바=그룹, 탭=뷰). 임계 이상 움직이면 드래그, 아니면 클릭(전환).
  // 참조 안정(useCallback) — memo 된 ViewTabs 에 내려가도 경계를 깨지 않는다.
  const startDrag = useCallback(
    (kind: "view" | "group", id: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // 탭/그룹 드래그가 에디터(.cm-content)·터미널 본문을 네이티브 선택으로 칠하지
      // 않도록 mousedown 시점에 선택을 원천 차단한다 — 이후 user-select 변경으로는
      // 이미 시작된 선택을 못 막는다(App.css .app-root 주석 참조). 클릭(탭 전환)은
      // mouseup 에서 처리하므로 영향 없다.
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const cells = cellsRef.current;
      // 드래그 출발 그룹(자기 영역 판정용): group=그 그룹, view=그 뷰가 속한 그룹.
      const sourceGroup =
        kind === "group"
          ? cells.find((c) => c.group.id === id)?.group
          : cells.find((c) => c.group.tabs.some((v) => v.id === id))?.group;
      const sourceGroupId = sourceGroup?.id;
      // 다중-뷰 그룹의 탭 드래그만 자기 영역 가장자리 분할 허용(탭 분리).
      const selfCenterOnly =
        kind === "group" || !sourceGroup || sourceGroup.tabs.length <= 1;
      let moved = false;
      let rect: DOMRect | null = null;
      // 호버 갱신은 프레임당 1회(원칙 4) + 같은 {그룹,존}이면 상태를 유지해
      // 존 경계를 넘을 때만 리렌더(없으면 mousemove 마다 서브트리 전체 리렌더).
      const updateHover = rafThrottle((x: number, y: number) => {
        const next = rect ? hitTest(x, y, rect, sourceGroupId, selfCenterOnly) : null;
        setHover((prev) =>
          prev?.groupId === next?.groupId && prev?.zone === next?.zone
            ? prev
            : next,
        );
      });
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD)
            return;
          moved = true;
          rect = containerRef.current?.getBoundingClientRect() ?? null;
          setDrag({ kind, id });
          // 드래그 = 오버레이(드롭 인디케이터가 브라우저 홀 위에도 그려진다).
          pushOverlay();
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        updateHover(ev.clientX, ev.clientY);
      };
      const onUp = (ev: MouseEvent) => {
        updateHover.cancel(); // 드롭 판정은 아래에서 직접 — 대기분은 버린다.
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          popOverlay();
          const target = rect
            ? hitTest(ev.clientX, ev.clientY, rect, sourceGroupId, selfCenterOnly)
            : null;
          if (target) {
            // 드롭 = 활성(스토어가 도착 칸을 activePaneId 로 만든다) — 활성은
            // 실포커스와 분리될 수 없다(클릭 분기와 동일 불변식). 분할 드롭은
            // 새 그룹이 생성되므로 결과의 groupId 로 포커스한다.
            if (kind === "view")
              void execute("tab.move", { tab: id, dst: target.groupId, zone: target.zone }, {});
            else void execute("pane.move", { project: projectId, src: id, dst: target.groupId, zone: target.zone }, {});
          }
        } else if (kind === "view") {
          transferViewFocus(activeSessionViewId(), id, () =>
            void execute("tab.activate", { tab: id }, {}),
          ); // 클릭 = 탭 전환 + 실포커스
        } else {
          const targetViewId = sourceGroup?.activeTabId;
          if (targetViewId) {
            transferViewFocus(activeSessionViewId(), targetViewId, () =>
              void execute("pane.activate", { pane: id }, {}),
            );
          } else {
            void execute("pane.activate", { pane: id }, {});
          }
        }
        setDrag(null);
        setHover(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      projectId,
      hitTest,
      pushOverlay,
      popOverlay,
    ],
  );

  // memo 된 ViewTabs 용 안정 콜백.
  const onTabPointerDown = useCallback(
    (viewId: string, e: React.MouseEvent) => startDrag("view", viewId)(e),
    [startDrag],
  );

  // 더블클릭 = 인접 두 영역을 반반으로(합 보존 — 다른 형제 비율 불변). row 디바이더는
  // 세로 불분할 명제를 따른다 — 균등화 목표 x 로 라인 묶음 전체가 이동(교집합 클램프)하고
  // 한 커밋(resizeSplits)으로 적용돼 라인이 찢어지지 않는다. col 은 명제 밖 — 인접쌍만.
  const onGutterDoubleClick = (d: Gutter) => () => {
    if (d.dir === "row") {
      resizeSplits(
        projectId,
        equalizeLineGroup(gutters, d.splitId, d.index).moves,
      );
      return;
    }
    // 명령을 통해 균등화한다 — 골은 이름으로 지목한다(내부 split id 는 밖으로 나가지 않는다,
    // IDENTITY §4). 렌더러는 트리를 손에 들고 있으므로 그 자리에서 이름 있는 좌표로 바꾼다.
    const owner = gutterOwnerOf(displayLayout, d.splitId, d.index, (g) => g.id);
    if (owner) {
      void execute("pane.equalize", { pane: owner.pane, edge: owner.side }, {});
    }
  };

  const onGutterDown = (d: Gutter) => (e: React.MouseEvent) => {
    e.preventDefault();
    // 착지값 — 드래그 중 마지막으로 커밋한 비율. 완결 시 이것으로 명령을 한 번 남긴다.
    let lastResizeSizes: number[] | null = null;
    if (resizeDragActive) return; // 중복 시작(DOM + 네이티브 합성) 무시.
    const cont = containerRef.current;
    if (!cont) return;
    const contRect = cont.getBoundingClientRect();
    const totalPx =
      d.dir === "row"
        ? Math.max(0, contRect.width - railWidthPx)
        : contRect.height;
    const splitPx = (totalPx * d.spanPct) / 100;
    if (splitPx <= 0) return;
    resizeDragActive = true; // 실제 드래그 개시 확정 후에만(위 early-return 은 잠그지 않음).
    emitResizeGesture(true);
    const startPos = d.dir === "row" ? e.clientX : e.clientY;
    const startSizes = [...d.sizes];
    const i = d.index;
    // 세로 불분할 명제 — row 디바이더는 드래그 시작 시 같은 x 선상의 세그먼트 전부를 한
    // 묶음으로 잡고(verticalLines 단일 소유), 내내 같은 x 로 함께 움직인다. 라인은 이동할
    // 뿐 쪼개지지 않는다. col 은 명제 밖 — 기존 인접쌍 델타 교환 그대로.
    const lineGroup =
      d.dir === "row" ? collectLineGroup(gutters, d.splitId, d.index) : [];
    const startX = d.rect.left;
    // 스토어 커밋은 프레임당 1회 상한(원칙 3·4) — mousemove 는 60Hz 를 넘는다.
    // 묶음 전체가 한 커밋(resizeSplits) — 중간 상태로도 라인이 토막나지 않는다.
    const commitResize = rafThrottle((moves: LineMove[]) =>
      resizeSplits(projectId, moves),
    );
    const onMove = (ev: MouseEvent) => {
      if (d.dir === "row") {
        const targetX = startX + ((ev.clientX - startPos) / totalPx) * 100;
        commitResize(moveLineGroup(lineGroup, targetX).moves);
        return;
      }
      let delta = (ev.clientY - startPos) / splitPx;
      delta = Math.max(
        -(startSizes[i] - MIN_PANE_FRAC),
        Math.min(startSizes[i + 1] - MIN_PANE_FRAC, delta),
      );
      const sizes = [...startSizes];
      sizes[i] = startSizes[i] + delta;
      sizes[i + 1] = startSizes[i + 1] - delta;
      lastResizeSizes = sizes;
      commitResize([{ splitId: d.splitId, sizes }]);
    };
    const onUp = () => {
      commitResize.flush(); // 리스너 제거 전에 — 마지막 프레임 유실 = 스냅백.
      // 착지 한 번만 명령으로 남긴다 — 중간값까지 명령으로 보낼 이유가 없다(매 프레임이다).
      // 그러나 완결은 사용자 의도 동작이므로 원장에 남고 CLI·AI 와 같은 경로여야 한다.
      const landed = lastResizeSizes;
      if (landed) {
        const owner = gutterOwnerOf(displayLayout, d.splitId, d.index, (g) => g.id);
        const pair = landed[d.index] + landed[d.index + 1];
        if (owner && pair > 0) {
          void execute(
            "pane.resize",
            { pane: owner.pane, edge: owner.side, ratio: landed[d.index] / pair },
            {},
          );
        }
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      resizeDragActive = false;
      // flush(최종 레이아웃 커밋) 뒤에 종료를 알린다 — 구독자(브라우저 provider)는
      // 이 시점의 슬롯 rect 를 최종값으로 신뢰하고 bounds 를 1회 커밋한다.
      emitResizeGesture(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = d.dir === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const hoverCell = hover && cells.find((c) => c.group.id === hover.groupId);

  // 내부 좌표(splitId·index) → 정본 골 주소. 트리를 손에 든 이 자리에서만 변환하고, DOM 에는
  // 이름 있는 좌표만 새긴다. 해소 못 하면(트리와 divider 목록이 한 프레임 어긋난 순간) 주소를
  // 짓지 않는다 — 틀린 주소가 없는 주소보다 나쁘다.
  const gutterKey = (d: Gutter): string | undefined => {
    const owner = gutterOwnerOf(displayLayout, d.splitId, d.index, (g) => g.id);
    return owner ? gutterAddress(owner.pane, owner.side) : undefined;
  };

  // 셀 좌표 — CSS 변수 4개만 전달하고 산수(calc)는 CSS 단일 규칙이 소유한다.
  // (좌표 문자열을 렌더마다 조립해 흩뿌리던 레거시 제거 — 치수 상수는 아래
  // 컨테이너에서 1회 주입되는 --header-h/--status-h/--pane-inset 이 단일 소스)
  // 실이동 판정 — 해가 이동을 지시한 패널만 애니메이션 대상이다. 위상 하위 전체 선택자는
  // 델타 0 인 요소까지 animation + will-change 로 합성 레이어에 올렸다 내려 위상마다 재래스터를
  // 일으켰고, 그 재래스터가 DOM(주소표시줄 포함)의 "움찔"로 보였다(실사고).
  const flipMoves = (groupId?: string): boolean => !!moveOf(groupId);

  /** 이동량 → 시작 오프셋(px). 합성은 여기 한 곳뿐이다(두 축을 각자 보간하면 어긋난다).
   *  컨테이너 폭 실측이 아직 없으면(위상 중 첫 마운트) 배열 교환 항을 접을 수 없다 — 절반만
   *  적용하면 엉뚱한 방향으로 미끄러지므로 그 위상은 활강하지 않는다(스냅). */
  const flipOffsetPx = (groupId?: string): number => {
    const move = moveOf(groupId);
    if (!move) return 0;
    if (hostWidthPx <= 0 && Math.abs(move.dLeftPct) > 0.05) return 0;
    return moveOffsetPx(move, hostWidthPx, railWidthPx);
  };

  const cellVars = (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }, groupId?: string) => {
    const projected =
      railWidthPx > 0
        ? projectRailCssRect(rect, railStation)
        : { railLeft: 0, railWidth: 0 };
    return ({
      "--l": `${rect.left}%`,
      "--t": `${rect.top}%`,
      "--w": `${rect.width}%`,
      "--h": `${rect.height}%`,
      "--rail-dx": `${projected.railLeft * railWidthPx}px`,
      "--rail-dw": `${projected.railWidth * railWidthPx}px`,
      "--flip-x": `${flipOffsetPx(groupId)}px`,
    }) as React.CSSProperties;
  };

  // 장식 span(디바이더·드롭 표시)은 패널이 아니라 복도의 일부다 — 이동량의 유일한 원천은
  // 삽입 지점 변화이고, 해결기의 같은 사상(spanMoveAcross)이 그것을 소유한다.
  const spanFlipPx = (rect: Rect): number =>
    travel
      ? moveOffsetPx(
          spanMoveAcross(rect, travel.from, travel.to),
          hostWidthPx,
          railWidthPx,
        )
      : 0;
  const spanMovesPx = (rect: Rect): boolean => Math.abs(spanFlipPx(rect)) > 0.5;
  const gutterVars = (d: Gutter) => {
    if (railWidthPx <= 0) return {};
    if (d.dir === "row") {
      const after = d.rect.left > railStation ? 1 : 0;
      return {
        "--rail-dx": `${(after - d.rect.left / 100) * railWidthPx}px`,
        "--flip-x": `${spanFlipPx(d.rect)}px`,
      } as React.CSSProperties;
    }
    const projected = projectRailCssSpan(d.rect, railStation);
    return {
      "--rail-dx": `${projected.railLeft * railWidthPx}px`,
      "--rail-dw": `${projected.railWidth * railWidthPx}px`,
      "--flip-x": `${spanFlipPx(d.rect)}px`,
    } as React.CSSProperties;
  };

  return (
    <div
      className="space"
      data-focus-dim={focusDim ? "1" : undefined}
      data-node={`layout/space/${content.id}`}
      data-projection={
        content.maximizedTabId
          ? "maximized"
          : focusProjectionApplied
            ? "switched"
            : "canonical"
      }
      data-focused-pane={content.activePaneId}
      data-maximized-tab={content.maximizedTabId ?? ""}
      data-traveling={traveling ? "true" : "false"}
      ref={containerRef}
      style={
        {
          "--pane-inset": `${inset}px`,
          "--header-h": `${HEADER_PX}px`,
          "--status-h": `${STATUS_PX}px`,
        } as React.CSSProperties
      }
    >
      {/* ── 그룹 셀: 유일한 위치 지정 레이어(카드 배경/라운드 소유). 내부는
          flex column 정상 흐름 — [헤더][본문 공간][상태바]. 헤더/상태바 좌표
          산수는 존재하지 않는다. 본문 공간은 비워두고 영속 슬롯이 그 위에 뜬다. */}
      {displayCells.map(({ group, rect }) => {
        const isActiveGroup = group.id === content.activePaneId;
        const active = group.tabs.find((v) => v.id === group.activeTabId);
        // 홀 셀(레이어 원칙): 활성 뷰 아래 네이티브 레이어(임베드 webview)가 비쳐야 하면 본문 영역에
        // 배경을 칠하면 안 된다 — CSS 가 헤더/상태바 밴드만 칠하도록 클래스로 표시. 데이터 주도:
        // transparent 선언 플러그인 콘텐츠 뷰(예: 브라우저 플러그인)만 홀로 처리(코어 하드 체크 없음).
        const holeCell = isHoleView(active);
        return (
          <div
            key={`cell-${group.id}`}
            className={`pane${holeCell ? " hole" : ""}${
              group.id === content.activePaneId ? " spot-clear" : ""
            }${flipMoves(group.id) ? " flip-move" : ""}`}
            data-node={`layout/pane/${group.id}`}
            style={cellVars(rect, group.id)}
            ref={rectMotion.ref}
          >
            {maxCell ? (
              /* 최대화 헤더: 탭·+ 대신 타이틀 — 더블클릭/버튼으로 원래 분할 복원 */
              <div
                className="pane-title active"
                title={t("view.restoreHint")}
                onDoubleClick={() => void execute("tab.restore", { project: projectId }, {})}
              >
                <span className="pane-title-icon icon-inline">
                  {active?.kind === "file" ? (
                    <Icon name="file" size="sm" />
                  ) : (
                    <Icon name="plugin" size="sm" />
                  )}
                </span>
                <span className="pane-title-name">
                  {titleOf(active)}
                </span>
                <button
                  type="button"
                  className="icon-btn pane-title-btn"
                  title={t("view.restore")}
                  onClick={() => void execute("tab.restore", { project: projectId }, {})}
                >
                  <Icon name="minus" size="sm" />
                </button>
              </div>
            ) : splitHeaderMode === "tabs" ? (
              /* 탭 모드: 탭바(탭 드래그=뷰 이동, +=새 탭) */
              <div className="pane-tabs">
                <ViewTabs
                  projectId={projectId}
                  group={group}
                  onTabPointerDown={onTabPointerDown}
                />
              </div>
            ) : (
              /* title 모드(현재 비노출 — 재노출 대비 보존): 바 전체=그룹 드래그 핸들 */
              <div
                className={`pane-title${isActiveGroup ? " active" : ""}`}
                title={t("panel.move")}
                onMouseDown={startDrag("group", group.id)}
              >
                <span className="pane-title-icon icon-inline">
                  {active?.kind === "file" ? (
                    <Icon name="file" size="sm" />
                  ) : (
                    <Icon name="plugin" size="sm" />
                  )}
                </span>
                <span className="pane-title-name">
                  {titleOf(active)}
                </span>
                <button
                  type="button"
                  className="icon-btn pane-title-btn"
                  title={t("panel.split")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void execute("pane.split", { project: projectId, pane: group.id, side: "right" }, {})}
                >
                  <Icon name="split" size="sm" />
                </button>
                <button
                  type="button"
                  className="icon-btn pane-title-btn"
                  title={t("view.close")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => group.activeTabId && void execute("tab.close", { tab: group.activeTabId }, {})}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            )}
            <div className="pane-body" />
            <div className="pane-status-wrap">
              <GroupStatusBar group={group} />
            </div>
          </div>
        );
      })}

      {/* ── 전경 프레임: 카드 보더(1px)를 모든 것 위에(불투명 터미널 포함) 보장.
          슬롯 레이어가 셀 보더를 덮기 때문에 보더만 분리해 띄운다(pointer-events
          none). 좌표는 셀과 동일한 변수 — 산수는 CSS 규칙이 소유.
          focus = 활성 그룹 표시(단일 그룹 포함 항상 — 사용자 결정).
          구조 경계선(--bd, §B 계약)은 불변 — 강조는 outline/배경(--acc, §B4)으로만.
          꺽쇠는 프레임 모서리 = 헤더/스테이터스 밴드 구간이라 네이티브 webview
          (본문 슬롯만 차지)에 가려지지 않는다. ── */}
      {displayCells.map(({ group, rect }) => (
        <div
          key={`frame-${group.id}`}
          className={`pane-border${
            group.id === content.activePaneId ? " focus" : ""
          }${flipMoves(group.id) ? " flip-move" : ""}`}
          style={cellVars(rect, group.id)}
          ref={rectMotion.ref}
        />
      ))}

      {/* ── 영속 본문 레이어: viewId 키 → 이동해도 remount 없음. 이 레이어만이
          위치 지정의 정당한 사유를 가진다(그룹 간 이동에도 CodeMirror/터미널
          세션 보존). 본문 영역 좌표는 CSS 규칙(셀 변수 + 치수 변수)이 계산. ── */}
      {cells.flatMap(({ group, rect }) =>
        group.tabs.map((view) => {
          // 최대화 중엔 최대화 뷰만 보인다(전체 rect) — 나머지는 숨김 유지.
          const shown = maxCell
            ? view.id === maximizedId
            : view.id === group.activeTabId;
          const slotRect = maxCell && shown ? FULL_RECT : rect;
          // B4 복원 hydration 게이트 — cold(복원됐지만 아직 안 보인) 뷰는 본문 마운트를
          // 미룬다(PTY 동시 spawn 분산). 보이는 순간·idle 체인이 승격한다. 평상시 cold 는
          // 빈 집합이라 게이트 비용 0. 슬롯 div 자체는 항상 렌더(원자적 외형·주소 안정).
          const hydrated = !coldSet.has(view.id) || shown;
          return (
            <div
              key={view.id}
              // .hole: 본문은 칸의 자식이 아니라 영속 레이어의 형제라서, 홀 표시는
              // 셀렉터 조합(.pane.hole 하위)이 아니라 본문 자신의 클래스여야 한다.
              // 기준은 셀과 동일한 단일 선언 축(isHoleView) — 홀 배경·베일·레일 클립이
              // 전부 이 클래스 하나를 본다.
              className={`tab-body${isHoleView(view) ? " hole" : ""}${
                group.id === content.activePaneId ? " spot-clear" : ""
              }${shown && flipMoves(group.id) ? " flip-move" : ""}`}
              // 네이티브 클릭 판정용(App.tsx native-mousedown → elementFromPoint).
              // 값은 이 슬롯이 사는 칸(pane)의 id — 이름과 값이 같은 실체를 가리킨다(IDENTITY).
              data-pane={group.id}
              data-project-id={projectId}
              data-node={`layout/tab/${view.id}`}
              ref={shown ? rectMotion.ref : undefined}
              // 평상시 비활성 슬롯은 화면 밖으로 파킹하고, 최대화의 제외 슬롯은 합성 트리에서도
              // 제거한다(viewSurfaceStyle 단일 진실). 둘 다 DOM/플러그인 인스턴스는 유지한다.
              style={{
                ...cellVars(slotRect, group.id),
                ...viewSurfaceStyle(shown, !!maxCell),
              }}
              onMouseDownCapture={() => {
                // 클릭 확인 후 이동(§12-④ 개정) — 활성화와 그에 따르는 투영 주행은 게스처
                // 완결(mouseup) 뒤에 시작한다. 게스처 전 구간이 정지한 기하 위에서 끝나므로
                // 클릭(페인 추적·xterm 자기 포커스)은 항상 확인되고, 활성화는 시작 슬롯에
                // 귀속된다(straddle 불능).
                armSlotActivation(() => {
                  if (group.activeTabId) {
                    transferViewFocus(
                      activeSessionViewId(),
                      group.activeTabId,
                      () => void execute("pane.activate", { pane: group.id }, {}),
                    );
                  } else {
                    void execute("pane.activate", { pane: group.id }, {});
                  }
                });
              }}
            >
              {!hydrated ? null : view.kind === "file" ? (
                <FileViewerHost
                  path={view.path}
                  projectId={projectId}
                  root={projectRoot}
                  viewId={view.id}
                />
              ) : (
                <PluginViewHost
                  viewKey={`${view.pluginId}.${view.view}`}
                  viewId={view.id}
                  projectId={projectId}
                  root={projectRoot}
                  region="content"
                  command={view.command ?? null}
                  // B3 복원 seam — 관찰됐던 런타임(cwd·플러그인 state). 터미널은 spawn 위치,
                  // 브라우저류는 state(URL 등) 복원. 관찰값이 하나도 없으면 null(새 뷰).
                  restore={
                    view.cwd || view.state !== undefined
                      ? { cwd: view.cwd ?? null, state: view.state ?? null }
                      : null
                  }
                />
              )}
            </div>
          );
        }),
      )}

      {/* ── 리사이저(분할 경계 — 위치 지정이 본질인 요소). 최대화 중엔 경계 없음 ── */}
      {!maxCell &&
        gutters.map((d) => (
        <div
          key={`gutter-${d.splitId}-${d.index}`}
          data-gutter-key={gutterKey(d)}
          data-node={gutterKey(d)}
          // 강조는 CSS :hover 가 아니라 우리가 소유한 상태에서 온다. :hover 는 포인터가
          // 네이티브 자식(브라우저 표면)으로 빠져나갈 때 leave 이벤트를 못 받아 그대로
          // 붙들리고, 그러면 accent 세로선이 창 본문 전체 높이로 브라우저를 가로지른 채
          // 남는다(실측 2026-07-26). 게다가 :hover 는 스크립트로 켜거나 끌 수 없어 구동도
          // 검증도 불가능하다 — 소유권을 상태로 옮겨야 두 문제가 함께 풀린다.
          data-hover={gutterHoverKey === gutterKey(d) ? "1" : undefined}
          className={`pane-gutter ${d.dir}${spanMovesPx(d.rect) ? " flip-move" : ""}`}
          onPointerEnter={() => useGutterHover.getState().set(gutterKey(d) ?? null)}
          onPointerLeave={() => useGutterHover.getState().set(null)}
          style={
            d.dir === "row"
              ? {
                  left: `calc(${d.rect.left}% + var(--rail-dx, 0px))`,
                  top: `${d.rect.top}%`,
                  height: `${d.rect.height}%`,
                  ...gutterVars(d),
                }
              : {
                  left: `calc(${d.rect.left}% + var(--rail-dx, 0px))`,
                  top: `${d.rect.top}%`,
                  width: `calc(${d.rect.width}% + var(--rail-dw, 0px))`,
                  ...gutterVars(d),
                }
          }
          onMouseDown={onGutterDown(d)}
          onDoubleClick={onGutterDoubleClick(d)}
          title={t("divider.equalize")}
        />
      ))}

      {/* ── 드롭 인디케이터(드래그 중, 시각용) — 본문 영역 좌표는 CSS 규칙 소유 ── */}
      {drag && hover && hoverCell && (
        <div
          className={`drop-ind-wrap${flipMoves(hoverCell.group.id) ? " flip-move" : ""}`}
          style={cellVars(hoverCell.rect, hoverCell.group.id)}
        >
          <div className={`drop-ind ${hover.zone}`} />
        </div>
      )}
    </div>
  );
});
