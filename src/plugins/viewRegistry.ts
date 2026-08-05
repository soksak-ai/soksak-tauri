// 뷰 레지스트리 — 플러그인 뷰 provider 의 단일 저장소.
// 뷰 구현과 배치는 직교(§0-6): 우측/좌측 사이드바·콘텐츠 영역 모두 여기 등록된
// 동일한 provider 를 PluginViewHost 로 소비한다. version 은 UI 재구성 신호.

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { qualifiedViewId, type ContributedView } from "./spec";

export interface PluginViewContext {
  projectId: string;
  root: string | null;
  // 이 뷰가 추종/연관하는 터미널 pane(cwd 추종 대상). 사이드바=cwdTabOf(활성 그룹의 포커스 터미널),
  // 그 외 배치=null. app.terminal.getCwd/onCwd 와 함께 cwd 추종에 쓴다(계약 A13/S7). 없으면 null.
  paneId: string | null;
  // 콘텐츠 배치 뷰의 sessions view.id(이 뷰 인스턴스의 안정 키 — 예: app.webview.label(viewId) 로
  // 인스턴스별 webview 라벨 생성). 사이드바 배치는 null.
  viewId: string | null;
  // 레일 투영 마운트 전용(§4.4-lite): 이 사이드바 인스턴스가 섬기는 결부 콘텐츠 뷰의 id.
  // per-view 인스턴스가 자기 문서/스토어를 정확히 연결하는 채널. 그 외 배치 = null.
  boundViewId: string | null;
  // 이 뷰가 마운트 시 1회 자동 실행할 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 실행).
  // 프로그램 선언(ContributedProgram.command)이 source. 뷰 종류 무관 채널 — 자동 실행 여부는
  // 뷰 구현이 결정한다(터미널 뷰만 PTY 로 실행). 명령 없으면 null.
  command: string | null;
  // 복원 seam(B3) — 이 마운트가 재시작 복원이면 관찰됐던 런타임(cwd·state)을 싣는다.
  // 터미널 뷰는 restore.cwd 에서 spawn(마지막 작업 위치 복원). state 는 setRestoreState 로
  // 기록했던 플러그인 관찰 상태(예: 브라우저 URL). 새로 연 뷰는 null — 잔재 유입이 구조적으로 불가.
  restore: { cwd: string | null; state: unknown } | null;
  // 코어가 소유하는 현재 유효 가시성. 비활성 슬롯도 레이아웃 보존을 위해 같은 rect 를
  // 유지할 수 있으므로 DOM 기하/IntersectionObserver 로 이 값을 추측하면 안 된다.
  isVisible: () => boolean;
  // mount 뒤 가시성 변화 구독. 최초 상태는 isVisible()로 읽고 이후 변화만 여기서 받는다.
  onVisibilityChange: (listener: (visible: boolean) => void) => () => void;
  // 이 뷰의 사이드바 탭 배지(읽지않음 표시). number=카운트, "dot"=점, null=해제.
  // 창마다 자체 store라 per-window(그 창의 활성 프로젝트 기준). 데이터는 app.data.watch 로 재계산.
  setBadge: (badge: number | "dot" | null) => void;
  // 이 뷰의 status 보고(R1) — sessions view.status 로. null=회수. 콘텐츠 배치 뷰만 유효(close guard).
  setStatus: (status: { code: string; message?: string } | null) => void;
  // 이 뷰의 탭 제목 동적 갱신(콘텐츠 배치만 — 예: 브라우저 페이지 <title>). 빈 값 무시. 사이드바=no-op.
  setTitle: (title: string) => void;
  // 이 뷰의 탭 아이콘 갱신(콘텐츠 배치만 — 예: 브라우저 파비콘 URL). 빈 값 = 해제(매니페스트
  // 아이콘 폴백). title 과 동형의 콘텐츠 사실 채널. 사이드바=no-op.
  setIcon: (icon: string) => void;
  // 플러그인 관찰 런타임 상태 보고(B3) — 뷰 레코드에 영속, 복원 마운트의 restore.state 로 돌아온다.
  // 플러그인 kv 에 viewId 키로 영속하지 마라(viewId 재사용 충돌 — 죽은 뷰의 잔재가 새 뷰에 유입).
  // JSON 직렬화 가능 값만. 콘텐츠 배치만 유효, 사이드바=no-op.
  setRestoreState: (state: unknown) => void;
}

