// 명령 카탈로그 — soksak 전 기능을 command 로 등록한다(단일 진실).
// 타기팅 규칙(모든 명령 공통):
//   - 대상 id 를 명시하면 그 위치(프로젝트 전체에서 검색), 생략하면 호출자 컨텍스트
//     (SOKSAK_CALLER_TAB → 그 탭이 속한 pane/스페이스/프로젝트) 또는 활성 체인.
//   - 모든 변이는 결과(새 id/변경 후 상태)를 반환 — 호출자가 응답만으로 검증 가능.

import { registerCaptureCatalog } from "./catalogCapture";
import { registerHealthCatalog } from "./catalogHealth";
import { invoke, currentWindow, windowByLabel, frameworkPath } from "../framework";
import { tmsg } from "../i18n";
import { suggestLayout, type MonitorFact, type WindowFact } from "../lib/layoutSuggest";
import {
  DEFAULT_RAIL_PLACEMENT,
  snapRailStation,
  type RailPlacement,
} from "../lib/railPlacement";
import { listRecentProjects, removeRecentProject } from "../state/recentProjects";
import {
  allGroups,
  projectArrangement,
  useSessions,
  type Space,
  type DropZone,
  type PaneNode,
  type Program,
  type Project,
  type Side,
  type Tab,
  type Pane,
} from "../state/sessions";
import {
  canonicalGutter,
  isCanonicalSide,
  resolveGutter,
  type GutterSide,
} from "../lib/gutterAddress";
import type { SidebarLayout } from "../state/sidebarLayout";
import type { SplitTree } from "../state/splitTree";
import { addProjectClaimed, closeProjectReleased } from "../state/projectRegistry";
import { getRegisteredProgram, listPrograms } from "../plugins/programRegistry";
import { resolveTerminalProgram, TERMINAL_CONTRACT } from "../plugins/terminalEngine";
import {
  activeSessionViewId,
  transferViewFocus,
} from "../plugins/viewFocus";
import { useSettings } from "../state/settings";
import { applyWindowZoom } from "../lib/zoomIntent";
import { browserLabelPrefix, currentWindowLabel } from "../lib/webviewLabels";
import { awaitViewMounted } from "../plugins/viewFocus";
import { useViewLabels } from "../state/viewLabels";
import { useBookmarks } from "../state/bookmarks";
import { useTheme } from "../state/theme";
import { useIconRegistry } from "../ui/icons/registry";
import { hasPtyObservation } from "../terminal/ptyObservationStore";
import { resolveTermTab } from "./termResolve";
import { computeLayout } from "../components/GroupArea";
import type { Arrangement } from "../lib/railArrangement";
import { catalogJson, register, type CommandContext, type CommandHint } from "./registry";
import { registerFsWatchCatalog } from "./catalogFsWatch";
import { registerPluginCatalog } from "./catalogPlugins";
import { registerDaemonCatalog } from "./catalogDaemon";
import { registerUpdateCatalog } from "./catalogUpdate";
import { registerUiCatalog } from "./catalogUi";
import { registerProjectionCatalog } from "./catalogProjection";
import { registerDomCatalog } from "./catalogDom";
import { registerAiSessionCatalog } from "./catalogAiSession";
import { registerDataCatalog } from "./catalogData";
import { registerPtySessionCatalog } from "./catalogPtySession";
import { registerSecretsCatalog } from "./catalogSecrets";
import { registerTurnCatalog } from "./catalogTurn";
import { registerNetworkCatalog } from "./catalogNetwork";
import { registerMediaCatalog } from "./catalogMedia";
import { registerClipboardCatalog } from "./catalogClipboard";
import { registerNotifyCatalog } from "./catalogNotify";
import { registerScheduleCatalog } from "./catalogSchedule";
import { registerServiceCatalog } from "./catalogService";
import { registerFrameworkCatalog } from "./catalogFramework";
import { registerSystemCatalog } from "./catalogSystem";
import { registerUnitDevCatalog } from "./catalogUnitDev";
import { registerReleaseCatalog } from "./catalogRelease";
import { registerWebviewCatalog } from "./catalogWebview";
import {
  ensureDefaultProjectRoot,
  FOLDER_NAME_RE,
  validateProjectRoot,
} from "../lib/projectRoot";

// ── 공통 에러/헬퍼 ───────────────────────────────────────────────────────────

const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});

// 해소된 대상 축을 답에 싣는다 — 생략된 축은 호출자 컨텍스트로 조용히 채워지므로, 답이 그
// 결과를 말하지 않으면 호출자는 어디에 실행됐는지 알 방법이 없다(targetEcho 게이트). 실패
// 봉투에는 얹지 않는다 — 실패한 호출에는 해소된 대상이 없다.
function withTargets(result: object, targets: Record<string, string | undefined>): object {
  const rec = result as Record<string, unknown>;
  if (rec.ok === false || rec.code) return result;
  return { ...rec, ...targets };
}

// 구조를 바꾼 명령의 응답에 착지한 배치를 실어 준다 — 호출자가 "어디로 정렬됐는지"를 알기 위해
// 다시 조회할 필요가 없다(퍼즐은 변경 직후 이미 풀려 있다). 실패 응답에는 붙이지 않는다.
function withArrangement(projectId: string, result: object): object {
  const rec = result as Record<string, unknown>;
  if (rec.ok === false || rec.code) return result;
  const t = useSessions.getState().projects.find((item) => item.id === projectId);
  const solved = t ? projectArrangement(t) : null;
  if (!solved) return result;
  return {
    ...rec,
    arrangement: {
      station: solved.station,
      switched: solved.swapped,
      cleanLines: solved.cleanLines,
      cells: solved.cells.map((cell) => ({ id: cell.id, rect: cell.rect })),
    },
  };
}

export interface Location {
  project: Project;
  space: Space;
  pane: Pane;
  /** 빈 pane(탭 0개)은 위치로 유효하되 tab 만 없다 — tab 을 전제하는 소비처는 부재를 처리한다. */
  tab?: Tab;
}

// layout.apply 저작 형태 — 1차 스페이스, 2차 각 스페이스의 pane(분할). 표면 계약(space/pane)과 같은 결.
interface LayoutPaneSpec {
  program: string;
  side?: Side;
}
interface LayoutSpaceSpec {
  title?: string;
  panes?: LayoutPaneSpec[];
}

// 골 축의 해소·정본화는 lib/gutterAddress 하나가 소유한다(렌더러의 data-node 주소와 명령
// 파라미터가 같은 함수를 받는다 — 기준 두 벌 금지). 여기서는 그 결과에 sizes 를 얹을 뿐이다.
const EDGES = ["right", "bottom", "left", "top"] as const satisfies readonly GutterSide[];
const paneIdOf = (pane: Pane) => pane.id;

// 답이 지목하는 정본 골 — 명령 표면의 방향 축 이름은 edge 다(side 는 pane.split 의 분할 방향을
// 뜻하는 다른 축이라, 한 표면에서 같은 낱말이 두 뜻을 가지지 않게 여기서 이름을 맞춘다).
function gutterEcho(
  layout: PaneNode,
  paneId: string,
  edge: GutterSide,
): { pane: string; edge: GutterSide } | null {
  const canonical = canonicalGutter(layout, paneId, edge, paneIdOf);
  return canonical ? { pane: canonical.pane, edge: canonical.side } : null;
}

