// ui.* DOM 주소 명령 — 구조적 path 주소로 DOM 을 조회/측정/조작한다(임의 selector 금지).
//
// 단일 진실: 주소 문법은 address.ts, 노드 수집은 nodeScan.ts. 여기는 그 둘을 소켓 명령으로 노출.
//  - ui.tree:        노출된 DOM 주소 트리 + live Element 의 opaque nodeIdentity.
//  - ui.measure:     주소 → 같은 nodeIdentity + rect + computed style. selector 거부(주소만).
//  - ui.input.click: 주소 → 요소 click 디스패치(danger:inject). 불일치 = NOT_EXPOSED.
// 노출(data-node)되지 않은 요소는 주소 트리에 없어 접근 불가 → 명확한 에러(추측 0).

import { moduleState } from "../lib/moduleState";
import { currentWindow } from "../framework";
import { browserLabel, currentWindowLabel } from "../lib/webviewLabels";
import { contentViewHost, hasContentViewHost, type SurfacePointerInput } from "../lib/contentViews";
import { surfaceInputProvider } from "../lib/surfaceInputProviders";
import { parseAddress, isParseError } from "./address";
import { scanNodes, type ScannedNode } from "../plugins/nodeScan";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { viewFocusSnapshot } from "../plugins/viewFocus";
import { useGutterHover } from "../state/gutterHover";
import { useSessions } from "../state/sessions";
import { motionLiveList, motionLiveRates, setMotionDebug, motionRecentBirths, motionJourneys, motionSwaps, motionTriggers } from "../lib/motionDebug";
import { railTravelMs, railTravelWallMs } from "../lib/railMotion";
import {
  recordWindowFrames,
  startWindowRecording,
  validWindowRecordMaxBytes,
} from "./windowRecorder";
import { createFiniteDomTraceSampler } from "./finiteDomTrace";
import { layoutSettlementStatus, waitLayoutSettled } from "./waitLayoutSettled";
import { declareLayoutCause, onLayoutTransitionJournal } from "../lib/layoutTransitionJournal";
import { PRESENTATION_CLOCK, presentationNowUnixMs } from "../lib/presentationClock";
import { stackingPathOf, type StackingComputedStyle } from "../lib/stackingOrder";

type FocusTraceEntry = {
  t: number;
  type: string;
  tag: string | null;
  className: string;
  dataNode: string | null;
  hasFocus: boolean;
};

// 서로 다른 것은 따로 선다 — 한 가방에 넣으면 그것은 상태가 아니라 가방이다.
/** 포커스 추적 — 기록 중인 사건과 그 종료 손잡이는 한 몸이다. */
const focusTrace = moduleState("commands/catalogDom#focusTrace", () => ({
  focusTrace: null as { events: FocusTraceEntry[]; recording: boolean } | null,
  focusTraceStop: null as (() => void) | null,
}));

// 구조 주소는 논리 위치의 식별자라 같은 자리에 새 Element 가 마운트돼도 그대로다. 인스턴스
// 교체를 관측하는 축은 Element 자신을 키로 삼는다. WeakMap 이므로 이 식별자는 DOM 생명주기를
// 늘리지 않고, 값에는 주소·태그·dataset 같은 내부 구조를 싣지 않는다.
const domNodeIdentity = moduleState("commands/catalogDom#domNodeIdentity", () => ({
  byElement: new WeakMap<Element, string>(),
}));

type MultiDomTraceNode = {
  address: string;
  connected: boolean;
  rect: { x: number; y: number; w: number; h: number };
};
/**
 * 표본을 실제로 낸 관측자. 한 거래의 표본이 비면 "DOM이 멈췄다"와 "아무도 안 봤다"를 갈라야
 * 하는데, 그 답은 누가 몇 번 봤는지에만 있다. 원장이 관측자를 안 실으면 구멍의 이유를 사람이
 * 추측하게 된다(실측: frame callback이 한 번도 안 온 실행을 표본 간격 16ms로 역산해야 했다).
 */
type MultiDomTraceProducer =
  | "arm"
  | "layout-commit"
  | "commit-anchor"
  | "frame-callback"
  | "interval"
  | "animation-end"
  | "settlement";
type MultiDomTraceSample = {
  sequence: number;
  sampledAtUnixMs: number;
  trigger: "initial" | "layout-dom-commit" | "presentation-frame";
  producer: MultiDomTraceProducer;
  transactionId: string | null;
  domCommittedAtUnixMs: number | null;
  nodes: MultiDomTraceNode[];
};
type MultiDomTraceSession = {
  traceId: string;
  addresses: string[];
  targets: { address: string; el: HTMLElement }[];
  unixFromPerformance: number;
  startedAtUnixMs: number;
  expiresAtUnixMs: number;
  endedAtUnixMs: number | null;
  timedOut: boolean;
  samples: MultiDomTraceSample[];
  presentationFrame: number | null;
  presentationTransactionId: string | null;
  presentationDomCommittedAtUnixMs: number | null;
  animationEndHandler: ((event: AnimationEvent) => void) | null;
  settlementObserver: MutationObserver | null;
  intervalProducer: ReturnType<typeof setInterval> | null;
  /** 이 거래에서 켠 관측자. 관측 장치가 관측 대상을 밀어냈는지 두 실행을 대조해 가르려면
   *  무엇을 켰는지가 영수증에 남아야 한다. 기본은 전부 켬 — 이 축은 대조를 가능하게 할 뿐이다. */
  intervalEnabled: boolean;
  unsubscribe: () => void;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  producerCounts: Record<MultiDomTraceProducer, number>;
};

/** 관측자 목록은 한 자리에서 파생한다 — 손으로 두 번 나열하면 한쪽이 반드시 빠진다. */
const MULTI_DOM_TRACE_PRODUCERS = [
  "arm",
  "layout-commit",
  "commit-anchor",
  "frame-callback",
  "interval",
  "animation-end",
  "settlement",
] as const satisfies readonly MultiDomTraceProducer[];

function emptyMultiDomProducerCounts(): Record<MultiDomTraceProducer, number> {
  return Object.fromEntries(
    MULTI_DOM_TRACE_PRODUCERS.map((producer) => [producer, 0]),
  ) as Record<MultiDomTraceProducer, number>;
}
const multiDomTraceSessions = moduleState(
  "commands/catalogDom#multiDomTraceSessions",
  () => new Map<string, MultiDomTraceSession>(),
);
const MULTI_DOM_TRACE_MAX_SESSIONS = 8;
const MULTI_DOM_TRACE_MAX_MS = 15_000;
const MULTI_DOM_TRACE_RECEIPT_RETENTION_MS = 30_000;

function multiDomTraceNow(session: MultiDomTraceSession): number {
  return session.unixFromPerformance + performance.now();
}

function appendMultiDomTraceSample(
  session: MultiDomTraceSession,
  trigger: MultiDomTraceSample["trigger"],
  producer: MultiDomTraceProducer,
  transactionId: string | null,
  domCommittedAtUnixMs: number | null,
  frameTime?: number,
): void {
  const sample: MultiDomTraceSample = {
    sequence: session.samples.length,
    sampledAtUnixMs: frameTime === undefined
      ? multiDomTraceNow(session)
      : session.unixFromPerformance + frameTime,
    trigger,
    producer,
    transactionId,
    domCommittedAtUnixMs,
    // 같은 사건 callback 안에서 전 참가자를 읽는다. 보간·이동량 투영은 하지 않는다.
    nodes: session.targets.map(({ address, el }) => {
      const rect = el.getBoundingClientRect();
      return {
        address,
        connected: el.isConnected,
        rect: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10,
        },
      };
    }),
  };
  // 계수는 남긴 표본을 센다. 시도를 세면 "봤다"가 부풀어 구멍을 덮는다.
  session.samples.push(sample);
  session.producerCounts[producer] += 1;
}

/**
 * Layout commit이 연 실제 document presentation 원장. `requestAnimationFrame`은 타이머로
 * 위치를 재조회하는 폴링이 아니라 WebKit이 다음 표시 frame을 만들 때 발행하는 callback이다.
 * 세션 close/timeout이 명시적 상한이며, 새 거래는 이전 callback 소유권을 교체한다.
 */
function startMultiDomPresentationFrames(
  session: MultiDomTraceSession,
  transactionId: string,
  domCommittedAtUnixMs: number,
): void {
  if (session.presentationFrame !== null) cancelAnimationFrame(session.presentationFrame);
  session.presentationTransactionId = transactionId;
  session.presentationDomCommittedAtUnixMs = domCommittedAtUnixMs;
  // One-shot post-commit DOM anchor. It is a real layout read at the
  // transaction boundary, not a timer sample; keeping it alongside the
  // settlement anchor gives the mapper start/middle/end coverage even when
  // WebKit suppresses all frame callbacks for an occluded document.
  appendMultiDomTraceSample(
    session,
    "presentation-frame",
    "commit-anchor",
    transactionId,
    domCommittedAtUnixMs,
  );
  // rAF is legitimately suspended for an occluded WebKit document. CSS
  // animationend is an event from the same compositor transaction and gives
  // us the real final DOM rect without a timer/polling loop.
  session.animationEndHandler = (event: AnimationEvent) => {
    if (session.endedAtUnixMs !== null
        || session.presentationTransactionId !== transactionId
        || !event.animationName) return;
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "animation-end",
      transactionId,
      domCommittedAtUnixMs,
    );
  };
  document.addEventListener("animationend", session.animationEndHandler, true);
  // The class removal is the application's explicit animation settlement
  // event. MutationObserver is event-driven and observes the real DOM; it is
  // not a coordinate polling loop. This covers WebKit documents where both
  // rAF and animationend are throttled while a native surface occludes them.
  session.settlementObserver = new MutationObserver(() => {
    if (session.endedAtUnixMs !== null
        || session.presentationTransactionId !== transactionId
        || session.targets.some(({ el }) => el.classList.contains("flip-move"))) return;
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "settlement",
      transactionId,
      domCommittedAtUnixMs,
    );
  });
  session.settlementObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
    subtree: true,
  });
  // Last-resort only: WebKit exposes no event for intermediate transformed
  // rects when an occluded document suspends both rAF and animation events.
  // This bounded recorder ends at the trace expiry and is never used for
  // normal DOM observation; it exists to keep that missing evidence RED rather
  // than silently projecting native coordinates into the DOM.
  //
  // 스스로 다시 거는 setTimeout 사슬로 두지 않는다. 그 사슬은 tick 하나가 안 돌면(늦어서든
  // 던져서든) 관측자가 영영 죽고, 원장에는 이유 없는 구멍만 남는다 — 실측: 활강 시작과 함께
  // 표본이 339ms 끊긴 뒤 같은 세션의 event 관측자는 계속 살아 있었다. interval은 tick 하나의
  // 실패가 다음 tick을 앗아가지 않으며 종료는 finishMultiDomTrace 한 자리가 소유한다.
  if (session.intervalProducer !== null) clearInterval(session.intervalProducer);
  // 조건은 tick 안이 아니라 설치 자리에 선다 — tick 안에 두면 타이머는 계속 돌고 그 자체가
  // 재려는 것을 흔든다.
  if (session.intervalEnabled) session.intervalProducer = setInterval(() => {
    if (session.endedAtUnixMs !== null || session.presentationTransactionId !== transactionId) return;
    if (multiDomTraceNow(session) >= session.expiresAtUnixMs) return;
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "interval",
      transactionId,
      domCommittedAtUnixMs,
    );
  }, 8);
  const sample = (frameTime: number) => {
    if (session.endedAtUnixMs !== null
        || session.presentationTransactionId !== transactionId) return;
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "frame-callback",
      transactionId,
      domCommittedAtUnixMs,
      frameTime,
    );
    session.presentationFrame = requestAnimationFrame(sample);
  };
  session.presentationFrame = requestAnimationFrame(sample);
}

function finishMultiDomTrace(session: MultiDomTraceSession, timedOut: boolean): void {
  if (session.endedAtUnixMs !== null) return;
  session.endedAtUnixMs = multiDomTraceNow(session);
  session.timedOut = timedOut;
  session.unsubscribe();
  session.unsubscribe = () => {};
  if (session.presentationFrame !== null) cancelAnimationFrame(session.presentationFrame);
  session.presentationFrame = null;
  if (session.animationEndHandler !== null) {
    document.removeEventListener("animationend", session.animationEndHandler, true);
    session.animationEndHandler = null;
  }
  session.settlementObserver?.disconnect();
  session.settlementObserver = null;
  if (session.intervalProducer !== null) clearInterval(session.intervalProducer);
  session.intervalProducer = null;
  session.presentationTransactionId = null;
  session.presentationDomCommittedAtUnixMs = null;
  if (session.expiryTimer !== null) clearTimeout(session.expiryTimer);
  session.expiryTimer = null;
  if (timedOut) {
    // close 영수증을 읽을 유한 유예 뒤 회수한다. 주기 감시가 아니라 세션별 단발 제거다.
    session.evictionTimer = setTimeout(() => {
      if (multiDomTraceSessions.get(session.traceId) === session) {
        multiDomTraceSessions.delete(session.traceId);
      }
    }, MULTI_DOM_TRACE_RECEIPT_RETENTION_MS);
  }
}

export function __resetMultiDomTraceForTest(): void {
  for (const session of multiDomTraceSessions.values()) {
    finishMultiDomTrace(session, false);
    if (session.evictionTimer !== null) clearTimeout(session.evictionTimer);
  }
  multiDomTraceSessions.clear();
}

function nodeIdentityOf(el: Element): string {
  const existing = domNodeIdentity.byElement.get(el);
  if (existing) return existing;
  const identity = crypto.randomUUID();
  domNodeIdentity.byElement.set(el, identity);
  return identity;
}

const notExposed = (addr: string) => ({
  ok: false as const,
  code: "NOT_EXPOSED" as const,
  message: `이 주소는 공개되지 않았습니다: ${addr}. ui.tree 로 지금 부를 수 있는 주소를 확인하세요`,
});

// 뷰 컨테이너의 단일 셀렉터 — 아래 두 순회(수집·제외)가 같은 집합을 보지 않으면 노드가 두 번
// 세어지거나 조용히 빠지고, 주소 유일성(A1) 판정이 그 위에 선다. 파일 뷰어 컨테이너도 같은
// 클래스를 쓰므로 baseAddress 어트리뷰트로 가른다.
const VIEW_CONTAINER = ".tab-viewer[data-view-addr]";

// 현재 창의 노출 노드 전부를 절대 주소로 수집한다(뷰 컨테이너 + 호스트 크롬). DOM 직접 순회.
export function collectExposed(): ScannedNode[] {
  const out: ScannedNode[] = [];
  const win = currentWindowLabel();
  // 뷰 컨테이너 — data-view-addr(<region>/view/<viewKey>) 를 baseAddress 로. win 접두는 현재 창.
  for (const c of document.querySelectorAll<HTMLElement>(VIEW_CONTAINER)) {
    const base = c.dataset.viewAddr ?? "";
    if (!base) continue;
    out.push(...scanNodes(c, `win/${win}/${base}`));
  }
  // 호스트 크롬 — 뷰 컨테이너 밖의 [data-node].
  //
  // 프로젝트 평면은 전부 마운트된다(비활성은 DOM 가시성만 꺼진다). 그래서 평면 안의 크롬 노드는
  // 프로젝트마다 한 벌씩 살고, 프로젝트 축이 없으면 rail/left 가 둘로 풀린다(실측).
  // 정본 주소는 프로젝트를 싣고, 활성 평면만 생략형 별칭을 함께 가진다(문법의 "생략=활성").
  for (const el of document.querySelectorAll<HTMLElement>("[data-node]")) {
    if (el.closest(VIEW_CONTAINER)) continue; // 뷰 노드는 위에서 처리
    const nodePath = el.dataset.node ?? "";
    if (!nodePath) continue;
    const plane = el.closest<HTMLElement>("[data-project-plane]");
    const proj = plane?.dataset.projectPlane;
    if (!proj) {
      out.push({ address: `win/${win}/chrome/${nodePath}`, nodePath, el });
      continue;
    }
    out.push({
      address: `win/${win}/proj/${proj}/chrome/${nodePath}`,
      nodePath,
      el,
      ...(plane?.dataset.projectActive === "1"
        ? { alias: `win/${win}/chrome/${nodePath}` }
        : {}),
    });
  }
  return out;
}