export type ViewBadge = number | "dot" | null;

export interface PluginViewFocusRequest {
  /** A newer focus intent or unmount aborts this signal. Deferred focus must honor it. */
  signal: AbortSignal;
}

// 플러그인이 구현하는 뷰. React 비요구 — 컨테이너 DOM 에 직접 그린다.
export interface PluginViewProvider {
  // 뷰 인스턴스의 제품 수명. 명령 대상·상태처럼 DOM 노드와 무관한 소유권은 여기서
  // 등록한다. 프레임워크가 별도 renderer에서 DOM을 그려도 같은 인스턴스 계약을 쓴다.
  // 반환 cleanup은 mount/unmount 수명이 끝난 뒤 호출된다.
  connect?(ctx: PluginViewContext): void | (() => void);
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
  // 현재 활성-chain이 이 뷰를 가리키는지 알린다. 입력 실행 focus()와 별개이므로, 이미
  // descendant가 DOM focus를 가진 경우에도 반드시 전달된다.
  setFocused?(container: HTMLElement, ctx: PluginViewContext, focused: boolean): void;
  // 다른 뷰로 떠나기 전 동기 경계. 조합/프리에딧 등 유실 가능한 일시 입력을 확정하되,
  // 자기 container 밖 DOM 을 조회하거나 포커스하지 않는다.
  prepareFocusTransfer?(container: HTMLElement, ctx: PluginViewContext): void;
  // 줌 인텐트(선택 표면 — PLUGIN-CONTRACT §Zoom). 뷰가 자기 관례로 응답한다:
  // 터미널=폰트 스텝, 브라우저=페이지 줌, 에디터=본문 폰트. 행 그리드(헤더·툴바 밴드)에는
  // 절대 손대지 않는다(줌 불변식). 미구현이면 코어가 무시한다(생략 가능 규약).
  zoom?(
    container: HTMLElement,
    ctx: PluginViewContext,
    action: "in" | "out" | "reset",
  ): void;
  // 코어의 최신 포커스 의도를 자기 canonical input 으로 시행한다. 비동기 준비가 필요하면
  // request.signal 을 보존하고, aborted 뒤에는 절대 포커스하지 않는다.
  focus?(
    container: HTMLElement,
    ctx: PluginViewContext,
    request: PluginViewFocusRequest,
  ): void;
  // 라이브 갱신 — **결부(binding 축) 가 바뀔 때** 호스트가 remount 대신 이걸 불러 같은 인스턴스에
  // 새 ctx 를 전달한다. 축의 단일 진실은 viewContext 의 VIEW_CONTEXT_AXIS 다(여기 필드 이름을
  // 나열하지 마라 — 나열은 계약과 갈리고, 갈린 목록은 조용하다).
  //
  // 구현 의무는 하나다: **받은 ctx 로 다시 그린다.** 일부 필드만 반영하는 구현은 계약 위반이다 —
  // 호스트는 어느 필드가 바뀌었는지 알려 주지 않고, 알려 주기 시작하면 그 자체가 손목록이 된다.
  //
  // 구현하면 결부 전환에 뷰가 통째 재생성되지 않는다(파일트리 canvas 재구축 ~36ms, 펼친 폴더
  // 유실 없음). 구현하지 않으면 호스트가 결부 변경에 remount 한다 — 통보 수단이 없는 provider 에게
  // 남은 정직한 길이다: 남의 결부 데이터를 계속 그리는 것보다 구조 상태를 잃는 편이 옳다.
  update?(container: HTMLElement, ctx: PluginViewContext): void;
}

export interface PluginViewPresentationRuntime {
  source: string;
  pluginId: string;
  app: () => unknown;
}

const presentationRuntimes = moduleState(
  "plugins/viewRegistry#presentationRuntimes",
  () => new WeakMap<PluginViewProvider, PluginViewPresentationRuntime>(),
);