// 그 viewKey 를 담은 leaf 를 직접 감싼 분할 — 사이드바 트리의 내부 노드는 이름이 없으므로,
// 조절 대상 분할을 그 안의 뷰로 지목한다(sidebar.left.resize). 뿌리가 leaf 면 분할이 없다(null).
function sidebarSplitIdOf(layout: SidebarLayout, viewKey: string): string | null {
  const walk = (node: SidebarLayout, parentId: string | null): string | null => {
    if (node.type === "leaf") return node.value.viewKeys.includes(viewKey) ? parentId : null;
    for (const c of node.children) {
      const hit = walk(c, node.id);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(layout, null);
}

// 해소된 골이 사는 분할의 현재 비율 — 이 읽기가 필요한 이유는 resizeSplit 이 sizes 전량을
// 요구하기 때문이다(골 하나를 옮기려고 나머지 비율까지 되읽어 다시 넣는다). 그 인터페이스가
// 골 하나의 비율만 받는 형태로 바뀌면 이 함수는 통째로 사라진다 — 제거 조건은 그것이고,
// 그때까지는 여기 지역 읽기로 둔다(승격하면 사라져야 할 것에 자리를 준다). 승격이 필요해지면
// splitTree.ts 의 resizeSplitTree·findSplitTree 옆에 leaf 제네릭으로 둔다 — 그 파일은 칸 트리와
// 사이드바 트리 양쪽의 단일 추상이라 한쪽에만 맞는 읽기를 두면 대칭이 깨진다.
function splitSizesOf(node: PaneNode, splitId: string): number[] | null {
  if (node.type === "leaf") return null;
  if (node.id === splitId) return node.sizes;
  for (const c of node.children) {
    const hit = splitSizesOf(c, splitId);
    if (hit) return hit;
  }
  return null;
}

// 탭 id 가 속한 위치를 전 프로젝트에서 검색. 터미널 대상도 이 함수로 해소한다 — 터미널은
// 플러그인 뷰이고 그 인스턴스가 탭이다(코어 터미널 없음).
/** 탭 위치 — 캡처 등 다른 카탈로그 파일도 같은 자리를 쓴다(두 벌이면 같은 id 가 다른 곳을 답한다). */
export function locateTab(tabId: string): Location | null {
  const s = useSessions.getState();
  for (const project of s.projects) {
    for (const space of project.spaces) {
      for (const pane of allGroups(space.layout)) {
        const tab = pane.tabs.find((v) => v.id === tabId);
        if (tab) return { project, space, pane, tab };
      }
    }
  }
  return null;
}

// pane id 가 속한 위치(tab = 그 pane 의 활성 탭).
function locatePane(paneId: string): Location | null {
  const s = useSessions.getState();
  for (const project of s.projects) {
    for (const space of project.spaces) {
      const pane = allGroups(space.layout).find((g) => g.id === paneId);
      if (pane) {
        const tab =
          pane.tabs.find((v) => v.id === pane.activeTabId) ?? pane.tabs[0];
        return { project, space, pane, tab };
      }
    }
  }
  return null;
}

// 활성 체인(활성 프로젝트 → 활성 스페이스 → 활성 pane → 활성 탭).
function activeChain(): Location | null {
  const s = useSessions.getState();
  const project = s.projects.find((t) => t.id === s.activeId);
  if (!project) return null;
  const space =
    project.spaces.find((c) => c.id === project.activeSpaceId) ??
    project.spaces[0];
  if (!space) return null;
  const pane =
    allGroups(space.layout).find((g) => g.id === space.activePaneId) ??
    allGroups(space.layout)[0];
  if (!pane) return null;
  const tab =
    pane.tabs.find((v) => v.id === pane.activeTabId) ?? pane.tabs[0];
  // 빈 pane(전부 이동·닫힘)도 유효한 위치다 — pane 대상 명령(tab.open 등)은 계속 동작해야
  // 하므로 여기서 끊지 않고, tab 을 전제하는 소비처가 부재를 처리한다(INTERNAL 사망 금지, 실측).
  return { project, space, pane, tab };
}

// 호출 컨텍스트 해석: 호출자 탭($SOKSAK_CALLER_TAB) 우선, 없으면 활성 체인.
function resolveCtx(ctx: CommandContext): Location | null {
  if (ctx.pane) {
    const loc = locateTab(ctx.pane);
    if (loc) return loc;
  }
  return activeChain();
}

// 대상 프로젝트: 명시 id > 컨텍스트.
function resolveProject(
  params: Record<string, unknown>,
  ctx: CommandContext,
): Project | null {
  const id = params.project as string | undefined;
  if (id) {
    return useSessions.getState().projects.find((t) => t.id === id) ?? null;
  }
  return resolveCtx(ctx)?.project ?? null;
}

// 대상 pane: 명시 id(전 프로젝트 검색) > 컨텍스트 pane.
function resolvePane(
  params: Record<string, unknown>,
  ctx: CommandContext,
): Location | null {
  const id = params.pane as string | undefined;
  if (id) return locatePane(id);
  return resolveCtx(ctx);
}

// term.* 의 컨텍스트 기반 터미널 탭 해석(명시 tab 이 없을 때) — resolveTermTab 에 주입.
// 터미널 = PTY 관찰을 가진 뷰의 인스턴스(플러그인 터미널, 그 인스턴스가 탭이다). 호출자 탭 >
// 활성 탭 > 같은 스페이스의 첫 터미널 탭 순. substrate 술어(hasPtyObservation)로 generic
// 판정(코어 락인 0).
function terminalContextTab(
  _params: Record<string, unknown>,
  ctx: CommandContext,
): { tabId: string } | null {
  if (ctx.pane && hasPtyObservation(ctx.pane)) return { tabId: ctx.pane };
  const loc = activeChain();
  if (!loc) return null;
  if (loc.tab && hasPtyObservation(loc.tab.id)) {
    return { tabId: loc.tab.id };
  }
  for (const g of allGroups(loc.space.layout)) {
    for (const v of g.tabs) {
      if (hasPtyObservation(v.id)) return { tabId: v.id };
    }
  }
  return null;
}

// 브라우저 계열 프로그램 id 해석(layout.apply dev preset). 프로그램은 전부 플러그인 기여라
// 코어는 브라우저 종류를 모른다(락인 0) — 등록 프로그램 id 관례("browser")로 식별한다. 없으면
// undefined 를 돌려주고, 호출부가 그 패널을 건너뛰며 사유를 남긴다(은폐 금지).
// hint 예시용 실존 프로그램 — 등록 목록의 첫 항목. 특정 program id 를 가정하지 않는다(코어
// program-무지) — 하드코딩 예시는 미설치 환경에서 깨진 안내가 된다(실측: claude). 등록 프로그램이
// 없으면 플레이스홀더(<program>) — 예시임이 드러난다.
function exampleProgramId(): string {
  return listPrograms()[0]?.decl.id ?? "<program>";
}

// dev 프리셋의 브라우저 pane 해석 — 관례 프로그램 id "browser"(terminal 과 동일 메커니즘)만 본다.
// substring 매칭 폴백은 두지 않는다: "browser" 를 포함한 임의 id 를 기본 브라우저로 오인할 수 있고
// (엔진 변형·도구 프로그램), terminal 은 그런 폴백 없이 관례 id 하나로 동작한다 — 대칭 유지.
// 미등록이면 undefined — 호출부가 그 pane 을 건너뛰고 사유를 남긴다(은폐 금지).
function findBrowserProgram(): string | undefined {
  return listPrograms().find((p) => p.decl.id === "browser")?.decl.id;
}

// ── 직렬화(state.tree) ──────────────────────────────────────────────────────

function serializeTab(v: Tab) {
  if (v.kind === "file") {
    return {
      id: v.id,
      kind: v.kind,
      title: v.title,
      customLabel: v.customLabel,
      path: v.path,
      mode: v.mode,
      dirty: v.status?.code === "dirty",
    };
  }
  return {
    id: v.id,
    kind: v.kind,
    title: v.title,
    customLabel: v.customLabel,
    icon: v.icon,
    plugin: v.pluginId,
    view: v.view,
  };
}

// 분할 구조의 직렬화(배치 트리·사이드바 트리 공용). 내부 노드는 실체가 아니므로 이름이 없다 —
// dir/sizes 와 children 중첩만 싣고 id 는 싣지 않는다. 골을 조작하는 명령(pane.resize·
// pane.equalize·sidebar.left.resize)은 leaf 로 골을 지목하므로 내부 노드를 부를 일이 없다
// (IDENTITY §4).
function serializeSplitStructure<L>(
  node: SplitTree<L>,
  leafOf: (value: L) => object,
): object {
  if (node.type === "leaf") return leafOf(node.value);
  return {
    split: { dir: node.dir, sizes: node.sizes },
    children: node.children.map((c) => serializeSplitStructure(c, leafOf)),
  };
}

function serializeLayout(node: PaneNode): object {
  return serializeSplitStructure(node, (pane) => ({ pane: pane.id }));
}

function serializeSidebarLayout(node: SidebarLayout): object {
  return serializeSplitStructure(node, (g) => ({
    viewKeys: g.viewKeys,
    active: g.activeViewKey,
  }));
}

function serializeSpace(
  c: Space,
  activeSpaceId: string,
  /** 이 스페이스의 해(배치 해결기). 레일이 없는 비활성 스페이스는 null — 정본 배열 그대로. */
  arrangement: Arrangement<Pane> | null,
  railStation?: number,
  railOpen = true,
) {
  const displayLayout = arrangement?.displayLayout ?? c.layout;
  const canonicalLayout = serializeLayout(c.layout);
  const canonicalCells = computeLayout(c.layout).cells;
  const projectedCells = computeLayout(displayLayout).cells;
  const maximizedPane = c.maximizedTabId
    ? (projectedCells.find(({ group }) => group.id === c.activePaneId) ??
      projectedCells.find(({ group }) =>
        group.tabs.some((tab) => tab.id === c.maximizedTabId),
      ) ?? null)
    : null;
  const cells = maximizedPane
    ? [{ group: maximizedPane.group, rect: { left: 0, top: 0, width: 100, height: 100 } }]
    : projectedCells;
  const canonicalOrder = canonicalCells.map(({ group }) => group.id);
  const projectedOrder = projectedCells.map(({ group }) => group.id);
  const swappedPanes = canonicalOrder.filter(
    (id, index) => projectedOrder[index] !== id,
  );
  const projection = c.maximizedTabId
    ? {
        kind: "maximized" as const,
        applied: true,
        focusedPaneId: c.activePaneId,
        swappedPanes: [] as string[],
      }
    : displayLayout !== c.layout
      ? {
          kind: "switched" as const,
          applied: true,
          focusedPaneId: c.activePaneId,
          swappedPanes,
        }
      : {
          kind: "canonical" as const,
          applied: false,
          focusedPaneId: c.activePaneId,
          swappedPanes: [] as string[],
        };
  const boundPane = c.railBindingTabId
    ? cells.find(({ group }) =>
        group.tabs.some((tab) => tab.id === c.railBindingTabId),
      )
    : undefined;
  const railRelation = c.railBindingTabId
    ? {
        boundTabId: c.railBindingTabId,
        boundPaneId: boundPane?.group.id ?? null,
        connected:
          railOpen &&
          !!boundPane &&
          railStation !== undefined &&
          Math.abs(boundPane.rect.left - railStation) <= 0.01,
      }
    : null;
  return {
    id: c.id,
    title: c.title,
    active: c.id === activeSpaceId,
    activePaneId: c.activePaneId,
    maximizedTabId: c.maximizedTabId ?? null,
    // layout/panes = 지금 화면. canonicalLayout = 저장된 SplitTree의 읽기 전용 직렬화.
    // 소비자는 투영 결과를 정본으로 오인하거나 private store를 읽을 필요가 없다.
    layout: maximizedPane
      ? { pane: maximizedPane.group.id }
      : serializeLayout(displayLayout),
    canonicalLayout,
    projection,
    railRelation,
    panes: cells.map(({ group, rect }) => ({
      id: group.id,
      rect: {
        left: Math.round(rect.left * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      active: group.id === c.activePaneId,
      activeTabId: group.activeTabId,
      tabs: group.tabs.map(serializeTab),
    })),
  };
}

// 좌 레일 위치의 공개 사실. 저장의 PIN station과 현재 그리드에서 실제로
// 적용되는 station은 구분한다. 구 스냅샷의 dirty PIN을 조회했다는 이유만으로
// 저장값을 변경하지 않으며, 명시적 PIN 명령만 유효 라인으로 스냅해 저장한다.
function serializeLeftRailPosition(t: Project) {
  const arrangement = projectArrangement(t);
  const cleanLines = arrangement?.cleanLines ?? [0, 100];
  const placement: RailPlacement = t.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
  const effectiveStation = arrangement?.station ?? 0;
  return placement.mode === "pin"
    ? {
        mode: placement.mode,
        station: placement.station,
        effectiveStation,
        cleanLines,
      }
    : { mode: placement.mode, effectiveStation, cleanLines };
}

function serializeTree() {
  const s = useSessions.getState();
  return {
    activeProjectId: s.activeId,
    projects: s.projects.map((t) => {
      const leftRailPosition = serializeLeftRailPosition(t);
      const arrangement = projectArrangement(t);
      return {
        id: t.id,
        title: t.title,
        root: t.root ?? null,
        color: t.color ?? null,
        sidebarOpen: t.sidebarOpen,
        leftRailPosition,
        active: t.id === s.activeId,
        activeSpaceId: t.activeSpaceId,
        spaces: t.spaces.map((c) =>
          serializeSpace(
            c,
            t.activeSpaceId,
            c.id === t.activeSpaceId ? arrangement : null,
            leftRailPosition.effectiveStation,
            t.sidebarOpen,
          ),
        ),
      };
    }),
  };
}

// ── 파라미터 조각(재사용) ────────────────────────────────────────────────────

/**
 * 창 축의 해소 — 네 명령이 같은 모양을 쓴다.
 *
 * 모양이 명령마다 다르면 "생략 = 지금 대상"이 어디선가 빠진다(실측: window.close 만 빠져
 * 인자 누락으로 죽었다). 해소를 한 함수로 두면 그 규칙이 코드에서 성립한다 — 테스트가
 * 사후에 잡아내는 것과 다르다.
 */
function windowTarget(p: Record<string, unknown>): string {
  return typeof p.label === "string" && p.label ? p.label : currentWindowLabel();
}

const P = {
  /**
   * 창 축 — 봉투(--window)가 이미 대상을 지목하므로 생략이 기본이다.
   *
   * 정의를 한 곳에 두는 이유: 명령마다 따로 적으면 뜻과 기본값이 갈라진다. 실측 결함 —
   * window.close 만 label 을 사실상 필수로 요구해, 자기 창에 대고 부른 close 가 인자 누락으로
   * 죽었고 e2e 는 실행할 때마다 뷰를 쌓았다. 창 축은 필수가 될 수 없다(windowAxis.test).
   *
   * 웹뷰 축(webview.recover 의 label = b-<win>-<view>)은 다른 식별자 공간이라 이 규칙 밖이다.
   */
  windowLabel: {
    type: "string",
    description: "Window label (omit = the addressed window; see window.list)",
  },
  project: {
    type: "string",
    description: "Target project id (omit = caller's context project)",
  },
  space: { type: "string", description: "Target space tab id" },
  pane: {
    type: "string",
    description: "Target pane id (omit = caller's context pane)",
  },
  /**
   * 탭 축 — 한 축에 이름은 하나다. 같은 id 공간을 두 이름으로 부르면 호출자는 어느 쪽을 쓸지
   * 짐작하고, 고칠 때는 한쪽만 고친다. 터미널 대상도 이 축이다(터미널 = 플러그인 뷰의 인스턴스).
   */
  tab: {
    type: "string",
    description: "Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB)",
  },
  program: {
    type: "string",
    description:
      "Program id — plugin-registered only (see program.list; no built-in default). Omitted or unregistered id opens a blank pane",
  },
  side: {
    type: "string",
    description: "Split direction",
    enum: ["left", "right", "top", "bottom"],
  },
  edge: {
    type: "string",
    description:
      "Which of the pane's edges the gutter sits on — right|bottom are canonical, left|top name the same gutter from the neighbour's side",
    enum: [...EDGES],
  },
  zone: {
    type: "string",
    description: "Drop zone (center = move/merge; others = split in that direction)",
    enum: ["center", "left", "right", "top", "bottom"],
  },
} satisfies Record<string, import("./registry").ParamSpec>;

// ── 등록 ─────────────────────────────────────────────────────────────────────

export function registerCatalog(): void {
  const S = () => useSessions.getState();

  // ----- state -----
  // ui.measure / ui.tree / ui.input.* 는 catalogDom.ts(주소 기반) — selector 측정은 폐기(주소 체계로 전환).

  register("state.tree", {
    description:
      "Full layout snapshot (address book): all ids and active state across project → space → pane (display rect %) → tab. Each space exposes displayed and canonical stored layouts plus projection provenance; each project exposes its effective left-rail position and clean grid lines.",
    params: {},
    returns:
      "{ activeProjectId, projects[].{ leftRailPosition, spaces[].{ layout, canonicalLayout, projection, railRelation:{boundTabId,boundPaneId,connected}?, panes[] } } } — layout/panes are displayed state; canonicalLayout is the stored SplitTree",
    message: (d) => tmsg("msg.state.tree", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["state.tree"],
    handler: () => serializeTree(),
  });

  // 배치의 해 — station·스위칭·이동량은 (그리드, 포커스)의 순수 함수이고, 이 명령은 그 해를
  // 그대로 노출한다. 관측(ui.measure 실측)과 이 답을 대조하면 화면이 계약대로인지 판정된다.
  // 배치를 직접 설정하는 명령은 두지 않는다 — 해는 트리와 포커스에서 나오므로 그것을 직접
  // 쓰는 표면은 두 번째 진실이 된다(위치는 sidebar.left.position, 구조는 pane.* 이 소유).
  register("layout.arrangement", {
    description:
      "The solved arrangement of the active space: the rail station, whether the focused pane was switched to the front (row-mismatch rule), the displayed cell rects, and the move list a focus change would produce. Read-only — the arrangement is a function of the split tree and the focus, so pane.*/sidebar.left.position are the ways to change it.",
    triggers: {
      ko: "배치 해 레일 스테이션 이동량 스위칭 정렬 계산 확인",
    },
    params: { project: P.project },
    returns:
      "{ projectId, spaceId, station, cleanLines[], switched, cells[].{id,rect,railSide}, movesFrom:{focusId, moves[].{id,dLeftPct,dRailUnits}} }",
    message: (d) => tmsg("msg.layout.arrangement", { n: Number(d.station) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["layout.arrangement"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const solved = projectArrangement(t);
      if (!solved) return notFound("스페이스 없음");
      const railOpen = t.sidebarOpen;
      return {
        projectId: t.id,
        spaceId: t.activeSpaceId,
        station: solved.station,
        cleanLines: solved.cleanLines,
        switched: solved.swapped,
        railOpen,
        cells: solved.cells.map((cell) => ({
          id: cell.id,
          rect: {
            left: cell.rect.left,
            top: cell.rect.top,
            width: cell.rect.width,
            height: cell.rect.height,
          },
          railSide: cell.rect.left >= solved.station - 0.01 ? "after" : "before",
        })),
      };
    },
  });

  register("state.commands", {
    description: "Full command catalog with parameter schemas, returns, errors, and examples — the source of truth for all available commands.",
    params: {},
    returns: "{ commands: [{name,description,params,returns,errors,examples}] }",
    message: (d) => tmsg("msg.state.commands", { n: ((d.commands as unknown[]) ?? []).length }),
    examples: ["commands"],
    handler: () => ({ commands: catalogJson() }),
  });

  register("state.context", {
    description:
      "Resolve the caller's position: project/space/pane/tab that $SOKSAK_CALLER_TAB belongs to (falls back to active chain when called outside a terminal).",
    params: { tab: P.tab },
    returns:
      "{ projectId, spaceId, paneId, tabId?, callerTab? } — tabId is absent when the pane is empty; callerTab is the terminal tab this call came from",
    message: (d) =>
      d.tabId
        ? tmsg("msg.state.context", { view: String(d.tabId) })
        : tmsg("msg.state.context.emptyPane", { pane: String(d.paneId) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["state.context"],
    handler: (p, ctx) => {
      const loc = p.tab ? locateTab(p.tab as string) : resolveCtx(ctx);
      if (!loc) return notFound("컨텍스트를 해석할 수 없음");
      return {
        projectId: loc.project.id,
        spaceId: loc.space.id,
        paneId: loc.pane.id,
        // 빈 pane 이면 tabId 없이 pane 까지의 위치를 답한다 — 빈 pane 위치도 위치다.
        tabId: loc.tab?.id,
        // 호출자 문맥 축("터미널 안 내 위치") — 대상 축(tabId)과 다른 축이라 이름도 다르다.
        // 명시 > 컨텍스트 > 활성 탭(PTY 관찰을 가진 탭일 때만).
        callerTab:
          (p.tab as string) ??
          ctx.pane ??
          (loc.tab && hasPtyObservation(loc.tab.id) ? loc.tab.id : undefined),
      };
    },
  });

  // ----- project -----
  register("project.list", {
    description: "List all projects with id, title, root path, and active state.",
    triggers: { ko: "프로젝트 목록 프로젝트 리스트 열린 프로젝트" },
    params: {},
    returns: "{ projects: [{id,title,root,active}] }",
    message: (d) => tmsg("msg.project.list", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["project.list"],
    handler: () => ({
      projects: S().projects.map((t) => ({
        id: t.id,
        title: t.title,
        root: t.root ?? null,
        active: t.id === S().activeId,
      })),
    }),
  });

  register("project.recent", {
    description:
      "List recent projects (the cross-window recents feeding the control-plane project map and the project rail): root, alias, last-opened timestamp. Same list from any window (core kv).",
    triggers: { ko: "최근 프로젝트 목록 최근 연 프로젝트 픽커 레일" },
    params: {},
    returns: "{ recents: [{root, alias, lastOpenedAt}] }",
    message: (d) => tmsg("msg.project.recent", { n: ((d.recents as unknown[]) ?? []).length }),
    examples: ["project.recent"],
    handler: async () => ({ recents: await listRecentProjects() }),
  });

  register("project.recent.remove", {
    description:
      "Remove a project from the recents list (project map/rail). Does not touch the project on disk — only the recents entry. Idempotent (missing root is a no-op).",
    triggers: { ko: "최근 프로젝트 제거 최근 목록에서 지우기 잊기" },
    params: {
      root: { type: "string", description: "Project root to forget", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.project.recent.remove"),
    examples: ['project.recent.remove \'{"root":"/Users/me/old"}\''],
    handler: async (p) => {
      await removeRecentProject(p.root as string);
      return {};
    },
  });

  register("project.open", {
    description:
      "Open a project (creates it if it doesn't exist yet). When root is omitted, folder (slug) is required — creates and uses ~/.soksak/projects/<folder>. Home (~) and root (/) are forbidden as root. Duplicate root activates the existing project instead.",
    triggers: { ko: "프로젝트 만들기 새 프로젝트 프로젝트 생성 열기" },
    params: {
      root: { type: "string", description: "Project root directory (absolute path — home/root forbidden)" },
      folder: {
        type: "string",
        description:
          "Required when root is omitted — ^[a-z0-9][a-z0-9-]*$, used as ~/.soksak/projects/<folder>",
      },
      alias: { type: "string", description: "Tab alias (omit = folder name)" },
      program: { ...P.program, description: "Initial view program (omit = empty space tab)" },
      shell: { type: "string", description: "Terminal shell path (omit = global setting → $SHELL)" },
    },
    returns:
      "{ projectId, spaceId, paneId, tabId, existing? } | { existingWindow } (already open in another window — focused instead) | { routedWindow } (called on the control-plane window — opened in a new project window instead)",
    message: (d) =>
      d.routedWindow
        ? tmsg("msg.project.open.routed", { window: String(d.routedWindow) })
        : d.existingWindow
          ? tmsg("msg.project.open.existingWindow")
          : d.existing
            ? tmsg("msg.project.open.existing")
            : tmsg("msg.project.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      // 실패는 표준 안내에 맡긴다(창 필드 없이 code 만 도착).
      if (d.code) return [];
      // 제어판이 새 워크스페이스 창으로 라우팅했다 — 그 창에서 이어가는 수를 제시한다.
      const routed = d.routedWindow as string | undefined;
      if (routed) {
        return [
          { cmd: `--window ${routed} state.tree`, why: tmsg("hint.flow.project.open.routedContinue") },
          { cmd: `--window ${routed} layout.apply dev`, why: tmsg("hint.flow.project.open.routedLayout") },
        ];
      }
      // 이미 다른 창에 열려 있어 그 창을 앞으로 가져왔다 — 그 창에서 이어간다.
      const existingWin = d.existingWindow as string | undefined;
      if (existingWin) {
        return [
          { cmd: `--window ${existingWin} state.tree`, why: tmsg("hint.flow.project.open.existingWindow") },
        ];
      }
      // 이 창에서 열렸다 — 화면을 꾸미는 다음 수들을 제시한다(가능성의 제시, 3개 상한).
      return [
        { cmd: "layout.apply dev", why: tmsg("hint.flow.project.open.layout") },
        { cmd: "window.maximize", why: tmsg("hint.flow.project.open.maximize") },
        { cmd: "space.create", why: tmsg("hint.flow.project.open.space") },
      ];
    },
    examples: [
      'project.open \'{"root":"/Users/me/work","program":"claude"}\'',
      'project.open \'{"folder":"my-project"}\'',
    ],
    handler: async (p) => {
      let root = p.root as string | undefined;
      const alias = (p.alias as string) ?? "";
      if (root) {
        // P2: 홈/루트 금지 + 정규화(P5 중복 비교 기준).
        try {
          root = await validateProjectRoot(root);
        } catch (e) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: String(e),
          };
        }
      } else {
        const folder = (p.folder as string | undefined)?.trim();
        if (!folder || !FOLDER_NAME_RE.test(folder)) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "root 생략 시 folder 필수(^[a-z0-9][a-z0-9-]*$)",
          };
        }
        root = await ensureDefaultProjectRoot(folder);
      }
      // 루트 초기화 정책(git init 등)은 project.created 이벤트 구독 플러그인 소유.
      // P6(전역 단일 오픈) 게이트 경유 — 다른 창 소유면 그 창 포커스 + existingWindow 반환.
      const r = await addProjectClaimed({
        alias,
        root,
        shell: p.shell as string | undefined,
        program: p.program as Program | undefined,
      });
      if (!r.ok || "existingWindow" in r || "routedWindow" in r) return r;
      return {
        projectId: r.projectId,
        spaceId: r.contentId,
        paneId: r.groupId,
        tabId: r.viewId,
        ...(r.existing ? { existing: r.existing } : {}),
      };
    },
  });

  register("project.close", {
    danger: "destructive",
    description: "Close a project. Refuses to close the last remaining project.",
    triggers: { ko: "프로젝트 닫기 프로젝트 제거" },
    params: { project: { ...P.project, required: true } },
    returns: "{ activeProjectId }",
    message: () => tmsg("msg.project.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['project.close \'{"project":"t2"}\''],
    // P6: 닫기 성공 시 전역 점유 해제(다른 창이 이 프로젝트를 열 수 있게).
    handler: (p) => closeProjectReleased(p.project as string),
  });

  register("project.activate", {
    description: "Switch to a different project, making it active.",
    triggers: { ko: "프로젝트 전환 프로젝트 바꾸기 이동" },
    params: { project: { ...P.project, required: true } },
    returns: "{}",
    message: () => tmsg("msg.project.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['project.activate \'{"project":"t2"}\''],
    handler: (p) => S().setActive(p.project as string),
  });

  register("project.rename", {
    description: "Rename a project tab.",
    triggers: { ko: "프로젝트 이름 바꾸기 이름 변경 프로젝트 제목" },
    params: {
      project: { ...P.project, required: true },
      title: { type: "string", description: "New project name", required: true },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.project.rename"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['project.rename \'{"project":"pjt-a1b2c3","title":"백엔드"}\''],
    handler: (p) =>
      withTargets(S().renameProject(p.project as string, p.title as string), {
        projectId: p.project as string,
      }),
  });

  register("project.color", {
    description: "Set the accent color for a project (rail chip and tab highlight). Omit color to remove.",
    triggers: { ko: "프로젝트 색 색상 탭 색깔" },
    params: {
      project: { ...P.project, required: true },
      color: {
        type: "string",
        description: "CSS color (e.g. #4a8fe8). Omit to revert to default.",
      },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.project.color"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['project.color \'{"project":"pjt-a2b3c4","color":"#4a8fe8"}\''],
    handler: (p) =>
      withTargets(
        S().setProjectColor(p.project as string, (p.color as string) ?? null),
        { projectId: p.project as string },
      ),
  });

  register("project.update", {
    description:
      "Batch-update project settings. Omitted fields are preserved; \"\" removes the override. root is immutable.",
    params: {
      project: { ...P.project, required: true },
      title: { type: "string", description: "Alias (empty string is ignored)" },
      shell: { type: "string", description: 'Terminal shell path ("" = default)' },
      color: { type: "string", description: 'Accent color ("" = remove)' },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.project.update"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'project.update \'{"project":"pjt-a2b3c4","title":"백엔드","shell":"/bin/zsh"}\'',
    ],
    handler: (p) =>
      withTargets(
        S().updateProject(p.project as string, {
          title: p.title as string | undefined,
          shell: p.shell === undefined ? undefined : (p.shell as string) || null,
          color: p.color === undefined ? undefined : (p.color as string) || null,
        }),
        { projectId: p.project as string },
      ),
  });

  register("project.sidebar.toggle", {
    description: "Toggle the file-tree sidebar for a project.",
    triggers: { ko: "사이드바 파일트리 열기 닫기 토글" },
    params: { project: P.project },
    returns: "{ projectId, sidebarOpen }",
    message: (d) =>
      d.sidebarOpen
        ? tmsg("msg.project.sidebar.toggle.opened")
        : tmsg("msg.project.sidebar.toggle.closed"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["project.sidebar.toggle"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return withTargets(S().toggleSidebar(t.id), { projectId: t.id });
    },
  });

  // 앱이 낳은 자식 프로세스는 코어가 쥐고 있는데 목록 표면이 없었다 — 회수에 실패한 자식이
  // 밖에서 보이지 않으니, 고아가 쌓여도 사용자도 도구도 알 수 없었다. 읽기 전용 관찰면.
  register("process.list", {
    description:
      "List the child processes the app spawned for plugins: handle id, OS pid, the window that spawned it, the command, and whether it is still alive. The handle id is a small counter and is not an OS pid — ask liveness with pid. An entry that is no longer alive but still listed is an orphan its owner failed to reclaim. Read-only.",
    triggers: { ko: "프로세스 목록 자식 프로세스 고아 좀비 사이드카 스폰 생존" },
    params: {
      alive: { type: "boolean", description: "Only entries that are still running" },
      window: { type: "string", description: "Only entries spawned by this window label" },
    },
    returns: "{ processes: [{id, pid, window, cmd, group, detached, alive}], count }",
    message: (d) => tmsg("msg.process.list", { n: Number(d.count ?? 0) }),
    examples: ["process.list", 'process.list \'{"alive":true}\''],
    handler: async (p) => {
      const all = (await invoke("process_list")) as Array<Record<string, unknown>>;
      const processes = all.filter(
        (r) =>
          (p.alive !== true || r.alive === true) &&
          (typeof p.window !== "string" || r.window === p.window),
      );
      return { processes, count: processes.length };
    },
  });

  register("project.rightbar.toggle", {
    description: "Toggle the right plugin sidebar (⌥⌘B). Provide open to set state explicitly (idempotent).",
    triggers: { ko: "우측 사이드바 오른쪽 패널 플러그인 바 열기 닫기" },
    params: {
      project: P.project,
      open: { type: "boolean", description: "When provided, force open or closed" },
    },
    returns: "{ projectId, rightOpen }",
    message: (d) =>
      d.rightOpen
        ? tmsg("msg.project.rightbar.toggle.opened")
        : tmsg("msg.project.rightbar.toggle.closed"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["project.rightbar.toggle", 'project.rightbar.toggle \'{"open":true}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return withTargets(S().toggleRightSidebar(t.id, p.open as boolean | undefined), {
        projectId: t.id,
      });
    },
  });

  // 레일 탭의 라벨은 뷰 종류(viewKey)에 붙는다 — 콘텐츠 탭 하나가 아니라 그 종류의 탭 자리다.
  // 그래서 이 두 명령의 축은 tab id 가 아니라 viewKey 이고, 이름도 그렇게 부른다.
  register("tab.label.set", {
    description:
      "Set a custom tab label for a sidebar view (overrides the manifest title). Empty label clears the override (manifest fallback). viewKey = '<pluginId>.<viewId>' from ui.tree (tab/left/<key>).",
    triggers: { ko: "사이드바 탭 이름변경 라벨 뷰 제목 변경" },
    params: {
      viewKey: { type: "string", description: "viewKey '<pluginId>.<viewId>'", required: true },
      label: { type: "string", description: "Custom label; empty to clear", required: true },
    },
    returns: "{ viewKey, label }",
    message: (d) =>
      d.label
        ? tmsg("msg.tab.label.set.set", { label: String(d.label) })
        : tmsg("msg.tab.label.set.cleared"),
    errors: ["INVALID_PARAMS"],
    examples: [
      'tab.label.set \'{"viewKey":"soksak-plugin-<id>.<view>","label":"내 라벨"}\'',
    ],
    handler: (p) => {
      const key = p.viewKey as string;
      useViewLabels.getState().setLabel(key, p.label as string);
      return { viewKey: key, label: useViewLabels.getState().labels[key] ?? "" };
    },
  });

  register("tab.label.get", {
    description:
      "Get the custom tab label override for a sidebar view (empty = none, caller falls back to manifest title). Omit viewKey to list all overrides.",
    triggers: { ko: "사이드바 탭 라벨 조회 뷰 제목" },
    params: {
      viewKey: { type: "string", description: "viewKey; omit to list all overrides" },
    },
    returns: "{ labels } or { viewKey, label }",
    message: (d) =>
      d.labels
        ? tmsg("msg.tab.label.get.all", {
            n: Object.keys((d.labels as Record<string, unknown>) ?? {}).length,
          })
        : tmsg("msg.tab.label.get.one", { label: String(d.label ?? "") }),
    examples: ["tab.label.get", 'tab.label.get \'{"viewKey":"x.y"}\''],
    handler: (p) => {
      const labels = useViewLabels.getState().labels;
      if (p.viewKey !== undefined)
        return { viewKey: p.viewKey, label: labels[p.viewKey as string] ?? "" };
      return { labels };
    },
  });

  register("sidebar.right.mode", {
    description:
      "Right sidebar layout mode — overlay (floats over content) or push (occupies area like the left sidebar). Global setting; omit mode to query current.",
    triggers: { ko: "우측 사이드바 밀기 영역차지 오버레이 모드 도킹" },
    params: {
      mode: { type: "string", description: "overlay | push — omit to query current" },
    },
    returns: "{ mode }",
    message: (d) => tmsg("msg.sidebar.right.mode", { mode: String(d.mode) }),
    errors: ["INVALID_PARAMS"],
    examples: ["sidebar.right.mode", 'sidebar.right.mode \'{"mode":"push"}\''],
    handler: (p) => {
      const s = useSettings.getState();
      if (p.mode !== undefined) {
        if (p.mode !== "overlay" && p.mode !== "push")
          return { ok: false as const, code: "INVALID_PARAMS", message: "mode: overlay | push" };
        s.setRightSidebarMode(p.mode);
        return { mode: p.mode };
      }
      return { mode: s.rightSidebarMode };
    },
  });

  register("sidebar.left.tree", {
    description:
      "Return the left sidebar layout tree (SplitTree of tab groups) — direction, sizes, each leaf's viewKeys + active. Source for sidebar.left.move/resize targets, which name a viewKey (the tree's interior nodes have no name).",
    triggers: { ko: "좌측 사이드바 레이아웃 트리 탭 분할 구조" },
    params: { project: P.project },
    returns: "{ projectId, layout }",
    message: () => tmsg("msg.sidebar.left.tree"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sidebar.left.tree"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return { projectId: t.id, layout: serializeSidebarLayout(t.leftLayout) };
    },
  });

  register("sidebar.left.position", {
    description:
      "Read or set the project left rail position mode. Omit mode to query. flow (default) stands the rail at the focused pane's clean left line and travels with focus; pin without station freezes the current effective line; pin with station snaps to the nearest clean full-height grid line. The solved arrangement is what state.tree reports.",
    triggers: {
      ko: "좌측 사이드바 레일 위치 플로우 포커스 추종 핀 고정 그립 스냅",
    },
    params: {
      project: P.project,
      mode: {
        type: "string",
        description: "flow | pin; omit to query current position",
        enum: ["flow", "pin"],
      },
      station: {
        type: "number",
        description:
          "Requested logical station in 0..100 for pin; omitted pin freezes the current effective station",
      },
    },
    returns:
      "{ projectId, leftRailPosition:{ mode, station?(persisted), effectiveStation, cleanLines[] } }",
    message: () => tmsg("msg.sidebar.left.position"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      "sidebar.left.position",
      'sidebar.left.position \'{"mode":"pin"}\'',
      'sidebar.left.position \'{"mode":"pin","station":50}\'',
      'sidebar.left.position \'{"mode":"flow"}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");

      const mode = p.mode as "flow" | "pin" | undefined;
      const requested = p.station as number | undefined;
      if (mode === undefined) {
        if (requested !== undefined) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS",
            message: "station은 mode=pin에서만 지정할 수 있음",
          };
        }
        return {
          projectId: t.id,
          leftRailPosition: serializeLeftRailPosition(t),
        };
      }

      if (mode === "flow") {
        if (requested !== undefined) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS",
            message: "FLOW는 station을 가지지 않음",
          };
        }
        const changed = S().setLeftRailPlacement(t.id, { mode: "flow" });
        if (!changed.ok) return changed;
      } else {
        if (
          requested !== undefined &&
          (!Number.isFinite(requested) || requested < 0 || requested > 100)
        ) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS",
            message: "station은 0..100이어야 함",
          };
        }
        const current = serializeLeftRailPosition(t);
        const station = snapRailStation(
          current.cleanLines,
          requested ?? current.effectiveStation,
        );
        const changed = S().setLeftRailPlacement(t.id, {
          mode: "pin",
          station,
        });
        if (!changed.ok) return changed;
      }

      const updated = S().projects.find((item) => item.id === t.id);
      if (!updated) return notFound("프로젝트 없음");
      return {
        projectId: updated.id,
        leftRailPosition: serializeLeftRailPosition(updated),
      };
    },
  });

  register("sidebar.left.move", {
    description:
      "Drag-merge a left sidebar view — into=merge as a tab, left/right=horizontal split, top/bottom=vertical split (same 4 directions as the content area). viewKeys/targets come from sidebar.left.tree.",
    triggers: { ko: "좌측 사이드바 탭 이동 합치기 분할 드래그 머지" },
    params: {
      project: P.project,
      viewKey: { type: "string", description: "viewKey to move", required: true },
      target: { type: "string", description: "target viewKey (a view in the target group)", required: true },
      zone: {
        type: "string",
        description: "into | left | right | top | bottom (4-direction, same as content area)",
        enum: ["into", "left", "right", "top", "bottom"],
        required: true,
      },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.sidebar.left.move"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sidebar.left.move \'{"viewKey":"soksak-plugin-<id>.<view>","target":"soksak-plugin-<other-id>.<view>","zone":"right"}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const zone = p.zone as string;
      const target = p.target as string;
      let drop;
      if (zone === "into") drop = { type: "into" as const, targetKey: target };
      else if (zone === "left" || zone === "right")
        drop = { type: "split" as const, targetKey: target, dir: "row" as const, before: zone === "left" };
      else if (zone === "top" || zone === "bottom")
        drop = { type: "split" as const, targetKey: target, dir: "col" as const, before: zone === "top" };
      else
        return { ok: false as const, code: "INVALID_PARAMS", message: "zone: into | left | right | top | bottom" };
      return withTargets(S().moveSidebarView(t.id, p.viewKey as string, drop), {
        projectId: t.id,
      });
    },
  });

  register("sidebar.left.resize", {
    description:
      "Resize the left sidebar split that holds a view — sizes are parallel to that split's children (sum 1). The tree's interior nodes have no name, so the split is named by one of the views inside it (viewKeys from sidebar.left.tree).",
    triggers: { ko: "좌측 사이드바 분할 비율 크기 조절" },
    params: {
      project: P.project,
      viewKey: {
        type: "string",
        description: "A viewKey inside the split to resize (its own tab group's split)",
        required: true,
      },
      sizes: { type: "number[]", description: "Ratio per child, sum 1", required: true },
    },
    returns: "{ projectId, sizes }",
    message: () => tmsg("msg.sidebar.left.resize"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sidebar.left.resize \'{"viewKey":"soksak-plugin-<id>.<view>","sizes":[0.6,0.4]}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const key = p.viewKey as string;
      const splitId = sidebarSplitIdOf(t.leftLayout, key);
      if (!splitId) {
        return notFound(`분할 안의 사이드바 뷰가 아님: ${key}`);
      }
      const sizes = p.sizes as number[];
      const r = S().resizeSidebar(t.id, splitId, sizes);
      return r.ok ? { projectId: t.id, sizes } : r;
    },
  });

  // ----- space -----
  register("space.list", {
    description: "List space tabs in a project.",
    params: { project: P.project },
    returns: "{ projectId, spaces: [{id,title,active}] }",
    message: (d) => tmsg("msg.space.list", { n: ((d.spaces as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["space.list"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return {
        projectId: t.id,
        spaces: t.spaces.map((c) => ({
          id: c.id,
          title: c.title,
          active: c.id === t.activeSpaceId,
        })),
      };
    },
  });

  register("space.create", {
    description: "Create a new space tab. Program priority: explicit > project setting > global setting.",
    triggers: { ko: "새 탭 스페이스 탭 추가 새로 열기" },
    params: { project: P.project, program: P.program },
    returns: "{ projectId, spaceId, paneId, tabId? }",
    message: () => tmsg("msg.space.create"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      // 새 스페이스는 활성 스페이스가 되므로 후속 수는 컨텍스트를 그대로 겨냥한다(대상 id 불요).
      if (d.code) return [];
      return [
        { cmd: "pane.split right", why: tmsg("hint.flow.space.create.split") },
        { cmd: `tab.open ${exampleProgramId()}`, why: tmsg("hint.flow.space.create.view") },
        { cmd: "window.snapshot", why: tmsg("hint.flow.space.create.snapshot") },
      ];
    },
    examples: ['space.create \'{"program":"browser"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const r = S().addContent(t.id, p.program as Program | undefined);
      if (!r.ok) return r;
      return {
        projectId: t.id,
        spaceId: r.contentId,
        paneId: r.groupId,
        tabId: r.viewId,
      };
    },
  });

  register("space.close", {
    danger: "destructive",
    description: "Close a space tab. Refuses to close the last remaining space.",
    triggers: { ko: "탭 닫기 스페이스 닫기" },
    params: {
      project: P.project,
      space: { ...P.space, required: true },
    },
    returns: "{ projectId, spaceId(closed), activeSpaceId }",
    message: () => tmsg("msg.space.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['space.close \'{"space":"spc-d5e6f7"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return withTargets(S().closeContent(t.id, p.space as string), {
        projectId: t.id,
        spaceId: p.space as string,
      });
    },
  });

  register("space.activate", {
    description: "Switch to a specific space tab, making it active.",
    triggers: { ko: "탭 이동 탭 전환 탭 바꾸기" },
    params: {
      project: P.project,
      space: { ...P.space, required: true },
    },
    returns: "{ projectId, spaceId }",
    message: () => tmsg("msg.space.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['space.activate \'{"space":"spc-d5e6f7"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return withTargets(S().setActiveContent(t.id, p.space as string), {
        projectId: t.id,
        spaceId: p.space as string,
      });
    },
  });

  register("space.switchScan", {
    description:
      "Measure a space-tab switch as the user sees it: record the switch and report whether the new space lands in a single clean frame or smears across several (jank), via per-frame pixel change in the content area. Detects same-color switches that brightness can't. Restores the original tab. Replaces ad-hoc capture scripts.",
    triggers: { ko: "탭 전환 측정 깜빡임 jank 스페이스 전환 검사 단일프레임" },
    params: {
      project: P.project,
      to: { ...P.space, required: true },
      from: {
        type: "string",
        description: "Space id to start on (default: current active)",
      },
      frames: { type: "number", description: "Frames to capture (default 30)" },
      intervalMs: { type: "number", description: "Frame interval ms (default 16)" },
      applyAtMs: {
        type: "number",
        description: "Delay after recording starts before switching (default 250)",
      },
      settleMs: {
        type: "number",
        description: "Settle wait on the start space (default 600)",
      },
      region: {
        type: "json",
        description:
          "Content area fractional rect {x0,y0,x1,y1} (0..1). Default covers the space's content area.",
      },
      threshold: {
        type: "number",
        description:
          "Noise floor (changed-pixel fraction) below which no switch is reported (default 0.003). Detection above the floor is peak-relative, so it adapts to the switch's magnitude.",
      },
    },
    returns:
      "{ projectId, spaceId(measured), frames, frameMs, switchFrame, switchFrames (consecutive changed = jank spread), clean, diffsPct }",
    message: (d) =>
      d.clean
        ? tmsg("msg.space.switchScan.clean")
        : tmsg("msg.space.switchScan.jank", { n: Number(d.switchFrames) }),
    examples: [
      'space.switchScan \'{"from":"spc-d5e6f7","to":"spc-h2j3k4"}\'',
      'space.switchScan \'{"to":"spc-h2j3k4","frames":40}\'',
    ],
    handler: async (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const prev = t.activeSpaceId;
      const to = p.to as string;
      const from = (p.from as string | undefined) ?? prev;
      const frames = (p.frames as number | undefined) ?? 30;
      const intervalMs = (p.intervalMs as number | undefined) ?? 16;
      const applyAtMs = (p.applyAtMs as number | undefined) ?? 250;
      const settleMs = (p.settleMs as number | undefined) ?? 600;
      const region =
        (p.region as { x0: number; y0: number; x1: number; y1: number }) ?? {
          // 좌측 사이드바·상단 크롬 제외한 본문 영역(탭 전환이 바뀌는 곳).
          x0: 0.23,
          y0: 0.1,
          x1: 0.99,
          y1: 0.96,
        };

      const { tempDir, join } = frameworkPath;
      const dir = await join(await tempDir(), "soksak", `switchscan-${Date.now()}`);

      // 1) 시작 스페이스로 + settle.
      S().setActiveContent(t.id, from);
      await sleep(settleMs);
      // 2) 녹화 시작(비대기) → applyAtMs 후 대상 스페이스로 전환 → 완료 대기.
      const recT0 = performance.now();
      const recP = invoke<number>("plugin:webview-capture|record", {
        dir,
        frames,
        intervalMs,
      });
      await sleep(applyAtMs);
      S().setActiveContent(t.id, to);
      const n = await recP;
      const realFrameMs = n > 0 ? (performance.now() - recT0) / n : intervalMs;
      // 3) 프레임간 픽셀 변화율 → 전환 프레임 탐지.
      const grid = await invoke<number[][]>(
        "plugin:webview-capture|analyze_frame_diffs",
        { dir, regions: [region] },
      );
      // 4) 원래 스페이스 복원.
      S().setActiveContent(t.id, prev);

      const diffs = grid.map((r) => r[0] ?? 0);
      // 자기적응 감지 — 전환 변화량은 스페이스 쌍마다 다르다(비슷한 두 터미널=0.5%, 터미널↔에디터=수%).
      // 고정 임계값은 작은 전환을 놓치므로, peak 의 40% 이상인 프레임을 전환으로 본다(단 floor 미만이면
      // 노이즈로 보고 전환 없음). 깨끗 = 그런 프레임이 정확히 1개(연속/복수면 번짐=jank). floor 조절 가능.
      const peak = diffs.length ? Math.max(...diffs) : 0;
      const floor = (p.threshold as number | undefined) ?? 0.003;
      let switchFrame = -1;
      let switchFrames = 0;
      if (peak >= floor) {
        const hi = Math.max(floor, peak * 0.4);
        for (let f = 0; f < diffs.length; f++) {
          if (diffs[f] >= hi) {
            if (switchFrame < 0) switchFrame = f;
            switchFrames++;
          }
        }
      }
      return {
        projectId: t.id,
        spaceId: to,
        frames: n,
        frameMs: Math.round(realFrameMs),
        switchFrame,
        switchFrames,
        clean: switchFrame >= 0 && switchFrames <= 1,
        diffsPct: diffs.map((d) => +(d * 100).toFixed(1)),
      };
    },
  });

  register("space.rename", {
    description: "Rename a space tab.",
    params: {
      project: P.project,
      space: { ...P.space, required: true },
      title: { type: "string", description: "New name", required: true },
    },
    returns: "{ projectId, spaceId }",
    message: () => tmsg("msg.space.rename"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['space.rename \'{"space":"spc-d5e6f7","title":"빌드"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return withTargets(
        S().renameContent(t.id, p.space as string, p.title as string),
        { projectId: t.id, spaceId: p.space as string },
      );
    },
  });

  // ----- pane -----
  register("pane.list", {
    description:
      "List displayed panes in a space, including rect (%), displayed layout, immutable canonical layout, and projection provenance.",
    params: { project: P.project, space: P.space },
    returns:
      "{ projectId, spaceId, activePaneId, layout, canonicalLayout, projection, railRelation:{boundTabId,boundPaneId,connected}?, panes[] }",
    message: (d) => tmsg("msg.pane.list", { n: ((d.panes as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["pane.list"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const c = p.space
        ? t.spaces.find((x) => x.id === p.space)
        : (resolveCtx(ctx)?.space ??
          t.spaces.find((x) => x.id === t.activeSpaceId));
      if (!c) return notFound(`스페이스 없음: ${p.space}`);
      const arrangement =
        c.id === t.activeSpaceId ? projectArrangement(t) : null;
      const out = serializeSpace(
        c,
        t.activeSpaceId,
        arrangement,
        serializeLeftRailPosition(t).effectiveStation,
        t.sidebarOpen,
      );
      return {
        projectId: t.id,
        spaceId: c.id,
        activePaneId: out.activePaneId,
        layout: out.layout,
        canonicalLayout: out.canonicalLayout,
        projection: out.projection,
        railRelation: out.railRelation,
        panes: out.panes,
      };
    },
  });

  register("pane.split", {
    description:
      "Split a pane — add a new pane beside the target on a given side (optionally running a program). Use when arranging the layout or opening something side by side.",
    triggers: { ko: "칸 나누기 분할 화면 분할 옆에 열기 나란히" },
    params: {
      project: P.project,
      pane: P.pane,
      side: { ...P.side, required: true },
      program: P.program,
    },
    returns:
      "{ projectId, paneId(new pane), tabId?, arrangement:{station,switched,cleanLines[],cells[]} }",
    message: () => tmsg("msg.pane.split"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      const out: CommandHint[] = [];
      const pane = d.paneId as string | undefined;
      // 새로 생긴 pane 에 다른 프로그램을 탭으로 더 열 수 있다 — 그 pane 을 명시 겨냥한다.
      if (pane)
        out.push({
          cmd: `tab.open '{"pane":"${pane}","program":"${exampleProgramId()}"}'`,
          why: tmsg("hint.flow.pane.split.view"),
        });
      out.push({ cmd: "window.snapshot", why: tmsg("hint.flow.pane.split.snapshot") });
      return out;
    },
    examples: ['pane.split \'{"side":"right"}\'', 'pane.split \'{"side":"bottom","program":"browser"}\''],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("대상 pane 없음");
      const r = S().splitWithNewView(
        loc.project.id,
        loc.pane.id,
        p.side as Side,
        p.program as Program,
      );
      if (!r.ok) return r;
      return withArrangement(loc.project.id, {
        projectId: loc.project.id,
        paneId: r.groupId,
        tabId: r.viewId,
      });
    },
  });

  register("pane.merge", {
    description: "Merge panes — move all tabs from src into dst; empty src pane is removed automatically.",
    triggers: { ko: "칸 합치기 병합 탭 이동 합병" },
    params: {
      project: P.project,
      src: { type: "string", description: "Source pane id", required: true },
      dst: { type: "string", description: "Destination pane id", required: true },
    },
    returns: "{ projectId, paneId(merged pane) }",
    message: () => tmsg("msg.pane.merge"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['pane.merge \'{"src":"pan-p2q3r4","dst":"pan-g2h3j4"}\''],
    handler: (p, ctx) => {
      const loc = locatePane(p.src as string) ?? resolvePane(p, ctx);
      if (!loc) return notFound(`pane 없음: ${p.src}`);
      const r = S().moveGroupToGroup(
        loc.project.id,
        p.src as string,
        p.dst as string,
        "center",
      );
      if (!r.ok) return r;
      return withArrangement(loc.project.id, {
        projectId: loc.project.id,
        paneId: r.groupId,
      });
    },
  });

  register("pane.move", {
    description: "Reposition a pane — move the entire src pane to the zone position relative to dst.",
    triggers: { ko: "칸 이동 재배치 위치 옮기기" },
    params: {
      project: P.project,
      src: { type: "string", description: "Source pane id", required: true },
      dst: { type: "string", description: "Destination pane id", required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ projectId, paneId }",
    message: () => tmsg("msg.pane.move"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['pane.move \'{"src":"pan-p2q3r4","dst":"pan-g2h3j4","zone":"left"}\''],
    handler: (p) => {
      const loc = locatePane(p.src as string);
      if (!loc) return notFound(`pane 없음: ${p.src}`);
      const r = S().moveGroupToGroup(
        loc.project.id,
        p.src as string,
        p.dst as string,
        p.zone as DropZone,
      );
      if (!r.ok) return r;
      return withArrangement(loc.project.id, {
        projectId: loc.project.id,
        paneId: r.groupId,
      });
    },
  });

  register("pane.close", {
    danger: "destructive",
    description: "Close a pane and all its tabs. Refuses to close the last pane.",
    triggers: { ko: "칸 닫기 칸 제거" },
    params: { pane: { ...P.pane, required: true } },
    returns: "{ paneId(closed), activePaneId }",
    message: () => tmsg("msg.pane.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['pane.close \'{"pane":"pan-p2q3r4"}\''],
    handler: (p) => {
      const loc = locatePane(p.pane as string);
      if (!loc) return notFound(`pane 없음: ${p.pane}`);
      return withArrangement(
        loc.project.id,
        withTargets(S().closeGroup(loc.project.id, p.pane as string), {
          paneId: p.pane as string,
        }),
      );
    },
  });

  register("pane.activate", {
    description: "Activate a pane, making it the focused one.",
    triggers: { ko: "칸 포커스 칸 활성화 선택" },
    params: { pane: { ...P.pane, required: true } },
    returns: "{ paneId }",
    message: () => tmsg("msg.pane.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['pane.activate \'{"pane":"pan-p2q3r4"}\''],
    handler: (p) => {
      const loc = locatePane(p.pane as string);
      if (!loc) return notFound(`pane 없음: ${p.pane}`);
      const echo = { paneId: p.pane as string };
      if (!loc.pane.activeTabId)
        return withTargets(S().setActiveGroup(loc.project.id, p.pane as string), echo);
      return withTargets(
        transferViewFocus(activeSessionViewId(), loc.pane.activeTabId, () =>
          S().setActiveGroup(loc.project.id, p.pane as string),
        ),
        echo,
      );
    },
  });

  register("pane.resize", {
    description:
      "Move one gutter — the seam on the given edge of a pane. ratio is the new share of the area on that pane's side of the seam; the neighbour on the other side takes the rest, and the panes further along keep their sizes. Every seam is some pane's right or bottom edge (left/top name the same seam from the neighbour's side), so no interior layout id is ever needed.",
    triggers: { ko: "칸 크기 조절 비율 골 조정 크기 바꾸기 경계 끌기" },
    params: {
      pane: P.pane,
      edge: { ...P.edge, required: true },
      ratio: {
        type: "number",
        description:
          "New share (0..1, exclusive) of the two adjacent areas for the side the pane sits on",
        required: true,
      },
    },
    returns: "{ paneId, gutter:{pane,edge}(canonical), sizes }",
    message: () => tmsg("msg.pane.resize"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'pane.resize \'{"edge":"right","ratio":0.7}\'',
      'pane.resize \'{"pane":"pan-g2h3j4","edge":"bottom","ratio":0.35}\'',
    ],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("대상 pane 없음");
      const edge = p.edge as GutterSide;
      if (!EDGES.includes(edge)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `edge: ${EDGES.join(" | ")}`,
        };
      }
      const ratio = p.ratio as number;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "ratio 범위: 0 < ratio < 1",
        };
      }
      const layout = loc.space.layout;
      const gutter = resolveGutter(layout, loc.pane.id, edge, paneIdOf);
      const current = gutter ? splitSizesOf(layout, gutter.splitId) : null;
      if (!gutter || !current) {
        return notFound(`그 모서리에 골이 없음: ${loc.pane.id}/${edge}`);
      }
      const sizes = [...current];
      const pair = sizes[gutter.index] + sizes[gutter.index + 1];
      // 골 하나는 이웃한 두 자리만 움직인다(그것이 골을 끄는 일이다) — 나머지 자리는 불변.
      // left/top 으로 부른 골은 앞 형제의 진행방향 골이라, 요청한 pane 이 뒤쪽 자리에 있다.
      sizes[gutter.index] = isCanonicalSide(edge) ? pair * ratio : pair * (1 - ratio);
      sizes[gutter.index + 1] = pair - sizes[gutter.index];
      const r = S().resizeSplit(loc.project.id, gutter.splitId, sizes);
      return r.ok
        ? {
            paneId: loc.pane.id,
            gutter: gutterEcho(layout, loc.pane.id, edge),
            sizes,
          }
        : r;
    },
  });

  register("pane.equalize", {
    description:
      "Even out a gutter — halves the two areas the seam divides (what double-clicking it does). Pass all:true to give every area along that seam's axis the same share instead of just the two neighbours.",
    triggers: { ko: "칸 균등 같은 크기 반반 균등화" },
    params: {
      pane: P.pane,
      edge: { ...P.edge, required: true },
      all: {
        type: "boolean",
        description: "Equalize every area along that seam's axis, not just the two neighbours",
      },
    },
    returns: "{ paneId, gutter:{pane,edge}(canonical), sizes }",
    message: () => tmsg("msg.pane.equalize"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'pane.equalize \'{"edge":"right"}\'',
      'pane.equalize \'{"pane":"pan-g2h3j4","edge":"bottom","all":true}\'',
    ],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("대상 pane 없음");
      const edge = p.edge as GutterSide;
      if (!EDGES.includes(edge)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `edge: ${EDGES.join(" | ")}`,
        };
      }
      const layout = loc.space.layout;
      const gutter = resolveGutter(layout, loc.pane.id, edge, paneIdOf);
      const current = gutter ? splitSizesOf(layout, gutter.splitId) : null;
      if (!gutter || !current) {
        return notFound(`그 모서리에 골이 없음: ${loc.pane.id}/${edge}`);
      }
      const sizes = [...current];
      if (p.all === true) {
        sizes.fill(1 / sizes.length);
      } else {
        const half = (sizes[gutter.index] + sizes[gutter.index + 1]) / 2;
        sizes[gutter.index] = half;
        sizes[gutter.index + 1] = half;
      }
      const r = S().resizeSplit(loc.project.id, gutter.splitId, sizes);
      return r.ok
        ? {
            paneId: loc.pane.id,
            gutter: gutterEcho(layout, loc.pane.id, edge),
            sizes,
          }
        : r;
    },
  });

  register("layout.apply", {
    description:
      "Apply a layout by building fresh spaces — never destroys existing spaces. Hierarchy: first-level spaces are independent switchable screens; second-level panes are the splits inside each space. preset dev = a terminal plus a browser side by side (if no browser program is installed, that pane is skipped and reported in skipped). preset facets = build the named spaces you pass in (spaces required). Verify by switching to a space with space.activate, then capturing with window.snapshot.",
    triggers: { ko: "화면 구성 레이아웃 적용 스페이스 배치 개발 화면 나란히 배치 dev facets" },
    params: {
      preset: {
        type: "string",
        enum: ["dev", "facets"],
        required: true,
        description:
          "dev = a terminal plus a browser side by side; facets = build the named spaces passed in spaces",
      },
      spaces: {
        type: "json",
        description:
          "Named spaces to build (required for facets): [{ title, panes?: [{ program, side? }] }]",
      },
      project: P.project,
    },
    returns:
      "{ projectId, spaces: [{ spaceId, title, panes: [{ paneId, program }] }], skipped? } — skipped lists panes dropped because their program is missing",
    message: (d) => tmsg("msg.layout.apply", { n: ((d.spaces as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      const out: CommandHint[] = [];
      const spaces = (d.spaces as { spaceId?: string }[] | undefined) ?? [];
      const skipped = (d.skipped as unknown[] | undefined) ?? [];
      // 건너뛴 pane 이 있으면(브라우저 미설치 등) 설치 경로를 먼저 제시한다.
      if (skipped.length)
        out.push({ cmd: "plugin.catalog", why: tmsg("hint.flow.layout.apply.install") });
      const first = spaces[0]?.spaceId;
      if (first)
        out.push({ cmd: `space.activate ${first}`, why: tmsg("hint.flow.layout.apply.activate") });
      out.push({ cmd: "window.snapshot", why: tmsg("hint.flow.layout.apply.snapshot") });
      return out;
    },
    examples: [
      "layout.apply dev",
      'layout.apply \'{"preset":"facets","spaces":[{"title":"docs","panes":[{"program":"browser"}]}]}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const skipped: {
        space: string;
        program: string;
        side?: Side;
        reason: string;
      }[] = [];
      let spaceSpecs: LayoutSpaceSpec[];
      if (p.preset === "dev") {
        // dev 축약 — 터미널 + 브라우저(우측). 터미널은 계약(설정 엔진)으로, 브라우저는 관례 id 로
        // 해소한다 — 코어는 특정 program 을 특권화하지 않는다. 어느 쪽이든 없으면 그 pane 만 건너뛰고
        // 사유를 남긴다(은폐 금지 — browser 와 대칭).
        const terminalId = resolveTerminalProgram();
        const browserId = findBrowserProgram();
        const panes: LayoutPaneSpec[] = [];
        if (terminalId) panes.push({ program: terminalId });
        else
          skipped.push({
            space: "dev",
            program: TERMINAL_CONTRACT.id,
            reason: tmsg("layout.skip.unregistered", { program: TERMINAL_CONTRACT.id }),
          });
        if (browserId) panes.push({ program: browserId, side: "right" });
        else
          skipped.push({
            space: "dev",
            program: "browser",
            side: "right",
            reason: tmsg("layout.skip.noBrowser"),
          });
        spaceSpecs = [{ title: "dev", panes }];
      } else {
        // facets — spaces 인자를 그대로 쓰는 별칭. spaces 필수.
        const raw = p.spaces;
        if (!Array.isArray(raw) || raw.length === 0) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "preset=facets 는 spaces 필요([{title,panes}])",
          };
        }
        spaceSpecs = raw as LayoutSpaceSpec[];
      }
      const builtSpaces: {
        spaceId: string;
        title: string;
        panes: { paneId: string; program: string }[];
      }[] = [];
      for (const spec of spaceSpecs) {
        const title = typeof spec.title === "string" ? spec.title : "";
        // 새 스페이스(빈 스페이스) — 첫 pane 을 명시 제어하려 program 없이 만든다. 기존 스페이스는 불변.
        const created = S().addContent(t.id);
        if (!created.ok) continue; // 프로젝트 확인 이후이므로 도달 불가(방어)
        const spaceId = created.contentId;
        const firstPaneId = created.groupId;
        if (title) S().renameContent(t.id, spaceId, title);
        const builtPanes: { paneId: string; program: string }[] = [];
        let firstFilled = false;
        for (const pane of spec.panes ?? []) {
          const program = pane.program;
          if (typeof program !== "string" || !getRegisteredProgram(program)) {
            skipped.push({
              space: title || spaceId,
              program: String(program),
              side: pane.side,
              reason: tmsg("layout.skip.unregistered", { program: String(program) }),
            });
            continue;
          }
          if (!firstFilled) {
            // 첫 pane = 스페이스의 초기(빈) pane 에 탭을 넣는다.
            S().addViewToGroup(t.id, program, firstPaneId);
            builtPanes.push({ paneId: firstPaneId, program });
            firstFilled = true;
          } else {
            // 이후 pane = 첫 pane 옆에 분할 생성.
            const r = S().splitWithNewView(t.id, firstPaneId, pane.side ?? "right", program);
            if (r.ok) builtPanes.push({ paneId: r.groupId, program });
          }
        }
        builtSpaces.push({ spaceId, title, panes: builtPanes });
      }
      return skipped.length
        ? { projectId: t.id, spaces: builtSpaces, skipped }
        : { projectId: t.id, spaces: builtSpaces };
    },
  });

  // ----- tab -----
  register("tab.list", {
    description: "List the tabs inside a pane.",
    params: { pane: P.pane },
    returns: "{ paneId, activeTabId, tabs[] }",
    message: (d) => tmsg("msg.tab.list", { n: ((d.tabs as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["tab.list"],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("pane 없음");
      return {
        paneId: loc.pane.id,
        activeTabId: loc.pane.activeTabId,
        tabs: loc.pane.tabs.map(serializeTab),
      };
    },
  });

  register("tab.open", {
    description:
      "Open a new tab in a pane by program id (terminal / claude / codex / a plugin view program). The answer waits until the view is mounted, so the returned tabId can be acted on immediately; mounted:false means it did not come up in time and commands aimed at it will not find it yet.",
    triggers: { ko: "탭 열기 탭 추가 claude 열기 터미널 열기" },
    params: {
      pane: P.pane,
      program: { ...P.program, required: true },
      mountTimeoutMs: {
        type: "number",
        description:
          "How long to wait for the view to become actionable (default 5000). 0 answers as soon as the tab exists — mounted will be false and commands aimed at the tab may not find it yet.",
      },
    },
    returns: "{ paneId, tabId, mounted }",
    message: () => tmsg("msg.tab.open"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['tab.open \'{"program":"claude"}\''],
    handler: async (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("pane 없음");
      const r = S().addViewToGroup(loc.project.id, p.program as Program, loc.pane.id);
      if (!r.ok) return r; // 실패 봉투에 mounted 를 섞지 않는다
      // 답이 ok 면 그 결과는 쓸 수 있어야 한다. 상태는 즉시 바뀌지만 플러그인 뷰는 다음
      // 렌더에 마운트되므로, 그 사이에 이 tabId 로 명령을 보내면 플러그인은 자기 뷰를
      // 모른다(실측: tab.open 직후 navigate 가 NO_VIEW). 마운트 신호를 기다렸다 답한다 —
      // 폴링이 아니라 마운트 그 지점이 깨운다.
      const wait = typeof p.mountTimeoutMs === "number" ? Math.max(0, p.mountTimeoutMs) : 5000;
      const mounted = wait > 0 ? await awaitViewMounted(r.viewId, wait) : false;
      return { paneId: r.groupId, tabId: r.viewId, mounted };
    },
  });

  register("tab.close", {
    danger: "destructive",
    description: "Close a tab — if it was the last tab in a pane, the pane is also removed. Refuses to close the last tab in a space.",
    triggers: { ko: "탭 닫기" },
    params: { tab: { ...P.tab, required: true } },
    returns: "{ tabId(closed), activePaneId, activeTabId }",
    message: () => tmsg("msg.tab.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['tab.close \'{"tab":"tab-k5m6n7"}\''],
    handler: (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound(`탭 없음: ${p.tab}`);
      return withTargets(S().closeView(loc.project.id, p.tab as string), {
        tabId: p.tab as string,
      });
    },
  });

  register("tab.activate", {
    description: "Activate (switch to) a specific tab.",
    triggers: { ko: "탭 전환 탭 선택 탭 활성화" },
    params: { tab: { ...P.tab, required: true } },
    returns: "{ tabId }",
    message: () => tmsg("msg.tab.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['tab.activate \'{"tab":"tab-k5m6n7"}\''],
    handler: (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound(`탭 없음: ${p.tab}`);
      return withTargets(
        transferViewFocus(activeSessionViewId(), p.tab as string, () =>
          S().setActiveView(loc.project.id, p.tab as string),
        ),
        { tabId: p.tab as string },
      );
    },
  });

  register("tab.rename", {
    description:
      "Set a custom label for a content tab. Overrides the dynamic content title (e.g. a browser page <title> keeps updating underneath; the override wins on display). Empty title clears the override and the dynamic title returns. Sidebar views use tab.label.set instead.",
    triggers: { ko: "탭 이름변경 탭명 변경 라벨" },
    params: {
      tab: { ...P.tab, required: true },
      title: { type: "string", description: "Custom label; empty to clear the override", required: true },
    },
    returns: "{ tabId, label }",
    message: (d) =>
      d.label ? tmsg("msg.tab.rename.set", { label: String(d.label) }) : tmsg("msg.tab.rename.cleared"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'tab.rename \'{"tab":"tab-k5m6n7","title":"작업 브라우저"}\'',
      'tab.rename \'{"tab":"tab-k5m6n7","title":""}\'',
    ],
    handler: (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound(`탭 없음: ${p.tab}`);
      return withTargets(
        S().renameView(loc.project.id, p.tab as string, p.title as string),
        { tabId: p.tab as string },
      );
    },
  });

  register("tab.maximize", {
    description:
      "Maximize a tab to fill the entire space. The split tree is preserved; only the display is toggled. Same as double-clicking a tab. Omit tab to maximize the active one.",
    triggers: { ko: "최대화 전체화면 탭 최대화 크게 보기" },
    params: { tab: P.tab },
    returns: "{ tabId }",
    message: () => tmsg("msg.tab.maximize"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['tab.maximize \'{"tab":"tab-k5m6n7"}\'', "tab.maximize"],
    handler: (p, ctx) => {
      const loc = p.tab ? locateTab(p.tab as string) : resolveCtx(ctx);
      if (!loc?.tab) return notFound(`탭 없음: ${p.tab ?? "(활성)"}`);
      const r = S().maximizeView(loc.project.id, loc.tab.id);
      return r.ok ? { tabId: r.viewId } : r;
    },
  });

  register("tab.restore", {
    description: "Exit tab maximize mode and restore the original split layout for the active space.",
    triggers: { ko: "최대화 해제 원래대로 레이아웃 복원" },
    params: { project: P.project },
    returns: "{ projectId, tabId(restored tab | null = was not maximized) }",
    message: (d) =>
      d.tabId ? tmsg("msg.tab.restore.restored") : tmsg("msg.tab.restore.none"),
    examples: ["tab.restore"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const r = S().restoreView(t.id);
      return r.ok ? { projectId: t.id, tabId: r.viewId } : r;
    },
  });

  register("tab.move", {
    description: "Move a tab to the zone position of the dst pane (center = move into that pane; other = split and create a new pane).",
    triggers: { ko: "탭 이동 다른 칸으로" },
    params: {
      tab: { ...P.tab, required: true },
      dst: { type: "string", description: "Destination pane id", required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ tabId, paneId(moved or created pane) }",
    message: () => tmsg("msg.tab.move"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['tab.move \'{"tab":"tab-k5m6n7","dst":"pan-g2h3j4","zone":"right"}\''],
    handler: (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound(`탭 없음: ${p.tab}`);
      const r = S().moveViewToGroup(
        loc.project.id,
        p.tab as string,
        p.dst as string,
        p.zone as DropZone,
      );
      return r.ok ? { tabId: p.tab as string, paneId: r.groupId } : r;
    },
  });

  // ----- status(뷰 보고 회신, R8) -----
  register("status.query", {
    description:
      "Query the status each view reports (R8 회신) — what setStatus / file dirty / terminal running pushed. Omit tab to list every reporting tab.",
    triggers: { ko: "상태 조회 뷰 상태 status 조회 무엇이 도는지" },
    params: { tab: P.tab },
    returns: "{ statuses: Array<{ tabId, code, message? }> }",
    message: (d) => tmsg("msg.status.query", { n: ((d.statuses as unknown[]) ?? []).length }),
    examples: ["status.query", 'status.query \'{"tab":"tab-k5m6n7"}\''],
    handler: (p) => {
      const only = p.tab as string | undefined;
      const statuses: { tabId: string; code: string; message?: string }[] = [];
      for (const t of S().projects)
        for (const c of t.spaces)
          for (const g of allGroups(c.layout))
            for (const v of g.tabs)
              if (v.status && (!only || v.id === only))
                statuses.push({
                  tabId: v.id,
                  code: v.status.code,
                  message: v.status.message,
                });
      return { statuses };
    },
  });

  // ----- term(터미널 입출력 — AI 의 눈과 손) -----
  register("term.read", {
    description:
      "Read terminal screen and scrollback text (TUI shows current screen only). Use to check command output.",
    triggers: { ko: "터미널 읽기 출력 확인 결과 보기" },
    params: {
      tab: { ...P.tab, description: "Target terminal tab id (omit = caller's context tab)" },
      lines: { type: "number", description: "Last N lines only (omit = all)" },
    },
    returns: "{ tabId, text }",
    message: (d) => tmsg("msg.term.read", { n: String(d.text ?? "").length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["term.read", 'term.read \'{"lines":50}\''],
    handler: (p, ctx) => {
      const r = resolveTermTab(p, ctx, terminalContextTab);
      if (!r) return notFound("터미널 탭 없음");
      const text = r.readBuffer(p.lines as number | undefined);
      if (text === undefined) return notFound(`터미널 준비 안 됨: ${r.tabId}`);
      return { tabId: r.tabId, text };
    },
  });

  register("term.send", {
    danger: "inject",
    description:
      "Inject raw key input into a terminal (for TUI control). Pass control characters via JSON escapes: \\r=Enter, \\u0003=^C, \\u001b[A=↑.",
    triggers: { ko: "터미널 입력 키 주입 TUI 조작 키 보내기" },
    params: {
      tab: { ...P.tab, description: "Target terminal tab id (omit = caller's context tab)" },
      text: { type: "string", description: "Bytes to inject (escapes allowed)", required: true },
    },
    returns: "{ tabId }",
    message: () => tmsg("msg.term.send"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['term.send \'{"text":"ls\\r"}\'', 'term.send \'{"text":"\\u0003"}\''],
    handler: (p, ctx) => {
      const r = resolveTermTab(p, ctx, terminalContextTab);
      if (!r) return notFound("터미널 탭 없음");
      if (!r.sendInput(p.text as string))
        return notFound(`터미널 준비 안 됨: ${r.tabId}`);
      return { tabId: r.tabId };
    },
  });

  register("term.exec", {
    danger: "inject",
    description:
      "Execute a shell command in a terminal (sends the text plus Enter). Returns immediately — it does not wait for the command to finish, so read the output a moment later with term.read.",
    triggers: { ko: "명령 실행 터미널 실행 셸 실행 커맨드 실행" },
    params: {
      tab: { ...P.tab, description: "Target terminal tab id (omit = caller's context tab)" },
      cmd: { type: "string", description: "Shell command to run", required: true },
    },
    returns: "{ tabId }",
    message: () => tmsg("msg.term.exec"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      // 실행은 즉시 돌아온다 — 출력은 잠시 후 그 탭을 읽어 확인한다.
      const tab = d.tabId as string | undefined;
      return [
        {
          cmd: tab ? `term.read '{"tab":"${tab}"}'` : "term.read",
          why: tmsg("hint.flow.term.exec.read"),
        },
      ];
    },
    examples: ['term.exec \'{"cmd":"git status"}\''],
    handler: (p, ctx) => {
      const r = resolveTermTab(p, ctx, terminalContextTab);
      if (!r) return notFound("터미널 탭 없음");
      if (!r.sendInput(`${p.cmd as string}\r`))
        return notFound(`터미널 준비 안 됨: ${r.tabId}`);
      return { tabId: r.tabId };
    },
  });

  register("term.cwd", {
    description: "Get the current working directory of a terminal tab (requires shell integration).",
    triggers: { ko: "현재 디렉토리 cwd 작업 폴더 터미널 경로" },
    params: {
      tab: { ...P.tab, description: "Target terminal tab id (omit = caller's context tab)" },
    },
    returns: "{ tabId, cwd|null }",
    message: (d) =>
      d.cwd ? tmsg("msg.term.cwd.path", { path: String(d.cwd) }) : tmsg("msg.term.cwd.none"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["term.cwd"],
    handler: (p, ctx) => {
      const r = resolveTermTab(p, ctx, terminalContextTab);
      if (!r) return notFound("터미널 탭 없음");
      return { tabId: r.tabId, cwd: r.getCwd() ?? null };
    },
  });

  // ----- bookmark -----
  register("bookmark.list", {
    description: "List saved browser bookmarks.",
    triggers: { ko: "즐겨찾기 목록 북마크 목록" },
    params: {},
    returns: "{ bookmarks: [{url,title}] }",
    message: (d) => tmsg("msg.bookmark.list", { n: ((d.bookmarks as unknown[]) ?? []).length }),
    examples: ["bookmark.list"],
    handler: () => ({ bookmarks: useBookmarks.getState().list }),
  });

  register("bookmark.add", {
    description: "Add a URL to browser bookmarks.",
    triggers: { ko: "즐겨찾기 추가 북마크 추가 저장" },
    params: {
      url: { type: "string", description: "URL", required: true },
      title: { type: "string", description: "Display name (omit = hostname)" },
    },
    returns: "{}",
    message: () => tmsg("msg.bookmark.add"),
    examples: ['bookmark.add \'{"url":"https://example.com"}\''],
    handler: (p) => {
      const url = p.url as string;
      const bm = useBookmarks.getState();
      if (!bm.has(url)) {
        const title =
          (p.title as string) ??
          (() => {
            try {
              return new URL(url).host;
            } catch {
              return url;
            }
          })();
        bm.toggle(url, title);
      }
      return {};
    },
  });

  register("bookmark.remove", {
    description: "Remove a URL from browser bookmarks.",
    triggers: { ko: "즐겨찾기 삭제 북마크 제거 삭제" },
    params: { url: { type: "string", description: "URL", required: true } },
    returns: "{}",
    message: () => tmsg("msg.bookmark.remove"),
    examples: ['bookmark.remove \'{"url":"https://example.com"}\''],
    handler: (p) => {
      useBookmarks.getState().remove(p.url as string);
      return {};
    },
  });

  // 파일을 여는 명령은 ui.intent.open 하나다(결부 문맥으로 배치까지 해소한다). 닫기는 tab.close —
  // 파일 탭도 탭이다.

  // ----- explorer(파일 탐색기) -----
  register("explorer.list", {
    description:
      "List direct children of a directory (same view as the file tree). Omit path to use the project root (falls back to HOME).",
    triggers: { ko: "파일 목록 디렉토리 목록 폴더 내용 파일 탐색" },
    params: {
      project: P.project,
      path: { type: "string", description: "Absolute directory path" },
    },
    returns: "{ projectId|null, root, children: [{name,dir}] }",
    message: (d) => tmsg("msg.explorer.list", { n: ((d.children as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["explorer.list", 'explorer.list \'{"path":"/tmp"}\''],
    handler: async (p, ctx) => {
      const t = resolveProject(p, ctx);
      const path = (p.path as string) ?? t?.root ?? null;
      const r = await invoke<{ root: string; children: object[] }>(
        "list_children",
        { path },
      );
      // 경로를 명시하면 프로젝트 없이도 답한다(HOME 폴백) — 그래서 이 축은 null 이 될 수 있다.
      return { projectId: t?.id ?? null, ...r };
    },
  });

  // ----- settings / theme -----
  // splitHeaderMode 는 탭 모드 고정(2026-06 결정)으로 표면에서 제외.
  // 터미널 외형(shell/font/cursor/scrollback/renderer)은 코어 설정이 아니다 — 터미널
  // 플러그인 설정(manifest configuration)이 소유한다(plugin.<id>.settings.* 로 노출).
  const SETTING_KEYS = [
    "language",
    "projectTabPosition",
    "iconSet",
    "iconBox",
    "focusIndicator",
    "railRelation",
    "railFill",
    "focusDim",
    "railSeamStyle",
    "appFontFamily",
    "windowZoom",
    "orchestratorAgent",
    "orchestratorModel",
  ] as const;

  register("settings.get", {
    description: "Retrieve all application settings.",
    triggers: { ko: "설정 확인 앱 설정 조회 환경설정" },
    params: {},
    returns: `{ ${SETTING_KEYS.join(", ")}, bg }`,
    message: () => tmsg("msg.settings.get"),
    examples: ["settings.get"],
    handler: () => {
      const s = useSettings.getState();
      return {
        language: s.language,
        projectTabPosition: s.projectTabPosition,
        iconSet: s.iconSet,
        iconBox: s.iconBox,
        focusIndicator: s.focusIndicator,
        railRelation: s.railRelation,
        railFill: s.railFill,
        focusDim: s.focusDim,
        railSeamStyle: s.railSeamStyle,
        appFontFamily: s.appFontFamily,
        windowZoom: s.windowZoom,
        orchestratorAgent: s.orchestratorAgent,
        orchestratorModel: s.orchestratorModel,
        // 선택 가능한 아이콘 셋 목록(내장 + 활성 플러그인 등록분).
        iconSets: Object.values(useIconRegistry.getState().sets).map((x) => ({
          id: x.id,
          name: x.name,
        })),
        theme: useTheme.getState().current,
        themeMode: useTheme.getState().effectiveMode,
      };
    },
  });

  register("settings.set", {
    description: `Change an application setting. key: ${SETTING_KEYS.join("|")}`,
    triggers: { ko: "설정 변경 설정 바꾸기 환경설정 변경 폰트 크기 언어" },
    params: {
      key: {
        type: "string",
        description: "Setting key",
        enum: SETTING_KEYS,
        required: true,
      },
      value: {
        type: "json",
        description:
          "Value — language:ko|en, projectTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, railRelation:tint|moment|stroke (rail-pane relation surface — tint fill only, moment flash on rebind, stroke outline+label), railFill:none|faint (bound-pane background in stroke mode — none is the default, faint is a 1% accent tint), focusDim:boolean (spotlight — every pane dims except the active one), railSeamStyle:seam|edge (how a manufactured adjacency is marked: seam dashes the inner shared edge, edge dashes the outer right edge), appFontFamily:string (CSS font-family stack), windowZoom:number (0.5-2.0 — whole-window zoom factor applied to the main webview and every child webview), orchestratorAgent:string (agent CLI command or path the natural-language console spawns), orchestratorModel:string (--model alias for the agent; empty = CLI default)",
        required: true,
      },
    },
    returns: "{ key, value }",
    message: (d) => tmsg("msg.settings.set", { key: String(d.key) }),
    errors: ["INVALID_PARAMS"],
    examples: [
      'settings.set \'{"key":"projectTabPosition","value":"left"}\'',
      'settings.set \'{"key":"iconBox","value":true}\'',
    ],
    handler: (p) => {
      const s = useSettings.getState();
      const key = p.key as (typeof SETTING_KEYS)[number];
      const v = p.value;
      const bad = (need: string) => ({
        ok: false as const,
        code: "INVALID_PARAMS" as const,
        message: `${key}: ${need} 이어야 함`,
      });
      switch (key) {
        case "language":
          if (v !== "ko" && v !== "en") return bad("ko|en");
          s.setLanguage(v);
          break;
        case "projectTabPosition":
          if (v !== "top" && v !== "left") return bad("top|left");
          s.setProjectTabPosition(v);
          break;
        case "iconSet":
          if (typeof v !== "string" || !v.trim())
            return bad("string(셋 id — settings.get 의 iconSets 참조)");
          s.setIconSet(v.trim());
          break;
        case "iconBox":
          if (typeof v !== "boolean") return bad("boolean");
          s.setIconBox(v);
          break;
        case "focusIndicator":
          if (v !== "outline" && v !== "corners") return bad("outline|corners");
          s.setFocusIndicator(v);
          break;
        case "railRelation":
          if (v !== "tint" && v !== "moment" && v !== "stroke")
            return bad("tint|moment|stroke");
          s.setRailRelation(v);
          break;
        case "railFill":
          if (v !== "none" && v !== "faint") return bad("none|faint");
          s.setRailFill(v);
          break;
        case "focusDim":
          if (typeof v !== "boolean") return bad("boolean");
          s.setFocusDim(v);
          break;
        case "railSeamStyle":
          if (v !== "seam" && v !== "edge") return bad("seam|edge");
          s.setRailSeamStyle(v);
          break;
        case "appFontFamily":
          if (typeof v !== "string" || !v.trim())
            return bad("string(CSS font-family 스택)");
          s.setAppFontFamily(v.trim());
          break;
        case "windowZoom":
          if (typeof v !== "number" || !Number.isFinite(v))
            return bad("number(0.5~2.0 클램프)");
          s.setWindowZoom(v);
          applyWindowZoom(useSettings.getState().windowZoom);
          break;
        case "orchestratorAgent":
          if (typeof v !== "string" || !v.trim())
            return bad("string(에이전트 CLI 명령 또는 경로)");
          s.setOrchestratorAgent(v.trim());
          break;
        case "orchestratorModel":
          if (typeof v !== "string") return bad('string(모델 별칭 — "" = CLI 기본)');
          s.setOrchestratorModel(v.trim());
          break;
      }
      return { key, value: v };
    },
  });

  register("window.info", {
    description: "Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).",
    params: {},
    returns: "{ x, y, w, h, scale }",
    message: (d) => tmsg("msg.window.info", { w: Number(d.w), h: Number(d.h) }),
    examples: ["window.info"],
    handler: async () => {
      const win = currentWindow();
      const [pos, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      return { x: pos.x, y: pos.y, w: size.width, h: size.height, scale };
    },
  });

  register("window.move", {
    description: "Move the window to a screen position in physical pixels (for automation and multi-monitor validation).",
    params: {
      x: { type: "number", description: "Physical x coordinate", required: true },
      y: { type: "number", description: "Physical y coordinate", required: true },
    },
    returns: "{ x, y }",
    message: (d) => tmsg("msg.window.move", { x: Number(d.x), y: Number(d.y) }),
    examples: ['window.move \'{"x":0,"y":0}\''],
    handler: async (p) => {
      await currentWindow().setPhysicalPosition(p.x as number, p.y as number);
      return { x: p.x, y: p.y };
    },
  });

  register("window.resize", {
    description: "Resize the window to a physical pixel size (for automation and resize-path E2E — drives the native window resize, the same path as edge-drag, which pane.resize does not exercise).",
    params: {
      w: { type: "number", description: "Physical width", required: true },
      h: { type: "number", description: "Physical height", required: true },
    },
    returns: "{ w, h }",
    message: (d) => tmsg("msg.window.resize", { w: Number(d.w), h: Number(d.h) }),
    examples: ['window.resize \'{"w":1200,"h":800}\''],
    handler: async (p) => {
      await currentWindow().setPhysicalSize(p.w as number, p.h as number);
      return { w: p.w, h: p.h };
    },
  });

  register("window.focus", {
    description:
      "Bring a window to the front and focus it. Without label, focuses the window this command runs in (clears inactive state for automation); with label, focuses that window (see window.list).",
    triggers: { ko: "창 포커스 창 활성화 창 앞으로" },
    params: { label: P.windowLabel },
    returns: "{ focused: true }",
    message: () => tmsg("msg.window.focus"),
    examples: ["window.focus", 'window.focus \'{"label":"w-<uuid>"}\''],
    errors: ["TARGET_NOT_FOUND"],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(`창 없음: ${label}`);
      if (label !== currentWindowLabel()) {
        await invoke("window_focus", { label });
        return { focused: true };
      }
      // setFocus 는 창을 key 로 만들 뿐 — 앱 전면 전환은 네이티브 자기 활성화로.
      await invoke("window_activate");
      await currentWindow().setFocus();
      return { focused: true };
    },
  });

  register("window.maximize", {
    description:
      "Maximize a window to fill the screen (native window maximize — distinct from tab.maximize, which only enlarges one tab within a space). Without label, targets the window this command runs in; with label, targets that window (see window.list). Pass off:true to restore (unmaximize).",
    triggers: { ko: "창 최대화 전체화면 창 키우기 최대화 해제" },
    params: {
      label: P.windowLabel,
      off: { type: "boolean", description: "Restore (unmaximize) instead of maximizing" },
    },
    returns: "{ maximized: boolean }",
    message: (d) =>
      d.maximized ? tmsg("msg.window.maximize") : tmsg("msg.window.maximize.off"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "window.maximize",
      'window.maximize \'{"off":true}\'',
      'window.maximize \'{"label":"w-<uuid>"}\'',
    ],
    handler: async (p) => {
      const off = p.off === true;
      const label = windowTarget(p);
      const win = await windowByLabel(label);
      if (!win) return notFound(`창 없음: ${label}`);
      if (off) await win.unmaximize();
      else await win.maximize();
      return { maximized: !off };
    },
  });

  register("window.reload", {
    description:
      "Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted).",
    triggers: { ko: "앱 리로드 새로고침 플러그인 재시작 코드 반영" },
    params: {},
    returns: "{ reloaded: true }",
    message: () => tmsg("msg.window.reload"),
    examples: ["window.reload"],
    handler: async () => {
      // 리로드 전에 이 창의 child 표면(브라우저)을 먼저 숨긴다 — 렌더러 재부팅 구간
      // (JS 공백 ~150ms)에 이전 브라우저가 그대로 떠 있던 유령 창은 부트 서두 숨김만으로는
      // 닫히지 않는다(그 숨김은 새 렌더러 진입 후에야 돈다). 숨김 완료가 리로드보다 먼저다.
      try {
        const stale = await invoke<string[]>("webview_list");
        const prefix = browserLabelPrefix();
        const mine = stale.filter((l) => l.startsWith(prefix));
        await Promise.all(
          mine.map((l) =>
            invoke("webview_visible", { label: l, visible: false }).catch(() => {}),
          ),
        );
        if (mine.length > 0)
          await invoke("activity_publish", {
            kind: "webview.lifecycle",
            source: "webview",
            payload: {
              event: "hidden-at-reload",
              labels: mine,
              origin: "internal",
              message: `· webview hidden before reload ×${mine.length}`,
            },
          }).catch(() => {});
      } catch {
        /* 표면 없음/조회 실패 — 리로드를 막지 않는다 */
      }
      // 소켓 응답을 먼저 흘려보낸 뒤 다음 틱에 리로드(응답 유실 방지).
      setTimeout(() => window.location.reload(), 30);
      return { reloaded: true };
    },
  });

  // ── 멀티 윈도우 ──────────────────────────────────────────────────────────
  register("window.open", {
    description:
      "Open a new project window for a project root (P6: if the root is already open in some window, no window is created — that window is focused and returned as existingWindow). root is required unless mode orchestrator, which brings the control plane (main) forward instead — opening and creating projects live there; empty project windows do not exist.",
    triggers: { ko: "새 창 창 열기 새 윈도우 프로젝트 새 창 오케스트레이터 창" },
    params: {
      root: {
        type: "string",
        description: "Project root to open in the new window (absolute path).",
      },
      alias: {
        type: "string",
        description: "Display alias for the project tab (defaults to the folder name).",
      },
      shell: {
        type: "string",
        description: "Shell binary for the project's terminals (defaults to the user shell).",
      },
      mode: {
        type: "string",
        description:
          "orchestrator = bring the control plane (main) forward. Mutually exclusive with root.",
        enum: ["orchestrator"],
      },
    },
    returns: "{ label } | { existingWindow } (root already open — focused instead)",
    message: (d) =>
      d.existingWindow ? tmsg("msg.window.open.existing") : tmsg("msg.window.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      if (d.code) return [];
      // 새 창의 라벨을 겨냥해 명령을 보내는 법을 제시한다(--window <label>).
      const label = (d.label as string | undefined) ?? (d.existingWindow as string | undefined);
      if (!label) return [];
      return [
        {
          cmd: `--window ${label} state.tree`,
          why: tmsg("hint.flow.window.open.target", { label }),
        },
      ];
    },
    examples: [
      'window.open \'{"root":"/Users/me/work"}\'',
      'window.open \'{"mode":"orchestrator"}\'',
    ],
    handler: async (p) => {
      if (p.mode === "orchestrator") {
        if (p.root) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "mode=orchestrator 는 root 와 함께 쓸 수 없음",
          };
        }
        // 컨트롤 플레인은 main 하나뿐(NAMING 4b 예약어) — 있으면 앞으로, 사용자가 닫았으면
        // 같은 예약 라벨로 재개설한다(부트가 라벨로 분기하므로 init 불요).
        const labels = await invoke<string[]>("window_list");
        if (labels.includes("main")) {
          await invoke("window_focus", { label: "main" }).catch(() => {});
          return { existingWindow: "main" };
        }
        await invoke("window_create", { label: "main" });
        return { label: "main" };
      }
      // 빈 워크스페이스 창은 없다 — 프로젝트 열기·생성은 컨트롤 플레인(main)의 표면이다.
      if (!p.root) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "root 필요 — 프로젝트 열기·생성은 오케스트레이터(main)에서",
        };
      }
      let root: string;
      try {
        root = await validateProjectRoot(p.root as string);
      } catch (e) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: String(e),
        };
      }
      // P6 선검사: 이미 열려 있으면 창을 만들지 않고 소유 창 포커스(중복 창 0).
      // 검사↔생성 사이 레이스는 새 창 부트의 claim 이 최종 시행(실패 시 빈 상태로 열화).
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const owner = owners.owners.find((o) => o.root === root)?.window;
      if (owner) {
        await invoke("window_focus", { label: owner }).catch(() => {});
        return { existingWindow: owner };
      }
      let init = `root=${encodeURIComponent(root)}`;
      if (typeof p.alias === "string" && p.alias) init += `&alias=${encodeURIComponent(p.alias)}`;
      if (typeof p.shell === "string" && p.shell) init += `&shell=${encodeURIComponent(p.shell)}`;
      return { label: await invoke<string>("window_create", { init }) };
    },
  });

  register("window.list", {
    description: "List open window labels. Use to discover targets for commands that accept a window argument.",
    triggers: { ko: "창 목록 윈도우 목록 열린 창" },
    params: {},
    returns: "{ labels }",
    message: (d) => tmsg("msg.window.list", { n: ((d.labels as unknown[]) ?? []).length }),
    examples: ["window.list"],
    handler: async () => ({ labels: await invoke<string[]>("window_list") }),
  });

  register("window.projects", {
    description:
      "Map open windows to the project each one hosts (root path + name + window label). The meaning layer over window.list — use it first to pick the right window before targeting commands with --window. Same answer from any window (process-wide registry).",
    triggers: { ko: "창 프로젝트 매핑 어느 창 프로젝트 열림 창별 프로젝트" },
    params: {},
    returns: "{ projects: [{ root, name, window }] }",
    message: (d) => tmsg("msg.window.projects", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["window.projects"],
    handler: async () => {
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const projects = owners.owners.map((o) => ({
        root: o.root,
        name: o.root.split("/").filter(Boolean).pop() ?? o.root,
        window: o.window,
      }));
      return { projects };
    },
  });

  register("window.close", {
    description:
      "Close a window. Omit label to close the window this command is addressed to — the envelope already names it, so the common case needs no argument. An unknown label is TARGET_NOT_FOUND, not an internal failure.",
    triggers: { ko: "창 닫기 윈도우 닫기" },
    params: { label: P.windowLabel },
    returns: "{ ok, label }",
    message: () => tmsg("msg.window.close"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["window.close", 'window.close \'{"label":"w-<uuid>"}\''],
    handler: async (p) => {
      // 봉투가 이미 대상 창을 지목했는데 label 을 또 요구하면, 그 창에 대고 부른 close 가
      // 인자 누락으로 죽는다(실측: e2e 가 자기 창을 못 닫아 실행할 때마다 뷰가 쌓였다).
      // 나머지 표면과 같은 규칙을 따른다 — 생략 = 지금 대상.
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(`창 없음: ${label}`);
      if (label === currentWindowLabel()) {
        // 자기를 파괴하는 명령은 답을 먼저 흘린다 — 답할 통로가 그 파괴로 함께 죽기 때문이다
        // (실측: 자기 창 close 가 WINDOW_DESTROYED 로 돌아와, 닫혔는데도 호출자는 실패로 읽었다).
        // window.reload 가 같은 이유로 같은 모양을 쓴다.
        setTimeout(() => void invoke("window_close", { label }), 30);
        return { ok: true, label };
      }
      await invoke("window_close", { label });
      return { ok: true, label };
    },
  });

  register("window.occlusion", {
    description:
      "Toggle occlusion detection. When false, rendering continues even when fully covered by other apps (for continuous background capture — note battery cost). Not needed for normal use; snapshot/record disable it automatically during capture.",
    params: {
      enabled: {
        type: "boolean",
        description: "Occlusion detection on (default) / off",
        required: true,
      },
    },
    returns: "{ occlusion }",
    message: (d) =>
      d.occlusion ? tmsg("msg.window.occlusion.on") : tmsg("msg.window.occlusion.off"),
    examples: ['window.occlusion \'{"enabled":false}\''],
    handler: async (p) => {
      const enabled = !!p.enabled;
      await invoke("plugin:webview-capture|set_occlusion", { enabled });
      return { occlusion: enabled };
    },
  });

  register("window.layers", {
    description:
      "Dump the window's native view hierarchy (class / frame / hidden, indented text). Ground truth for layer diagnostics — verify a native child webview's actual bounds and z-order against the DOM slot (e.g. divider-drag freeze, hole-punch mismatch).",
    triggers: {
      ko: "네이티브 뷰 계층 레이어 덤프 child 위치 진단",
    },
    params: {},
    returns: "{ hierarchy } — indented text, one view per line",
    message: () => tmsg("msg.window.layers"),
    examples: ["window.layers"],
    handler: async () => {
      const hierarchy = await invoke<string>("webview_debug_hierarchy");
      return { hierarchy };
    },
  });

  register("window.monitors", {
    description:
      "Monitor and window placement facts (physical px): every monitor's rect/scale/name and every window's rect, focus state, and owning monitor index. Facts only — placement strategy is layout.suggest, execution is window.place (same coordinate space).",
    triggers: {
      ko: "모니터 목록 해상도 창 배치 현황 듀얼 모니터 파악",
    },
    params: {},
    returns:
      "{ monitors: [{index,name,x,y,w,h,scale}], windows: [{label,title,x,y,w,h,focused,monitor}] }",
    message: (d) =>
      tmsg("msg.window.monitors", {
        n: ((d.monitors as unknown[]) ?? []).length,
        m: ((d.windows as unknown[]) ?? []).length,
      }),
    examples: ["window.monitors"],
    handler: async () => {
      return (await invoke("window_monitors")) as object;
    },
  });

  register("window.place", {
    description:
      "Place a window at an exact frame (physical px — the window.monitors coordinate space). Position and size applied once. Use layout.suggest output directly. The OS may clamp frames into the usable area (e.g. below the macOS menu bar) — read back window.monitors for the settled frame.",
    triggers: {
      ko: "창 배치 이동 모니터로 옮기기 위치 지정",
    },
    params: {
      label: P.windowLabel,
      x: { type: "number", description: "Left edge (physical px)", required: true },
      y: { type: "number", description: "Top edge (physical px)", required: true },
      w: { type: "number", description: "Width (physical px)", required: true },
      h: { type: "number", description: "Height (physical px)", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.window.place"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'window.place \'{"x":0,"y":0,"w":2560,"h":1440}\'',
      'window.place \'{"label":"main","x":2560,"y":0,"w":2560,"h":1440}\'',
    ],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(`창 없음: ${label}`);
      await invoke("window_place", { label, x: p.x, y: p.y, w: p.w, h: p.h });
      return {};
    },
  });

  register("layout.suggest", {
    description:
      "Suggest window placements from current monitor/window facts (pure strategy — nothing moves). strategy spread: orchestrator windows take a monitor free of project windows whole (or the right third alongside on a single monitor); project windows fill their own monitor. strategy grid: tile all windows on the first monitor. Feed each placement to window.place to execute.",
    triggers: {
      ko: "창 배치 제안 전략 모니터 분배 오케스트레이터 배치",
    },
    params: {
      strategy: {
        type: "string",
        description: "Placement strategy",
        enum: ["spread", "grid"],
        default: "spread",
      },
      roles: {
        type: "json",
        description:
          'Optional label→role map, e.g. {"main":"orchestrator"} — unlisted windows count as project windows',
      },
    },
    returns: "{ placements: [{label,monitor,x,y,w,h}] }",
    message: (d) => tmsg("msg.layout.suggest", { n: ((d.placements as unknown[]) ?? []).length }),
    examples: [
      'layout.suggest \'{"strategy":"spread","roles":{"main":"orchestrator"}}\'',
    ],
    handler: async (p) => {
      const facts = (await invoke("window_monitors")) as {
        monitors: MonitorFact[];
        windows: WindowFact[];
      };
      const placements = suggestLayout({
        monitors: facts.monitors,
        windows: facts.windows,
        strategy: (p.strategy as "spread" | "grid") ?? "spread",
        roles: (p.roles as Record<string, "orchestrator" | "project">) ?? undefined,
      });
      return { placements };
    },
  });

  register("activity.recent", {
    description:
      "Query the app-wide activity stream (P12 execution visibility): registry command executions (command/source/danger/duration/outcome — param keys only, no values), terminal command start/finish, AI turn ends, view activations. Cursor with since (exclusive seq) to fetch only new entries; entries carry monotonic seq + epoch-ms ts. Same answer from any window (process-wide singleton hub).",
    triggers: {
      ko: "활동 피드 실행 기록 최근 명령 스트림 조회 오케스트레이터",
    },
    params: {
      since: {
        type: "number",
        description: "Return entries with seq greater than this (backfill cursor). Omit for latest.",
      },
      limit: {
        type: "number",
        description: "Maximum entries to return (default 200)",
        default: 200,
      },
    },
    returns: "{ entries: [{ seq, ts, kind, source, payload }] }",
    message: (d) => tmsg("msg.activity.recent", { n: ((d.entries as unknown[]) ?? []).length }),
    examples: [
      'activity.recent \'{"limit":20}\'',
      'activity.recent \'{"since":1234}\'',
    ],
    // §5 R2: 조회도 사실이다 — 기록된다(선형 증가일 뿐 되먹임 아님. 낭독 루프는 tts 축이
    // 차단). 컴포넌트 자기 백필은 호출측이 origin:"internal" 로 선언(노출만 낮아짐).
    handler: async (p) => {
      const entries = await invoke("activity_recent", {
        since: p.since ?? null,
        limit: p.limit ?? 200,
      });
      return { entries };
    },
  });

  register("window.themeScan", {
    description:
      "Measure whether a dark/light theme transition is atomic across screen regions. Records the toggle, then reports each region's transition frame and how many frames they are out of sync (a torn frame is chrome already switched while content has not). Idempotent — replaces ad-hoc capture scripts. Restores the original theme when done.",
    triggers: {
      ko: "테마 전환 검사 원자성 깜빡임 tear 측정 다크 라이트 토글 회귀",
    },
    params: {
      theme: {
        type: "string",
        description: "Theme name to scan (default: current theme)",
      },
      from: {
        type: "string",
        description: "Starting mode (default dark)",
        enum: ["light", "dark"],
      },
      to: {
        type: "string",
        description: "Ending mode (default light)",
        enum: ["light", "dark"],
      },
      frames: { type: "number", description: "Frames to capture (default 40)" },
      intervalMs: {
        type: "number",
        description: "Frame interval in ms (default 16 ≈ one display frame)",
      },
      applyAtMs: {
        type: "number",
        description: "Delay after recording starts before toggling (default 250)",
      },
      settleMs: {
        type: "number",
        description: "Settle wait after setting the start mode (default 800)",
      },
      skipCapture: {
        type: "boolean",
        description:
          "Measure latency only (applyJsMs, applyReflowMs) and skip frame capture — fast, robust even when the window is backgrounded. For A/B latency tuning.",
      },
      regions: {
        type: "json",
        description:
          "Named fractional rects {name:{x0,y0,x1,y1}} (0..1). Default samples chrome top bar, center content, and left sidebar.",
      },
    },
    returns:
      "{ frames, frameMs (measured capture interval), spreadFrames, spreadMs, atomic, regions:[{name,start,end,transitionFrame}] }",
    message: (d) =>
      d.atomic !== undefined
        ? d.atomic
          ? tmsg("msg.window.themeScan.atomic")
          : tmsg("msg.window.themeScan.torn", { n: Number(d.spreadFrames) })
        : tmsg("msg.window.themeScan"),
    examples: [
      "window.themeScan",
      'window.themeScan \'{"theme":"Midnight","frames":48}\'',
    ],
    handler: async (p) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const ts = useTheme.getState();
      const theme = (p.theme as string | undefined) ?? ts.current;
      const startMode = (p.from as "light" | "dark" | undefined) ?? "dark";
      const endMode = (p.to as "light" | "dark" | undefined) ?? "light";
      // 기본값은 RPC 10s 안에 여유로 들어오게 보수적으로(네이티브 캡처가 프레임당 ~55ms 로
      // intervalMs 보다 느리고 가끔 stall — 전환은 3~5프레임이라 20프레임이면 충분).
      const frames = (p.frames as number | undefined) ?? 20;
      const intervalMs = (p.intervalMs as number | undefined) ?? 16;
      const applyAtMs = (p.applyAtMs as number | undefined) ?? 180;
      const settleMs = (p.settleMs as number | undefined) ?? 600;
      const regionMap =
        (p.regions as Record<
          string,
          { x0: number; y0: number; x1: number; y1: number }
        >) ?? {
          // 크롬 상단바 / 중앙 콘텐츠(에디터·터미널) / 좌측 사이드바 — tear 를 드러내는 세 구역.
          top: { x0: 0.3, y0: 0.0, x1: 0.95, y1: 0.06 },
          center: { x0: 0.45, y0: 0.15, x1: 0.95, y1: 0.85 },
          left: { x0: 0.02, y0: 0.2, x1: 0.22, y1: 0.85 },
        };
      const names = Object.keys(regionMap);
      const regionList = names.map((n) => regionMap[n]);

      // 원래 테마/모드 — 검사 후 복원(부수효과 없는 멱등 호출).
      const prevTheme = ts.current;
      const prevMode = ts.effectiveMode;

      let stage = "start";
      try {
        stage = "path";
        const { tempDir, join } = frameworkPath;
        const dir = await join(
          await tempDir(),
          "soksak",
          `themescan-${Date.now()}`,
        );

        // 1) 시작 모드로 세팅 + settle.
        stage = "applyStart";
        useTheme.getState().apply(theme, startMode);
        await sleep(settleMs);
        // 1b) clean 지연 측정(캡처 전, 동시 캡처가 rAF 를 느리게 해 오염되지 않게). rAF 대신 강제
        // reflow(offsetHeight)로 동기 style recalc+layout 을 잰다 — 백그라운드 창에서도 견고
        // (paint/composite 는 제외되나 recalc+layout 이 테마 변경의 주 비용). applyJsMs=동기 JS
        // (플러그인 theme.changed 핸들러), applyReflowMs=그 위에 recalc+layout 까지.
        stage = "measurePaint";
        const applyT0 = performance.now();
        useTheme.getState().apply(theme, endMode);
        const applyJsMs = performance.now() - applyT0;
        void document.documentElement.offsetHeight;
        const applyReflowMs = performance.now() - applyT0;
        // skipCapture: 캡처 없이 지연만 — 빠르고 견고(가려진 창·헤드리스에서도). 최적화 A/B 용.
        if (p.skipCapture) {
          useTheme.getState().apply(prevTheme, prevMode);
          return {
            applyJsMs: Math.round(applyJsMs),
            applyReflowMs: Math.round(applyReflowMs),
            skipped: "capture",
          };
        }
        // 캡처 패스를 위해 다시 startMode 로 되돌리고 짧게 settle.
        useTheme.getState().apply(theme, startMode);
        await sleep(250);
        // 2) 녹화 시작(비대기) → applyAtMs 후 끝 모드로 토글 → 녹화 완료 대기.
        stage = "record";
        const recT0 = performance.now();
        const recP = invoke<number>("plugin:webview-capture|record", {
          dir,
          frames,
          intervalMs,
        });
        await sleep(applyAtMs);
        useTheme.getState().apply(theme, endMode);
        const n = await recP;
        // 실측 프레임 간격(네이티브 캡처가 intervalMs 보다 느릴 수 있음 — tear ms 는 이것 기준).
        const realFrameMs = n > 0 ? (performance.now() - recT0) / n : intervalMs;
        // 3) 프레임별 영역 명도 → tear 판정.
        stage = "analyze";
        const grid = await invoke<number[][]>(
          "plugin:webview-capture|analyze_regions",
          { dir, regions: regionList },
        );
        // 4) 원래 테마 복원.
        useTheme.getState().apply(prevTheme, prevMode);

        stage = "interpret";
        const round = (v: number) => Math.round(v);
        const per = names.map((name, c) => {
          const start = grid[0]?.[c] ?? 0;
          const end = grid[grid.length - 1]?.[c] ?? 0;
          const mid = (start + end) / 2;
          const rising = end >= start;
          let transitionFrame = -1;
          for (let f = 0; f < grid.length; f++) {
            const v = grid[f]?.[c] ?? 0;
            if (rising ? v >= mid : v <= mid) {
              transitionFrame = f;
              break;
            }
          }
          return { name, start: round(start), end: round(end), transitionFrame };
        });
        const tfs = per.map((r) => r.transitionFrame).filter((f) => f >= 0);
        const minTf = tfs.length ? Math.min(...tfs) : 0;
        const maxTf = tfs.length ? Math.max(...tfs) : 0;
        const spreadFrames = maxTf - minTf;
        return {
          frames: n,
          frameMs: Math.round(realFrameMs),
          applyJsMs: Math.round(applyJsMs),
          applyReflowMs: Math.round(applyReflowMs),
          spreadFrames,
          spreadMs: Math.round(spreadFrames * realFrameMs),
          atomic: spreadFrames === 0,
          regions: per,
        };
      } catch (e) {
        // 행이 아니라 실패면 단계와 함께 회신(타임아웃으로 침묵하지 않게).
        try {
          useTheme.getState().apply(prevTheme, prevMode);
        } catch {
          /* 복원 실패는 부차 */
        }
        return { error: String(e), stage };
      }
    },
  });

  register("theme.list", {
    description:
      "List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons.",
    triggers: { ko: "테마 목록 테마 보기 사용 가능 테마" },
    params: {},
    returns:
      "{ current, mode, themes:[{name,defaultMode,modes,source,warnings,relation}], rejected }",
    message: (d) => tmsg("msg.theme.list", { n: ((d.themes as unknown[]) ?? []).length }),
    examples: ["theme.list"],
    handler: () => {
      const s = useTheme.getState();
      return {
        current: s.current,
        mode: s.effectiveMode,
        themes: Object.values(s.themes).map((th) => ({
          name: th.name,
          defaultMode: th.defaultMode,
          modes: th.colorsAlt ? ["light", "dark"] : [th.defaultMode],
          source: th.source,
          warnings: s.warnings[th.name] ?? [],
          relation: th.relation,
        })),
        rejected: s.rejected,
      };
    },
  });

  register("theme.apply", {
    description: "Apply a theme (replaces all token slots). Omit mode to keep the current mode.",
    triggers: { ko: "테마 적용 테마 바꾸기 다크 모드 라이트 모드 색 테마" },
    params: {
      name: { type: "string", description: "Theme name (see theme.list)", required: true },
      mode: { type: "string", description: "Color mode", enum: ["light", "dark"] },
    },
    returns: "{ name, mode }",
    message: (d) => tmsg("msg.theme.apply", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['theme.apply \'{"name":"Paper"}\'', 'theme.apply \'{"name":"Midnight","mode":"light"}\''],
    handler: (p) => {
      const s = useTheme.getState();
      const ok2 = s.apply(p.name as string, p.mode as "light" | "dark" | undefined);
      if (!ok2) return notFound(`테마 없음: ${p.name}`);
      const cur = useTheme.getState();
      return { name: cur.current, mode: cur.effectiveMode };
    },
  });

  register("theme.reload", {
    description: "Re-scan the external theme directory (~/.soksak/themes) and re-apply the current theme.",
    triggers: { ko: "테마 새로고침 테마 리로드 외부 테마 재스캔" },
    params: {},
    returns: "{ count, rejected }",
    message: (d) => tmsg("msg.theme.reload", { n: Number(d.count) }),
    examples: ["theme.reload"],
    handler: async () => {
      await useTheme.getState().reload();
      const s = useTheme.getState();
      return { count: Object.keys(s.themes).length, rejected: s.rejected };
    },
  });

  register("theme.install", {
    description: "Install a theme JSON file into ~/.soksak/themes (immediately usable if validation passes).",
    triggers: { ko: "테마 설치 테마 추가 외부 테마 설치" },
    params: {
      path: { type: "string", description: "Absolute path to theme .json file", required: true },
    },
    returns: "{ installed(install path), rejected? }",
    message: (d) =>
      d.rejected
        ? tmsg("msg.theme.install.rejected")
        : tmsg("msg.theme.install.installed", { path: String(d.installed) }),
    errors: ["INTERNAL"],
    examples: ['theme.install \'{"path":"/tmp/dracula.json"}\''],
    handler: async (p) => {
      const installed = await useTheme.getState().install(p.path as string);
      const s = useTheme.getState();
      const reject = s.rejected.find((r) => r.file === installed);
      return reject ? { installed, rejected: reject.errors } : { installed };
    },
  });

  // ----- 분권 카탈로그(파일 분리 — 단일 진실은 동일 registry) -----
  registerFsWatchCatalog();
  registerHealthCatalog();
  registerCaptureCatalog();
  registerPluginCatalog();
  registerDaemonCatalog();
  registerUpdateCatalog();
  registerUiCatalog();
  registerProjectionCatalog();
  registerDomCatalog();
  registerDataCatalog();
  registerPtySessionCatalog();
  registerSecretsCatalog();
  registerAiSessionCatalog();
  registerTurnCatalog();
  registerNetworkCatalog();
  registerMediaCatalog();
  registerClipboardCatalog();
  registerNotifyCatalog();
  registerScheduleCatalog();
  registerServiceCatalog();
  registerFrameworkCatalog();
  registerSystemCatalog();
  registerUnitDevCatalog();
  registerReleaseCatalog();
  registerWebviewCatalog();
}
