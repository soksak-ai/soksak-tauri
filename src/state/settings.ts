import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// 앱 설정: 언어(i18n) + 크롬(탭 위치·아이콘·포커스 등). localStorage 에 영속.
// 터미널 외형(폰트/커서/스크롤백/렌더러/셸)은 코어가 소유하지 않는다 — 터미널 플러그인의
// manifest configuration 이 단일진실(중복 제거). 코어 설정은 터미널을 모른다.

export type Language = "ko" | "en";
export type TabPosition = "top" | "left";
// 분할 패널 헤더: 제목표시줄(단일 뷰) 또는 탭(여러 뷰 + +).
export type SplitHeaderMode = "title" | "tabs";
// 원격(AI/CLI/MCP) 위험 명령 정책. allow=즉시 실행, deny=차단(권한 게이트, M3).
export type DangerPolicy = "allow" | "deny";
// 포커스 영역 표시: outline=사각 아웃라인, corners=모서리 꺽쇠 4개.
export type FocusIndicator = "outline" | "corners";
// 탭 닫기 확인 정책(R6) — warn=blocking status(미저장·실행 중 등)면 확인창, off=무조건 즉시 닫기.
export type TabCloseConfirm = "warn" | "off";
// 우측 플러그인 사이드바 배치: overlay=콘텐츠 위에 뜸(기존), push=좌측 사이드바처럼 영역 차지(콘텐츠 밀어냄).
export type RightSidebarMode = "overlay" | "push";
// 좌 레일 시각 모드(§12-⑤): pane=분할창처럼(카드 틴트+elevation), ground=바닥에 눕는 평면.
export type RailLook = "pane" | "ground";
// 레일-패널 관계면 표현 3안 스위치 — 비교 실험용 임시 축(결정 시 채택안만 남기고 소거).
// stroke=스트로크+라벨(기본 — 사용자 확정), moment=결부 변경 순간만 잠깐 플래시, tint=저농도 액센트 채움만.
export type RailRelation = "tint" | "moment" | "stroke";
// 결부 패널 바탕(정식 설정) — none(기본·사용자 확정)|faint(액센트 1%).
export type RailFill = "none" | "faint";
// 교체-인접 표시(정식 설정) — edge=바깥 오른쪽 변 점선(기본·사용자 채택) | seam=내부 공유변 점선.
export type RailSeamStyle = "seam" | "edge";