/** 로더만 쓰는 실행 재료 부착. provider 공개 객체를 변형하지 않아 플러그인이 위조할 필드가 없다. */
export function attachViewPresentationRuntime(
  provider: PluginViewProvider,
  runtime: PluginViewPresentationRuntime,
): PluginViewProvider {
  presentationRuntimes.set(provider, runtime);
  return provider;
}

export function viewPresentationRuntime(
  provider: PluginViewProvider,
): PluginViewPresentationRuntime | null {
  return presentationRuntimes.get(provider) ?? null;
}

export interface RegisteredView {
  pluginId: string;
  decl: ContributedView; // 매니페스트 선언(제목/아이콘/배치) — 표시 정보의 단일진실
  provider: PluginViewProvider;
}

interface ViewRegistryState {
  views: Record<string, RegisteredView>; // key = "<pluginId>.<viewId>"
  version: number; // 등록/해제마다 증가 — 소비자(UI) 재구성 신호
  // 뷰별 배지(읽지않음 표시). version 과 분리 — 배지 변경이 뷰를 remount 시키지 않도록(독립 구독).
  badges: Record<string, ViewBadge>;
  register: (
    pluginId: string,
    decl: ContributedView,
    provider: PluginViewProvider,
  ) => () => void;
  setViewBadge: (key: string, badge: ViewBadge) => void;
}

// 등록부는 모듈 경계 밖에 산다 — 갈아끼우기가 이 store 를 갈면 등록된 뷰가 통째로 사라지고,
// 플러그인은 이미 활성이라 다시 등록하지 않는다. 그 소실은 "탭의 + 가 아무것도 안 준다"로만
// 보인다(+ 메뉴는 등록 프로그램에서 온다).
export const useViewRegistry = moduleState("plugins/viewRegistry#store", () =>
  create<ViewRegistryState>((set, get) => ({
  views: {},
  version: 0,
  badges: {},

  register: (pluginId, decl, provider) => {
    const key = qualifiedViewId(pluginId, decl.id);
    if (get().views[key]) {
      // §0-3 침묵 실패 금지 — 중복 등록은 버그(해제 없이 재활성화).
      throw new Error(`이미 등록된 뷰: ${key}`);
    }
    set((s) => ({
      views: { ...s.views, [key]: { pluginId, decl, provider } },
      version: s.version + 1,
    }));
    return () => {
      set((s) => {
        if (!s.views[key]) return s; // 이미 해제됨 — 멱등
        const views = { ...s.views };
        delete views[key];
        const badges = { ...s.badges };
        delete badges[key]; // 뷰 해제 시 배지도 정리
        return { views, badges, version: s.version + 1 };
      });
    };
  },

  // 배지 설정 — version 미증가(뷰 remount 방지). 동일값이면 no-op(불필요 렌더 차단).
  setViewBadge: (key, badge) =>
    set((s) => {
      const cur = s.badges[key] ?? null;
      const next = badge === 0 ? null : badge; // 0 = 없음으로 정규화
      if (cur === next) return s;
      const badges = { ...s.badges };
      if (next == null) delete badges[key];
      else badges[key] = next;
      return { badges };
    }),
})),
);

// 배치별 뷰 목록(아이콘 레일/탭 스트립용) — 등록 순서 유지.
export function viewsForPlacement(
  placement: import("./spec").ViewPlacement,
): { key: string; view: RegisteredView }[] {
  const { views } = useViewRegistry.getState();
  return Object.entries(views)
    .filter(([, v]) => v.decl.placements.includes(placement))
    .map(([key, view]) => ({ key, view }));
}

export function getRegisteredView(key: string): RegisteredView | null {
  return useViewRegistry.getState().views[key] ?? null;
}

// 이 플러그인이 실제 등록한 view id(declared≡actual 의 actual). 등록 순서(Object 삽입순) 보존.
export function registeredViewIds(pluginId: string): string[] {
  return Object.values(useViewRegistry.getState().views)
    .filter((v) => v.pluginId === pluginId)
    .map((v) => v.decl.id);
}
