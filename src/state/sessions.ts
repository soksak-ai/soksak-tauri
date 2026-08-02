import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { issueId } from "./ids";
import { noteActivation } from "../lib/motionDebug";
import {
  DEFAULT_RAIL_PLACEMENT,
  isCleanRailStation,
  type RailPlacement,
} from "../lib/railPlacement";
import { useSettings } from "./settings";
import {
  solveArrangement,
  type Arrangement,
} from "../lib/railArrangement";
import {
  autorunCommandOf,
  getRegisteredProgram,
} from "../plugins/programRegistry";
import { resolveContractImplementer } from "../plugins/contractResolve";
import { localize, tmsg } from "../i18n";
import {
  type SplitTree,
  splitLeaf,
  insertBeside,
  removeLeaf,
  leavesOf,
  resizeSplitTree,
  findSplitTree,
  mapLeaves,
} from "./splitTree";
import {
  type SidebarLayout,
  type SidebarDrop,
  initialSidebarLayout,
  reconcileSidebarLayout,
  moveSidebarView as moveSidebarViewT,
  hasSidebarView,
} from "./sidebarLayout";
import { browserViewIdFromLabel } from "../lib/webviewLabels";
import { useProjection } from "./projection";

// 3단 구조:
//   - 최상단 = 프로젝트(Project): 자체 사이드바(파일트리) + 스페이스들
//   - 스페이스(Space) = 배치 트리(PaneNode): 좌/우/상/하 재귀 분할.
//       각 leaf = 칸(Pane — 자체 헤더 + 활성 탭). 드래그/명령으로 분할·이동·병합.
//   - 탭(Tab) = 파일(뷰어 플러그인) / 플러그인(터미널·브라우저·에디터 등 — 코어는 터미널 비소유).
// 비활성 프로젝트/스페이스/탭은 언마운트하지 않고 숨겨 세션(PTY/에디터/웹뷰)을 유지한다.
//
// 설계 원칙(AI 명령 인터페이스의 기초):
//   - 모든 변이 액션은 CmdResult 를 반환한다 — 생성된 id/변경 후 상태(검증 가능).
//   - 조용한 실패 금지 — 수행 불가는 구조화 에러({code, message}).
//   - 대상 지정은 활성 스페이스 한정이 아니라 프로젝트 전체에서 검색(임의 위치 타기팅).
//   - 요청 의도가 이미 충족된 상태면 idempotent 성공(ok)으로 처리.

// ── 결과 타입 ────────────────────────────────────────────────────────────────

export type CmdErrCode =
  | "TARGET_NOT_FOUND"
  | "LAST_ITEM"
  | "INVALID_PARAMS"
  // 요청 자체는 유효하지만 고정된 레일 선을 패널이 가로지르게 되는 레이아웃 변경.
  | "LAYOUT_CONFLICT"
  // 요청은 유효하지만 영속 상태/OS 경계가 실패했다. INVALID_PARAMS로 원인을 위장하지 않는다.
  | "INTERNAL"
  // 플러그인 활성화에 사용자 동의가 필요(원격 enable 거부 — 플러그인 스펙 §0-5).
  | "CONSENT_REQUIRED"
  // 플러그인 삭제가 의존자 cascade 를 유발 — 동의(cascade:true) 없이는 차단(고아 방지).
  | "CASCADE_REQUIRED"
  // DOM 주소가 노출 노드(data-node)에 없음 — 임의 selector 추측 금지, 노출된 것만 접근(ui.tree).
  | "NOT_EXPOSED"
  // 한 주소가 둘 이상으로 풀림(주소 공리 A1 위반) — 어느 하나를 고르지 않는다. 주소를 만드는
  // 쪽의 결함이므로 호출자가 인스턴스 축(inst)으로 좁히거나, 마운트가 인스턴스를 실어야 한다.
  | "AMBIGUOUS";

// data = 코드별 부가 정보(선택). 예: CONSENT_REQUIRED 의 미동의 체인(연속 동의 팝업용).
export type CmdErr = { ok: false; code: CmdErrCode; message: string; data?: unknown };
export type CmdOk<T extends object = object> = { ok: true } & T;
export type CmdResult<T extends object = object> = CmdOk<T> | CmdErr;

export const ok = <T extends object>(data: T): CmdOk<T> => ({
  ok: true,
  ...data,
});
export const err = (code: CmdErrCode, message: string, data?: unknown): CmdErr => ({
  ok: false,
  code,
  message,
  ...(data !== undefined ? { data } : {}),
});

// ── 모델 타입 ────────────────────────────────────────────────────────────────

// 뷰가 코어에 상시 보고하는 상태(R1) — code=기계 식별자, message=사람 표시.
// blocking code(STATUS_BLOCKING)는 닫기 가드를 발동(R2). 회수는 뷰 종속(R4) — 뷰 삭제=status 삭제.
export interface TabStatus {
  code: string;
  message?: string;
}

// 콘텐츠 뷰: 파일(뷰어 플러그인), 플러그인(콘텐츠 배치 — 터미널·브라우저·에디터 전부 여기).
// 코어는 터미널 뷰를 소유하지 않는다(터미널도 플러그인 뷰).
// title 은 콘텐츠 사실(파일명·페이지 <title> — setViewTitle 로 계속 갱신), customLabel 은
// 사용자 의도(view.rename). 표시는 customLabel 우선 — 사이드바 viewLabels 와 동일 규칙
// (기본=사실, 오버라이드=사용자 의도만 담는다). 빈 오버라이드는 저장하지 않는다.
export type Tab =
  | {
      id: string;
      kind: "file";
      title: string;
      customLabel?: string;
      path: string; // 절대 경로
      mode: "code" | "preview";
      // 미저장은 status.code "dirty" 로 표현(R5) — 별도 dirty 플래그 없음(이중진실 금지).
      status?: TabStatus;
    }
  // 플러그인 뷰(콘텐츠 배치) — 전역 키 "<pluginId>.<view>" 의 provider 를
  // PluginViewHost 가 그린다. 닫기/이동/드래그는 일반 뷰와 동일(view id 제네릭).
  | {
      id: string;
      kind: "plugin";
      title: string;
      customLabel?: string;
      // 탭 아이콘(콘텐츠 사실 — 예: 브라우저 파비콘 URL). title 동형: 플러그인이 setIcon 으로
      // 보고, 빈 값 = 해제(매니페스트 아이콘 폴백). 표시 전용 — 의미는 코어가 모른다.
      icon?: string;
      pluginId: string;
      view: string; // 플러그인 내 뷰 id
      // 이 뷰가 마운트 시 받을 자동 실행 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 1회 실행).
      // PluginViewContext.command 로 전달. 뷰 종류 무관 채널(터미널 뷰만 실제 자동 실행).
      command?: string;
      status?: TabStatus;
      // 관찰된 작업 디렉토리(OSC 7/633) — 영속 대상(B3): 복원 뷰가 마지막 cwd 에서 시작한다.
      cwd?: string;
      // 플러그인 관찰 런타임 상태(B3 일반화) — 뷰 레코드에 실려 뷰와 수명을 같이한다(뷰 닫힘 =
      // 상태 소멸, id 재사용 충돌 불가). 예: 브라우저 현재 URL. 플러그인 kv 에 viewId 키로 영속
      // 금지 — viewId 는 세션 넘어 유일하지 않다(reseed 재사용). ctx.setRestoreState 가 기록,
      // 복원 마운트의 ctx.restore.state 로 돌아온다. JSON 직렬화 가능 값만.
      state?: unknown;
      // 마지막 활동 시각(epoch ms) — 근거는 이벤트만(명령 시작/종료·turn·활성화·PTY 출력).
      // 복원 hydration 우선순위(B4)와 "마지막 사용" 표시의 데이터.
      lastActivity?: number;
      // 엔티티 id 마이그레이션이 심은 옛 탭 id — PTY 재부착·체크포인트의 옛 키를 보존한다
      // (손실 0). 제거 조건: 그 체크포인트의 재봉인(adopt) 완료 후 스냅샷 정리.
      legacyPaneId?: string;
    };

