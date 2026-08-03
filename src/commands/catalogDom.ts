// ui.* DOM 주소 명령 — 구조적 path 주소로 DOM 을 조회/측정/조작한다(임의 selector 금지).
//
// 단일 진실: 주소 문법은 address.ts, 노드 수집은 nodeScan.ts. 여기는 그 둘을 소켓 명령으로 노출.
//  - ui.tree:        노출된 DOM 주소 트리(뷰 컨테이너 [data-node] + 호스트 크롬 [data-node]).
//  - ui.measure:     주소 → 요소 rect + computed style(레이아웃 진단). selector 거부(주소만).
//  - ui.input.click: 주소 → 요소 click 디스패치(danger:inject). 불일치 = NOT_EXPOSED.
// 노출(data-node)되지 않은 요소는 주소 트리에 없어 접근 불가 → 명확한 에러(추측 0).

import { moduleState } from "../lib/moduleState";
import { currentWindow, invoke } from "../framework";
import { browserLabel, currentWindowLabel } from "../lib/webviewLabels";
import { contentViewHost } from "../lib/contentViews";
import { parseAddress, isParseError } from "./address";
import { scanNodes, type ScannedNode } from "../plugins/nodeScan";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { viewFocusSnapshot } from "../plugins/viewFocus";
import { useGutterHover } from "../state/gutterHover";
import { motionLiveList, motionLiveRates, setMotionDebug, motionRecentBirths, motionJourneys, motionSwaps, motionTriggers } from "../lib/motionDebug";
import { railTravelMs, railTravelWallMs } from "../lib/railMotion";

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