interface SettingsState {
  language: Language;
  // 프로젝트(최상단) 탭 위치. left 면 사이드바 왼쪽 세로 레일.
  projectTabPosition: TabPosition;
  // 컨텐츠(워크스페이스) 탭 위치. left 면 좌측 세로 스트립(제품 계약 138px).
  contentTabPosition: TabPosition;
  // 분할 패널 헤더 모드(기본 title).
  splitHeaderMode: SplitHeaderMode;
  // 원격 위험 명령 정책: 파괴적(닫기/제거) / 주입(입력·임의 JS).
  remoteDestructive: DangerPolicy;
  remoteInject: DangerPolicy;
  // 아이콘 셋 id(내장 "lucide" + 플러그인 등록 셋). 미등록이면 lucide 폴백.
  iconSet: string;
  // 아이콘 버튼 라운드박스(보더+배경) 상시 표시 여부. off = 베어(hover 만).
  iconBox: boolean;
  // 포커스 그룹 표시 스타일(그룹 2개 이상일 때 활성 그룹에 표시).
  focusIndicator: FocusIndicator;
  // 앱 첫 오픈 시 가리킬 기본 프로젝트 루트("" = 자동 project1). 프로젝트
  // 설정의 "기본 프로젝트" 체크박스가 저장 — 부트(main.tsx)가 소비.
  defaultProjectRoot: string;
  // 탭 닫기 확인 정책(R6 — warn 기본).
  tabCloseConfirm: TabCloseConfirm;
  rightSidebarMode: RightSidebarMode;
  railLook: RailLook;
  railRelation: RailRelation;
  railFill: RailFill;
  focusDim: boolean;
  railSeamStyle: RailSeamStyle;
  /**
   * 포커스 판을 레일 옆으로 **당겨오는가**.
   *
   * 당기면 판이 오고 레일은 제자리다(인접이 만들어진 것이라 이음매가 점선). 안 당기면 판은
   * 제자리이고 레일이 그 판을 찾아간다(인접이 실재하므로 실선). 같은 목적의 두 방법이라
   * 동시에 켜면 이중으로 움직인다 — 한 축이 방법을 정한다.
   *
   * 가까운 판을 흐리는 것은 이 축이 아니다(focusDim).
   */
  railPullFocused: boolean;
  /**
   * 실선 이음매의 색 — 레일이 판을 찾아가 인접이 **실재**할 때 그리는 선(railPullFocused=false).
   *
   * "" 는 테마가 정한 색이다(비움 = 위임). 값을 넣으면 그 색이 이긴다. 테마 토큰을 덮어쓰지
   * 않고 레일 오버레이 자기 자리에만 얹는다 — 한 토큰을 둘이 쓰면 어느 쪽이 이길지 특이성이
   * 정한다.
   */
  railSolidColor: string;
  /**
   * 흐림 세기 — 0..1. 포커스가 아닌 판(dimIdle)과, 레일이 못 가 사이에 낀 판(dimBlocked).
   *
   * 두 값은 단계마다 숫자 하나라는 규칙의 사용자 손잡이다(lib/dimLevel). 칠하는 매체는 둘
   * (홀 판은 베일, DOM 판은 filter)이지만 둘 다 이 숫자만 읽는다.
   */
  dimIdle: number;
  dimBlocked: number;
  // FLOW에서 포커스 패널의 자체 왼쪽 선이 막혔을 때 같은 row 형제를 화면에서만 교환.
  // 앱 UI 폰트(=앱 크롬 전역). 터미널 폰트와 무관 — 터미널 폰트는 터미널 플러그인이 별도 소유.
  // appFontFamily → --app-font(루트 font-family), appFontSize → --app-font-size(루트 font-size).
  appFontFamily: string;
  windowZoom: number;
  // 오케스트레이터 자연어 콘솔이 스폰하는 에이전트 CLI(로그인셸 PATH 에서 해소). 기본 claude —
  // E2E 는 각본 스텁 경로를 넣어 결정적으로 검증한다(orchestrator/agent.ts).
  orchestratorAgent: string;
  // 에이전트 모델(--model). 명령 라우팅 턴은 왕복이 잦아 빠른 모델이 체감을 지배 — 기본 haiku.
  // "" = 에이전트 CLI 의 기본 모델.
  orchestratorModel: string;
  setLanguage: (l: Language) => void;
  setProjectTabPosition: (p: TabPosition) => void;
  setContentTabPosition: (p: TabPosition) => void;
  setSplitHeaderMode: (m: SplitHeaderMode) => void;
  setRemoteDestructive: (p: DangerPolicy) => void;
  setRemoteInject: (p: DangerPolicy) => void;
  setIconSet: (id: string) => void;
  setIconBox: (v: boolean) => void;
  setFocusIndicator: (v: FocusIndicator) => void;
  setDefaultProjectRoot: (root: string) => void;
  setTabCloseConfirm: (v: TabCloseConfirm) => void;
  setRightSidebarMode: (v: RightSidebarMode) => void;
  setRailLook: (v: RailLook) => void;
  setRailRelation: (v: RailRelation) => void;
  setRailFill: (v: RailFill) => void;
  setFocusDim: (v: boolean) => void;
  setRailSeamStyle: (v: RailSeamStyle) => void;
  setRailPullFocused: (v: boolean) => void;
  setRailSolidColor: (v: string) => void;
  setDimIdle: (v: number) => void;
  setDimBlocked: (v: number) => void;
  setAppFontFamily: (v: string) => void;
  setWindowZoom: (v: number) => void;
  setOrchestratorAgent: (v: string) => void;
  setOrchestratorModel: (v: string) => void;
}