// 칸: 탭 묶음 + 활성 탭. 배치 트리의 leaf.
export interface Pane {
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

// 배치 재귀 트리. leaf = 칸 하나, split = 행/열로 묶인 칸들(sizes = 분할 비율).
// 스페이스의 분할 트리 = 제네릭 SplitTree(leaf 값 = Pane). split/remove/resize/find 는
// splitTree.ts 단일 추상(사이드바 배치 SidebarLayout 과 동일 코드 — 중복 없음).
export type PaneNode = SplitTree<Pane>;

// 드롭 위치(드래그 분할 방향). center=이동, 나머지=해당 방향으로 분할.
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export type Side = "left" | "right" | "top" | "bottom";

// 컨텐츠가 처음 열 때 띄우는 프로그램(첫 화면). 내장 "terminal"(코어 능력) +
// 플러그인 등록 프로그램 id(programRegistry). 미등록 id 는 터미널 폴백.
export type Program = string;

// 컨텐츠 탭: 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드). 프로젝트당 여러 개 + 전환.
// 프로그램 자동 실행은 터미널 뷰의 autorun 이 담당(뷰 단위로 일반화).
export interface Space {
  id: string;
  title: string; // 1,2,3,… (이름변경 가능)
  layout: PaneNode; // 그룹(분할) 트리
  activePaneId: string;
  // 이 스페이스가 투영하는 단 하나의 sidebar 소유 뷰. 패널 포커스와 독립·스냅샷 영속.
  railBindingTabId?: string;
  // 최대화된 뷰(컨텐츠 영역 전체 차지). 레이아웃 트리는 불변 — 표시 오버라이드만.
  // undefined = 보통. 뷰가 사라지면 normalize 가 해제한다.
  maximizedTabId?: string;
}

export interface Project {
  id: string;
  title: string; // 별칭
  sidebarOpen: boolean;
  // 좌 레일 프레임의 위치 모드. projection ref 핀(레일 안의 내용)과 별도 축이다.
  // 구 스냅샷/테스트 fixture의 부재는 FLOW로 해석한다.
  leftRailPlacement?: RailPlacement;
  // 우측 플러그인 사이드바: 열림 + 활성 뷰("<pluginId>.<viewId>" | "manager" | null).
  rightOpen: boolean;
  rightView: string | null;
  // 좌측 사이드바 레이아웃(B2) — SplitTree<SidebarGroup>. 등록된 sidebar-left 뷰의 배치(탭 묶음 +
  // 세로 분할 + 활성). 콘텐츠 영역과 동일한 drag-merge. 등록 변화와 reconcile(LeftSidebarHost).
  leftLayout: SidebarLayout;
  // 프로젝트 루트 디렉토리(P1 루트 필수 — projectRoot.ts 헌법). 정체성 = 이
  // 경로(P4). 터미널 시작 위치이자 파일트리/git 의 기준.
  root: string;
  // 복원 시 root 가 파일시스템에 없음(휘발 — 직렬화 제외). 탭은 유지하되 배너로 알리고
  // 사용자가 정리한다(무단 삭제 금지 — B1 정합성). 경로가 돌아오면 재시작 복원에서 해소.
  rootMissing?: boolean;
  // 프로젝트의 터미널 셸(미지정이면 전역 설정 shell → 시스템 $SHELL).
  shell?: string;
  // 프로젝트 식별 색(레일 칩/탭 강조). 미지정이면 테마 기본.
  color?: string;
  // 컨텐츠 탭들 + 활성.
  spaces: Space[];
  activeSpaceId: string;
}

export interface NewProjectOpts {
  alias: string;
  root: string; // P1 — 호출부가 검증·정규화(validateProjectRoot)까지 마친 경로
  shell?: string; // undefined = 전역 설정 따름
  // 첫 콘텐츠의 초기 뷰 프로그램. 생략 = 빈 스켈레톤(makeContent 계약과 동일).
  program?: Program;
}

// ── 액션 결과 형태 ──────────────────────────────────────────────────────────

// 새 뷰 생성 결과.
export interface NewViewIds {
  viewId: string;
}

interface SessionsStore {
  projects: Project[]; // 프로젝트들
  activeId: string;

  // 프로젝트 레벨
  // 부트 1회: 기본 루트로 첫 프로젝트(t1/"P1") 생성 — main.tsx 전용(P3).
  bootstrapFirstProject: (root: string, opts?: { alias?: string; shell?: string }) => void;
  // 영속된 레이아웃 복원(A5) — main.tsx 부트가 직렬화 스냅샷을 deserialize 해 통째 주입.
  // bootstrap 과 배타: 복원본이 있으면 이걸, 없으면 bootstrap. reseed 는 호출부(persistence)가.
  restoreProjects: (projects: Project[], activeId: string) => void;
  addProject: (
    opts: NewProjectOpts,
  ) => CmdResult<
    { projectId: string; contentId: string; groupId: string; existing?: true } & Partial<NewViewIds>
  >;
  closeTab: (id: string) => CmdResult<{ activeProjectId: string }>;
  setActive: (id: string) => CmdResult;
  renameProject: (id: string, title: string) => CmdResult;
  // 프로젝트 식별 색 설정(null = 제거).
  setProjectColor: (id: string, color: string | null) => CmdResult;
  // 프로젝트 설정 일괄 변경(undefined = 유지, null = 제거→기본). root 는 불변.
  updateProject: (
    id: string,
    patch: {
      title?: string;
      shell?: string | null;
      color?: string | null;
    },
  ) => CmdResult;
  toggleSidebar: (id: string) => CmdResult<{ sidebarOpen: boolean }>;
  setLeftRailPlacement: (
    id: string,
    placement: RailPlacement,
  ) => CmdResult<{ placement: RailPlacement }>;
  // 우측 플러그인 사이드바. open 명시 시 그 상태로(멱등), 생략 시 토글.
  toggleRightSidebar: (
    id: string,
    open?: boolean,
  ) => CmdResult<{ rightOpen: boolean }>;
  setRightView: (
    id: string,
    view: string | null,
  ) => CmdResult<{ rightView: string | null }>;
  // 좌측 사이드바 활성 탭 — viewKey 가 든 leaf 그룹의 활성을 그것으로. (기존 setLeftTab 대체.)
  setLeftTab: (id: string, viewKey: string) => CmdResult<{ leftTab: string }>;
  // 등록 sidebar-left 뷰와 reconcile(LeftSidebarHost 가 렌더 시 호출). 변화 시에만 set.
  reconcileSidebar: (id: string, registeredKeys: string[]) => void;
  // 사이드바 뷰 drag-merge(into=탭 합류, split=세로 분리).
  moveSidebarView: (id: string, viewKey: string, drop: SidebarDrop) => CmdResult;
  // 사이드바 split 비율 조절(핸들 드래그/명령).
  resizeSidebar: (id: string, splitId: string, sizes: number[]) => CmdResult;

  // 컨텐츠 탭 레벨. program 명시 시 그 프로그램으로(+메뉴), 아니면 프로젝트>전역 설정.
  addContent: (
    projectId: string,
    program?: Program,
  ) => CmdResult<{ contentId: string; groupId: string } & Partial<NewViewIds>>;
  closeContent: (
    projectId: string,
    contentId: string,
  ) => CmdResult<{ activeSpaceId: string }>;
  setActiveContent: (projectId: string, contentId: string) => CmdResult;
  renameContent: (
    projectId: string,
    contentId: string,
    title: string,
  ) => CmdResult;
  bindContentRail: (
    projectId: string,
    contentId: string,
    viewId: string,
  ) => CmdResult<{ viewId: string }>;