/**
 * 주소 → 요소. 정확히 하나가 아니면 고르지 않는다(주소 공리 A2).
 *
 * 예전에는 같은 주소가 여러 요소에 붙는 것을 전제하고 "보이는 것"을 골랐다. 그 추측은 둘 다
 * 보이면 무너진다 — 실측: pane 6개가 전부 tab/view/0 을 써서 클릭이 어느 pane 으로 갈지 알 수
 * 없었다. 주소가 유일하지 않다는 것은 주소를 만드는 쪽의 결함이지 고르기로 덮을 일이 아니다.
 * 여기서 거절하면 결함이 그 자리에서 드러난다.
 */
export type Resolved =
  | { el: HTMLElement }
  | { ok: false; code: "NOT_EXPOSED" | "AMBIGUOUS"; message: string };

export function resolveExposed(addressStr: string): Resolved {
  const parsed = parseAddress(addressStr);
  if (isParseError(parsed)) return notExposed(addressStr);
  const want = addressStr.replace(/^\/+|\/+$/g, "");
  const wantWithWin = want.startsWith("win/") ? want : `win/${currentWindowLabel()}/${want}`;
  const matches = collectExposed().filter(
    (n) =>
      n.address === want ||
      n.address === wantWithWin ||
      n.alias === want ||
      n.alias === wantWithWin,
  );
  if (matches.length === 0) return notExposed(addressStr);
  if (matches.length > 1) {
    return {
      ok: false as const,
      code: "AMBIGUOUS" as const,
      message: `이 주소가 ${matches.length}개로 풀립니다: ${addressStr}. tab 을 지정해 하나로 좁히세요`,
    };
  }
  return { el: matches[0].el };
}