const notExposed = (addr: string) => ({
  ok: false as const,
  code: "NOT_EXPOSED" as const,
  message: `노출되지 않은 주소(접근 불가): ${addr}`,
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
      message: `한 주소가 ${matches.length}개로 풀립니다(주소 공리 A1 위반): ${addressStr} — tab 축으로 좁히세요`,
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
      "Return the exposed DOM address tree — absolute addresses of nodes declared via data-node by plugin views and host-chrome elements. Use to discover addressable targets before calling ui.measure or ui.input.click; unexposed elements are absent and unreachable. Pass rects:true to include each node's viewport rect for coordinate work (drags, precision clicks).",
    triggers: { ko: "DOM 트리 주소목록 노드목록 ui트리" },
    params: {
      rects: {
        type: "boolean",
        description: "Include each node's viewport rect {x,y,w,h} (px)",
        default: false,
      },
    },
    returns: "{ window, count, duplicates, nodes: [{ address, nodePath, rect? }] }",
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
        if (!withRects) return { address: n.address, nodePath: n.nodePath };
        const r = n.el.getBoundingClientRect();
        return {
          address: n.address,
          nodePath: n.nodePath,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        };
      });
      return { window: currentWindowLabel(), count: nodes.length, duplicates, nodes };
    },
  });

  register("ui.measure", {
    description:
      "Measure an exposed node — its viewport rect (px) and computed style. style always includes the layout fields plus the interaction/visibility axis (pointerEvents, opacity, visibility) so you can tell whether a node is actually visible and clickable, not just where it sits. Pass props to read any extra computed properties by name (e.g. zIndex, transform, backgroundColor). Pass occlusion:true to also hit-test the node's center (through Shadow DOM) and report what covers it and whether it is reachable. Pass screen:true to also get the node's GLOBAL logical screen coordinates (screen.x/y = rect origin, screen.cx/cy = center) — feed cx/cy straight to an OS pointer tool (e.g. cliclick c:cx,cy) when a real hit-tested click is required; synthetic ui.input.click bypasses hit-testing and default actions, so it cannot verify pointer-events or focus-on-mouseup behavior. Accepts structural addresses from ui.tree only; CSS selectors are rejected.",
    triggers: { ko: "DOM 측정 레이아웃 rect 크기 스타일 포인터이벤트 가시성 가림 도달성 스크린 전역좌표 실클릭" },
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
          "Also hit-test the node's center (Shadow-DOM-piercing): report the topmost element there and whether it is this node (reachable) or something covers it",
        default: false,
      },
      screen: {
        type: "boolean",
        description:
          "Also return global logical screen coordinates (window inner origin + viewport rect). cx/cy is the node center — pass it directly to an OS-level pointer tool for a real hit-tested click",
        default: false,
      },
    },
    returns:
      "{ address, dataset, rect:{x,y,w,h}, style, occlusion?:{ reachable, topTag, topNode }, screen?:{ x, y, cx, cy } } — dataset contains every declared data-* field on the exposed node",
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
      const out: Record<string, unknown> = {
        address: addr,
        ...(pseudo ? { pseudo } : {}),
        // 모든 data-* 선언은 공개 상태다. 자동화/플러그인은 private DOM 속성명을
        // 다시 추측하지 않고 ui.tree → ui.measure 한 경로로 읽는다.
        dataset: Object.fromEntries(Object.entries(el.dataset)),
        rect: {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
        },
        style,
      };
      // occlusion — rect 중심에서 shadow 관통 히트테스트로 "무엇이 가리나 + 도달 가능한가"를
      // 판정. ui.hit 과 조합해 소비자가 파생할 수 있으나 흔한 판정이라 한 번에 제공(재발명 방지).
      if (p.occlusion === true) {
        const top = deepElementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        out.occlusion = {
          reachable: !!top && (top === el || el.contains(top) || top.contains(el)),
          topTag: top ? top.tagName.toLowerCase() : null,
          topNode: top instanceof HTMLElement ? (top.dataset.node ?? null) : null,
        };
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
      "{ requestedTabId, mounted, delivered, activeTabId, settled, windowFocused, activeElement:{ tag, dataNode, className, ancestors } }",
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
      return {
        requestedTabId: request.requestedViewId,
        mounted: request.mounted,
        delivered: request.delivered,
        activeTabId,
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

  register("ui.input.click", {
    description:
      "Dispatch a real-click sequence (mousedown → mouseup → click) to an exposed node (E2E injection). Use to drive UI flows programmatically or in tests. Pass phase:'down' to send only the mousedown, then observe the mid-gesture state (ui.hit / ui.measure), then phase:'up' to finish with mouseup+click — the only way to verify contracts that live BETWEEN down and up (e.g. that a mid-gesture surface stays hittable, or that activation waits for gesture completion). Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
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
    },
    returns: "{ clicked, address, phase? }",
    message: () => tmsg("msg.ui.input.click"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
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
      // **콘텐츠 뷰를 가리키면 그 안으로 넣는다.**
      //
      // 그 안은 다른 프로세스라 DOM 으로 만든 클릭이 닿지 않고, 닿아도 사용자 활성화가 없어
      // 엔진이 창-열기 같은 것을 막는다(실측 2026-08-02: `_blank` 링크를 스크립트로 눌러도
      // 창-열기 요청이 0회였다). 태그가 게스트에 미는 입력은 엔진이 내는 진짜 입력이다.
      //
      // 좌표는 **뷰 좌표**다(CSS px). 안 주면 왼쪽 위 — 가운데를 기본으로 하면 무엇이 눌릴지
      // 그 페이지가 정하고, 검사가 페이지 내용에 매달린다.
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
      if (view) {
        const cvLabel = view.getAttribute("data-content-view") ?? "";
        const r0 = view.getBoundingClientRect();
        const at = {
          x: typeof p.x === "number" ? p.x : Math.round(r0.left),
          y: typeof p.y === "number" ? p.y : Math.round(r0.top),
        };
        // 호스트 계약을 지난다 — 태그를 직접 만지면 그 구현이 바뀌는 날 이 자리만 조용히 죽는다.
        // 못 하는 구현은 그 자리에서 이름을 달고 거절한다(조용한 성공 금지).
        await contentViewHost().sendInput(cvLabel, at.x, at.y);
        return { clicked: true, address: addr, contentView: cvLabel };
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
      for (const type of types) {
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }),
        );
      }
      return phase
        ? { clicked: true, address: addr, phase }
        : { clicked: true, address: addr };
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
    handler: (p) => {
      const addr = p.address as string;
      const key = p.key as string;
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "key is required" };
      }
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
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
      "Drive the pointer the way the OS does: enter/move onto an exposed node, or leave (no address = the pointer is not over us). Hover state that a native child surface can steal — gutter highlight — is owned by app state, not CSS :hover, precisely so it can be driven and read back here. Returns the gutter-hover key now held, so a test can assert both the arming and the release.",
    triggers: { ko: "포인터 이동 hover 강조 진입 이탈 마우스 주입 E2E" },
    params: {
      address: { type: "string", description: "Exposed node to move onto. Omit to signal the pointer left us." },
    },
    returns: "{ address, gutterHover }",
    message: () => tmsg("msg.ui.input.pointer"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS"],
    danger: "inject",
    examples: [
      'ui.input.pointer \'{"address":"win/main/chrome/gutter/pan-g2h3j4/right"}\'',
      "ui.input.pointer   # 이탈(강조 해제)",
    ],
    handler: (p) => {
      const addr = typeof p.address === "string" ? p.address : null;
      if (addr == null) {
        useGutterHover.getState().set(null);
        return { address: null, gutterHover: useGutterHover.getState().key };
      }
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
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
    },
    returns: "{ dblclicked, address }",
    message: () => tmsg("msg.ui.input.dblclick"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    danger: "inject",
    examples: ['ui.input.dblclick \'{"address":"win/main/chrome/tab/left/a.x"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
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
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.fill \'{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}\'',
    ],
    handler: (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
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
      "Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup). Two modes: (1) drop onto a target — give `to` (+ optional zone); (2) drag by dx/dy for resize handles. steps and durationMs expose a finite real-time sequence for animation/layout verification; defaults preserve the immediate two-move behavior. recordDir starts the framework-neutral window recorder in the same request before the drag, so transition frames are observable even when control requests are serialized. mousemove+mouseup dispatch on window so window-level drag listeners receive them.",
    triggers: { ko: "드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그" },
    params: {
      from: { type: "string", description: "Source node address (the tab / gutter / element to grab)", required: true },
      to: { type: "string", description: "Target node address to drop onto (mode 1). Omit when using dx/dy.", required: false },
      zone: {
        type: "string",
        description: "center | left | right | top | bottom — point within the target rect (mode 1)",
        enum: ["center", "left", "right", "top", "bottom"],
      },
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
        description: "Finite pre-drag recording lead in milliseconds (0..2000, default 0).",
        default: 0,
      },
      captureSteps: {
        type: "boolean",
        description: "With recordDir, capture the baseline, every injected move, and the released frame deterministically instead of running the real-time recorder. Works without focusing the window.",
        default: false,
      },
    },
    returns: "{ dragged, from, to?, zone?, dx?, dy?, steps, durationMs, recording?:{dir,frames} }",
    message: (d) => (d.dragged ? tmsg("msg.ui.input.drag.dragged") : tmsg("msg.ui.input.drag.tap")),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
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
      const captureSteps = p.captureSteps === true;
      const recordFrames = p.recordFrames === undefined ? 120 : Number(p.recordFrames);
      const recordIntervalMs = p.recordIntervalMs === undefined ? 33 : Number(p.recordIntervalMs);
      const recordLeadMs = p.recordLeadMs === undefined ? 0 : Number(p.recordLeadMs);
      if (
        recordDir &&
        (!Number.isInteger(recordFrames) || recordFrames < 1 || recordFrames > 600 ||
          !Number.isFinite(recordIntervalMs) || recordIntervalMs < 0 ||
          !Number.isFinite(recordLeadMs) || recordLeadMs < 0 || recordLeadMs > 2_000)
      ) {
        return { ok: false as const, code: "INVALID_PARAMS", message: "녹화 인자가 범위를 벗어났다" };
      }
      if (captureSteps && !recordDir) {
        return { ok: false as const, code: "INVALID_PARAMS", message: "captureSteps에는 recordDir가 필요하다" };
      }
      const fromR = resolveExposed(p.from as string);
      if (!("el" in fromR)) return fromR;
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
      let capturedSteps = 0;
      const captureStep = async (): Promise<void> => {
        if (!recordDir || !captureSteps) return;
        const png = await invoke<string>("plugin:webview-capture|snapshot_region", {});
        await invoke("write_file_base64", {
          path: `${recordDir}/f${String(capturedSteps).padStart(4, "0")}.png`,
          base64: png,
        });
        capturedSteps += 1;
      };
      const recording = recordDir && !captureSteps
        ? invoke<number>("plugin:webview-capture|record", {
            dir: recordDir,
            frames: recordFrames,
            intervalMs: recordIntervalMs,
          })
        : null;
      await captureStep();
      if (recording && recordLeadMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, recordLeadMs));
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
          await captureStep();
          if (durationMs > 0 && step < steps) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, durationMs / steps),
            );
          }
        }
      }
      fire("mouseup", toPt.x, toPt.y, window);
      await captureStep();
      const recordingResult = captureSteps
        ? { recording: { dir: recordDir, frames: capturedSteps, mode: "steps" } }
        : recording
          ? { recording: { dir: recordDir, frames: await recording, mode: "realtime" } }
          : {};
      return byDelta
        ? { dragged: dist >= 5, from: p.from, dx: p.dx ?? 0, dy: p.dy ?? 0, steps, durationMs, ...recordingResult }
        : { dragged: dist >= 5, click: dist < 5, from: p.from, to: p.to, zone: p.zone ?? "center", steps, durationMs, ...recordingResult };
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
      "Return the topmost DOM element at viewport x,y (tag, classes, data-* attrs, rect) — hit-test diagnostics for drag/click E2E (what would elementFromPoint see?). Pierces Shadow DOM: plugin views mount inside a shadow root, so this descends shadowRoots to the real deepest element instead of stopping at the shadow host (symmetric with ui.tree, which collects data-node across shadow boundaries).",
    params: {
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
    },
    returns: "{ tag, className, dataset, host, rect } | { tag: null }",
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
        host: host
          ? { tag: host.tagName.toLowerCase(), className: host.className, dataset: { ...host.dataset } }
          : null,
        painters,
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      };
    },
  });

}