  // 콘텐츠 뷰/그룹 레벨. 그룹에 프로그램별 새 뷰 탭(터미널/claude/codex/브라우저).
  // opts.command = 터미널 자동 실행 명령 직접 지정(내부용 — 프로그램 resolve 우회.
  // 플러그인 활성화 시 설치 터미널 등 호스트 흐름 전용, 원격 명령엔 비노출).
  addViewToGroup: (
    projectId: string,
    program: Program,
    groupId?: string,
    opts?: { command?: string },
  ) => CmdResult<{ groupId: string } & NewViewIds>;
  // 그룹(패널) 통째 닫기 — 안의 모든 뷰 제거(마지막 그룹이면 거부).
  closeGroup: (
    projectId: string,
    groupId: string,
  ) => CmdResult<{ activePaneId: string }>;
  openFileView: (
    projectId: string,
    path: string,
  ) => CmdResult<{ viewId: string; groupId: string; existing: boolean }>;
  // 플러그인 뷰를 콘텐츠 탭으로(중복 판정 키 = pluginId+view, openFileView 대칭).
  openPluginView: (
    projectId: string,
    pluginId: string,
    view: string,
    title: string,
  ) => CmdResult<{ viewId: string; groupId: string; existing: boolean }>;
  closeView: (
    projectId: string,
    viewId: string,
  ) => CmdResult<{ activePaneId: string; activeTabId: string }>;
  setActiveView: (projectId: string, viewId: string) => CmdResult;
  setActiveGroup: (projectId: string, groupId: string) => CmdResult;
  // 뷰 최대화 — 컨텐츠 영역 전체를 한 뷰가 차지(분할 트리 불변, 표시만). 복원=원래 분할.
  maximizeView: (
    projectId: string,
    viewId: string,
  ) => CmdResult<{ viewId: string }>;
  restoreView: (projectId: string) => CmdResult<{ viewId: string | null }>;
  setFileMode: (
    projectId: string,
    viewId: string,
    mode: "code" | "preview",
  ) => CmdResult;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => CmdResult;
  // 뷰 status 보고(R1) — null 이면 회수(R4). 모든 뷰 kind 공통.
  setViewStatus: (
    projectId: string,
    viewId: string,
    status: TabStatus | null,
  ) => CmdResult;
  // 임의 뷰의 탭 제목 갱신(콘텐츠 플러그인이 동적 제목 — 예: 페이지 <title>). 빈 값은 무시.
  setViewTitle: (projectId: string, viewId: string, title: string) => void;
  // 탭 아이콘 갱신(콘텐츠 사실 — 예: 파비콘 URL). 빈 값 = 해제(사실이 "아이콘 없음"으로 변한 것).
  setViewIcon: (projectId: string, viewId: string, icon: string) => void;
  // 사용자 지정 탭 라벨 설정(view.rename). 빈 값 = 오버라이드 해제(동적 title 복귀).
  renameView: (projectId: string, viewId: string, label: string) => CmdResult<{ label: string }>;
  // 뷰 런타임 관찰값(B3) — cwd(OSC 관찰)·lastActivity(이벤트 근거)·state(플러그인 관찰 상태).
  // undefined = 유지.
  // projectId null 허용: 이벤트가 프로젝트를 모르면 전 탭에서 뷰를 찾는다(pane→view 매핑 안정).
  setViewRuntime: (
    projectId: string | null,
    viewId: string,
    patch: { cwd?: string; lastActivity?: number; state?: unknown },
  ) => void;
  // 드래그/명령 분할·이동: viewId 를 targetGroup 의 zone 위치로.
  moveViewToGroup: (
    projectId: string,
    viewId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => CmdResult<{ groupId: string }>;
  // 그룹 전체(타이틀바 드래그/명령)를 targetGroup 의 zone 위치로. center=병합.
  moveGroupToGroup: (
    projectId: string,
    sourceGroupId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => CmdResult<{ groupId: string }>;
  // 분할 비율 조절(리사이저 드래그/명령).
  resizeSplit: (
    projectId: string,
    splitId: string,
    sizes: number[],
  ) => CmdResult;
  // 여러 split 의 sizes 를 한 커밋으로(세로 라인 동반 드래그 — 중간 토막 상태 없음).
  // 레일 충돌 검사는 최종 상태 1회 — 거부 시 전체 무변경.
  resizeSplits: (
    projectId: string,
    updates: { splitId: string; sizes: number[] }[],
  ) => CmdResult;
  // targetGroup 옆에 새 뷰 그룹을 분할 생성(split 버튼 / title 모드 ⌘T / 명령).
  // program 미지정/미등록이면 빈 그룹(빈 패널) — viewId 없음(Partial).
  splitWithNewView: (
    projectId: string,
    targetGroupId: string,
    side: Side,
    program?: Program,
  ) => CmdResult<{ groupId: string } & Partial<NewViewIds>>;
}

// 발급은 ids.ts(단일 진실)가 한다 — 카운터·reseed 는 폐기됐다. 랜덤 id 는 재실행·창 간
// 재등장이 없으므로 "보존 id 위로 카운터를 올리는" 조율 자체가 필요 없어진다.
// 내부 노드(split)만 지역 카운터를 유지한다 — 실체가 아니라 주소·명령·응답 어디에도
// 나오지 않으므로(§1-2) 전역 유일성이 필요 없고, 접두 id 를 주면 idScope 게이트가 잡는다.
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화가
// 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
const ms = moduleState("state/sessions#state", () => ({
  nextSplitId: 1,
}));
const newViewId = () => issueId("tab");
const newGroupId = () => issueId("pane");
const newSplitId = () => `s${ms.nextSplitId++}`;
const newContentId = () => issueId("space");
// split id 생성기(복원 시 windowSnapshot.deserialize 에 주입 — A2 는 split id 를 재생성한다).
export const nextSplitIdGen = (): string => newSplitId();

// 발급 형식 미리보기(비파괴) — 진단·게이트용. 랜덤 발급이므로 값이 아니라 형식이 계약이다.
export function newIds(): {
  project: string;
  view: string;
  group: string;
  split: string;
  content: string;
} {
  return {
    project: issueId("project"),
    view: issueId("tab"),
    group: issueId("pane"),
    split: `s${ms.nextSplitId}`,
    content: issueId("space"),
  };
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function makeGroup(view?: Tab): Pane {
  // view 생략 = 빈 그룹(빈 탭) — 첫 화면 자동 실행 없음(순수 스켈레톤). +메뉴로 뷰를 추가한다.
  return view
    ? { id: newGroupId(), tabs: [view], activeTabId: view.id }
    : { id: newGroupId(), tabs: [], activeTabId: "" };
}

// 새 플러그인 뷰(콘텐츠 배치) — 프로그램이 어떤 플러그인의 contributes.views 중 하나를 연다.
// PluginViewHost 가 "<pluginId>.<view>" provider 를 그린다. 코어는 plugin-agnostic — 어떤
// 플러그인이든 동일 경로(특정 플러그인 락인 0). command 는 마운트 시 뷰에 흘려보낼 자동 실행
// 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 1회 실행). 미지정 = 자동 실행 없음.
function newPluginViewFor(
  pluginId: string,
  view: string,
  title: string,
  command?: string,
): Tab {
  return {
    id: newViewId(),
    kind: "plugin",
    title,
    pluginId,
    view,
    ...(command ? { command } : {}),
  };
}

// 프로그램 → 새 뷰. 내장 프로그램 개념은 없다(§2.6) — 등록 프로그램의 spec 으로 resolve.
// 모든 프로그램은 kind:"view"(코어 터미널 제거 — 터미널도 플러그인 뷰)다. 뷰 소유 플러그인은
// 두 축으로 온다: viewPlugin(name-pin, 그 플러그인의 뷰) 또는 viewContract(계약-핀, 사용자가
// 고른 구현체의 뷰). 미지정이면 프로그램 소유 플러그인. command 는 그 뷰에 흘려보낼 자동 실행
// 명령이다. 미등록 id 는 뷰 생성 불가(null). 계약에 활성 구현체가 0 이어도 null(빈 그룹으로 열화).
function newViewFor(
  program: Program,
  opts?: { command?: string },
): Tab | null {
  const reg = getRegisteredProgram(program);
  if (!reg || !reg.decl.view) return null;
  // command 우선순위: 호출부 직접 지정(opts) > 프로그램 선언(autorun).
  const command = opts?.command ?? autorunCommandOf(reg.decl);
  // viewContract(계약-핀) = 사용자 설정으로 구현체를 고른다(코어는 계약 의미 무지 — 조회만).
  // view id 는 프로그램 선언값(관례 content)을 그대로 구현체 뷰로 연다 — 코어가 뷰 id 를 하드코딩
  // 하지 않는다. 활성 구현체 0 이면 뷰 생성 불가(null → 빈 그룹).
  if (reg.decl.viewContract) {
    const impl = resolveContractImplementer(reg.decl.viewContract);
    if (!impl) return null;
    return newPluginViewFor(impl, reg.decl.view, localize(reg.decl.title), command);
  }
  // viewPlugin 명시 = 그 플러그인의 뷰(크로스 플러그인), 미지정 = 프로그램 소유 플러그인.
  const pluginId = reg.decl.viewPlugin ?? reg.pluginId;
  return newPluginViewFor(pluginId, reg.decl.view, localize(reg.decl.title), command);
}

// 뷰의 새 id 묶음 — 생성 명령 응답용.
function idsOfView(v: Tab): NewViewIds {
  return { viewId: v.id };
}

// 새 컨텐츠 영역. program 생략 = 빈 그룹(빈 탭, 첫 화면 자동실행 없음 — 순수 스켈레톤).
// program 지정(+메뉴로 새 콘텐츠 탭) = 그 프로그램 뷰로 시작.
function makeContent(title: string, program?: Program): Space {
  // program 미지정 또는 미등록(newViewFor=null) = 빈 그룹(빈 탭, 순수 스켈레톤).
  const g = makeGroup(program ? (newViewFor(program) ?? undefined) : undefined);
  return {
    id: newContentId(),
    title,
    layout: splitLeaf(g),
    activePaneId: g.id,
  };
}


// ── 그룹 트리 헬퍼 ────────────────────────────────────────────────────────────

export function allGroups(node: PaneNode, acc: Pane[] = []): Pane[] {
  acc.push(...leavesOf(node)); // leaf 값(Pane) = SplitTree leavesOf
  return acc;
}

export function allViews(node: PaneNode): Tab[] {
  return allGroups(node).flatMap((g) => g.tabs);
}

function findGroupOfView(
  node: PaneNode,
  viewId: string,
): Pane | undefined {
  return allGroups(node).find((g) => g.tabs.some((v) => v.id === viewId));
}

function hasGroup(node: PaneNode, groupId: string): boolean {
  return allGroups(node).some((g) => g.id === groupId);
}

function findGroup(node: PaneNode, groupId: string): Pane | undefined {
  return allGroups(node).find((g) => g.id === groupId);
}

// ── PaneNode 연산 = 제네릭 SplitTree 위임(단일 진실, SidebarLayout 과 동일 코드). ──────
// 순회·구조 조작(map/find/resize/remove/insert)은 splitTree.ts 하나뿐이다. 여기는 leaf
// (Pane) 술어·변환만 제공한다.

// 특정 그룹의 Pane 을 변환.
function mapGroupNode(
  node: PaneNode,
  groupId: string,
  fn: (g: Pane) => Pane,
): PaneNode {
  return mapLeaves(node, (g) => (g.id === groupId ? fn(g) : g));
}

// 뷰가 어느 그룹에 있든 변환(종류 보존).
function mapViewNode(
  node: PaneNode,
  viewId: string,
  fn: (v: Tab) => Tab,
): PaneNode {
  return mapLeaves(node, (g) =>
    g.tabs.some((v) => v.id === viewId)
      ? { ...g, tabs: g.tabs.map((v) => (v.id === viewId ? fn(v) : v)) }
      : g,
  );
}

// split 노드 존재 여부 / sizes 변환 — 제네릭 위임.
const findSplit = (node: PaneNode, splitId: string): boolean =>
  findSplitTree(node, splitId);
const mapSplitNode = (
  node: PaneNode,
  splitId: string,
  sizes: number[],
): PaneNode => resizeSplitTree(node, splitId, sizes);

// 뷰 제거: (1) 그 뷰를 가진 그룹에서 뷰만 빼고 활성 보정(mapLeaves), (2) 빈 그룹 leaf 를
// removeLeaf 로 붕괴. split 정리(붕괴·sizes 재정규화)는 removeLeaf 단일 구현 재사용.
function removeView(
  node: PaneNode,
  viewId: string,
): { tree: PaneNode | null; removed: Tab | null } {
  let removed: Tab | null = null;
  const mapped = mapLeaves(node, (g) => {
    const found = g.tabs.find((v) => v.id === viewId);
    if (!found) return g;
    removed = found;
    const tabs = g.tabs.filter((v) => v.id !== viewId);
    let activeTabId = g.activeTabId;
    if (activeTabId === viewId) {
      const idx = g.tabs.findIndex((v) => v.id === viewId);
      activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0])?.id ?? "";
    }
    return { ...g, tabs, activeTabId };
  });
  if (!removed) return { tree: node, removed: null };
  const { tree } = removeLeaf(mapped, (g) => g.tabs.length === 0);
  return { tree, removed };
}

// 그룹(leaf) 하나를 통째로 제거 = removeLeaf(그 group id 매칭, 붕괴 포함).
function removeGroup(
  node: PaneNode,
  groupId: string,
): { tree: PaneNode | null; removed: Pane | null } {
  return removeLeaf(node, (g) => g.id === groupId);
}

// targetGroup 을 fresh 그룹과 분할(side 방향) = insertBeside(같은 dir 형제면 중첩 회피).
function splitAtGroup(
  node: PaneNode,
  targetGroupId: string,
  side: Side,
  fresh: Pane,
): PaneNode {
  const dir: "row" | "col" =
    side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  return insertBeside(
    node,
    (g) => g.id === targetGroupId,
    dir,
    before,
    fresh,
    newSplitId,
  );
}

// 활성 그룹이 사라졌으면 첫 그룹으로 보정 + 최대화 뷰가 사라졌으면 최대화 해제.
function normalizeActiveGroupC(c: Space): Space {
  const groups = allGroups(c.layout);
  let next =
    c.maximizedTabId &&
    !groups.some((g) => g.tabs.some((v) => v.id === c.maximizedTabId))
      ? { ...c, maximizedTabId: undefined }
      : c;
  if (
    next.railBindingTabId &&
    !groups.some((g) => g.tabs.some((v) => v.id === next.railBindingTabId))
  ) {
    next = { ...next, railBindingTabId: undefined };
  }
  if (groups.some((g) => g.id === next.activePaneId)) return next;
  return { ...next, activePaneId: groups[0]?.id ?? next.activePaneId };
}

/**
 * 최대화가 채우는 그룹 — 최대화된 뷰를 실제로 담고 있는 그룹. 최대화 아님(또는 대상이 어느
 * 그룹에도 없음)이면 null 이고, 그때는 분할 배치가 그대로 표시된다. 대상을 못 찾았다고 빈
 * 화면으로 접지 않는다: 화면이 사라지는 것보다 최대화가 안 걸리는 편이 언제나 낫다.
 */
function maximizedGroupId(content: Space): string | null {
  const target = content.maximizedTabId;
  if (!target) return null;
  const owner = allGroups(content.layout).find((g) =>
    g.tabs.some((v) => v.id === target),
  );
  return owner?.id ?? null;
}

/**
 * 현재 화면에 실제 표시되는 배치 — 배치 해결기 단일 호출. 콘텐츠가 없으면 평면도 없다(null).
 * fallbackStation: 미해소 포커스 렌더에서 지킬 현 위치(호출자가 직전 확정값을 준다).
 */
export function projectArrangement(
  project: Project,
  fallbackStation = 0,
): Arrangement<Pane> | null {
  const content =
    project.spaces.find((item) => item.id === project.activeSpaceId) ??
    project.spaces[0];
  if (!content) return null;
  return solveArrangement<Pane>({
    layout: content.layout,
    focusId: content.activePaneId,
    placement: project.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT,
    railOpen: project.sidebarOpen,
    // 최대화는 밑 분할 위의 이동이 아니라 [레일 | 기능] 단일 평면으로의 원자적 전환이다.
    // 채우는 패널은 최대화된 뷰가 든 그룹이다 — 활성 그룹이 아니다. 둘은 어긋날 수 있고
    // (다른 그룹의 탭을 더블클릭하는 순간 그렇게 된다), 어긋난 채 활성 그룹으로 접으면
    // 최대화된 뷰가 없는 패널만 남아 화면에 아무것도 안 그려진다(실측: maximizedTabId=v35
    // 가 g3 소속인데 layout={"panel":"g5"}, DOM 슬롯 0개, 창 전체 백지).
    maximizedId: maximizedGroupId(content),
    fallbackStation,
    // 당겨오는가는 선언이 정한다 — 적어 두고 안 읽으면 없는 것과 같다.
    pullFocused: useSettings.getState().railPullFocused,
  });
}

function leftRailLayoutConflict(project: Project): CmdErr | null {
  const placement = project.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
  if (placement.mode !== "pin") return null;
  const cleanLines = projectArrangement(project)?.cleanLines ?? [0, 100];
  return isCleanRailStation(cleanLines, placement.station)
    ? null
    : err(
        "LAYOUT_CONFLICT",
        `고정된 좌 레일 선 ${placement.station}을 패널이 가로지를 수 없음`,
        { station: placement.station, cleanLines },
      );
}

// ── 터미널 pane resolver(플러그인 터미널 = substrate) ─────────────────────────

// 탭이 구동하는 PTY substrate 키 후보(있으면). 터미널 판정은 generic — 그 후보 id 가
// PTY 관찰을 가지면(app.pty 를 구동하면) 터미널이다(pluginId·kind 하드코딩 없음, hasPty 주입).
// 코어는 터미널 뷰를 소유하지 않으므로 후보는 항상 탭 id(플러그인이 app.pty.spawn 에 넘긴 그 키).
function ptyKeyOfTab(v: Tab, hasPty: (id: string) => boolean): string | undefined {
  return hasPty(v.id) ? v.id : undefined;
}

// 프로젝트의 사이드바(파일트리)가 따라갈 터미널 pane(= 현재 cwd 출처). 순수 resolver — PTY
// 관찰 predicate(hasPty)를 주입받아 플러그인 터미널을 따라간다(generic).
// 활성 컨텐츠의 활성 그룹의 활성(=포커스된) 뷰가 터미널이면 그 pane, 아니면 아무 터미널 뷰의 pane.
export function cwdTabOf(
  project: Project,
  hasPty: (id: string) => boolean,
): string | undefined {
  const content =
    project.spaces.find((c) => c.id === project.activeSpaceId) ??
    project.spaces[0];
  if (!content) return undefined;
  const groups = allGroups(content.layout);
  const activeGroup =
    groups.find((g) => g.id === content.activePaneId) ?? groups[0];
  const active = activeGroup?.tabs.find(
    (v) => v.id === activeGroup.activeTabId,
  );
  if (active) {
    const key = ptyKeyOfTab(active, hasPty);
    if (key) return key;
  }
  for (const g of groups) {
    for (const v of g.tabs) {
      const key = ptyKeyOfTab(v, hasPty);
      if (key) return key;
    }
  }
  return undefined;
}

// 뷰 탭 표시명 단일 진실 — customLabel(사용자 의도) 우선, title(콘텐츠 사실) 폴백.
// 탭·배지 등 모든 사용자 표면이 이 함수로 표시한다(inline `customLabel ?? title` 재정의 금지).
export function viewDisplayTitle(v: Tab): string {
  return v.customLabel ?? v.title;
}

// viewId 로 이 창의 뷰 레코드를 프로젝트 전체에서 검색. 없으면 null.
export function findViewById(projects: Project[], viewId: string): Tab | null {
  for (const t of projects)
    for (const c of t.spaces)
      for (const v of allViews(c.layout)) if (v.id === viewId) return v;
  return null;
}

// webview label 의 사람 표시명 — 사용자 표면(복구 배지 등) 전용. 이 창의 브라우저 뷰
// (b-<창>-<viewId>)면 탭 표시명으로 해소하고, 대응 뷰가 없으면 label 그대로 둔다
// (사람 이름이 없는 webview 는 식별자가 유일한 사실이다).
export function webviewDisplayName(label: string, projects: Project[]): string {
  const viewId = browserViewIdFromLabel(label);
  const v = viewId ? findViewById(projects, viewId) : null;
  return v ? viewDisplayTitle(v) : label;
}

// paneId(=플러그인 터미널 view.id) 의 {projectId, viewId}(M5 — terminal status 브리지용). 없으면 null.
export function locateTab(
  projects: Project[],
  paneId: string,
): { projectId: string; viewId: string } | null {
  for (const t of projects)
    for (const c of t.spaces)
      for (const v of allViews(c.layout))
        if (v.id === paneId) return { projectId: t.id, viewId: v.id };
  return null;
}

// ── 검색/변환 헬퍼 ───────────────────────────────────────────────────────────

function mapProject(
  projects: Project[],
  projectId: string,
  fn: (t: Project) => Project,
): Project[] {
  return projects.map((t) => (t.id === projectId ? fn(t) : t));
}

function activeContentOf(t: Project): Space | undefined {
  return t.spaces.find((c) => c.id === t.activeSpaceId);
}

// 그룹/뷰가 속한 컨텐츠를 프로젝트 전체에서 검색(임의 위치 타기팅).
function contentOfGroup(
  t: Project,
  groupId: string,
): Space | undefined {
  return t.spaces.find((c) => hasGroup(c.layout, groupId));
}

function contentOfView(
  t: Project,
  viewId: string,
): Space | undefined {
  return t.spaces.find((c) =>
    allViews(c.layout).some((v) => v.id === viewId),
  );
}

function mapContent(
  t: Project,
  contentId: string,
  fn: (c: Space) => Space,
): Project {
  return {
    ...t,
    spaces: t.spaces.map((c) => (c.id === contentId ? fn(c) : c)),
  };
}

// 뷰 id(터미널 pane 포함 — pane=터미널 뷰)가 속한 프로젝트 — 호출자 컨텍스트(ctx.pane)
// 라우팅의 단일 유틸. 없으면 null.
export function projectIdOfView(viewId: string): string | null {
  for (const t of useSessions.getState().projects) {
    for (const c of t.spaces) {
      if (allViews(c.layout).some((v) => v.id === viewId)) return t.id;
    }
  }
  return null;
}

// 뷰를 어느 컨텐츠에 있든 변환(숨은 컨텐츠의 마운트된 뷰도 대상 — dirty/mode/focus 등).
function mapViewEverywhere(
  t: Project,
  viewId: string,
  fn: (v: Tab) => Tab,
): Project {
  return {
    ...t,
    spaces: t.spaces.map((c) => ({
      ...c,
      layout: mapViewNode(c.layout, viewId, fn),
    })),
  };
}

// 스페이스 자동 타이틀의 번호 추출 — "스페이스 3"·"Space 3"·"3" 모두 후행 정수를 읽는다(로케일·접두 무관).
// 접두 붙은 자동 타이틀에서도 nextNum 이 올바로 증가하도록(순수 parseInt("스페이스 3")=NaN 회피).
export function spaceAutoNum(title: string): number {
  const m = String(title).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

// 로드-타임 마이그레이션 — 구 버전의 순수 숫자 스페이스 타이틀("3")을 "스페이스 3"(i18n)으로 승격한다.
// 엑셀식 명명으로 그것이 "스페이스"임을 명확히 한다. 순수 숫자만 대상이라 사용자가 이름 바꾼 타이틀은
// 보존한다. 멱등(변환 후엔 순수 숫자가 아니라 재실행 무영향). windowBoot 복원 직후 1회 적용.
export function migrateSpaceTitle(title: string): string {
  return /^\d+$/.test(title.trim()) ? tmsg("space.autoTitle", { n: title.trim() }) : title;
}

function makeProject(id: string, opts: NewProjectOpts): Project {
  const c = makeContent(tmsg("space.autoTitle", { n: 1 }), opts.program);
  const alias = opts.alias.trim() || baseName(opts.root);
  return {
    id,
    title: alias,
    sidebarOpen: true,
    leftRailPlacement: DEFAULT_RAIL_PLACEMENT, // flow — 레일은 포커스 패널에 붙는다
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: opts.root,
    shell: opts.shell,
    spaces: [c],
    activeSpaceId: c.id,
  };
}

// 자주 쓰는 에러.
const noProject = (id: string): CmdErr =>
  err("TARGET_NOT_FOUND", `프로젝트 없음: ${id}`);

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useSessions = moduleState("state/sessions#store", () =>
  create<SessionsStore>((set, get) => ({
  // 부트(main.tsx)가 기본 루트(~/.soksak/projects/project1)를 준비한 뒤
  // bootstrapFirstProject 로 첫 프로젝트를 만든다(P3) — 렌더 전이므로
  // 프로젝트 0개 상태는 화면에 나타나지 않는다(부트 실패만의 예외 상태).
  projects: [],
  activeId: "",

  bootstrapFirstProject: (root, opts) => {
    if (get().projects.length > 0) return; // 멱등 — 부트 1회 전용
    // 자동 project1 은 "P1", 그 외 기본 표시명은 폴더명 — 생성자(컨트롤 플레인)가 별칭을
    // 지정하면 그것이 우선한다(init 쿼리 alias).
    const alias = opts?.alias || (baseName(root) === "project1" ? "P1" : "");
    const t = makeProject("t1", { alias, root, shell: opts?.shell });
    set({ projects: [t], activeId: "t1" });
  },

  restoreProjects: (projects, activeId) => {
    if (get().projects.length > 0) return; // 멱등 — 부트 1회 전용(bootstrap 과 배타)
    if (projects.length === 0) return; // 빈 복원본은 무시(부트가 bootstrap 으로 폴백)
    const active = projects.some((t) => t.id === activeId) ? activeId : projects[0].id;
    set({ projects, activeId: active });
  },

  addProject: (opts) => {
    // P5 중복 금지 — 같은 루트(정규화는 호출부 책임)의 프로젝트가 있으면
    // 그 프로젝트를 활성화하고 existing 으로 알린다(openFileView 패턴).
    const dup = get().projects.find((t) => t.root === opts.root);
    if (dup) {
      set({ activeId: dup.id });
      const c = dup.spaces.find((x) => x.id === dup.activeSpaceId)!;
      const g = allGroups(c.layout)[0];
      const v = g.tabs[0];
      return ok({
        projectId: dup.id,
        contentId: c.id,
        groupId: g.id,
        ...(v ? idsOfView(v) : {}),
        existing: true,
      });
    }
    const id = issueId("project");
    const t = makeProject(id, opts);
    set((s) => ({ projects: [...s.projects, t], activeId: id }));
    const c = t.spaces[0];
    const g = allGroups(c.layout)[0];
    const v = g.tabs[0];
    return ok({
      projectId: id,
      contentId: c.id,
      groupId: g.id,
      ...(v ? idsOfView(v) : {}),
    });
  },

  closeTab: (id) => {
    let r: CmdResult<{ activeProjectId: string }> = noProject(id);
    set((s) => {
      if (!s.projects.some((t) => t.id === id)) return s;
      if (s.projects.length <= 1) {
        r = err("LAST_ITEM", "마지막 프로젝트는 닫을 수 없음");
        return s;
      }
      const idx = s.projects.findIndex((t) => t.id === id);
      const projects = s.projects.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = (projects[idx] ?? projects[idx - 1] ?? projects[0]).id;
      }
      r = ok({ activeProjectId: activeId });
      return { projects, activeId };
    });
    return r;
  },

  setActive: (id) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.projects.some((t) => t.id === id)) return s;
      r = ok({});
      return s.activeId === id ? s : { activeId: id };
    });
    return r;
  },