// 좌표 위 최상단 요소를 shadow DOM 을 관통해 찾는다. document.elementFromPoint 는 shadow host
// 에서 멈추므로(플러그인 뷰는 shadow 안에 마운트된다), shadowRoot.elementFromPoint 를 따라
// 내려가 실제 최심 요소를 반환한다 — ui.tree/nodeScan 이 data-node 를 shadow 관통 수집하는
// 것과 대칭. inner 가 host 자신이면 멈춘다(무한 루프 방지). doc 인자는 테스트 주입용.
export function deepElementFromPoint(
  x: number,
  y: number,
  doc: DocumentOrShadowRoot = document,
): Element | null {
  // elementFromPoint 는 레이아웃 엔진이 필요하다 — 실제 webview 엔 항상 있으나 일부 환경
  // (jsdom 등)엔 없다. 없으면 좌표 히트테스트가 불가하므로 null(추측 금지).
  const efp = (root: DocumentOrShadowRoot): Element | null =>
    typeof root.elementFromPoint === "function" ? root.elementFromPoint(x, y) : null;
  let el = efp(doc);
  while (el?.shadowRoot) {
    const inner = efp(el.shadowRoot);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

// 한 점 위의 **선언 소유자 사슬** — 최심(=최상단) 요소에서 위로 올라가며 data-node 를 모은다.
// closest 는 shadow 경계를 못 넘으므로 host 로 갈아타며 오른다(deepElementFromPoint 와 대칭).
//
// 층 순서를 판정하는 소비자가 dataset·host·배경 페인터를 자기 규칙으로 이어붙이면, 배경이
// 투명한 조상이 사슬에서 빠져 "누가 위인가"의 답이 소비자마다 갈린다. 사슬은 코어가 한 자리에서
// 답한다. 선언 소유자가 없으면 빈 배열이다 — 없음을 다른 값으로 채우지 않는다.
export function declaredOwnerChain(el: Element | null): string[] {
  const owners: string[] = [];
  const seen = new Set<string>();
  for (let node: Node | null = el; node; ) {
    if (node instanceof HTMLElement) {
      const owner = node.dataset.node;
      if (owner && !seen.has(owner)) {
        seen.add(owner);
        owners.push(owner);
      }
    }
    const parent = node instanceof Element ? node.parentElement : null;
    node = parent ?? ((node.getRootNode() as ShadowRoot | null)?.host ?? null);
  }
  return owners;
}

// shadow 경계를 넘는 포함 판정 — `container` 가 `node` 자신이거나 그 조상인가.
//
// Node.contains 는 shadow 경계에서 멈춘다. 히트테스트(deepElementFromPoint)는 그 경계를 뚫고
// 내려가므로, 내려간 길을 같은 걸음으로 되짚지 않으면 자기 안을 찍고도 "남이 가렸다"가 답이 된다
// (플러그인 뷰는 shadow 안에 마운트된다 — 우측 사이드바가 그 자리다). parentElement 가 끊기면
// host 로 갈아타며 오른다 — declaredOwnerChain 과 같은 걸음이다.
export function containsDeep(container: Element | null, node: Element | null): boolean {
  if (!container || !node) return false;
  for (let cur: Node | null = node; cur; ) {
    if (cur === container) return true;
    const parent: Element | null = cur instanceof Element ? cur.parentElement : null;
    cur = parent ?? ((cur.getRootNode() as ShadowRoot | null)?.host ?? null);
  }
  return false;
}

// camelCase | kebab-case computed 속성 이름을 읽는다(getPropertyValue 는 kebab 을 원한다).
function readComputed(cs: CSSStyleDeclaration, name: string): string {
  const kebab = name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  return cs.getPropertyValue(kebab) || (cs as unknown as Record<string, string>)[name] || "";
}

// shadow DOM 을 관통한 최종 활성 요소. document.activeElement 는 shadow host 에서 멈추므로
// (플러그인 뷰는 shadow 안에 마운트된다), shadowRoot.activeElement 를 따라 내려간다 —
// deepElementFromPoint 와 대칭. root 인자는 테스트 주입용.
export function deepActiveElement(root: DocumentOrShadowRoot = document): Element | null {
  let ae = root.activeElement;
  while (ae?.shadowRoot?.activeElement) ae = ae.shadowRoot.activeElement;
  return ae;
}

// 요소가 속한 뷰 컨테이너(탭 인스턴스 앵커를 가진 것). shadow 안 요소의 closest 는 shadow
// 경계를 못 넘으므로, 경계에서 막히면 shadow host 로 올라가 다시 시도한다(shadow 관통 조상 탐색).
//
// 탭 host 앵커의 정본 이름은 data-tab-id 하나다(viewHostAnchors — 옛 data-pane-id 는
// 소비자 전원 이행 후 제거됨, 2026-07-27).
const TAB_ANCHORED = ".tab-viewer[data-tab-id]";

/** 그 컨테이너가 지목하는 탭 id — 정본 앵커 하나(data-tab-id)만 읽는다. */
export function tabIdOfContainer(host: HTMLElement | null): string | null {
  return host?.dataset.tabId ?? null;
}

export function viewContainerOf(el: Element | null): HTMLElement | null {
  let cur: Node | null = el;
  while (cur instanceof Element) {
    const host = cur.closest<HTMLElement>(TAB_ANCHORED);
    if (host) return host;
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export function registerDomCatalog(): void {
  register("ui.tree", {
    description:
      "Return the exposed DOM address tree — absolute addresses of nodes declared via data-node by plugin views and host-chrome elements. Every node includes its complete declared data-* dataset and nodeIdentity, an opaque token stable for that live Element instance and changed when a different Element is mounted at the same address; compare it across observations to detect remounts. Use to discover addressable targets and their public roles before calling ui.measure or ui.input.click; unexposed elements are absent and unreachable. Pass rects:true to include each node's viewport rect for coordinate work (drags, precision clicks).",
    triggers: { ko: "DOM 트리 주소목록 노드목록 ui트리 노드식별자 재마운트 인스턴스" },
    params: {
      rects: {
        type: "boolean",
        description: "Include each node's viewport rect {x,y,w,h} (px)",
        default: false,
      },
    },
    returns: "{ window, count, duplicates, nodes: [{ address, nodePath, nodeIdentity, dataset, rect? }] }",
    message: (d) => tmsg("msg.ui.tree", { n: Number(d.count ?? 0) }),
    examples: ["ui.tree", 'ui.tree \'{"rects":true}\''],
    handler: (p) => {
      const withRects = p.rects === true;
      const scanned = collectExposed();
      // 주소 공리 A1 의 관측면 — 위반이 있으면 여기서 보인다. 침묵하면 고칠 수 없다.
      const seen = new Map<string, number>();
      for (const n of scanned) seen.set(n.address, (seen.get(n.address) ?? 0) + 1);
      const duplicates = [...seen.entries()]
        .filter(([, c]) => c > 1)
        .map(([address, count]) => ({ address, count }));
      const nodes = scanned.map((n) => {
        const exposed = {
          address: n.address,
          nodePath: n.nodePath,
          nodeIdentity: nodeIdentityOf(n.el),
          // data-node로 공개된 요소의 data-*는 이미 선언된 인터페이스다. tree가 이를 버리면
          // 소비자는 발견한 주소마다 ui.measure를 호출하거나 private DOM을 다시 추측해야 한다.
          dataset: Object.fromEntries(Object.entries(n.el.dataset)),
        };
        if (!withRects) return exposed;
        const r = n.el.getBoundingClientRect();
        return {
          ...exposed,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        };
      });
      return { window: currentWindowLabel(), count: nodes.length, duplicates, nodes };
    },
  });

  register("ui.measure", {
    description:
      "Measure an exposed node — its nodeIdentity, viewport rect (px), exact inline height/flexBasis, and computed style. nodeIdentity is the same opaque live-Element token exposed by ui.tree: stable for the same Element and changed on remount at the same address. style always includes the layout fields plus the interaction/visibility axis (pointerEvents, opacity, visibility) so you can tell whether a node is actually visible and clickable, not just where it sits. Pass props to read any extra computed properties by name (e.g. zIndex, transform, backgroundColor). Pass occlusion:true to also hit-test the node's center (through Shadow DOM) and report what covers it and whether it is reachable. Pass screen:true to also get the node's GLOBAL logical screen coordinates (screen.x/y = rect origin, screen.cx/cy = center) — feed cx/cy straight to an OS pointer tool (e.g. cliclick c:cx,cy) when a real hit-tested click is required; synthetic ui.input.click bypasses hit-testing and default actions, so it cannot verify pointer-events or focus-on-mouseup behavior. Accepts structural addresses from ui.tree only; CSS selectors are rejected.",
    triggers: { ko: "DOM 측정 레이아웃 rect 크기 스타일 포인터이벤트 가시성 가림 도달성 스크린 전역좌표 실클릭 노드식별자 재마운트 인스턴스" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      props: {
        type: "json",
        description:
          'Extra computed-style property names to read, camelCase or kebab (e.g. ["zIndex","backgroundColor"]) — lifts the fixed field set',
        required: false,
      },
      pseudo: {
        type: "string",
        description:
          'Read the computed style of a pseudo-element instead of the node itself ("::before" | "::after"). rect and dataset still describe the node. Required when a surface paints through a pseudo-element veil — those pixels belong to no measurable node otherwise',
        required: false,
      },
      occlusion: {
        type: "boolean",
        description:
          "Also hit-test the node's center (Shadow-DOM-piercing): report the topmost element there and whether this node owns that point (reachable) or something covers it. Ownership is containment across shadow boundaries — the topmost element being this node, inside it, or the node it is inside — read the same way the hit-test descends, never by matching names or address prefixes",
        default: false,
      },
      screen: {
        type: "boolean",
        description:
          "Also return global logical screen coordinates (window inner origin + viewport rect). cx/cy is the node center — pass it directly to an OS-level pointer tool for a real hit-tested click",
        default: false,
      },
      stacking: {
        type: "boolean",
        description:
          "Also return the ancestor chain that decides paint order: every stacking-context ancestor, every positioned ancestor, and the node itself, root first. Compare two nodes by their chains — subtracting two z-index values skips the stacking context between them and can answer the opposite of the screen",
        default: false,
      },
    },
    returns:
      "{ address, nodeIdentity, dataset, value?:string, rect:{x,y,w,h}, inlineStyle:{height,flexBasis}, style, occlusion?:{ reachable, topTag, topNode }, screen?:{ x, y, cx, cy }, stacking?:[{ identity, node, zIndex, positioned, order }] } — nodeIdentity is the opaque live Element identity shared with ui.tree; dataset contains every declared data-* field on the exposed node; value is the current public value of an exposed input, textarea, or select; stacking entries carry zIndex null for an undeclared layer",
    message: (d) =>
      tmsg("msg.ui.measure", {
        w: Number((d.rect as { w?: number })?.w ?? 0),
        h: Number((d.rect as { h?: number })?.h ?? 0),
      }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    examples: ['ui.measure \'{"address":"content/view/soksak-plugin-<id>.<view>/node/send"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      const r = el.getBoundingClientRect();
      // pseudo — 베일(::after)처럼 **어떤 노드에도 속하지 않는 픽셀**을 재는 축. 이 자리가
      // 없으면 홀 슬롯의 흐림은 눈으로 때려맞히는 수밖에 없다(실사고 2026-08-02: 7% 를 22%
      // 라고 읽었다). 이름을 달고 거절한다 — 모르는 값을 조용히 요소 측정으로 떨어뜨리면
      // "쟀다"는 답이 거짓이 된다.
      const pseudo = typeof p.pseudo === "string" ? p.pseudo : null;
      if (pseudo && pseudo !== "::before" && pseudo !== "::after") {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `pseudo 는 "::before" 또는 "::after" 만 잰다: ${pseudo}`,
        };
      }
      const cs = getComputedStyle(el, pseudo);
      const style: Record<string, string> = {
        display: cs.display,
        height: cs.height,
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
        borderTop: cs.borderTopWidth,
        borderBottom: cs.borderBottomWidth,
        fontSize: cs.fontSize,
        alignItems: cs.alignItems,
        alignSelf: cs.alignSelf,
        // 상호작용/가시성 축 — 레이아웃 필드만으론 "실제로 보이고 눌리는가"를 알 수 없다.
        pointerEvents: cs.pointerEvents,
        opacity: cs.opacity,
        visibility: cs.visibility,
      };
      // props[] — 임의 computed 속성 요청(하드코딩 필드 집합의 한계 제거).
      if (Array.isArray(p.props)) {
        for (const name of p.props as unknown[]) {
          if (typeof name === "string") style[name] = readComputed(cs, name);
        }
      }
      // pseudo 는 "없음"도 답이어야 한다 — content:none 이면 그 베일은 애초에 안 그려진다.
      if (pseudo) style.content = readComputed(cs, "content");
      const formElement = ["input", "textarea", "select"].includes(el.localName);
      const projectedForm = ["input", "textarea", "select"].includes(el.dataset.formControl ?? "")
        && Object.prototype.hasOwnProperty.call(el.dataset, "formValue");
      const publicValue = formElement
        ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
        : projectedForm ? el.dataset.formValue : undefined;
      const out: Record<string, unknown> = {
        address: addr,
        nodeIdentity: nodeIdentityOf(el),
        ...(pseudo ? { pseudo } : {}),
        ...(publicValue !== undefined
          // PluginView 노드는 host Window와 다른 realm에서 올 수 있으므로 host constructor의
          // instanceof는 같은 HTML 태그도 거짓이다. localName은 DOM 표준 form 의미이며
          // realm과 무관하다. child renderer projection은 같은 공개 node frame이 실어 온
          // data-form-* 영수증만 사용하며 host가 값을 추측하지 않는다.
          ? { value: publicValue }
          : {}),
        // 모든 data-* 선언은 공개 상태다. 자동화/플러그인은 private DOM 속성명을
        // 다시 추측하지 않고 ui.tree → ui.measure 한 경로로 읽는다.
        dataset: Object.fromEntries(Object.entries(el.dataset)),
        rect: {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
        },
        inlineStyle: {
          height: (el as HTMLElement).style?.height ?? "",
          flexBasis: (el as HTMLElement).style?.flexBasis ?? "",
        },
        style,
      };
      // occlusion — rect 중심에서 shadow 관통 히트테스트로 "무엇이 가리나 + 도달 가능한가"를
      // 판정. ui.hit 과 조합해 소비자가 파생할 수 있으나 흔한 판정이라 한 번에 제공(재발명 방지).
      if (p.occlusion === true) {
        const top = deepElementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        out.occlusion = {
          // 포함은 shadow 를 관통해 읽는다(containsDeep) — 히트가 뚫고 내려간 경계를
          // 판정만 안 넘으면 자기 안을 찍고도 도달 불가가 된다.
          reachable: containsDeep(el, top) || containsDeep(top, el),
          topTag: top ? top.tagName.toLowerCase() : null,
          topNode: top instanceof HTMLElement ? (top.dataset.node ?? null) : null,
        };
      }
      // stacking — 칠하는 순서를 정하는 조상 사슬. 두 노드의 z 를 직접 빼는 판정은 사이에
      // 낀 stacking context 를 건너뛰어 화면과 반대되는 답을 낸다(실사고: 레일 7 > 베일 6 은
      // 참인데, 둘을 실제로 가른 것은 그 사이 .space-plane 의 1 이었다). 비교는 이 사슬을 받은
      // 쪽이 한다 — 코어는 순서의 근거만 낸다.
      if (p.stacking === true) {
        out.stacking = stackingPathOf(el, {
          getStyle: (node) => getComputedStyle(node) as unknown as Partial<StackingComputedStyle>,
          identify: nodeIdentityOf,
        });
      }
      // screen — 전역 논리 좌표. 합성 dispatch 는 히트테스팅·기본동작을 재현하지 못하므로,
      // 실포인터 검증(OS 클릭 도구)이 소비할 좌표 환산을 코어가 한 경로로 제공한다.
      if (p.screen === true) {
        const win = currentWindow();
        const [pos, scale] = await Promise.all([
          win.innerPosition(),
          win.scaleFactor(),
        ]);
        const ox = pos.x / scale;
        const oy = pos.y / scale;
        out.screen = {
          x: +(ox + r.x).toFixed(2),
          y: +(oy + r.y).toFixed(2),
          cx: +(ox + r.x + r.width / 2).toFixed(2),
          cy: +(oy + r.y + r.height / 2).toFixed(2),
        };
      }
      return out;
    },
  });

  register("ui.slot", {
    description:
      "Measure a content view's slot rectangle — the bare host container a view renders into (viewport px + devicePixelRatio). Use so an engine plugin learns its present-target rect (device px = css px * dpr) to align a native/offscreen surface, and so AI can verify placement. Address is a VIEW container (no /node): win/<label>/<region>/view/<pluginId.viewId>. Unexposed returns NOT_EXPOSED.",
    triggers: { ko: "슬롯 뷰컨테이너 rect present타깃 dpr 측정" },
    params: {
      address: {
        type: "string",
        description: "View container address (win/<label>/<region>/view/<pluginId.viewId>, no node)",
        required: true,
      },
    },
    returns: "{ address, rect:{x,y,w,h}, dpr }",
    message: (d) =>
      tmsg("msg.ui.slot", {
        w: Number((d.rect as { w?: number })?.w ?? 0),
        h: Number((d.rect as { h?: number })?.h ?? 0),
        dpr: Number(d.dpr ?? 1),
      }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    examples: ['ui.slot \'{"address":"win/main/content/view/soksak-plugin-<id>.<view>"}\''],
    handler: (p) => {
      const addr = (p.address as string) ?? "";
      const want = addr.replace(/^\/+|\/+$/g, "");
      const win = currentWindowLabel();
      const wantWithWin = want.startsWith("win/") ? want : `win/${win}/${want}`;
      // 뷰 컨테이너를 base 주소(collectExposed 와 동일 생성 규칙)로 매칭 — node 없는 view 주소.
      for (const c of document.querySelectorAll<HTMLElement>(VIEW_CONTAINER)) {
        const base = c.dataset.viewAddr ?? "";
        if (!base) continue;
        const full = `win/${win}/${base}`;
        if (full === wantWithWin || full === want) {
          const r = c.getBoundingClientRect();
          return {
            address: addr,
            rect: {
              x: +r.x.toFixed(2),
              y: +r.y.toFixed(2),
              w: +r.width.toFixed(2),
              h: +r.height.toFixed(2),
            },
            dpr: window.devicePixelRatio,
          };
        }
      }
      return notExposed(addr);
    },
  });

  register("ui.focus.state", {
    description:
      "Return the keyboard-focus owner through the public view-host boundary: the requested view, whether its provider is mounted/delivered, and the view containing the active element. Pierces Shadow DOM — plugin views mount inside a shadow root, so this descends shadowRoot.activeElement to the real focused element (and finds its view across the shadow boundary) instead of stopping at the shadow host. settled only proves the DOM active element — widgets paint their focused state (e.g. a terminal's block cursor) only when they received a focus event AND the window is key, so also check windowFocused (document.hasFocus) and activeElement.ancestors (class chain up to the view container — a widget's own focus class appears here). Use after real-device input to verify focus settled in the intended view without querying plugin-private DOM.",
    triggers: { ko: "키보드 포커스 소유자 활성 뷰 포커스 상태 창키 커서" },
    params: {},
    returns:
      "{ requestedTabId, mounted, delivered, activeTabId, realms:[{ realm, focused, node }], settled, windowFocused, activeElement:{ tag, dataNode, className, ancestors } }",
    message: (d) =>
      tmsg("msg.ui.focus.state", {
        view: String(d.activeTabId ?? "none"),
      }),
    examples: ["ui.focus.state"],
    handler: () => {
      const request = viewFocusSnapshot();
      const active = deepActiveElement();
      const host = viewContainerOf(active);
      const activeTabId = tabIdOfContainer(host);
      // 조상 클래스 체인(뷰 컨테이너까지) — 위젯은 focus 이벤트를 받아야 자기 포커스
      // 표식(클래스·커서 페인트)을 켠다. activeElement 만으론 그 축이 안 보인다.
      const ancestors: { tag: string; className: string }[] = [];
      for (
        let el = active instanceof HTMLElement ? active.parentElement : null;
        el && el !== host?.parentElement && ancestors.length < 12;
        el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host as HTMLElement | null)
      ) {
        ancestors.push({ tag: el.tagName.toLowerCase(), className: el.className });
        if (el === host) break;
      }
      // 자식 realm 의 포커스 — 호스트 문서만 보면 이 사실이 안 보인다. 투영이 실어 온 값을
      // 그대로 낸다(호스트가 지어내지 않는다). 브라우저처럼 크롬이 자식 문서에 사는 뷰는
      // "글자가 안 들어간다" 가 여기서 값으로 드러난다.
      const realms = [...document.querySelectorAll<HTMLElement>("[data-realm-focused]")].reduce(
        (rows, el) => {
          const declared = el.dataset.node ?? "";
          const m = /^[^/]+\/plugin-view\/([^/]+)\/(.+)$/.exec(declared);
          if (!m) return rows;
          const row = rows.find((r) => r.realm === m[1])
            ?? (rows.push({ realm: m[1], focused: el.dataset.realmFocused === "true", node: null as string | null }), rows[rows.length - 1]);
          if (el.dataset.focused === "true") row.node = m[2];
          return rows;
        },
        [] as { realm: string; focused: boolean; node: string | null }[],
      );
      return {
        requestedTabId: request.requestedViewId,
        mounted: request.mounted,
        delivered: request.delivered,
        activeTabId,
        realms,
        settled:
          request.delivered && request.requestedViewId === activeTabId,
        // 창이 key 가 아니면 위젯은 포커스 표식을 안 그린다 — settled 와 독립 축.
        windowFocused: document.hasFocus(),
        activeElement:
          active instanceof HTMLElement
            ? {
                tag: active.tagName.toLowerCase(),
                dataNode: active.dataset.node ?? null,
                className: active.className,
                ancestors,
              }
            : null,
      };
    },
  });

  // ── 포커스 인과 타임라인 ────────────────────────────────────────────────
  // 사후 상태 읽기는 오염된다(사용자가 창을 떠나면 blur 가 activeElement 를 되돌린다).
  // 실기기 입력의 "그 순간"에 무엇이 포커스를 받고 무엇이 빼앗는지는 이벤트 기록만이
  // 증언한다. 리스너 4종을 달고 ms 후 스스로 정리한다 — 무한 감시 아님.
  register("ui.focus.trace.start", {
    description:
      "Start recording a focus-causality timeline: every mousedown/mouseup/focusin/focusout (capture, Shadow-DOM composed target) with document.hasFocus() at each event. Self-terminates after ms and removes its listeners. Use when focus lands wrong under real input: start the trace, have the real click happen, then ui.focus.trace.read for the timeline — post-hoc state reads are contaminated by the window blurring when the user switches away.",
    triggers: { ko: "포커스 추적 타임라인 기록 클릭 인과" },
    params: {
      ms: {
        type: "number",
        description: "Recording window in ms (default 10000, max 180000)",
        required: false,
      },
    },
    returns: "{ recording: true, ms }",
    message: (d) => tmsg("msg.ui.focus.trace.start", { ms: Number(d.ms ?? 0) }),
    examples: ['ui.focus.trace.start \'{"ms":10000}\''],
    handler: (p) => {
      focusTrace.focusTraceStop?.();
      const ms = Math.min(Math.max(Number(p.ms) || 10_000, 100), 180_000);
      const buf: FocusTraceEntry[] = [];
      const t0 = performance.now();
      const record = (e: Event) => {
        if (buf.length >= 300) return;
        const path = e.composedPath?.();
        const target = (path && path.length ? path[0] : e.target) as Element | null;
        const el = target instanceof HTMLElement ? target : null;
        buf.push({
          t: Math.round(performance.now() - t0),
          type: e.type,
          tag: target instanceof Element ? target.tagName.toLowerCase() : null,
          className: (el?.className ?? "").slice(0, 80),
          dataNode: el?.dataset.node ?? null,
          hasFocus: document.hasFocus(),
        });
      };
      const types = ["mousedown", "mouseup", "focusin", "focusout"] as const;
      for (const t of types) window.addEventListener(t, record, true);
      const timer = window.setTimeout(() => focusTrace.focusTraceStop?.(), ms);
      focusTrace.focusTrace = { events: buf, recording: true };
      focusTrace.focusTraceStop = () => {
        window.clearTimeout(timer);
        for (const t of types) window.removeEventListener(t, record, true);
        if (focusTrace.focusTrace) focusTrace.focusTrace.recording = false;
        focusTrace.focusTraceStop = null;
      };
      return { recording: true, ms };
    },
  });

  register("ui.focus.trace.read", {
    description:
      "Read the focus-causality timeline recorded by ui.focus.trace.start (idempotent; keeps the last trace after it self-terminates). recording tells whether the window is still open; each event carries its composed target and document.hasFocus() at that instant.",
    triggers: { ko: "포커스 추적 읽기 타임라인 결과" },
    params: {},
    returns: "{ recording, events: [{ t, type, tag, className, dataNode, hasFocus }] }",
    message: (d) =>
      tmsg("msg.ui.focus.trace.read", {
        n: Array.isArray(d.events) ? (d.events as unknown[]).length : 0,
      }),
    examples: ["ui.focus.trace.read"],
    handler: () => ({
      recording: focusTrace.focusTrace?.recording ?? false,
      events: focusTrace.focusTrace?.events ?? [],
    }),
  });

/** 이 노드는 **다른 realm 의 사실을 투영한 자리**인가.
 *
 * 콘텐츠가 네이티브 자식 웹뷰로 사는 뷰는 그 안의 노드를 호스트에 투영한다: 같은 자리에 같은
 * 크기의 투명 `<div>` 를 두고 값만 데이터셋으로 싣는다(pluginViewPresentation). 관측면으로는
 * 옳다 — 트리가 그 노드를 보고 measure 가 값을 답한다.
 *
 * 조작면은 다르다. 그 div 는 사건을 안 받고 진짜 노드는 다른 realm 에 있다. 여기에 사건을
 * 꽂으면 **아무 일도 일어나지 않는데 성공이 나간다** — 실측 2026-08-08: 브라우저 세 종의
 * 주소줄이 전부 그랬고, 사람에게는 "주소를 입력할 수 없다" 로 보였다.
 */
function projectedRealmNode(el: Element): boolean {
  // **이름의 모양으로 판정한다.** 값이 있는지로 보면 입력만 잡히고 버튼·표시 노드는 놓친다 —
  // 실측 2026-08-08: 주소줄은 넘어갔는데 그 옆 이동 버튼은 투영 div 에 클릭이 꽂혔다(아무 일도
  // 안 일어나고 성공). 투영인지 아닌지는 그 노드가 어느 realm 것인지의 문제이지 값의 문제가 아니다.
  return el instanceof HTMLElement && /^[^/]+\/plugin-view\/[^/]+\//.test(el.dataset.node ?? "");
}


/** 투영 주소가 밝히는 realm 과 그 안의 노드 — `tauri/plugin-view/<realm>/<node>`. */
function projectedTarget(el: Element): { realm: string; node: string } | null {
  if (!projectedRealmNode(el)) return null;
  const declared = (el as HTMLElement).dataset.node ?? "";
  const m = /^[^/]+\/plugin-view\/([^/]+)\/(.+)$/.exec(declared);
  return m ? { realm: m[1], node: m[2] } : null;
}

/** 포인터를 넣을 **표면**과 그 안에서 이 노드가 차지한 자리(표면-로컬 CSS px). */
interface GestureSurface {
  label: string;
  x: number; y: number; w: number; h: number;
  /** 이 노드가 표면 **전체**인가 — 콘텐츠 뷰가 그렇다. */
  whole: boolean;
}

/**
 * 이 노드에 넣는 포인터가 **어느 표면의 어느 자리**로 가는가.
 *
 * 두 가지가 같은 답을 낸다. 콘텐츠 뷰는 그 자체가 표면이고(그 안의 자리는 페이지가 정하므로
 * 부르는 쪽이 좌표를 준다), 투영 노드는 다른 realm 의 사실을 비춘 자리다 — 투영은 그 realm
 * 컨테이너의 직계 자식으로 컨테이너 좌상단 기준에 놓이므로(pluginViewPresentation), 컨테이너
 * 와의 차가 곧 그 realm 안의 자리다. 사람이 누른 자리를 그 realm 으로 넘길 때 쓰는 좌표계와
 * 같은 것이다.
 */
function gestureSurface(el: Element): GestureSurface | null {
  const declared = el instanceof HTMLElement ? el.dataset : undefined;
  // **자리 투영** — 이 노드가 곧 콘텐츠 표면이다. 표면 안의 왼쪽 위는 (0,0) 이지 이 자리가
  // 화면 어디에 놓였는지가 아니다.
  if (declared?.surface) {
    const r = el.getBoundingClientRect();
    return { label: declared.surface, x: 0, y: 0, w: r.width, h: r.height, whole: true };
  }
  // **노드 투영** — 다른 realm 안의 한 노드다. 투영은 그 realm 컨테이너의 직계 자식으로
  // 컨테이너 좌상단 기준에 놓이므로, 컨테이너와의 차가 그 realm 안의 자리다.
  if (declared?.realm) {
    const box = el.parentElement;
    if (box === null) return null;
    const r = el.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    return {
      label: declared.realm,
      x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height,
      whole: false,
    };
  }
  // **콘텐츠 뷰는 그 탭 노드의 자손이 아니다** — 칸 밖 표면에 놓인다(실측 2026-08-02:
  // `[data-pane]` 조상도 없었다). 그래서 자손을 뒤지면 못 찾고 조용히 DOM 클릭이 된다.
  // 소속은 라벨이 안다: `b-<창>-<뷰>`. 주소가 가리키는 탭의 뷰 id 로 라벨을 지어 찾는다.
  const viewId = el.getAttribute("data-node")?.match(/^layout\/tab\/(.+)$/)?.[1];
  // 선택자에 값을 끼워 넣지 않는다 — 이스케이프가 환경마다 있고 없고, 라벨에 특수문자가
  // 들어오는 날 선택자가 조용히 다른 것을 고른다. 속성을 읽어 비교한다.
  const wanted = viewId ? browserLabel(viewId) : null;
  const byLabel = wanted
    ? Array.from(document.querySelectorAll<HTMLElement>("[data-content-view]")).find(
        (n) => n.getAttribute("data-content-view") === wanted,
      ) ?? null
    : null;
  const view = el.matches("[data-content-view]")
    ? el
    : (el.querySelector<HTMLElement>("[data-content-view]") ?? byLabel);
  if (view === null) return null;
  const r = view.getBoundingClientRect();
  return {
    label: view.getAttribute("data-content-view") ?? "",
    x: 0, y: 0, w: r.width, h: r.height,
    whole: true,
  };
}

/**
 * 이 표면 안에서 게스처가 시작할 자리.
 *
 * 노드가 표면 전체면 좌상단이다 — 가운데를 기본으로 하면 무엇이 눌릴지 **그 페이지**가 정하고,
 * 검사가 페이지 내용에 매달린다. 표면 안의 한 노드면 그 노드의 가운데다.
 */
function gesturePoint(surface: GestureSurface, p: Record<string, unknown>): { x: number; y: number } {
  const x = typeof p.x === "number" ? p.x : surface.whole ? 0 : Math.round(surface.x + surface.w / 2);
  const y = typeof p.y === "number" ? p.y : surface.whole ? 0 : Math.round(surface.y + surface.h / 2);
  return { x, y };
}

function noGesturePath(addr: string) {
  return {
    ok: false as const,
    code: "OTHER_REALM" as const,
    message: `이 노드는 다른 화면 안에 있는데 지금 프레임워크에는 그리로 입력을 넣는 통로가 없습니다: ${addr}. 다른 프레임워크로 실행한 창에서 다시 부르세요`,
  };
}

/**
 * 게스처의 **모든 단계를 한 호출 안에서** 넣는다.
 *
 * 단계를 부르는 쪽이 이어 붙이게 두면 그 간격을 호출자가 정한다 — CLI 왕복은 더블클릭 간격을
 * 넘겨서, 두 번 누름이 별개의 단발 클릭 둘이 된다(실측 2026-08-08). 한 게스처는 한 호출이다.
 */
async function playGesture(
  label: string,
  steps: readonly SurfacePointerInput[],
): Promise<{ ok: false; code: "SURFACE_INPUT_UNAVAILABLE"; message: string } | null> {
  // **표면의 주인에게 간다.** 플러그인이 엔진 사이드카로 그리는 표면은 프레임워크의 통로가 안
  // 닿는다(실측 2026-08-08: 브라우저 세 종 중 하나만 됐다). 코어가 그 엔진을 알아서 고치면
  // 결합이므로, 주인이 스스로 답하고 코어는 배달만 한다. 주인이 없으면 프레임워크가 맡는다.
  const sink = surfaceInputProvider(label) ?? contentViewHost();
  try {
    for (const step of steps) await sink.sendInput(label, step);
    return null;
  } catch (error) {
    // 표면이 **있다**는 것과 이 프레임워크가 그것을 **쥐고 있다**는 것은 다른 사실이다.
    // 사이드카 엔진이 그리는 표면은 그 플러그인이 소유하고, 여기 통로는 거기 닿지 않는다.
    // 예외로 새면 응답은 "예기치 못하게 실패" 뿐이고, 부른 쪽은 자기 주소를 의심한다.
    return {
      ok: false as const,
      code: "SURFACE_INPUT_UNAVAILABLE" as const,
      message:
        `이 표면으로 포인터를 넣지 못했습니다(${label}): ${error instanceof Error ? error.message : String(error)}. ` +
        "ui.input.state 로 그 표면이 지금 입력을 받을 수 있는지 확인하세요",
    };
  }
}

/** 누름 한 벌 — 사람이 누른 것과 같은 짝. 누름만 보내면 클릭이 성립하지 않는다. */
function press(
  at: { x: number; y: number },
  button: "left" | "right",
  clickCount: number,
): SurfacePointerInput[] {
  return [
    { ...at, kind: "down", button, clickCount },
    { ...at, kind: "up", button, clickCount },
  ];
}

/**
 * 투영 노드에 대한 조작을 **그 노드가 사는 realm 에서** 한다.
 *
 * 호스트의 투영은 투명하고 사건을 안 받는다 — 거기 꽂으면 아무 일도 안 일어난다. 진짜 노드는
 * 자식 문서에 살고, 그 문서로 들어가는 길은 계약에 이미 있다(`evalJs`·`typeText`). 없던 것은
 * 주소가 **어느 문서를 가리키는지**였다: 여태 콘텐츠 표면 이름을 실어 노드가 없는 곳을 짚었다.
 */
async function inProjectedRealm(
  el: Element,
  addr: string,
  action: { kind: "fill"; value: string },
) {
  const target = projectedTarget(el);
  if (target === null) return null;
  if (!hasContentViewHost()) return noGesturePath(addr);
  const host = contentViewHost();
  const pick = `document.querySelector(${JSON.stringify(`[data-node="${target.node}"]`)})`;
  // 값을 대입하지 않는다 — 그 realm 의 코드는 자기 입력 사건으로만 상태를 갱신한다. 포커스하고
  // 기존 값을 고른 뒤 네이티브 입력으로 넣으면 사람이 친 것과 같은 경로가 된다.
  const ready = await host.evalJs(target.realm, `const el = ${pick}; if (!el) return "none"; el.focus(); if (el.select) el.select(); return "ok";`);
  if (!String(ready).includes("ok")) {
    return {
      ok: false as const,
      code: "NOT_EXPOSED" as const,
      message: `그 화면 안에 이 노드가 없습니다: ${addr}. ui.tree 로 지금 있는 주소를 확인하세요`,
    };
  }
  await host.typeText(target.realm, action.value);
  return { filled: true, realm: target.realm, address: addr };
}

  register("ui.input.click", {
    description:
      "Dispatch a real-click sequence (mousedown → mouseup → click) to an exposed node (E2E injection). Nodes that live on another surface - a content view, or a projected plugin-view node - receive a real engine pointer inside that surface instead, and the answer names it as surface; button:'right' drives context menus there. Use to drive UI flows programmatically or in tests. atUnixMs is the epoch the stimulus actually left, on the same presentation clock as layout.transactions and native display ledgers — join causality with it instead of inferring the click time from frames. Pass phase:'down' to send only the mousedown, then observe the mid-gesture state (ui.hit / ui.measure), then phase:'up' to finish with mouseup+click — the only way to verify contracts that live BETWEEN down and up. recordDir starts finite framework-neutral visual evidence before the click without focusing the window; recording.status reports its independent outcome, and capture/storage failure never cancels the click transaction. Unexposed addresses return NOT_EXPOSED — no guessing.",
    triggers: { ko: "클릭 주입 ui클릭 버튼클릭 E2E 게스처 다운 업 분해" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      phase: {
        type: "string",
        description:
          "'down' = mousedown only; 'up' = mouseup+click only; omit for the full sequence",
        required: false,
      },
      x: {
        type: "number",
        description:
          "Content-view-relative x (CSS px). Only when the address resolves to a content view; the click is delivered inside it as real input.",
        required: false,
      },
      y: { type: "number", description: "Content-view-relative y (CSS px).", required: false },
      button: {
        type: "string",
        description: "left (default) or right. right drives context-menu paths on native surfaces.",
        enum: ["left", "right"],
        required: false,
      },
      recordDir: {
        type: "string",
        description: "Optional output directory for finite transition frames captured concurrently with this click.",
        required: false,
      },
      recordFrames: {
        type: "number",
        description: "Frames to capture when recordDir is set (1..600, default 40).",
        default: 40,
      },
      recordIntervalMs: {
        type: "number",
        description: "Capture interval in milliseconds when recordDir is set (default 16).",
        default: 16,
      },
      recordLeadMs: {
        type: "number",
        description: "Finite pre-click recording lead in milliseconds (0..2000, default 0).",
        default: 0,
      },
      recordMaxBytes: {
        type: "number",
        description: "Maximum total stored PNG bytes for this finite recording (1..1073741824).",
        required: false,
      },
      traceAddresses: {
        type: "json",
        description:
          "Optional exposed node addresses sampled on each saved recording frame. Requires recordDir; every sample maps 1:1 to fNNNN.png.",
        required: false,
      },
      causeTraceId: {
        type: "string",
        description:
          "Caller-owned observation-transaction id stamped on the layout transaction this stimulus opens; read it back as causeTraceId in layout.transactions. Without it a caller can only guess which journal entry the click caused.",
        required: false,
      },
    },
    returns: "{ clicked, address, atUnixMs, clock, phase?, surface?, recording:{status:'not-requested'|'complete'|'failed',mode:'realtime',dir?,requestedFrames?,frames?,reason?}, trace?:{frames,samples} }",
    message: () => tmsg("msg.ui.input.click"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE"],
    danger: "inject",
    examples: ['ui.input.click \'{"address":"win/main/chrome/modal/consent/agree"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // 실제 클릭과 등가 시퀀스 — el.click()(click 단발)은 mousedown 기반 요소(사이드바 탭
      // 드래그-선택 등)를 못 누른다. dblclick 커맨드와 동일 패턴의 1라운드.
      // phase 분해: down/up 사이가 계약인 기능(히트 가능성·활성화 이연)은 중간 관찰이
      // 필요하므로 시퀀스를 쪼갤 수 있다.
      const phase = p.phase as string | undefined;
      if (phase !== undefined && phase !== "down" && phase !== "up") {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: `phase must be 'down' or 'up', got: ${phase}`,
        };
      }
      // 빈 사유는 "사유 없음"과 구별할 수 없다. 조용히 사유 없는 거래로 만들면 부른 쪽은
      // 자기가 선언했다고 믿고 장부에서 남의 거래를 읽는다.
      const causeTraceId = p.causeTraceId as string | undefined;
      if (causeTraceId !== undefined && (typeof causeTraceId !== "string" || causeTraceId.length === 0)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "causeTraceId는 비어 있지 않은 문자열이어야 한다",
        };
      }
      const recordDir = p.recordDir as string | undefined;
      const recordFrames = p.recordFrames === undefined ? 40 : Number(p.recordFrames);
      const recordIntervalMs = p.recordIntervalMs === undefined ? 16 : Number(p.recordIntervalMs);
      const recordLeadMs = p.recordLeadMs === undefined ? 0 : Number(p.recordLeadMs);
      const recordMaxBytes = p.recordMaxBytes;
      const traceAddresses = p.traceAddresses === undefined ? [] : p.traceAddresses;
      if (
        recordDir &&
        (!Number.isInteger(recordFrames) || recordFrames < 1 || recordFrames > 600 ||
          !Number.isFinite(recordIntervalMs) || recordIntervalMs < 0 ||
          !Number.isFinite(recordLeadMs) || recordLeadMs < 0 || recordLeadMs > 2_000)
      ) {
        return { ok: false as const, code: "INVALID_PARAMS", message: "녹화 인자가 범위를 벗어났다" };
      }
      if (
        recordMaxBytes !== undefined &&
        (!recordDir || !validWindowRecordMaxBytes(recordMaxBytes))
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: "recordMaxBytes는 recordDir과 함께 쓰는 1..1073741824 정수여야 한다",
        };
      }
      if (
        !Array.isArray(traceAddresses) ||
        traceAddresses.length > 16 ||
        traceAddresses.some((address) => typeof address !== "string" || address.length === 0) ||
        (traceAddresses.length > 0 && !recordDir)
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: "traceAddresses는 공개 주소 16개 이하이며 recordDir과 함께 써야 한다",
        };
      }
      const traceTargets = [];
      for (const address of traceAddresses as string[]) {
        const resolved = resolveExposed(address);
        if (!("el" in resolved)) return resolved;
        traceTargets.push({ address, el: resolved.el });
      }
      const trace = traceTargets.length > 0
        ? createFiniteDomTraceSampler(traceTargets)
        : null;
      const recording = recordDir
        ? startWindowRecording({
            dir: recordDir,
            frames: recordFrames,
            intervalMs: recordIntervalMs,
            ...(recordMaxBytes === undefined ? {} : { maxBytes: recordMaxBytes }),
            onFrame: (frame) => trace?.sample(frame),
          }, recordWindowFrames)
        : null;
      const recordingReady = await (recording?.ready ?? Promise.resolve(false));
      if (recordingReady && recordLeadMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, recordLeadMs));
      }
      const observationResult = async () => {
        // trace.samples()는 현재 배열의 snapshot이다. 녹화와 Promise.all 인자에서 동시에
        // 평가하면 첫 ready 사건 직후의 1장만 복사하고 나머지 onFrame 사건을 잃는다.
        // 녹화 완료가 모든 frame 사건의 상한이므로 먼저 그 경계를 지난 뒤 snapshot한다.
        const recordingReport = recording
          ? await recording.report
          : { status: "not-requested" as const, mode: "realtime" as const };
        const traceSamples = trace?.samples() ?? null;
        return {
          recording: recordingReport,
          ...(traceSamples == null
            ? {}
            : { trace: { frames: traceSamples.length, samples: traceSamples } }),
        };
      };
      // **다른 표면에 사는 노드는 그 표면 안으로 진짜 포인터를 넣는다.**
      //
      // 콘텐츠 뷰든 투영 노드든 진짜 노드는 이 문서에 없다. DOM 으로 만든 클릭은 닿지 않고,
      // 닿아도 사용자 활성화가 없어 엔진이 창-열기 같은 것을 막는다(실측 2026-08-02: `_blank`
      // 링크를 스크립트로 눌러도 창-열기 요청이 0회였다). 엔진이 내는 진짜 입력이라야 한다.
      const surface = gestureSurface(el);
      if (surface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        const at = gesturePoint(surface, p);
        // 호스트 계약을 지난다 — 태그를 직접 만지면 그 구현이 바뀌는 날 이 자리만 조용히 죽는다.
        // 못 하는 구현은 그 자리에서 이름을 달고 거절한다(조용한 성공 금지).
        if (causeTraceId !== undefined) declareLayoutCause(causeTraceId);
        const atUnixMs = presentationNowUnixMs();
        const pair = press(at, p.button === "right" ? "right" : "left", 1);
        const refused = await playGesture(
          surface.label,
          phase === "down" ? [pair[0]] : phase === "up" ? [pair[1]] : pair,
        );
        if (refused) return refused;
        return {
          clicked: true,
          address: addr,
          atUnixMs,
          clock: PRESENTATION_CLOCK,
          surface: surface.label,
          ...(phase ? { phase } : {}),
          ...(await observationResult()),
        };
      }
      const types =
        phase === "down"
          ? ["mousedown"]
          : phase === "up"
            ? ["mouseup", "click"]
            : ["mousedown", "mouseup", "click"];
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // 사유 선언은 자극보다 먼저다 — 클릭 핸들러가 같은 tick에 배치 거래를 열 수 있다.
      if (causeTraceId !== undefined) declareLayoutCause(causeTraceId);
      const atUnixMs = presentationNowUnixMs();
      for (const type of types) {
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }),
        );
      }
      return phase
        ? {
          clicked: true, address: addr, atUnixMs, clock: PRESENTATION_CLOCK, phase,
          ...(await observationResult()),
        }
        : {
          clicked: true, address: addr, atUnixMs, clock: PRESENTATION_CLOCK,
          ...(await observationResult()),
        };
    },
  });

  // 확정 문자열만 넣을 수 있으면 조합 구간을 한 번도 안 지나고 "한글이 들어간다" 고 말하게 된다.
  register("ui.input.compose", {
    description:
      "Set the in-progress composition (IME preedit) on a surface, or end it. Korean, Japanese and Chinese pass through a composition state before anything is committed: the page receives compositionstart/compositionupdate, shows characters that are not yet its value, and backspace removes a jamo rather than a character. ui.input.fill and typing commit finished text and never enter that state, so they cannot prove the composition path. Call with text to set what is being composed, and without text to unmark it — the place a person reaches with space or enter. Leaving a composition open makes the next input stack on top of it. Addresses that are not a surface return NOT_A_SURFACE.",
    triggers: { ko: "조합 IME 한글 미확정 preedit 입력중 컴포지션 주입" },
    params: {
      address: { type: "string", description: "Exposed surface address from ui.tree", required: true },
      text: { type: "string", description: "What is being composed. Omit to end the composition.", required: false },
    },
    returns: "{ address, surface, composing }",
    message: (d) => tmsg(d.composing == null ? "msg.ui.input.compose.end" : "msg.ui.input.compose"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "NOT_A_SURFACE", "SURFACE_INPUT_UNAVAILABLE"],
    danger: "inject",
    examples: [
      'ui.input.compose \'{"address":"win/main/…/surface","text":"한"}\'',
      'ui.input.compose \'{"address":"win/main/…/surface"}\'   # 조합을 끝낸다',
    ],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const surface = gestureSurface(found.el);
      if (surface === null) {
        return {
          ok: false as const,
          code: "NOT_A_SURFACE" as const,
          message: `이 주소는 화면 표면이 아니라 조합을 넣을 입력 요소가 없습니다: ${addr}. 그 뷰의 표면 주소로 부르세요`,
        };
      }
      if (!hasContentViewHost()) return noGesturePath(addr);
      const text = typeof p.text === "string" ? (p.text as string) : "";
      try {
        // 조합은 아직 프레임워크가 쥔 표면의 사실이다 — 주인이 그 자리를 밝히면 그때 축을 연다.
        await contentViewHost().markText(surface.label, text);
      } catch (error) {
        return {
          ok: false as const,
          code: "SURFACE_INPUT_UNAVAILABLE" as const,
          message:
            `이 표면에 조합을 넣지 못했습니다(${surface.label}): ${error instanceof Error ? error.message : String(error)}. ` +
            "먼저 그 입력 요소를 클릭해 커서를 두세요",
        };
      }
      return { address: addr, surface: surface.label, composing: text.length === 0 ? null : text };
    },
  });

  // 포인터가 표면에 도착하지 않을 때, 그 사실만으로는 아무것도 못 고친다. 배달을 가르는
  // 조건은 전부 그 표면과 창의 상태다 — 물을 자리가 없으면 원인은 영영 추측이다.
  register("ui.input.state", {
    description:
      "Ask a surface whether it can receive pointer input right now, and why not. Answers with the framework's own facts about delivery: whether the surface is attached to a window, whether that window accepts moved events, whether this view is the input responder, and the visibleRect the engine clips hover against. Use this the moment ui.input.click/pointer/drag reports success but nothing reaches the page — the answer names the condition instead of leaving you to guess coordinates. Read-only: it never focuses, moves, or activates anything. Addresses that are not a surface return NOT_A_SURFACE.",
    triggers: { ko: "표면 입력 상태 왜 안닿음 배달조건 responder 보이는사각형 진단" },
    params: {
      address: { type: "string", description: "Exposed surface address from ui.tree (a content view or a projected plugin-view surface)", required: true },
      x: { type: "number", description: "Surface-relative x (CSS px) to ask about. Some delivery conditions differ per point — notably which window is topmost there. Omit to ask about the cursor's current position.", required: false },
      y: { type: "number", description: "Surface-relative y (CSS px).", required: false },
    },
    returns: "{ address, surface, state:{ attached, hidden?, windowIsKey?, acceptsMouseMovedEvents?, isFirstResponder?, bounds?, visibleRect?, askedPoint?, topWindowAtPoint?, windowTopmostAtPoint? } }",
    message: () => tmsg("msg.ui.input.state"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "NOT_A_SURFACE", "SURFACE_INPUT_UNAVAILABLE"],
    examples: ['ui.input.state \'{"address":"win/main/content/view/x/tab/t1/node/tauri/plugin-view/b-main-t1/surface"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const surface = gestureSurface(found.el);
      if (surface === null) {
        return {
          ok: false as const,
          code: "NOT_A_SURFACE" as const,
          message: `이 주소는 화면 표면이 아니라 입력 상태를 답할 것이 없습니다: ${addr}. 그 뷰의 표면 주소로 부르세요`,
        };
      }
      if (!hasContentViewHost()) return noGesturePath(addr);
      try {
        const at = typeof p.x === "number" && typeof p.y === "number"
          ? { x: p.x as number, y: p.y as number }
          : undefined;
        const sink = surfaceInputProvider(surface.label) ?? contentViewHost();
        return { address: addr, surface: surface.label, state: await sink.inputState(surface.label, at) };
      } catch (error) {
        return {
          ok: false as const,
          code: "SURFACE_INPUT_UNAVAILABLE" as const,
          message:
            `이 표면의 상태를 읽지 못했습니다(${surface.label}): ${error instanceof Error ? error.message : String(error)}. ` +
            "그 탭이 지금 열려 있는지 tab.list 로 확인하세요",
        };
      }
    },
  });

  // 키보드로만 닿는 기능(팔레트 화살표·Esc·Ctrl+R 같은 단축키)은 클릭 주입으로 검증할 수 없다.
  // 그 자리에 표면이 없으면 "키보드 경로는 확인 못 했다" 가 남는다 — 그래서 키를 넣는다.
  register("ui.input.key", {
    description:
      "Dispatch a keydown (and keyup) to an exposed node — the only way to drive keyboard-only paths: palette arrows, Escape, Enter, and shortcuts like Ctrl+R. key takes a KeyboardEvent key value ('Enter', 'Escape', 'ArrowDown', 'r'). Modifiers are separate booleans. Returns defaultPrevented so you can tell whether a handler claimed the key or it fell through. Unexposed addresses return NOT_EXPOSED — no guessing.",
    triggers: { ko: "키 입력 키보드 단축키 방향키 엔터 이스케이프 주입 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      key: { type: "string", description: "KeyboardEvent key value: Enter, Escape, ArrowDown, Tab, r, …", required: true },
      ctrl: { type: "boolean", description: "Ctrl held" },
      meta: { type: "boolean", description: "Meta/Cmd held" },
      shift: { type: "boolean", description: "Shift held" },
      alt: { type: "boolean", description: "Alt/Option held" },
    },
    returns: "{ key, address, defaultPrevented }",
    message: (d) => tmsg("msg.ui.input.key", { key: String(d.key ?? "") }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.key \'{"address":"win/main/content/view/x/node/composer-input","key":"r","ctrl":true}\'',
      'ui.input.key \'{"address":"…/node/composer-input","key":"ArrowDown"}\'',
    ],
    handler: async (p) => {
      const addr = p.address as string;
      const key = p.key as string;
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "key is required" };
      }
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // 다른 표면에 사는 노드는 그 표면 안으로 진짜 키를 넣는다 — 호스트에 만든 키 사건은
      // 그 안에 안 닿고, 닿아도 사용자 활성화가 없어 엔진이 막는다.
      const keySurface = gestureSurface(el);
      if (keySurface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        try {
          await contentViewHost().sendKey(keySurface.label, key, {
            ctrl: p.ctrl === true, meta: p.meta === true,
            shift: p.shift === true, alt: p.alt === true,
          });
        } catch (error) {
          return {
            ok: false as const,
            code: "SURFACE_INPUT_UNAVAILABLE" as const,
            message:
              `이 표면에 키를 넣지 못했습니다(${keySurface.label}): ${error instanceof Error ? error.message : String(error)}. ` +
              "그 탭을 활성화한 뒤 다시 부르세요",
          };
        }
        return { dispatched: true, address: addr, key, surface: keySurface.label };
      }
      const init: KeyboardEventInit = {
        key,
        ctrlKey: p.ctrl === true,
        metaKey: p.meta === true,
        shiftKey: p.shift === true,
        altKey: p.alt === true,
        bubbles: true,
        composed: true,
        cancelable: true,
      };
      // 포커스가 없으면 핸들러가 붙은 요소에 이벤트가 닿아도 브라우저 기본 동작이 어긋난다.
      if (el instanceof HTMLElement) el.focus();
      const down = new KeyboardEvent("keydown", init);
      el.dispatchEvent(down);
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { key, address: addr, defaultPrevented: down.defaultPrevented };
    },
  });

  // 포인터의 "있음"과 "없음" 을 같은 표면에서 구동한다.
  //
  // 왜 필요한가: 골 강조 같은 hover 상태는 지금까지 CSS :hover 가 소유했고, :hover 는
  // 스크립트로 켜지도 끄지도 못한다 — 구동 불가 = 검증 불가였다. 게다가 포인터가 네이티브
  // 자식(브라우저 표면)으로 빠져나가면 webview 가 leave 를 못 받아 그대로 붙들리고, accent
  // 세로선이 창 본문 전체 높이로 브라우저를 가로지른 채 남았다(실측 2026-07-26: ui.hit 이
  // 그 골을 반환, 그 rect 가 네이티브 강조바 프레임과 동일).
  //
  // 소유권을 상태로 옮긴 뒤에는 그 상태를 OS 와 같은 경로로 구동할 수 있어야 한다. leave 는
  // 별개 동사가 아니라 같은 동사의 부재다 — 하나의 명령이 둘 다 낸다(짝이 갈라지지 않는다).
  register("ui.input.pointer", {
    description:
      "Drive the pointer the way the OS does: enter/move onto an exposed node, or leave (no address = the pointer is not over us). Hover state that a native child surface can steal — gutter highlight — is owned by app state, not CSS :hover, precisely so it can be driven and read back here. Returns the gutter-hover key now held, so a test can assert both the arming and the release. Addresses that resolve to a native surface may be refused with SURFACE_INPUT_UNAVAILABLE: some engines only update hover from the real pointer stream, and moving the real cursor would take it away from the person using the machine. Where that is so, a press is what creates hover — ui.input.click delivers mouseover/mouseenter/pointerover along with it.",
    triggers: { ko: "포인터 이동 hover 강조 진입 이탈 마우스 주입 E2E" },
    params: {
      address: { type: "string", description: "Exposed node to move onto. Omit to signal the pointer left us." },
      x: { type: "number", description: "Surface-relative x (CSS px) when the address is a content view.", required: false },
      y: { type: "number", description: "Surface-relative y (CSS px).", required: false },
    },
    returns: "{ address, surface?, gutterHover }",
    message: () => tmsg("msg.ui.input.pointer"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE"],
    danger: "inject",
    examples: [
      'ui.input.pointer \'{"address":"win/main/chrome/gutter/pan-g2h3j4/right"}\'',
      "ui.input.pointer   # 이탈(강조 해제)",
    ],
    handler: async (p) => {
      const addr = typeof p.address === "string" ? p.address : null;
      if (addr == null) {
        useGutterHover.getState().set(null);
        return { address: null, gutterHover: useGutterHover.getState().key };
      }
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // 다른 표면 위의 자리로 가는 이동은 그 표면 안으로 넣는다 — 호스트에 꽂은 이동은 그 안의
      // hover 를 만들지 못한다.
      const surface = gestureSurface(el);
      if (surface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        const at = gesturePoint(surface, p);
        // 사람의 포인터는 **들어온 다음** 움직인다 — 엔진은 그 짝으로 hover 를 시작한다.
        // 이동만 보내면 아직 들어온 적 없는 표면에서 움직이는 셈이라 자리를 못 잡는다.
        const refused = await playGesture(surface.label, [
          { ...at, kind: "enter", button: "left", clickCount: 1 },
          { ...at, kind: "move", button: "left", clickCount: 1 },
        ]);
        if (refused) return refused;
        return { address: addr, surface: surface.label, gutterHover: useGutterHover.getState().key };
      }
      const key = el instanceof HTMLElement ? (el.dataset.gutterKey ?? null) : null;
      if (key != null) useGutterHover.getState().set(key);
      el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, composed: true }));
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true }));
      return { address: addr, gutterHover: useGutterHover.getState().key };
    },
  });

  // 위상을 느리게 돌리고, 멈춘 자리에서 DOM 을 훑는다.
  //
  // 왜: 이 결함들은 전부 "움직이는 도중"에만 보인다 — 표면이 옛 자리에 좌초해 사이드바가
  // 두 벌로 보이고, 탭 복귀에 깜빡이고, 패널이 좁아진 채 세로선이 남는다. 정지 상태를
  // 아무리 캡처해도 찰나는 안 잡힌다. 느리게 만들고 멈출 수 있어야 관측이다.
  //
  // scale: 모든 transition/animation 을 이 배수로 늘린다(:root --motion-scale).
  // hold:  진행 중인 위상을 그 자리에 세운다(animation-play-state: paused + 전이 정지).
  // 창이 지금 구조적으로 성립하는가 — 사람이 신고한 결함들을 불변식으로 세워 앱이 스스로 답한다.
  //
  // 이 결함들은 매번 같은 방식으로 확인해야 하는데, 확인할 때마다 일회성 프로브를 새로 짜면
  // 다음번에 또 처음부터다. 관측은 명령이어야 한다 — 여기 있는 것이 기준이고, e2e 게이트는
  // 이 명령을 부르기만 한다.
  register("ui.verify", {
    description:
      "Check this window's structural invariants and report each by name. Answers whether the window is coherent right now: every exposed address resolves to exactly one node, no rail layer is left behind after a travel, no visible tab body has collapsed to nothing, and the motion clocks agree. Use after any layout change, and as the assertion in end-to-end gates — read passed (the verdict) and checks[].detail, which names the invariant and shows the offending addresses; the envelope only says the query ran.",
    triggers: { ko: "창 점검 불변식 검증 무결성 주소중복 레일잔존 빈슬롯 자가진단" },
    params: {},
    returns: "{ passed, failed, checks: [{ name, ok, detail }] }",
    message: (d) =>
      tmsg("msg.ui.verify", {
        failed: String(d.failed ?? 0),
        total: String((d.checks as unknown[] | undefined)?.length ?? 0),
      }),
    examples: ["ui.verify"],
    handler: () => {
      const scanned = collectExposed();
      const checks: { name: string; ok: boolean; detail: string }[] = [];

      // A1 유일성 — 한 주소가 둘로 풀리면 측정도 클릭도 어디로 갈지 알 수 없다.
      const seen = new Map<string, number>();
      for (const n of scanned) seen.set(n.address, (seen.get(n.address) ?? 0) + 1);
      const dup = [...seen.entries()].filter(([, c]) => c > 1);
      checks.push({
        name: "address.unique",
        ok: dup.length === 0,
        detail:
          dup.length === 0
            ? `${scanned.length}개 주소 모두 유일`
            : dup.map(([a, c]) => `${a} ×${c}`).join(", "),
      });

      // 여정이 끝났으면 빠지는 레일은 남아 있지 않다 — 남으면 사이드바가 두 벌로 보인다.
      const traveling = document.querySelector(".space-body.rail-traveling") != null;
      const leaving = scanned.filter((n) => n.nodePath === "rail/left/leaving");
      checks.push({
        name: "rail.settled",
        ok: traveling || leaving.length === 0,
        detail: traveling
          ? "여정 중 — 판정 보류"
          : leaving.length === 0
            ? "잔존 레일 없음"
            : leaving.map((n) => n.address).join(", "),
      });

      // 보이는 탭 본문은 크기를 가진다 — 0 이면 그 칸은 빈 화면이다.
      const collapsed = scanned.filter((n) => {
        if (!n.nodePath.startsWith("layout/tab/")) return false;
        const r = n.el.getBoundingClientRect();
        const onScreen =
          r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
        return onScreen && (r.width <= 0 || r.height <= 0);
      });
      checks.push({
        name: "tab.sized",
        ok: collapsed.length === 0,
        detail:
          collapsed.length === 0
            ? `보이는 탭 본문 ${scanned.filter((n) => n.nodePath.startsWith("layout/tab/")).length}개 모두 크기 있음`
            : collapsed.map((n) => n.address).join(", "),
      });

      // 화면이 쓰는 시간과 위상이 닫히는 시간은 같다 — 갈라지면 이동 도중에 착지가 선언된다.
      const wall = railTravelWallMs();
      const timer = railTravelMs();
      checks.push({
        name: "motion.paired",
        ok: wall === timer,
        detail: `화면 ${wall}ms / 위상 ${timer}ms`,
      });

      const failed = checks.filter((c) => !c.ok);
      // 판정은 payload 의 passed 다 — ok 는 봉투 예약키라 여기 실으면 삼켜지고, 호출자는
      // "명령이 돌았다" 를 "검사가 통과했다" 로 읽는다(검사 자체가 가짜 GREEN 이 된다).
      return { passed: failed.length === 0, failed: failed.length, checks };
    },
  });

  register("ui.layout.status", {
    description:
      "Return this window's event-driven layout barrier facts: motion owners, pending settlement revision, running layout animations, and visible content-view labels.",
    triggers: { ko: "레이아웃 거래 상태 장벽 진단 정착 리비전 애니메이션" },
    params: {},
    returns: "{ settled, motion, settlement, animations, contentViewLabels }",
    message: () => tmsg("msg.ui.motion"),
    examples: ["ui.layout.status"],
    handler: () => layoutSettlementStatus(useSessions.getState().activeId || undefined),
  });

  register("ui.layout.wait-settled", {
    description:
      "Wait until the current layout transaction is fully settled. Event-driven: consumes layout-motion edges and Web Animations finished promises; timeoutMs is only a finite failure bound, never a polling interval. settledAtUnixMs is the settle epoch on the same presentation clock as layout.transactions and native display ledgers. syncPending reports whether a surface owner confirmed this settlement — true means the DOM went quiet with nothing confirming the surface sync, not that the sync finished.",
    triggers: { ko: "레이아웃 거래 정착 대기 애니메이션 완료" },
    params: {
      timeoutMs: { type: "number", description: "Finite failure bound in ms (default 4000, max 30000)" },
    },
    returns: "{ waitedMs, animations, settledAtUnixMs, clock, syncPending }",
    message: () => tmsg("msg.ui.motion"),
    errors: ["INVALID_PARAMS", "TIMEOUT"],
    examples: ['ui.layout.wait-settled \'{"timeoutMs":8000}\''],
    handler: async (p) => {
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 4_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "timeoutMs must be in (0, 30000]" };
      }
      try {
        return await waitLayoutSettled(timeoutMs, useSessions.getState().activeId || undefined);
      } catch (error) {
        return {
          ok: false as const,
          code: "TIMEOUT" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  register("ui.motion", {
    description:
      "Slow down or freeze layout motion so a transient state can be inspected. scale multiplies every transition/animation duration; hold pauses them in place. Without params it reports the current setting. Transient defects — a surface stranded at its old rect, a pane briefly narrow, a flash on tab return — are invisible to a still capture; this is how you stop time and then read the DOM with ui.tree / ui.measure.",
    triggers: { ko: "모션 느리게 정지 일시정지 애니메이션 배속 관측 디버그" },
    params: {
      scale: { type: "number", description: "Duration multiplier (1 = normal, 20 = twenty times slower)" },
      hold: { type: "boolean", description: "Freeze motion in place (true) or resume (false)" },
    },
    returns: "{ scale, hold, applied, running, rates, wallMs, animations }",
    message: () => tmsg("msg.ui.motion"),
    errors: ["INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.motion \'{"scale":20}\'   # 20배 느리게',
      'ui.motion \'{"hold":true}\'  # 그 자리에 정지',
      "ui.motion            # 현재 설정 조회",
    ],
    handler: (p) => {
      if (typeof p.scale === "number" && (!(p.scale > 0) || p.scale > 200)) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scale must be in (0, 200]" };
      }
      // 설정의 소유자는 motionDebug 하나다 — 개발 UI 가 멈춰 둔 그 순간을 이 명령이 그대로 읽는다.
      const st = setMotionDebug({
        scale: typeof p.scale === "number" ? p.scale : undefined,
        hold: typeof p.hold === "boolean" ? p.hold : undefined,
      });
      // running·rates 는 결과다 — 설정이 세워졌다는 말이 느려졌다는 말을 대신하지 못한다(실사고:
      // 커스텀 프로퍼티만 두고 소비처가 없어 상태는 20 인데 화면은 그대로였다).
      return { ...st, ...motionLiveRates(), animations: motionLiveList(), recentBirths: motionRecentBirths(), journeys: motionJourneys(), swaps: motionSwaps(), triggers: motionTriggers() };
    },
  });

  // 이동하는 노드의 변화를 사실로 잡는다 — 기간 한정 rect 시계열(관측 명령, 사용자 요구
  // 2026-07-26 "돔 이동시에 해당 돔의 변화도 추적할 수 있어야 한다"). transitionrun 같은
  // 이벤트는 엔진 구현에 따라 빠질 수 있지만(실측: 등록 변수 전이에서 births 0) rect 는
  // 화면의 결과 그 자체라 빠질 수 없다. rAF 표본이므로 폴링이 아니라 캡처다(상한 5s).
  // 주입한 입력이 **도착하는가** — 구동과 판정 사이의 빈 칸.
  //
  // 없으면 실패가 두 갈래로 갈리는데 구분할 수가 없다: 이벤트가 안 갔거나, 갔는데 받는 쪽이
  // 안 움직였거나. 그 둘은 고칠 자리가 완전히 다르다(주입면 vs 앱 로직). "안에서 무슨 일이
  // 있었는지 모른다"는 진단이 아니라 관측면이 없다는 뜻이다 — 그래서 만든다.
  //
  // window 에 capture 로 붙는다: 앱의 리스너보다 **먼저** 보므로, 앱이 막든 지우든 도착
  // 자체는 기록된다. 도착했는데 앱이 안 움직였다면 그건 앱 쪽 사실이고, 안 도착했다면
  // 주입면 쪽 사실이다.
  register("ui.input.observe", {
    description:
      "Record which input events actually reach this window over a bounded span (ms ≤ 5000). Listens on window in the capture phase, so arrivals are recorded even if app handlers stop propagation. Use it to split a failed injection into 'the event never arrived' versus 'it arrived and nothing moved' — the two have different fixes. Drive the input from another connection while this runs.",
    triggers: { ko: "입력 도착 관측 이벤트 수신 확인 주입 검증" },
    params: {
      events: {
        type: "json",
        description: "Event type names to record (default: mousedown, mousemove, mouseup)",
      },
      ms: { type: "number", description: "Recording window in ms (default 1000, max 5000)" },
    },
    returns: "{ ms, counts: { <type>: n }, samples: [{ t, type, x, y, target }] }",
    message: (d) =>
      tmsg("msg.ui.input.observe", {
        n: Object.values((d.counts as Record<string, number>) ?? {}).reduce((a, b) => a + b, 0),
      }),
    examples: ['ui.input.observe \'{"events":["mousemove"],"ms":1500}\''],
    handler: async (p) => {
      const ms = Math.min(Math.max(typeof p.ms === "number" ? p.ms : 1000, 50), 5000);
      const types = Array.isArray(p.events) && p.events.length > 0
        ? p.events.map(String)
        : ["mousedown", "mousemove", "mouseup"];
      const counts: Record<string, number> = {};
      for (const t of types) counts[t] = 0;
      // 표본은 상한을 둔다 — 드래그 한 번이 수백 프레임이면 답이 원장을 밀어낸다.
      const samples: { t: number; type: string; x: number; y: number; target: string }[] = [];
      const t0 = performance.now();
      const wired: [string, EventListener][] = types.map((type) => [
        type,
        (e: Event) => {
          counts[type] += 1;
          if (samples.length >= 60) return;
          const me = e as MouseEvent;
          const el = e.target as HTMLElement | null;
          samples.push({
            t: Math.round(performance.now() - t0),
            type,
            x: Math.round(me.clientX ?? -1),
            y: Math.round(me.clientY ?? -1),
            // 어디로 갔는지도 사실이다 — 같은 좌표라도 target 이 다르면 다른 이야기다.
            target:
              el?.getAttribute?.("data-node") ??
              (el?.tagName ? el.tagName.toLowerCase() : String(e.target === window ? "window" : "?")),
          });
        },
      ]);
      for (const [type, fn] of wired) window.addEventListener(type, fn, true);
      try {
        await new Promise<void>((done) => setTimeout(done, ms));
      } finally {
        for (const [type, fn] of wired) window.removeEventListener(type, fn, true);
      }
      return { ms, counts, samples };
    },
  });

  register("ui.trace", {
    description:
      "Sample an exposed node's rect over a bounded window (ms ≤ 5000) at animation-frame cadence and return the series. This is how you verify that a layout change actually moves — and how slow/hold (ui.motion) visibly stretch or freeze that movement. Trigger the mutation right after starting the trace (it samples from the next frame).",
    triggers: { ko: "노드 추적 이동 기록 rect 시계열 트레이스" },
    params: {
      address: { type: "string", description: "Exposed node address (ui.tree)", required: true },
      ms: { type: "number", description: "Sampling window in ms (default 1000, max 5000)" },
    },
    returns:
      "{ address, from, to, samples: [{ t, x, y, w, h }], moved, translatedOnly(true = x/y changed while w/h stayed — the move-contract), resized }",
    message: (d) => tmsg("msg.ui.trace", { n: String((d.samples as unknown[])?.length ?? 0) }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    handler: async (p) => {
      const ms = Math.min(Math.max(typeof p.ms === "number" ? p.ms : 1000, 50), 5000);
      const found = resolveExposed(String(p.address ?? ""));
      if ("ok" in found) return found;
      const el = found.el;
      const t0 = performance.now();
      const samples: { t: number; x: number; y: number; w: number; h: number }[] = [];
      // 표본 캐던스는 타이머다 — rAF 는 가려진 창에서 멈춰 이 명령이 영영 안 끝난다
      // (실측: 배경 창 trace 가 TIMEOUT — reference_live-drag-verify-traps 의 그 함정).
      // 캡처 명령은 시간이 축이므로 타이머가 정확하고, 가림과 무관하게 완결된다.
      await new Promise<void>((done) => {
        const tick = () => {
          const r = el.getBoundingClientRect();
          samples.push({
            t: Math.round(performance.now() - t0),
            x: Math.round(r.x * 10) / 10,
            y: Math.round(r.y * 10) / 10,
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
          });
          if (performance.now() - t0 >= ms) done();
          else setTimeout(tick, 16);
        };
        tick();
      });
      const first = samples[0];
      const last = samples[samples.length - 1];
      // 이동 계약 판정 — "콘텐츠는 줄어들지 않고 이동만"(사용자 불변식). 출발·도착 rect 와
      // 함께, 표본 어느 지점에서든 크기가 변했는지(resized)와 순수 평행이동이었는지
      // (translatedOnly)를 사실로 답한다 — 하니스가 이 판정으로 위반을 잡는다.
      const translated = samples.some(
        (s2) => Math.abs(s2.x - first.x) > 0.5 || Math.abs(s2.y - first.y) > 0.5,
      );
      const resized = samples.some(
        (s2) => Math.abs(s2.w - first.w) > 0.5 || Math.abs(s2.h - first.h) > 0.5,
      );
      return {
        address: String(p.address ?? ""),
        from: { x: first.x, y: first.y, w: first.w, h: first.h },
        to: { x: last.x, y: last.y, w: last.w, h: last.h },
        samples,
        moved: translated || resized,
        translatedOnly: translated && !resized,
        resized,
      };
    },
  });

  register("ui.trace.multi.start", {
    description:
      "Resolve multiple exposed DOM nodes, record the initial raw rects, install the public layout DOM-commit subscription, and return its trace id only after arming is complete.",
    triggers: { ko: "다중 DOM 거래 추적 시작 구독 무장" },
    params: {
      addresses: {
        type: "json",
        description: "Unique exposed node addresses (1..16, from ui.tree)",
        required: true,
      },
      maxMs: {
        type: "number",
        description: `Bounded subscription lifetime in ms (default 5000, max ${MULTI_DOM_TRACE_MAX_MS})`,
      },
      producers: {
        type: "json",
        description:
          "Which display-column observers to install: { interval?: boolean } (default all on)."
          + " Turning the 8ms recorder off costs samples but stops its forced layout reads —"
          + " use it to tell whether the instrument displaced the frames it was measuring.",
      },
    },
    returns:
      "{ traceId, clock, addresses, startedAtUnixMs, expiresAtUnixMs, producersEnabled } —"
      + " the subscription is installed before this ACK",
    message: () => tmsg("msg.ui.trace", { n: "1" }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    handler: (p) => {
      const addresses = p.addresses;
      if (!Array.isArray(addresses)
          || addresses.length < 1
          || addresses.length > 16
          || addresses.some((address) => typeof address !== "string" || address.length === 0)
          || new Set(addresses).size !== addresses.length
          || (p.maxMs !== undefined
            && (typeof p.maxMs !== "number" || !Number.isFinite(p.maxMs) || p.maxMs <= 0))) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "addresses는 중복 없는 공개 주소 1..16개여야 합니다",
        };
      }
      const targets: { address: string; el: HTMLElement }[] = [];
      for (const address of addresses as string[]) {
        const found = resolveExposed(address);
        if ("ok" in found) return found;
        targets.push({ address, el: found.el });
      }
      if (multiDomTraceSessions.size >= MULTI_DOM_TRACE_MAX_SESSIONS) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `동시 DOM trace는 ${MULTI_DOM_TRACE_MAX_SESSIONS}개 이하여야 합니다`,
        };
      }
      const maxMs = Math.min(
        Math.max(typeof p.maxMs === "number" ? p.maxMs : 5_000, 50),
        MULTI_DOM_TRACE_MAX_MS,
      );
      const requested = p.producers as { interval?: unknown } | undefined;
      const producersParam = {
        interval: typeof requested?.interval === "boolean" ? requested.interval : true,
      };
      const t0 = performance.now();
      const unixFromPerformance = Number.isFinite(performance.timeOrigin)
        ? performance.timeOrigin
        : Date.now() - t0;
      const traceId = crypto.randomUUID();
      const startedAtUnixMs = unixFromPerformance + performance.now();
      const session: MultiDomTraceSession = {
        traceId,
        addresses: [...addresses] as string[],
        targets,
        unixFromPerformance,
        startedAtUnixMs,
        expiresAtUnixMs: startedAtUnixMs + maxMs,
        endedAtUnixMs: null,
        timedOut: false,
        samples: [],
        presentationFrame: null,
        presentationTransactionId: null,
        presentationDomCommittedAtUnixMs: null,
        animationEndHandler: null,
        settlementObserver: null,
        intervalProducer: null,
        intervalEnabled: producersParam.interval,
        unsubscribe: () => {},
        expiryTimer: null,
        evictionTimer: null,
        producerCounts: emptyMultiDomProducerCounts(),
      };
      // initial read와 listener 설치 사이에는 await·timer·callback 경계가 없다. 같은 JS stack을
      // 끝낸 뒤에만 start ACK를 내므로, ACK를 받은 자극은 이 구독보다 먼저 끼어들 수 없다.
      appendMultiDomTraceSample(session, "initial", "arm", null, null);
      session.unsubscribe = onLayoutTransitionJournal((event) => {
        if (event.type !== "dom-committed") return;
        appendMultiDomTraceSample(
          session,
          "layout-dom-commit",
          "layout-commit",
          event.transactionId,
          event.domCommittedAtUnixMs,
        );
        startMultiDomPresentationFrames(
          session,
          event.transactionId,
          event.domCommittedAtUnixMs,
        );
      });
      multiDomTraceSessions.set(traceId, session);
      // 가려진 창에서도 반드시 회수되는 단일 종료 장벽이다. 좌표 polling이 아니다.
      session.expiryTimer = setTimeout(() => finishMultiDomTrace(session, true), maxMs);
      return {
        traceId,
        clock: PRESENTATION_CLOCK,
        addresses: [...session.addresses],
        startedAtUnixMs: session.startedAtUnixMs,
        expiresAtUnixMs: session.expiresAtUnixMs,
        producersEnabled: { interval: session.intervalEnabled },
      };
    },
  });

  register("ui.trace.multi.close", {
    description:
      "Close one armed multi-DOM trace, unsubscribe synchronously, and return initial, layout DOM-commit, and WebKit presentation-frame raw samples.",
    triggers: { ko: "다중 DOM 거래 추적 닫기 원장 조회" },
    params: {
      traceId: { type: "string", description: "Trace id returned by ui.trace.multi.start", required: true },
    },
    returns:
      "{ traceId, clock, addresses, startedAtUnixMs, endedAtUnixMs, timedOut, producers:{arm,layout-commit,commit-anchor,frame-callback,interval,animation-end,settlement}, producersEnabled:{interval}, samples:[{sequence,sampledAtUnixMs,trigger:'initial'|'layout-dom-commit'|'presentation-frame',producer,transactionId:string|null,domCommittedAtUnixMs:number|null,nodes:[{address,connected,rect:{x,y,w,h}}]}] }",
    message: (d) => tmsg("msg.ui.trace", { n: String((d.samples as unknown[])?.length ?? 0) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    handler: (p) => {
      const traceId = typeof p.traceId === "string" ? p.traceId : "";
      if (!traceId) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "traceId가 필요합니다",
        };
      }
      const session = multiDomTraceSessions.get(traceId);
      if (!session) {
        return {
          ok: false as const,
          code: "TARGET_NOT_FOUND" as const,
          message: `DOM trace를 찾을 수 없습니다: ${traceId}`,
        };
      }
      finishMultiDomTrace(session, false);
      multiDomTraceSessions.delete(traceId);
      if (session.evictionTimer !== null) clearTimeout(session.evictionTimer);
      return {
        traceId,
        // 이 원장의 `...UnixMs` 시각을 낸 시계의 이름. 같은 접미사가 같은 시계를 뜻하지 않으므로,
        // 다른 producer 의 시각과 한 축에서 비교하려면 둘 다 이 이름을 답해야 한다.
        clock: PRESENTATION_CLOCK,
        addresses: [...session.addresses],
        startedAtUnixMs: session.startedAtUnixMs,
        endedAtUnixMs: session.endedAtUnixMs,
        timedOut: session.timedOut,
        // 구멍의 이유는 표본 사이가 아니라 관측자 계수에 있다. 0 은 "안 움직였다"가 아니라
        // "그 관측자는 한 번도 안 왔다"는 사실이다.
        producers: { ...session.producerCounts },
        // 무엇을 켜고 잰 원장인지 — 두 실행을 나중에 구분하려면 이 사실이 영수증에 있어야 한다.
        producersEnabled: { interval: session.intervalEnabled },
        samples: session.samples,
      };
    },
  });

  // 멈춘 자리에서 무엇이 어디에 얼마만큼 있는지 — 한 번에 훑는다.
  //
  // ui.measure 는 노드 하나를 잰다. 찰나를 판독하려면 그 순간의 여러 노드를 한꺼번에 봐야
  // 한다: 어떤 세로선이 어디 있는지, 패널 폭이 얼마인지, 그 안의 슬롯·표면이 얼마인지.
  // 왕복을 여러 번 하면 그 사이에 상태가 움직여 서로 다른 순간을 비교하게 된다.
  register("ui.snapshot.dom", {
    description:
      "Measure every exposed node in one pass — one consistent instant, not several round trips that drift apart. Returns address, rect, and the requested computed properties for each, so you can read where a line sits, how wide a pane is, and how big its children are, all from the same moment. Pair with ui.motion hold to stop time first. filter narrows by address substring; selector measures raw elements that carry no address (a content-view host, a plugin body) — read-only, it drives nothing.",
    triggers: { ko: "돔 일괄 측정 스냅샷 좌표 폭 한번에 관측 선 위치" },
    params: {
      filter: { type: "string", description: "Only addresses containing this substring" },
      selector: {
        type: "string",
        description:
          "CSS selector for elements that carry no exposed address (e.g. webview[data-content-view]). Observation only — input still requires an address.",
      },
      props: { type: "json", description: "Extra computed-style property names, e.g. [\"backgroundColor\",\"zIndex\"]" },
    },
    examples: [
      "ui.snapshot.dom",
      'ui.snapshot.dom \'{"filter":"pane","props":["backgroundColor"]}\'',
    ],
    returns: "{ count, nodes: [{ address, nodePath, rect, style? }] }",
    message: (d) => tmsg("msg.ui.snapshot.dom", { count: String(d.count ?? 0) }),
    errors: ["INVALID_PARAMS"],
    handler: (p) => {
      const filter = typeof p.filter === "string" ? p.filter : null;
      const props = Array.isArray(p.props) ? (p.props as string[]).filter((x) => typeof x === "string") : [];
      const nodes: unknown[] = [];
      // selector 를 주면 그것만 잰다 — 주소 스캔 결과에 섞으면 무엇이 답인지 안 보인다.
      const bySelector = typeof p.selector === "string" && p.selector.trim() !== "";
      for (const n of bySelector ? [] : collectExposed()) {
        const address = n.address;
        if (filter && !address.includes(filter)) continue;
        const el = n.el;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const k of props) style[k] = cs.getPropertyValue(k) || (cs as unknown as Record<string, string>)[k] || "";
        nodes.push({
          address,
          nodePath: n.nodePath,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
          ...(props.length > 0 ? { style } : {}),
        });
      }
      // 주소 없는 요소도 잰다 — 관측만이다. 입력은 여전히 주소를 요구한다(그 계약은 "짚지 못한
      // 것을 두드리지 않는다"이고, 이것은 "짚지 못한 것을 보지 못한다"가 아니다).
      //
      // 없으면 진단이 거기서 멈춘다: 콘텐츠 뷰 호스트(<webview>)와 플러그인 본문에는 주소가
      // 없어서, "표면이 어디에 어떤 크기로 있는가"를 물을 자리가 아예 없었다(실측 2026-07-29:
      // 탭 최대화 뒤 브라우저가 빈 화면인데 그것이 자리 문제인지 가시성 문제인지 못 갈랐다).
      if (bySelector) {
        const sel = String(p.selector);
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const style: Record<string, string> = {};
          for (const k of props) {
            style[k] = cs.getPropertyValue(k) || (cs as unknown as Record<string, string>)[k] || "";
          }
          nodes.push({
            selector: sel,
            // 같은 셀렉터에 여럿이면 무엇이 무엇인지 가려야 한다 — 표식을 함께 싣는다.
            mark:
              el.getAttribute("data-content-view") ??
              el.getAttribute("data-node") ??
              (el.className || el.tagName.toLowerCase()),
            rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
            ...(props.length > 0 ? { style } : {}),
          });
        }
      }
      return { count: nodes.length, nodes };
    },
  });

  register("ui.input.dblclick", {
    description:
      "Dispatch a double-click (two clicks + a dblclick event) to an exposed node (E2E injection). Use to drive double-click UI flows like inline tab/label rename. Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "더블클릭 두번클릭 이름변경 rename 주입 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      x: { type: "number", description: "Surface-relative x (CSS px) when the address is a content view.", required: false },
      y: { type: "number", description: "Surface-relative y (CSS px).", required: false },
      button: { type: "string", description: "left (default) or right.", enum: ["left", "right"], required: false },
    },
    returns: "{ dblclicked, address, surface? }",
    message: () => tmsg("msg.ui.input.dblclick"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE"],
    danger: "inject",
    examples: ['ui.input.dblclick \'{"address":"win/main/chrome/tab/left/a.x"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // 다른 표면에 사는 노드는 그 표면 안에서 두 번 눌린다 — 두 번째 누름이 **든 수 2** 라야
      // 엔진이 더블클릭으로 읽는다. 이 네 사건은 한 호출 안에서 잇달아 나간다.
      const surface = gestureSurface(el);
      if (surface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        const at = gesturePoint(surface, p);
        const button = p.button === "right" ? "right" as const : "left" as const;
        const refused = await playGesture(surface.label, [...press(at, button, 1), ...press(at, button, 2)]);
        if (refused) return refused;
        return { dblclicked: true, address: addr, surface: surface.label };
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const fire = (type: string) =>
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }),
        );
      // React onDoubleClick 은 네이티브 dblclick 을 듣는다 — 두 click 으로 자연 발생하지 않으니 명시 디스패치.
      fire("mousedown"); fire("mouseup"); fire("click");
      fire("mousedown"); fire("mouseup"); fire("click");
      fire("dblclick");
      return { dblclicked: true, address: addr };
    },
  });

  register("ui.input.fill", {
    description:
      "Set the value of an exposed input/textarea node and dispatch input+change events (E2E injection). Uses the native value setter so React controlled inputs pick the value up. Contenteditable nodes are filled too: textContent is replaced and input+focusout fire, so blur-commit inline editors take the value. Unexposed addresses return NOT_EXPOSED. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "입력 주입 값입력 텍스트입력 폼입력 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      value: { type: "string", description: "Value to set into the field", required: true },
    },
    returns: "{ filled, address }",
    message: () => tmsg("msg.ui.input.fill"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM"],
    danger: "inject",
    examples: [
      'ui.input.fill \'{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}\'',
    ],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      // 투영 노드에 사건을 꽂으면 아무 일도 안 일어난다 — 성공으로 답하지 않는다.
      if (projectedRealmNode(found.el)) {
        // 투영일 때만 기다린다 — 평범한 호스트 노드까지 await 를 태우면 그 뒤 순서가 바뀐다.
        const routed = await inProjectedRealm(found.el, addr, { kind: "fill", value: p.value as string });
        if (routed) return routed;
      }
      const el = found.el;
      // contenteditable 노드 — 인라인 편집면(blur 확정 계약)도 같은 명령으로 채운다.
      // textContent 교체 후 input + focusout(React onBlur 는 focusout 을 듣는다)으로 확정을 유발.
      if (el.isContentEditable) {
        el.focus();
        el.textContent = p.value as string;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return { filled: true, contentEditable: true, address: addr };
      }
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement)
      )
        return { ok: false as const, code: "INVALID_PARAMS", message: `입력 노드 아님: ${addr}` };
      // React controlled input 은 .value 직접 할당을 덮어쓴다 — prototype 의 native setter 로 넣어야 onChange 가 먹는다.
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, p.value as string);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { filled: true, address: addr };
    },
  });

  register("ui.input.drag", {
    description:
      "Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup). Two modes: (1) drop onto a target — give `to` (+ optional zone); (2) drag by dx/dy for resize handles. steps and durationMs expose a finite real-time sequence for animation/layout verification; defaults preserve the immediate two-move behavior. recordDir starts independent visual evidence before the drag without focusing the window; recording.status reports capture/storage failure without cancelling the finite pointer transaction. mousemove+mouseup dispatch on window so window-level drag listeners receive them.",
    triggers: { ko: "드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그" },
    params: {
      from: { type: "string", description: "Source node address (the tab / gutter / element to grab)", required: true },
      to: { type: "string", description: "Target node address to drop onto (mode 1). Omit when using dx/dy.", required: false },
      zone: {
        type: "string",
        description: "center | left | right | top | bottom — point within the target rect (mode 1)",
        enum: ["center", "left", "right", "top", "bottom"],
      },
      x: { type: "number", description: "Surface-relative start x (CSS px) when `from` is a content view. Defaults to its top-left.", required: false },
      y: { type: "number", description: "Surface-relative start y (CSS px).", required: false },
      button: { type: "string", description: "left (default) or right.", enum: ["left", "right"], required: false },
      dx: { type: "number", description: "Horizontal drag distance in CSS px from `from` center (mode 2 — resize/gutter). Alternative to `to`.", required: false },
      dy: { type: "number", description: "Vertical drag distance in CSS px from `from` center (mode 2).", required: false },
      steps: {
        type: "number",
        description: "Number of evenly spaced mousemove events (1..120). Default 2.",
        default: 2,
      },
      durationMs: {
        type: "number",
        description: "Total finite drag duration in milliseconds (0..10000). Default 0.",
        default: 0,
      },
      recordDir: {
        type: "string",
        description: "Optional output directory for f0000.png... captured concurrently with this drag.",
        required: false,
      },
      recordFrames: {
        type: "number",
        description: "Frames to capture when recordDir is set (1..600, default 120).",
        default: 120,
      },
      recordIntervalMs: {
        type: "number",
        description: "Capture interval in milliseconds when recordDir is set (default 33).",
        default: 33,
      },
      recordLeadMs: {
        type: "number",
        description: "Finite pre-drag realtime-recording lead in milliseconds (0..2000, default 0).",
        default: 0,
      },
      recordMaxBytes: {
        type: "number",
        description: "Maximum cumulative stored PNG bytes for this finite recording (1..1073741824).",
        required: false,
      },
    },
    returns: "{ dragged, click?, from, to?, zone?, dx?, dy?, steps, durationMs, surface?, recording:{status:'not-requested'|'complete'|'failed',dir?,requestedFrames?,frames?,mode:'realtime',reason?} }",
    message: (d) => (d.dragged ? tmsg("msg.ui.input.drag.dragged") : tmsg("msg.ui.input.drag.tap")),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE"],
    danger: "inject",
    examples: [
      'ui.input.drag \'{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}\'',
      'ui.input.drag \'{"from":"win/main/chrome/gutter/pan-g2h3j4/right","dx":120}\'',
    ],
    handler: async (p) => {
      const steps = p.steps === undefined ? 2 : Number(p.steps);
      const durationMs = p.durationMs === undefined ? 0 : Number(p.durationMs);
      if (!Number.isInteger(steps) || steps < 1 || steps > 120) {
        return { ok: false as const, code: "INVALID_PARAMS", message: "steps는 1..120 정수여야 함" };
      }
      if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10_000) {
        return { ok: false as const, code: "INVALID_PARAMS", message: "durationMs는 0..10000이어야 함" };
      }
      const recordDir = p.recordDir as string | undefined;
      const recordFrames = p.recordFrames === undefined ? 120 : Number(p.recordFrames);
      const recordIntervalMs = p.recordIntervalMs === undefined ? 33 : Number(p.recordIntervalMs);
      const recordLeadMs = p.recordLeadMs === undefined ? 0 : Number(p.recordLeadMs);
      const recordMaxBytes = p.recordMaxBytes;
      if (
        recordDir &&
        (!Number.isInteger(recordFrames) || recordFrames < 1 || recordFrames > 600 ||
          !Number.isFinite(recordIntervalMs) || recordIntervalMs < 0 ||
          !Number.isFinite(recordLeadMs) || recordLeadMs < 0 || recordLeadMs > 2_000)
      ) {
        return { ok: false as const, code: "INVALID_PARAMS", message: "녹화 인자가 범위를 벗어났다" };
      }
      if (
        recordMaxBytes !== undefined &&
        (!recordDir || !validWindowRecordMaxBytes(recordMaxBytes))
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: "recordMaxBytes는 recordDir과 함께 쓰는 1..1073741824 정수여야 한다",
        };
      }
      const fromR = resolveExposed(p.from as string);
      if (!("el" in fromR)) return fromR;
      // 끌기가 **다른 표면 위**에서 벌어지는가 — 콘텐츠 뷰 안이거나, 투영이 비추는 realm 안이다.
      // 호스트 window 에 쏜 move/up 은 그 안에 없다.
      const dragSurface = gestureSurface(fromR.el);
      let toSurfacePt: { x: number; y: number } | null = null;
      const fr = fromR.el.getBoundingClientRect();
      const fromPt = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
      const byDelta = p.dx != null || p.dy != null;
      let toPt: { x: number; y: number };
      if (byDelta) {
        // 모드 2 — 픽셀 델타(리사이즈 핸들/디바이더). from 중앙을 잡아 dx/dy 만큼 끈다.
        toPt = { x: fromPt.x + (Number(p.dx) || 0), y: fromPt.y + (Number(p.dy) || 0) };
      } else {
        // 모드 1 — 타겟에 드롭(탭 병합/분할).
        const toR = resolveExposed(p.to as string);
        if (!("el" in toR)) return toR;
        if (dragSurface) {
          // 끌기는 한 표면 안의 사건이다 — 두 끝이 다른 표면이면 그 사이에는 경로가 없다.
          const toSurface = gestureSurface(toR.el);
          if (toSurface === null || toSurface.label !== dragSurface.label) {
            return {
              ok: false as const,
              code: "INVALID_PARAMS",
              message: `끌기의 두 끝이 같은 표면이 아닙니다: ${dragSurface.label} → ${toSurface?.label ?? "호스트"}`,
            };
          }
          toSurfacePt = gesturePoint(toSurface, {});
        }
        const tr = toR.el.getBoundingClientRect();
        const zone = (p.zone as string) ?? "center";
        const zx = zone === "left" ? 0.08 : zone === "right" ? 0.92 : 0.5;
        const zy = zone === "top" ? 0.12 : zone === "bottom" ? 0.88 : 0.5;
        toPt = { x: tr.left + tr.width * zx, y: tr.top + tr.height * zy };
      }
      // 주입한 시퀀스는 **물리적으로 앞뒤가 맞아야** 한다: 누른 채 움직이는 동안 buttons=1,
      // 놓은 뒤 0. 안 맞으면 코어의 포인터 순서 복구가 그것을 유령 홀드로 보고 합성 mouseup 을
      // 쏘아 게스처를 첫 이동에서 닫는다(실측 2026-07-29: 골 드래그가 죽었고, 관측면이 그
      // mouseup 을 첫 이동과 같은 순간·같은 좌표로 잡았다). 그 보호는 옳다 — 앞뒤가 안 맞는
      // 것이 주입 쪽이었다. 계약 둘이 서로를 모르면 각자 옳은 채로 기능이 죽는다.
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            composed: true,
            button: 0,
            buttons: type === "mouseup" ? 0 : 1,
          }),
        );
      const dist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
      const recording = recordDir
        ? startWindowRecording({
            dir: recordDir,
            frames: recordFrames,
            intervalMs: recordIntervalMs,
            ...(recordMaxBytes === undefined ? {} : { maxBytes: recordMaxBytes }),
          }, recordWindowFrames)
        : null;
      const recordingReady = await (recording?.ready ?? Promise.resolve(false));
      if (recordingReady && recordLeadMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, recordLeadMs));
      }
      if (dragSurface) {
        if (!hasContentViewHost()) return noGesturePath(p.from as string);
        const start = gesturePoint(dragSurface, p);
        const end = byDelta
          ? { x: start.x + (Number(p.dx) || 0), y: start.y + (Number(p.dy) || 0) }
          : toSurfacePt ?? start;
        const button = p.button === "right" ? "right" as const : "left" as const;
        // 잡기 전에 이동을 앞세우지 않는다. 누름 자체가 그 자리의 hover 를 만들고(실측
        // 2026-08-08: 클릭 한 번이 mouseover·mouseenter·pointerover 를 냈다), 이동을 못 받는
        // 엔진에서는 앞세운 한 걸음이 **끌기 전체를 죽인다**.
        const seq: SurfacePointerInput[] = [{ ...start, kind: "down", button, clickCount: 1 }];
        if (dist >= 5) {
          for (let step = 1; step <= steps; step += 1) {
            const progress = step / steps;
            seq.push({
              x: Math.round(start.x + (end.x - start.x) * progress),
              y: Math.round(start.y + (end.y - start.y) * progress),
              kind: "drag", button, clickCount: 1,
            });
          }
        }
        seq.push({ ...(dist >= 5 ? end : start), kind: "up", button, clickCount: 1 });
        // 한 게스처는 한 호출이다 — 단계 사이를 호출자가 잇게 두면 그 간격을 CLI 왕복이 정한다.
        for (const [index, step] of seq.entries()) {
          const refused = await playGesture(dragSurface.label, [step]);
          if (refused) return refused;
          if (durationMs > 0 && step.kind === "drag" && index < seq.length - 2) {
            await new Promise((resolve) => window.setTimeout(resolve, durationMs / steps));
          }
        }
        const surfaceRecording = recording
          ? await recording.report
          : { status: "not-requested" as const, mode: "realtime" as const };
        return {
          dragged: dist >= 5, click: dist < 5, from: p.from,
          ...(byDelta ? { dx: p.dx ?? 0, dy: p.dy ?? 0 } : { to: p.to, zone: p.zone ?? "center" }),
          steps, durationMs, surface: dragSurface.label, recording: surfaceRecording,
        };
      }
      // mousedown 은 잡는 요소(골/탭)에, move/up 은 window 에 — 골 리사이즈는 window 레벨
      // mousemove/mouseup 리스너를 그 핸들이 등록하므로 window 로 보내야 받는다.
      fire("mousedown", fromPt.x, fromPt.y, fromR.el);
      if (dist >= 5) {
        for (let step = 1; step <= steps; step += 1) {
          const progress = step / steps;
          fire(
            "mousemove",
            fromPt.x + (toPt.x - fromPt.x) * progress,
            fromPt.y + (toPt.y - fromPt.y) * progress,
            window,
          );
          if (durationMs > 0 && step < steps) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, durationMs / steps),
            );
          }
        }
      }
      fire("mouseup", toPt.x, toPt.y, window);
      const recordingResult = recording
        ? await recording.report
        : { status: "not-requested" as const, mode: "realtime" as const };
      return byDelta
        ? { dragged: dist >= 5, from: p.from, dx: p.dx ?? 0, dy: p.dy ?? 0, steps, durationMs, recording: recordingResult }
        : { dragged: dist >= 5, click: dist < 5, from: p.from, to: p.to, zone: p.zone ?? "center", steps, durationMs, recording: recordingResult };
    },
  });

  register("ui.input.dnd", {
    description:
      "Synthesize an HTML5 drag-and-drop sequence (dragstart on `from` -> dragenter/dragover on `to` -> drop -> dragend) with a shared DataTransfer (E2E injection). ui.input.drag drives pointer(mouse) drags; this drives draggable/ondrop surfaces. Pass files to drop constructed File objects (base64 payload) onto a drop target — from is then optional. position picks the pointer y inside the target (before=upper quarter, after=lower quarter) for order-sensitive drop zones. Frames are yielded between steps so the UI can re-render (drop zones appearing after dragstart). Unexposed addresses return NOT_EXPOSED.",
    triggers: { ko: "드래그앤드롭 주입 dnd 파일드롭 재정렬 드롭존 E2E" },
    params: {
      from: { type: "string", description: "Source node address (draggable). Optional when only dropping files.", required: false },
      to: { type: "string", description: "Drop-target node address", required: true },
      position: {
        type: "string",
        description: "center | before | after — pointer y within the target rect",
        enum: ["center", "before", "after"],
      },
      files: {
        type: "json",
        description: '[{ name, type, base64 }] — constructed Files added to the DataTransfer (file drop)',
        required: false,
      },
    },
    returns: "{ dropped, from?, to, position }",
    message: () => tmsg("msg.ui.input.dnd"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.dnd \'{"from":".../node/section/s2","to":".../node/section/s5","position":"after"}\'',
      'ui.input.dnd \'{"to":".../node/img/s2/hero","files":[{"name":"a.png","type":"image/png","base64":"…"}]}\'',
    ],
    handler: async (p) => {
      const toR = resolveExposed(p.to as string);
      if (!("el" in toR)) return toR;
      const toEl = toR.el;
      let fromEl: HTMLElement | null = null;
      if (p.from != null) {
        const fromR = resolveExposed(p.from as string);
        if (!("el" in fromR)) return fromR;
        fromEl = fromR.el;
      }
      const dt = new DataTransfer();
      if (Array.isArray(p.files)) {
        for (const f of p.files as Array<{ name?: unknown; type?: unknown; base64?: unknown }>) {
          const raw = atob(String(f.base64 ?? ""));
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          dt.items.add(new File([bytes], String(f.name ?? "file"), { type: String(f.type ?? "") }));
        }
      }
      const frame = () => new Promise((r) => setTimeout(r, 50));
      const fire = (type: string, target: EventTarget, x: number, y: number) => {
        const ev = new DragEvent(type, {
          // composed — 플러그인 뷰는 Shadow DOM 안이다. 네이티브 드래그 이벤트처럼 경계를 넘어야
          // document 레벨 dragend 리스너(커밋/되돌림 판정)가 받는다.
          clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, view: window,
        });
        // WebKit 은 생성자 init 의 dataTransfer 를 무시할 수 있다 — 인스턴스에 고정.
        if (!ev.dataTransfer) Object.defineProperty(ev, "dataTransfer", { value: dt });
        target.dispatchEvent(ev);
      };
      const tr = toEl.getBoundingClientRect();
      const position = (p.position as string) ?? "center";
      const ty = position === "before" ? 0.2 : position === "after" ? 0.8 : 0.5;
      const toPt = { x: tr.left + tr.width / 2, y: tr.top + tr.height * ty };
      if (fromEl) {
        const fr = fromEl.getBoundingClientRect();
        fire("dragstart", fromEl, fr.left + fr.width / 2, fr.top + fr.height / 2);
        await frame(); // dragstart 상태 반영(드롭존 렌더 등) 대기
      }
      fire("dragenter", toEl, toPt.x, toPt.y);
      fire("dragover", toEl, toPt.x, toPt.y);
      await frame();
      // dragend 의 실패 판정(dropEffect==="none") 방지 — WebKit 은 드래그 세션 밖 setter 를
      // 무시하므로 own 프로퍼티로 고정한다(성공 드롭 표기).
      try { Object.defineProperty(dt, "dropEffect", { value: "move", configurable: true }); } catch { dt.dropEffect = "move"; }
      fire("drop", toEl, toPt.x, toPt.y);
      await frame();
      fire("dragend", fromEl ?? toEl, toPt.x, toPt.y);
      return { dropped: true, from: p.from, to: p.to, position };
    },
  });

  register("ui.hit", {
    description:
      "Return the topmost DOM element at viewport x,y (tag, classes, data-* attrs, rect) — hit-test diagnostics for drag/click E2E (what would elementFromPoint see?). Pierces Shadow DOM: plugin views mount inside a shadow root, so this descends shadowRoots to the real deepest element instead of stopping at the shadow host (symmetric with ui.tree, which collects data-node across shadow boundaries). owners is the declared owner chain at that point, topmost first — read layer order from it instead of stitching dataset, host and painters together with your own rule; an empty chain means no exposed node owns that point. The chain is the ancestor path of that element, so every later entry contains every earlier one: ask whether a node owns the point by looking for it IN the chain, never by matching the topmost name against an address prefix — a slash-shaped name proves nothing about containment.",
    params: {
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
    },
    returns: "{ tag, className, dataset, owners, host, painters, rect } | { tag: null }",
    message: (d) => (d.tag ? tmsg("msg.ui.hit.found", { tag: String(d.tag) }) : tmsg("msg.ui.hit.none")),
    examples: ['ui.hit \'{"x":200,"y":140}\''],
    handler: (p) => {
      const el = deepElementFromPoint(Number(p.x), Number(p.y));
      if (!(el instanceof Element)) return { tag: null };
      const r = el.getBoundingClientRect();
      // SVG 의 className 은 SVGAnimatedString — getAttribute 로 통일. 조상 체인의 데이터도 유용해
      // 가장 가까운 [data-node]/[class] 보유 HTML 조상을 closest 로 함께 보고한다.
      // 필드명은 dataset — data 는 봉투 예약키라 정규화가 페이로드를 삼킨다(ui.measure 와 정렬).
      const host = el.closest<HTMLElement>("[data-node], button, a, [class]");
      // 페인트 진단 사슬 — 홀(투명 슬롯) 위를 무엇이 칠하는지 지목한다: 히트 지점의 조상
      // 사슬에서 배경이 투명이 아닌 요소만 배경색과 함께 보고(레이어 원칙 §NATIVE-SURFACES —
      // "홀이 닫혔다" 진단은 이 사슬로 판독한다). 전체 사슬 나열은 소음이라 페인터만 남긴다.
      const painters: { tag: string; className: string; bg: string; node?: string }[] = [];
      for (let n: Element | null = el; n instanceof Element; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
        if (!(n instanceof HTMLElement)) continue;
        const cs = getComputedStyle(n);
        const bg = cs.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          painters.push({
            tag: n.tagName.toLowerCase(),
            className: typeof n.className === "string" ? n.className.slice(0, 60) : "",
            bg,
            ...(n.dataset.node ? { node: n.dataset.node } : {}),
          });
        }
        if (painters.length >= 6) break;
      }
      return {
        tag: el.tagName.toLowerCase(),
        className: el.getAttribute("class") ?? "",
        dataset: el instanceof HTMLElement ? { ...el.dataset } : {},
        // 이 점의 선언 소유자 사슬 — 위(최심)에서 아래로. 층 순서 판정의 단일 입력이다.
        owners: declaredOwnerChain(el),
        host: host
          ? { tag: host.tagName.toLowerCase(), className: host.className, dataset: { ...host.dataset } }
          : null,
        painters,
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      };
    },
  });

}