const DEFAULTS = {
  language: "ko" as Language,
  projectTabPosition: "top" as TabPosition,
  contentTabPosition: "top" as TabPosition,
  splitHeaderMode: "title" as SplitHeaderMode,
  remoteDestructive: "allow" as DangerPolicy,
  remoteInject: "allow" as DangerPolicy,
  iconSet: "lucide",
  iconBox: false,
  focusIndicator: "outline" as FocusIndicator,
  defaultProjectRoot: "",
  tabCloseConfirm: "warn" as TabCloseConfirm,
  rightSidebarMode: "overlay" as RightSidebarMode,
  railLook: "ground" as RailLook,
  railRelation: "stroke" as RailRelation,
  railFill: "none" as RailFill,
  focusDim: true,
  railSeamStyle: "edge" as RailSeamStyle,
  // 기본은 당김 — "레일에 가까운 쪽에 포커스 판이 온다"는 법칙의 직접적 표현이다.
  railPullFocused: true,
  // 비움 = 테마 색. 사용자가 넣으면 그 색이 실선 이음매를 칠한다.
  railSolidColor: "",
  // 사용자 확정(2026-08-02): 포커스 아닌 판은 50%, 레일이 못 가 낀 판은 70% 가라앉는다.
  dimIdle: 0.5,
  dimBlocked: 0.7,
  appFontFamily:
    '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
  // 창 전체 줌 배율(프레임 선택 시 ⌘±) — 값 하나를 전 표면(메인+자식 웹뷰)이 공동사용.
  windowZoom: 1,
  orchestratorAgent: "claude",
  orchestratorModel: "haiku",
};

/** 0..1 로 접는다 — 숫자가 아닌 값은 0 이 아니라 거절할 자리가 따로 있다(settings.set). */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const KEY = "soksak.settings";

type PersistedSettings = typeof DEFAULTS;

/**
 * 영속 대상 필드만 추출 — load/save/applyPersisted 와 **읽기 표면**의 공유 단일진실.
 *
 * 저장되는 것은 전부 읽힌다. 값을 못 읽으면 상태를 진단할 수 없고, 진단이 안 되면 결함이
 * "재현이 안 된다"로 끝난다(실사고 2026-08-02: `railLook` 은 저장되는데 읽을 자리도 바꿀
 * 자리도 없어서, 사용자 화면의 조건이 무엇인지 물어볼 수조차 없었다).
 * 쓰기는 좁아도 된다 — 전용 명령이 자기 검증을 지는 설정이 있다. 읽기는 좁으면 안 된다.
 */
export function serialize(s: SettingsState): PersistedSettings {
  return {
    language: s.language,
    projectTabPosition: s.projectTabPosition,
    contentTabPosition: s.contentTabPosition,
    splitHeaderMode: s.splitHeaderMode,
    remoteDestructive: s.remoteDestructive,
    remoteInject: s.remoteInject,
    iconSet: s.iconSet,
    iconBox: s.iconBox,
    focusIndicator: s.focusIndicator,
    defaultProjectRoot: s.defaultProjectRoot,
    tabCloseConfirm: s.tabCloseConfirm,
    rightSidebarMode: s.rightSidebarMode,
    railLook: s.railLook,
    railRelation: s.railRelation,
    railFill: s.railFill,
    focusDim: s.focusDim,
    railSeamStyle: s.railSeamStyle,
    railPullFocused: s.railPullFocused,
    railSolidColor: s.railSolidColor,
    dimIdle: s.dimIdle,
    dimBlocked: s.dimBlocked,
    appFontFamily: s.appFontFamily,
    windowZoom: s.windowZoom,
    orchestratorAgent: s.orchestratorAgent,
    orchestratorModel: s.orchestratorModel,
  };
}