  renameProject: (id, title) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.projects.some((t) => t.id === id)) return s;
      r = ok({});
      return { projects: s.projects.map((t) => (t.id === id ? { ...t, title } : t)) };
    });
    return r;
  },

  setProjectColor: (id, color) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.projects.some((t) => t.id === id)) return s;
      r = ok({});
      return {
        projects: s.projects.map((t) =>
          t.id === id ? { ...t, color: color ?? undefined } : t,
        ),
      };
    });
    return r;
  },

  updateProject: (id, patch) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.projects.some((t) => t.id === id)) return s;
      r = ok({});
      return {
        projects: s.projects.map((t) => {
          if (t.id !== id) return t;
          const next = { ...t };
          // 빈 제목은 무시(제목은 항상 비어 있지 않다는 불변식 유지).
          if (patch.title !== undefined && patch.title.trim()) {
            next.title = patch.title.trim();
          }
          if (patch.shell !== undefined) {
            next.shell = patch.shell ?? undefined;
          }
          if (patch.color !== undefined) {
            next.color = patch.color ?? undefined;
          }
          return next;
        }),
      };
    });
    return r;
  },

  toggleSidebar: (id) => {
    let r: CmdResult<{ sidebarOpen: boolean }> = noProject(id);
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      r = ok({ sidebarOpen: !t.sidebarOpen });
      return {
        projects: s.projects.map((x) =>
          x.id === id ? { ...x, sidebarOpen: !x.sidebarOpen } : x,
        ),
      };
    });
    return r;
  },

  setLeftRailPlacement: (id, placement) => {
    let r: CmdResult<{ placement: RailPlacement }> = noProject(id);
    if (
      placement.mode === "pin" &&
      (!Number.isFinite(placement.station) ||
        placement.station < 0 ||
        placement.station > 100)
    ) {
      return err("INVALID_PARAMS", "좌 레일 station은 0..100이어야 함");
    }
    set((s) => {
      const project = s.projects.find((item) => item.id === id);
      if (!project) return s;
      const current = project.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
      if (
        current.mode === placement.mode &&
        (current.mode === "flow" ||
          (placement.mode === "pin" && current.station === placement.station))
      ) {
        r = ok({ placement: current });
        return s;
      }
      const nextProject = { ...project, leftRailPlacement: placement };
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = err(
          "INVALID_PARAMS",
          "좌 레일 PIN은 현재 그리드의 깨끗한 세로선에만 둘 수 있음",
          conflict.data,
        );
        return s;
      }
      r = ok({ placement });
      return {
        projects: s.projects.map((item) =>
          item.id === id ? { ...item, leftRailPlacement: placement } : item,
        ),
      };
    });
    return r;
  },

  toggleRightSidebar: (id, open) => {
    let r: CmdResult<{ rightOpen: boolean }> = noProject(id);
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      const rightOpen = open ?? !t.rightOpen;
      r = ok({ rightOpen });
      if (rightOpen === t.rightOpen) return s; // 멱등
      return {
        projects: s.projects.map((x) => (x.id === id ? { ...x, rightOpen } : x)),
      };
    });
    return r;
  },

  setRightView: (id, view) => {
    let r: CmdResult<{ rightView: string | null }> = noProject(id);
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      r = ok({ rightView: view });
      if (t.rightView === view) return s;
      return {
        projects: s.projects.map((x) => (x.id === id ? { ...x, rightView: view } : x)),
      };
    });
    return r;
  },

  setLeftTab: (id, viewKey) => {
    let r: CmdResult<{ leftTab: string }> = noProject(id);
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      if (!hasSidebarView(t.leftLayout, viewKey)) {
        r = err("TARGET_NOT_FOUND", `사이드바 뷰 없음: ${viewKey}`);
        return s;
      }
      r = ok({ leftTab: viewKey });
      // viewKey 가 든 leaf 그룹의 활성만 그것으로(다른 leaf 는 불변).
      const leftLayout = mapLeaves(t.leftLayout, (g) =>
        g.viewKeys.includes(viewKey) && g.activeViewKey !== viewKey
          ? { ...g, activeViewKey: viewKey }
          : g,
      );
      return {
        projects: s.projects.map((x) => (x.id === id ? { ...x, leftLayout } : x)),
      };
    });
    return r;
  },

  reconcileSidebar: (id, registeredKeys) => {
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      const next = reconcileSidebarLayout(t.leftLayout, registeredKeys);
      if (next === t.leftLayout) return s; // 변화 없음(참조 보존 — 무한 reconcile 방지)
      return {
        projects: s.projects.map((x) => (x.id === id ? { ...x, leftLayout: next } : x)),
      };
    });
  },

  moveSidebarView: (id, viewKey, drop) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      if (!hasSidebarView(t.leftLayout, viewKey)) {
        r = err("TARGET_NOT_FOUND", `사이드바 뷰 없음: ${viewKey}`);
        return s;
      }
      const leftLayout = moveSidebarViewT(t.leftLayout, viewKey, drop, newSplitId);
      r = ok({});
      return {
        projects: s.projects.map((x) => (x.id === id ? { ...x, leftLayout } : x)),
      };
    });
    return r;
  },

  resizeSidebar: (id, splitId, sizes) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      const t = s.projects.find((x) => x.id === id);
      if (!t) return s;
      if (!findSplitTree(t.leftLayout, splitId)) {
        r = err("TARGET_NOT_FOUND", `사이드바 split 없음: ${splitId}`);
        return s;
      }
      r = ok({});
      const leftLayout = resizeSplitTree(t.leftLayout, splitId, sizes);
      return {
        projects: s.projects.map((x) => (x.id === id ? { ...x, leftLayout } : x)),
      };
    });
    return r;
  },

  addContent: (projectId, program) => {
    let r: CmdResult<
      { contentId: string; groupId: string } & Partial<NewViewIds>
    > = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const nextNum =
        Math.max(0, ...t.spaces.map((c) => spaceAutoNum(c.title))) + 1;
      const c = makeContent(tmsg("space.autoTitle", { n: nextNum }), program);
      const g = allGroups(c.layout)[0];
      const v = g.tabs[0];
      const nextProject = {
        ...t,
        spaces: [...t.spaces, c],
        activeSpaceId: c.id,
      };
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ contentId: c.id, groupId: g.id, ...(v ? idsOfView(v) : {}) });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  closeContent: (projectId, contentId) => {
    let r: CmdResult<{ activeSpaceId: string }> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const idx = t.spaces.findIndex((c) => c.id === contentId);
      if (idx === -1) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      if (t.spaces.length <= 1) {
        r = err("LAST_ITEM", "마지막 컨텐츠는 닫을 수 없음");
        return s;
      }
      const spaces = t.spaces.filter((c) => c.id !== contentId);
      let activeSpaceId = t.activeSpaceId;
      if (activeSpaceId === contentId) {
        activeSpaceId = (spaces[idx] ?? spaces[idx - 1] ?? spaces[0]).id;
      }
      const nextProject = { ...t, spaces, activeSpaceId };
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ activeSpaceId });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  setActiveContent: (projectId, contentId) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      if (!t.spaces.some((c) => c.id === contentId)) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      if (t.activeSpaceId === contentId) {
        r = ok({});
        return s; // 이미 활성(불필요 재렌더 방지)
      }
      const nextProject = { ...t, activeSpaceId: contentId };
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  renameContent: (projectId, contentId, title) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      if (!t.spaces.some((c) => c.id === contentId)) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, contentId, (c) => ({ ...c, title })),
        ),
      };
    });
    return r;
  },

  bindContentRail: (projectId, contentId, viewId) => {
    let r: CmdResult<{ viewId: string }> = noProject(projectId);
    set((s) => {
      const project = s.projects.find((item) => item.id === projectId);
      const content = project?.spaces.find((item) => item.id === contentId);
      if (!project || !content) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      // 재결부 허용: 활성 콘텐츠 뷰가 스페이스의 결부를 정한다 — 같은 뷰면 멱등, 다른
      // 뷰면 교체. 같은 해소(instanceKey)면 R1 이 슬롯 전환을 막아 레일은 차분하고, 빈
      // 그룹 포커스는 이 경로를 타지 않아(호출부가 활성 뷰 있을 때만) 기존 결부가 유지된다.
      if (content.railBindingTabId === viewId) {
        r = ok({ viewId });
        return s;
      }
      if (!allGroups(content.layout).some((g) => g.tabs.some((v) => v.id === viewId))) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({ viewId });
      return {
        projects: mapProject(s.projects, projectId, (item) => ({
          ...item,
          spaces: item.spaces.map((candidate) =>
            candidate.id === contentId
              ? { ...candidate, railBindingTabId: viewId }
              : candidate,
          ),
        })),
      };
    });
    return r;
  },

  addViewToGroup: (projectId, program, groupId, opts) => {
    let r: CmdResult<{ groupId: string } & NewViewIds> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      // 대상 그룹: 명시 id(전체 컨텐츠에서 검색) 또는 활성 컨텐츠의 활성 그룹.
      const content = groupId
        ? contentOfGroup(t, groupId)
        : activeContentOf(t);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${groupId ?? "(활성)"}`);
        return s;
      }
      const target = groupId ?? content.activePaneId;
      const v = newViewFor(program, opts);
      if (!v) {
        // 미등록 프로그램 — 코어는 터미널 폴백을 더 이상 갖지 않는다(터미널도 플러그인 뷰).
        r = err("TARGET_NOT_FOUND", `프로그램 없음: ${program}`);
        return s;
      }
      r = ok({ groupId: target, ...idsOfView(v) });
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, target, (g) => ({
              ...g,
              tabs: [...g.tabs, v],
              activeTabId: v.id,
            })),
            activePaneId: target,
          })),
        ),
      };
    });
    return r;
  },

  openFileView: (projectId, path) => {
    let r: CmdResult<{ viewId: string; groupId: string; existing: boolean }> =
      noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = activeContentOf(t);
      if (!content) return s;
      // 이미 열린 같은 파일이면 그 그룹/뷰를 활성화(재사용).
      const existing = allViews(content.layout).find(
        (v) => v.kind === "file" && v.path === path,
      );
      if (existing) {
        const grp = findGroupOfView(content.layout, existing.id);
        if (!grp) return s;
        r = ok({ viewId: existing.id, groupId: grp.id, existing: true });
        return {
          projects: mapProject(s.projects, projectId, (x) =>
            mapContent(x, content.id, (c) => ({
              ...c,
              layout: mapGroupNode(c.layout, grp.id, (g) => ({
                ...g,
                activeTabId: existing.id,
              })),
              activePaneId: grp.id,
            })),
          ),
        };
      }
      const v: Tab = {
        id: newViewId(),
        kind: "file",
        title: baseName(path),
        path,
        mode: "code",
      };
      r = ok({ viewId: v.id, groupId: content.activePaneId, existing: false });
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, c.activePaneId, (g) => ({
              ...g,
              tabs: [...g.tabs, v],
              activeTabId: v.id,
            })),
          })),
        ),
      };
    });
    return r;
  },

  openPluginView: (projectId, pluginId, view, title) => {
    let r: CmdResult<{ viewId: string; groupId: string; existing: boolean }> =
      noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = activeContentOf(t);
      if (!content) return s;
      // 같은 플러그인 뷰가 이미 열려 있으면 그 그룹/뷰를 활성화(재사용).
      const existing = allViews(content.layout).find(
        (v) => v.kind === "plugin" && v.pluginId === pluginId && v.view === view,
      );
      if (existing) {
        const grp = findGroupOfView(content.layout, existing.id);
        if (!grp) return s;
        r = ok({ viewId: existing.id, groupId: grp.id, existing: true });
        return {
          projects: mapProject(s.projects, projectId, (x) =>
            mapContent(x, content.id, (c) => ({
              ...c,
              layout: mapGroupNode(c.layout, grp.id, (g) => ({
                ...g,
                activeTabId: existing.id,
              })),
              activePaneId: grp.id,
            })),
          ),
        };
      }
      const v: Tab = {
        id: newViewId(),
        kind: "plugin",
        title,
        pluginId,
        view,
      };
      r = ok({ viewId: v.id, groupId: content.activePaneId, existing: false });
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, c.activePaneId, (g) => ({
              ...g,
              tabs: [...g.tabs, v],
              activeTabId: v.id,
            })),
          })),
        ),
      };
    });
    return r;
  },

  closeView: (projectId, viewId) => {
    let r: CmdResult<{ activePaneId: string; activeTabId: string }> =
      noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      // 닫은 뒤 content 가 통째로 비면 단일 빈 탭으로 유지한다 — 컨텐츠/그룹은 유지(순수 스켈레톤:
      // 빈 탭이 정당한 상태). leaf 단일 그룹의 마지막 뷰든, split 한쪽이 빈 그룹이라 removeView 가
      // 빈 그룹들을 정리하며 트리 전체가 비는 경우든 동일하다(removeView → tree=null). 닫은 뷰의
      // 그룹을 빈 채로 남긴다. tree=null 을 "프로젝트 없음" 으로 오인하면 안 된다(r 초기값 함정).
      const grp = findGroupOfView(content.layout, viewId);
      const { tree } = removeView(content.layout, viewId);
      if (!tree) {
        const next = normalizeActiveGroupC({
          ...content,
          layout: splitLeaf({ ...grp!, tabs: [], activeTabId: "" }),
        });
        const nextProject = mapContent(t, content.id, () => next);
        const conflict = leftRailLayoutConflict(nextProject);
        if (conflict) {
          r = conflict;
          return s;
        }
        r = ok({ activePaneId: next.activePaneId, activeTabId: "" });
        return {
          projects: mapProject(s.projects, projectId, () => nextProject),
        };
      }
      let next = normalizeActiveGroupC({ ...content, layout: tree });
      // R6 승계(plans/sidebar-projection-spec.md) — 닫힌 뷰가 이 프로젝트의 결부 뷰(활성 체인
      // 말단)였으면, 같은 스페이스의 focusHistory 최근 생존 뷰로 결부를 되돌린다. 인접 탭은
      // 그 다음 폴백(위 removeView 기본 승계가 이미 해뒀다).
      const wasBound =
        content.id === t.activeSpaceId &&
        grp?.id === content.activePaneId &&
        grp?.activeTabId === viewId;
      if (wasBound) {
        const history =
          useProjection.getState().byProject[projectId]?.focusHistory ?? [];
        for (const hv of history) {
          if (hv === viewId) continue;
          const hg = findGroupOfView(next.layout, hv);
          if (hg) {
            next = {
              ...next,
              activePaneId: hg.id,
              layout: mapGroupNode(next.layout, hg.id, (g) => ({
                ...g,
                activeTabId: hv,
              })),
            };
            break;
          }
        }
      }
      const activeGroup = findGroup(next.layout, next.activePaneId);
      const nextProject = mapContent(t, content.id, () => next);
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({
        activePaneId: next.activePaneId,
        activeTabId: activeGroup?.activeTabId ?? "",
      });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  setActiveView: (projectId, viewId) => {
    noteActivation("setActiveView", viewId); // 발화 원장 — 몇 번·어떤 경로로 불렸는지(관측)
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      const grp = findGroupOfView(content.layout, viewId);
      if (!grp) return s;
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, grp.id, (g) => ({
              ...g,
              activeTabId: viewId,
            })),
            activePaneId: grp.id,
          })),
        ),
      };
    });
    return r;
  },

  setActiveGroup: (projectId, groupId) => {
    noteActivation("setActiveGroup", groupId); // 발화 원장(관측)
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, groupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${groupId}`);
        return s;
      }
      // 이미 활성이면 상태 변경 없음(본문 클릭마다 불필요한 재렌더 방지).
      if (
        content.id === t.activeSpaceId &&
        content.activePaneId === groupId
      ) {
        r = ok({});
        return s;
      }
      const nextProject = {
        ...mapContent(t, content.id, (c) => ({
          ...c,
          activePaneId: groupId,
        })),
        activeSpaceId: content.id,
      };
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  maximizeView: (projectId, viewId) => {
    let r: CmdResult<{ viewId: string }> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      const grp = findGroupOfView(content.layout, viewId);
      if (!grp) return s;
      const nextProject = {
        ...mapContent(t, content.id, (c) => ({
            ...c,
            maximizedTabId: viewId,
            // 최대화 뷰 = 그 그룹의 활성 뷰 + 활성 그룹(표시·입력 일치).
            layout: mapGroupNode(c.layout, grp.id, (g) => ({
              ...g,
              activeTabId: viewId,
            })),
            activePaneId: grp.id,
          })),
        activeSpaceId: content.id,
      };
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ viewId });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  restoreView: (projectId) => {
    let r: CmdResult<{ viewId: string | null }> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = t.spaces.find((c) => c.id === t.activeSpaceId);
      if (!content) return s;
      r = ok({ viewId: content.maximizedTabId ?? null });
      if (!content.maximizedTabId) return s;
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            maximizedTabId: undefined,
          })),
        ),
      };
    });
    return r;
  },

  setFileMode: (projectId, viewId, mode) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "file" ? { ...v, mode } : v,
          ),
        ),
      };
    });
    return r;
  },

  // file 미저장은 status.code "dirty" 로 단일화(R5 — 이중진실 제거). setViewStatus 위임.
  setFileDirty: (projectId, viewId, dirty) =>
    get().setViewStatus(projectId, viewId, dirty ? { code: "dirty" } : null),

  // 뷰 status 보고/회수(R1·R4) — 모든 뷰 공통. null=필드 소멸. setFileDirty 와 동형.
  setViewRuntime: (projectId, viewId, patch) => {
    set((s) => {
      const targets = projectId
        ? s.projects.filter((t) => t.id === projectId)
        : s.projects.filter((t) => contentOfView(t, viewId));
      if (targets.length === 0) return s;
      let projects = s.projects;
      for (const t of targets) {
        projects = mapProject(projects, t.id, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "plugin" ? { ...v, ...patch } : v,
          ),
        );
      }
      return { projects };
    });
  },

  setViewStatus: (projectId, viewId, status) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) => ({
            ...v,
            status: status ?? undefined,
          })),
        ),
      };
    });
    return r;
  },

  // 임의 뷰 kind 의 탭 제목 갱신(콘텐츠 플러그인 동적 제목 — 예: 페이지 <title>). 빈 값은 무시.
  setViewTitle: (projectId, viewId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      projects: mapProject(s.projects, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => ({ ...v, title: trimmed })),
      ),
    }));
  },

  setViewIcon: (projectId, viewId, icon) => {
    const trimmed = icon.trim();
    set((s) => ({
      projects: mapProject(s.projects, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => {
          if (v.kind !== "plugin") return v;
          if (!trimmed) {
            const { icon: _drop, ...rest } = v;
            return rest as Tab;
          }
          return { ...v, icon: trimmed };
        }),
      ),
    }));
  },

  renameView: (projectId, viewId, label) => {
    const trimmed = label.trim();
    let r: CmdResult<{ label: string }> = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
    set((s) => ({
      projects: mapProject(s.projects, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => {
          r = ok({ label: trimmed });
          if (!trimmed) {
            const { customLabel: _drop, ...rest } = v;
            return rest as Tab;
          }
          return { ...v, customLabel: trimmed };
        }),
      ),
    }));
    return r;
  },

  moveViewToGroup: (projectId, viewId, targetGroupId, zone) => {
    let r: CmdResult<{ groupId: string }> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      // 같은 컨텐츠 안의 대상 그룹만 허용(컨텐츠 간 이동은 별도 개념).
      if (!hasGroup(content.layout, targetGroupId)) {
        r = err("TARGET_NOT_FOUND", `대상 그룹 없음(같은 컨텐츠 내): ${targetGroupId}`);
        return s;
      }
      const src = findGroupOfView(content.layout, viewId);
      if (!src) return s;
      const view = src.tabs.find((v) => v.id === viewId);
      if (!view) return s;

      if (zone === "center") {
        if (src.id === targetGroupId) {
          r = ok({ groupId: targetGroupId }); // 이미 그 그룹 — idempotent
          return s;
        }
        const { tree } = removeView(content.layout, viewId);
        if (!tree || !hasGroup(tree, targetGroupId)) return s;
        const nextContent = normalizeActiveGroupC({
          ...content,
          layout: mapGroupNode(tree, targetGroupId, (g) => ({
            ...g,
            tabs: [...g.tabs, view],
            activeTabId: view.id,
          })),
          activePaneId: targetGroupId,
        });
        const nextProject = mapContent(t, content.id, () => nextContent);
        const conflict = leftRailLayoutConflict(nextProject);
        if (conflict) {
          r = conflict;
          return s;
        }
        r = ok({ groupId: targetGroupId });
        return {
          projects: mapProject(s.projects, projectId, () => nextProject),
        };
      }

      // 분할: src 에서 떼고 target 옆에 새 그룹으로.
      if (allViews(content.layout).length <= 1) {
        r = err("LAST_ITEM", "유일한 뷰는 분할할 수 없음");
        return s;
      }
      const { tree } = removeView(content.layout, viewId);
      if (!tree || !hasGroup(tree, targetGroupId)) return s;
      const fresh = makeGroup(view);
      const nextContent = normalizeActiveGroupC({
        ...content,
        layout: splitAtGroup(tree, targetGroupId, zone, fresh),
        activePaneId: fresh.id,
      });
      const nextProject = mapContent(t, content.id, () => nextContent);
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ groupId: fresh.id });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  closeGroup: (projectId, groupId) => {
    let r: CmdResult<{ activePaneId: string }> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, groupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${groupId}`);
        return s;
      }
      if (allGroups(content.layout).length <= 1) {
        r = err("LAST_ITEM", "컨텐츠의 마지막 패널은 닫을 수 없음(컨텐츠 닫기를 사용)");
        return s;
      }
      const { tree } = removeGroup(content.layout, groupId);
      if (!tree) return s;
      const next = normalizeActiveGroupC({ ...content, layout: tree });
      const nextProject = mapContent(t, content.id, () => next);
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ activePaneId: next.activePaneId });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  moveGroupToGroup: (projectId, sourceGroupId, targetGroupId, zone) => {
    let r: CmdResult<{ groupId: string }> = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, sourceGroupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${sourceGroupId}`);
        return s;
      }
      if (sourceGroupId === targetGroupId) {
        r = ok({ groupId: targetGroupId }); // idempotent
        return s;
      }
      if (!hasGroup(content.layout, targetGroupId)) {
        r = err("TARGET_NOT_FOUND", `대상 그룹 없음(같은 컨텐츠 내): ${targetGroupId}`);
        return s;
      }
      if (allGroups(content.layout).length <= 1) {
        r = err("LAST_ITEM", "유일한 그룹은 이동할 수 없음");
        return s;
      }
      const source = findGroup(content.layout, sourceGroupId);
      if (!source) return s;
      const { tree } = removeGroup(content.layout, sourceGroupId);
      if (!tree || !hasGroup(tree, targetGroupId)) return s;

      if (zone === "center") {
        // target 으로 source 의 모든 탭을 병합(그룹 합치기).
        const nextContent = normalizeActiveGroupC({
          ...content,
          layout: mapGroupNode(tree, targetGroupId, (g) => ({
            ...g,
            tabs: [...g.tabs, ...source.tabs],
            activeTabId: source.activeTabId,
          })),
          activePaneId: targetGroupId,
        });
        const nextProject = mapContent(t, content.id, () => nextContent);
        const conflict = leftRailLayoutConflict(nextProject);
        if (conflict) {
          r = conflict;
          return s;
        }
        r = ok({ groupId: targetGroupId });
        return {
          projects: mapProject(s.projects, projectId, () => nextProject),
        };
      }
      // 그룹 통째로 target 옆에 재배치(같은 id·뷰 유지 → 본문 remount 없음).
      const nextContent = normalizeActiveGroupC({
        ...content,
        layout: splitAtGroup(tree, targetGroupId, zone, source),
        activePaneId: source.id,
      });
      const nextProject = mapContent(t, content.id, () => nextContent);
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ groupId: source.id });
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  resizeSplit: (projectId, splitId, sizes) =>
    get().resizeSplits(projectId, [{ splitId, sizes }]),

  resizeSplits: (projectId, updates) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      if (updates.length === 0) {
        r = ok({});
        return s;
      }
      // 묶음은 한 레이아웃의 라인 — 모든 splitId 를 가진 콘텐츠 하나에만 적용한다.
      const content = t.spaces.find((c) =>
        updates.every((u) => findSplit(c.layout, u.splitId)),
      );
      if (!content) {
        r = err(
          "TARGET_NOT_FOUND",
          `분할 없음: ${updates.map((u) => u.splitId).join(", ")}`,
        );
        return s;
      }
      const nextProject = mapContent(t, content.id, (c) => ({
        ...c,
        layout: updates.reduce(
          (layout, u) => mapSplitNode(layout, u.splitId, u.sizes),
          c.layout,
        ),
      }));
      const conflict = leftRailLayoutConflict(nextProject);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({});
      return {
        projects: mapProject(s.projects, projectId, () => nextProject),
      };
    });
    return r;
  },

  splitWithNewView: (projectId, targetGroupId, side, program) => {
    let r: CmdResult<{ groupId: string } & Partial<NewViewIds>> =
      noProject(projectId);
    set((s) => {
      const t = s.projects.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, targetGroupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${targetGroupId}`);
        return s;
      }
      // program 지정 시 그 프로그램 뷰, 미지정/미등록이면 빈 그룹(빈 패널 — 순수 스켈레톤).
      const v = program ? newViewFor(program) : null;
      const fresh = makeGroup(v ?? undefined);
      r = ok({ groupId: fresh.id, ...(v ? idsOfView(v) : {}) });
      return {
        projects: mapProject(s.projects, projectId, (x) =>
          mapContent(x, content.id, (c) =>
            normalizeActiveGroupC({
              ...c,
              layout: splitAtGroup(c.layout, targetGroupId, side, fresh),
              activePaneId: fresh.id,
            }),
          ),
        ),
      };
    });
    return r;
  },

})),
);