// app.data 권위 + ls 동기캐시. 부트에서 init. apply=권위 도착 시 스토어 반영(저장 없음).
const settingsSync = createCoreSync<PersistedSettings>({
  key: "settings",
  lsKey: KEY,
  fallback: DEFAULTS,
  apply: (v) => useSettings.setState({ ...DEFAULTS, ...v }),
});
export const initSettingsPersistence = (deps: CoreStoreDeps): (() => void) =>
  settingsSync.init(deps);

function load(): PersistedSettings {
  // 알 수 없는(소거된) 키는 버린다 — 예: 구 appFontSize. 죽은 축이 상태로 부활하지 않게
  // DEFAULTS 에 존재하는 키만 수용한다.
  const stored = settingsSync.loadSync() as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (k in stored) known[k] = stored[k];
  }
  return { ...DEFAULTS, ...known } as PersistedSettings;
}

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useSettings = moduleState("state/settings#store", () =>
  create<SettingsState>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveDebounced = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 300);
  };
  const save = () => {
    settingsSync.save(serialize(get()));
  };
  return {
    ...load(),
    setLanguage: (language) => {
      set({ language });
      save();
    },
    setProjectTabPosition: (projectTabPosition) => {
      set({ projectTabPosition });
      save();
    },
    setContentTabPosition: (contentTabPosition) => {
      set({ contentTabPosition });
      save();
    },
    setSplitHeaderMode: (splitHeaderMode) => {
      set({ splitHeaderMode });
      save();
    },
    setRemoteDestructive: (remoteDestructive) => {
      set({ remoteDestructive });
      save();
    },
    setRemoteInject: (remoteInject) => {
      set({ remoteInject });
      save();
    },
    setIconSet: (iconSet) => {
      set({ iconSet });
      save();
    },
    setIconBox: (iconBox) => {
      set({ iconBox });
      save();
    },
    setFocusIndicator: (focusIndicator) => {
      set({ focusIndicator });
      save();
    },
    setDefaultProjectRoot: (defaultProjectRoot) => {
      set({ defaultProjectRoot });
      save();
    },
    setTabCloseConfirm: (tabCloseConfirm) => {
      set({ tabCloseConfirm });
      save();
    },
    setRailLook: (railLook) => {
      set({ railLook });
      save();
    },
    setRailRelation: (railRelation) => {
      set({ railRelation });
      save();
    },
    setRailFill: (railFill) => {
      set({ railFill });
      save();
    },
    setFocusDim: (focusDim) => {
      set({ focusDim });
      save();
    },
    setRailSeamStyle: (railSeamStyle) => {
      set({ railSeamStyle });
      save();
    },
    setRailPullFocused: (railPullFocused) => {
      set({ railPullFocused });
      save();
    },
    setRailSolidColor: (railSolidColor) => {
      set({ railSolidColor });
      save();
    },
    // 세기는 0..1 밖으로 나갈 수 없다 — 밖으로 나가면 brightness 가 음수가 되어 화면이 뒤집힌다.
    setDimIdle: (v) => {
      set({ dimIdle: clamp01(v) });
      save();
    },
    setDimBlocked: (v) => {
      set({ dimBlocked: clamp01(v) });
      save();
    },
    setRightSidebarMode: (rightSidebarMode) => {
      set({ rightSidebarMode });
      save();
    },
    setAppFontFamily: (appFontFamily) => {
      set({ appFontFamily });
      save();
    },
    setWindowZoom: (windowZoom) => {
      // 창 줌 배율 클램프(0.5..2.0). 연타 폭풍 방지 — persist 는 디바운스(300ms).
      set({ windowZoom: Math.max(0.5, Math.min(2, windowZoom)) });
      saveDebounced();
    },
    setOrchestratorAgent: (orchestratorAgent) => {
      set({ orchestratorAgent });
      save();
    },
    setOrchestratorModel: (orchestratorModel) => {
      set({ orchestratorModel });
      save();
    },
  };
}),
);
