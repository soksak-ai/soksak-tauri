// ui.* DOM 주소 명령 — 구조적 path 주소로 DOM 을 조회/측정/조작한다(임의 selector 금지).
//
// 단일 진실: 주소 문법은 address.ts, 노드 수집은 nodeScan.ts. 여기는 그 둘을 소켓 명령으로 노출.
//  - ui.tree:        노출된 DOM 주소 트리(뷰 컨테이너 [data-node] + 호스트 크롬 [data-node]).
//  - ui.measure:     주소 → 요소 rect + computed style(레이아웃 진단). selector 거부(주소만).
//  - ui.input.click: 주소 → 요소 click 디스패치(danger:inject). 불일치 = NOT_EXPOSED.
// 노출(data-node)되지 않은 요소는 주소 트리에 없어 접근 불가 → 명확한 에러(추측 0).

import { invoke } from "@tauri-apps/api/core";
import { currentWindowLabel } from "../lib/webviewLabels";
import { parseAddress, isParseError } from "./address";
import { scanNodes, type ScannedNode } from "../plugins/nodeScan";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { viewFocusSnapshot } from "../plugins/viewFocus";

const notExposed = (addr: string) => ({
  ok: false as const,
  code: "NOT_EXPOSED" as const,
  message: `노출되지 않은 주소(접근 불가): ${addr}`,
});

// 현재 창의 노출 노드 전부를 절대 주소로 수집한다(뷰 컨테이너 + 호스트 크롬). DOM 직접 순회.
export function collectExposed(): ScannedNode[] {
  const out: ScannedNode[] = [];
  const win = currentWindowLabel();
  // 뷰 컨테이너 — data-view-addr(<region>/view/<viewKey>) 를 baseAddress 로. win 접두는 현재 창.
  for (const c of document.querySelectorAll<HTMLElement>(".plugin-view-container[data-view-addr]")) {
    const base = c.dataset.viewAddr ?? "";
    if (!base) continue;
    out.push(...scanNodes(c, `win/${win}/${base}`));
  }
  // 호스트 크롬 — 뷰 컨테이너 밖의 [data-node]. 주소 = win/<label>/chrome/<nodePath>.
  for (const el of document.querySelectorAll<HTMLElement>("[data-node]")) {
    if (el.closest(".plugin-view-container")) continue; // 뷰 노드는 위에서 처리
    const nodePath = el.dataset.node ?? "";
    if (!nodePath) continue;
    out.push({ address: `win/${win}/chrome/${nodePath}`, nodePath, el });
  }
  return out;
}

// 주소 → 단일 요소 resolve. 정규화(parse∘format) 한 주소로 매칭(생략형/정규형 일치). 없으면 null.
function resolveElement(addressStr: string): HTMLElement | null {
  const parsed = parseAddress(addressStr);
  if (isParseError(parsed)) return null;
  const exposed = collectExposed();
  // 정확 일치 우선. 입력 주소에 win 생략 시 현재 창으로 보정해 비교.
  const want = addressStr.replace(/^\/+|\/+$/g, "");
  const wantWithWin = want.startsWith("win/") ? want : `win/${currentWindowLabel()}/${want}`;
  const matches = exposed.filter((n) => n.address === want || n.address === wantWithWin);
  if (matches.length === 0) return null;
  // 같은 주소가 여러 요소에 붙을 수 있다(시트마다 반복되는 크롬 노드 — 뷰 탭바 등). 파킹된
  // (화면 밖 translateX) 복제를 잡으면 클릭/측정이 보이지 않는 요소로 가서 "동작 없음"이 된다
  // (실측: 탭 클릭 E2E 가 비활성 시트의 탭을 눌렀다). 사용자가 보는 요소 — 뷰포트와 교차하고
  // 크기가 있는 것 — 를 우선하고, 보이는 게 없으면 첫 매치(기존 동작)로 폴백한다.
  const visible = matches.find((n) => {
    const r = n.el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < window.innerWidth &&
      r.top < window.innerHeight
    );
  });
  return (visible ?? matches[0]).el;
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

// 요소가 속한 플러그인 뷰 컨테이너(.plugin-view-container[data-pane-id]). shadow 안 요소의
// closest 는 shadow 경계를 못 넘으므로, 경계에서 막히면 shadow host 로 올라가 다시 시도한다
// (shadow 관통 조상 탐색).
export function viewContainerOf(el: Element | null): HTMLElement | null {
  let cur: Node | null = el;
  while (cur instanceof Element) {
    const host = cur.closest<HTMLElement>(".plugin-view-container[data-pane-id]");
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
    returns: "{ window, count, nodes: [{ address, nodePath, rect? }] }",
    message: (d) => tmsg("msg.ui.tree", { n: Number(d.count ?? 0) }),
    examples: ["ui.tree", 'ui.tree \'{"rects":true}\''],
    handler: (p) => {
      const withRects = p.rects === true;
      const nodes = collectExposed().map((n) => {
        if (!withRects) return { address: n.address, nodePath: n.nodePath };
        const r = n.el.getBoundingClientRect();
        return {
          address: n.address,
          nodePath: n.nodePath,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        };
      });
      return { window: currentWindowLabel(), count: nodes.length, nodes };
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
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['ui.measure \'{"address":"content/view/soksak-plugin-<id>.<view>/node/send"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
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
      const out: Record<string, unknown> = {
        address: addr,
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
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
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
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['ui.slot \'{"address":"win/main/content/view/soksak-plugin-<id>.<view>"}\''],
    handler: (p) => {
      const addr = (p.address as string) ?? "";
      const want = addr.replace(/^\/+|\/+$/g, "");
      const win = currentWindowLabel();
      const wantWithWin = want.startsWith("win/") ? want : `win/${win}/${want}`;
      // 뷰 컨테이너를 base 주소(collectExposed 와 동일 생성 규칙)로 매칭 — node 없는 view 주소.
      for (const c of document.querySelectorAll<HTMLElement>(
        ".plugin-view-container[data-view-addr]",
      )) {
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
      "Return the keyboard-focus owner through the public view-host boundary: the requested view, whether its provider is mounted/delivered, and the view containing the active element. Pierces Shadow DOM — plugin views mount inside a shadow root, so this descends shadowRoot.activeElement to the real focused element (and finds its view across the shadow boundary) instead of stopping at the shadow host. Use after real-device input to verify focus settled in the intended view without querying plugin-private DOM.",
    triggers: { ko: "키보드 포커스 소유자 활성 뷰 포커스 상태" },
    params: {},
    returns:
      "{ requestedViewId, mounted, delivered, activeViewId, settled, activeElement }",
    message: (d) =>
      tmsg("msg.ui.focus.state", {
        view: String(d.activeViewId ?? "none"),
      }),
    examples: ["ui.focus.state"],
    handler: () => {
      const request = viewFocusSnapshot();
      const active = deepActiveElement();
      const host = viewContainerOf(active);
      const activeViewId = host?.dataset.paneId ?? null;
      return {
        ...request,
        activeViewId,
        settled:
          request.delivered && request.requestedViewId === activeViewId,
        activeElement:
          active instanceof HTMLElement
            ? {
                tag: active.tagName.toLowerCase(),
                dataNode: active.dataset.node ?? null,
                className: active.className,
              }
            : null,
      };
    },
  });

  register("ui.input.click", {
    description:
      "Dispatch a real-click sequence (mousedown → mouseup → click) to an exposed node (E2E injection). Use to drive UI flows programmatically or in tests. Pass phase:'down' to send only the mousedown, then observe the mid-gesture state (ui.hit / ui.measure), then phase:'up' to finish with mouseup+click — the only way to verify contracts that live BETWEEN down and up (e.g. travel-phase inertness with its gesture-owner exemption). Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "클릭 주입 ui클릭 버튼클릭 E2E 게스처 다운 업 분해" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      phase: {
        type: "string",
        description:
          "'down' = mousedown only; 'up' = mouseup+click only; omit for the full sequence",
        required: false,
      },
    },
    returns: "{ clicked, address, phase? }",
    message: () => tmsg("msg.ui.input.click"),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: ['ui.input.click \'{"address":"win/main/chrome/modal/consent/agree"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      // 실제 클릭과 등가 시퀀스 — el.click()(click 단발)은 mousedown 기반 요소(사이드바 탭
      // 드래그-선택 등)를 못 누른다. dblclick 커맨드와 동일 패턴의 1라운드.
      // phase 분해: down/up 사이가 계약인 기능(주행 불활성·게스처-당사자)은 중간 관찰이
      // 필요하므로 시퀀스를 쪼갤 수 있다.
      const phase = p.phase as string | undefined;
      if (phase !== undefined && phase !== "down" && phase !== "up") {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: `phase must be 'down' or 'up', got: ${phase}`,
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

  register("ui.input.dblclick", {
    description:
      "Dispatch a double-click (two clicks + a dblclick event) to an exposed node (E2E injection). Use to drive double-click UI flows like inline tab/label rename. Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "더블클릭 두번클릭 이름변경 rename 주입 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
    },
    returns: "{ dblclicked, address }",
    message: () => tmsg("msg.ui.input.dblclick"),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: ['ui.input.dblclick \'{"address":"win/main/chrome/tab/left/a.x"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
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
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.fill \'{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}\'',
    ],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
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
      "Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup). Two modes: (1) drop onto a target — give `to` (+ optional zone); (2) drag by dx/dy for resize handles. steps and durationMs expose a finite real-time sequence for animation/layout verification; defaults preserve the immediate two-move behavior. mousemove+mouseup dispatch on window so window-level drag listeners receive them.",
    triggers: { ko: "드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그" },
    params: {
      from: { type: "string", description: "Source node address (the tab / divider / element to grab)", required: true },
      to: { type: "string", description: "Target node address to drop onto (mode 1). Omit when using dx/dy.", required: false },
      zone: {
        type: "string",
        description: "center | left | right | top | bottom — point within the target rect (mode 1)",
        enum: ["center", "left", "right", "top", "bottom"],
      },
      dx: { type: "number", description: "Horizontal drag distance in CSS px from `from` center (mode 2 — resize/divider). Alternative to `to`.", required: false },
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
    },
    returns: "{ dragged, from, to?, zone?, dx?, dy?, steps, durationMs }",
    message: (d) => (d.dragged ? tmsg("msg.ui.input.drag.dragged") : tmsg("msg.ui.input.drag.tap")),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.drag \'{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}\'',
      'ui.input.drag \'{"from":"win/main/chrome/divider/s0/0","dx":120}\'',
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
      const fromEl = resolveElement(p.from as string);
      if (!fromEl) return notExposed(p.from as string);
      const fr = fromEl.getBoundingClientRect();
      const fromPt = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
      const byDelta = p.dx != null || p.dy != null;
      let toPt: { x: number; y: number };
      if (byDelta) {
        // 모드 2 — 픽셀 델타(리사이즈 핸들/디바이더). from 중앙을 잡아 dx/dy 만큼 끈다.
        toPt = { x: fromPt.x + (Number(p.dx) || 0), y: fromPt.y + (Number(p.dy) || 0) };
      } else {
        // 모드 1 — 타겟에 드롭(탭 병합/분할).
        const toEl = resolveElement(p.to as string);
        if (!toEl) return notExposed(p.to as string);
        const tr = toEl.getBoundingClientRect();
        const zone = (p.zone as string) ?? "center";
        const zx = zone === "left" ? 0.08 : zone === "right" ? 0.92 : 0.5;
        const zy = zone === "top" ? 0.12 : zone === "bottom" ? 0.88 : 0.5;
        toPt = { x: tr.left + tr.width * zx, y: tr.top + tr.height * zy };
      }
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }),
        );
      const dist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
      // mousedown 은 잡는 요소(divider/탭)에, move/up 은 window 에 — divider 리사이즈는 window 레벨
      // mousemove/mouseup 리스너를 onDividerDown 이 등록하므로 window 로 보내야 받는다.
      fire("mousedown", fromPt.x, fromPt.y, fromEl);
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
      return byDelta
        ? { dragged: dist >= 5, from: p.from, dx: p.dx ?? 0, dy: p.dy ?? 0, steps, durationMs }
        : { dragged: dist >= 5, click: dist < 5, from: p.from, to: p.to, zone: p.zone ?? "center", steps, durationMs };
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
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.dnd \'{"from":".../node/section/s2","to":".../node/section/s5","position":"after"}\'',
      'ui.input.dnd \'{"to":".../node/img/s2/hero","files":[{"name":"a.png","type":"image/png","base64":"…"}]}\'',
    ],
    handler: async (p) => {
      const toEl = resolveElement(p.to as string);
      if (!toEl) return notExposed(p.to as string);
      let fromEl: HTMLElement | null = null;
      if (p.from != null) {
        fromEl = resolveElement(p.from as string);
        if (!fromEl) return notExposed(p.from as string);
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
    returns: "{ tag, className, data, rect } | { tag: null }",
    message: (d) => (d.tag ? tmsg("msg.ui.hit.found", { tag: String(d.tag) }) : tmsg("msg.ui.hit.none")),
    examples: ['ui.hit \'{"x":200,"y":140}\''],
    handler: (p) => {
      const el = deepElementFromPoint(Number(p.x), Number(p.y));
      if (!(el instanceof Element)) return { tag: null };
      const r = el.getBoundingClientRect();
      // SVG 의 className 은 SVGAnimatedString — getAttribute 로 통일. 조상 체인의 데이터도 유용해
      // 가장 가까운 [data-node]/[class] 보유 HTML 조상을 closest 로 함께 보고한다.
      const host = el.closest<HTMLElement>("[data-node], button, a, [class]");
      return {
        tag: el.tagName.toLowerCase(),
        className: el.getAttribute("class") ?? "",
        data: el instanceof HTMLElement ? { ...el.dataset } : {},
        host: host
          ? { tag: host.tagName.toLowerCase(), className: host.className, data: { ...host.dataset } }
          : null,
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      };
    },
  });

  // native 마우스 브릿지(App 의 native-mousedown/move/up)를 소켓으로 구동 — 브라우저(네이티브 child)
  // 위 divider 드래그를 실제 마우스 없이 E2E 자가검증. kind = native-mousedown|native-mousemove|native-mouseup.
  register("webview.emitNative", {
    description: "Emit a native mouse-bridge event (native-mousedown/move/up) at viewport x,y — drives divider drag/resize over a native child (browser) without a real mouse, for E2E. Pair with ui.input.drag (DOM path); this is the native path. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    params: {
      kind: { type: "string", description: "native-mousedown | native-mousemove | native-mouseup", required: true },
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
    },
    returns: "{ ok, kind }",
    message: (d) => tmsg("msg.webview.emitNative", { kind: String(d.kind) }),
    examples: ['webview.emitNative \'{"kind":"native-mousedown","x":400,"y":300}\''],
    handler: async (p) => {
      await invoke("webview_emit_native", { kind: p.kind, x: p.x, y: p.y });
      return { ok: true, kind: p.kind };
    },
  });
}
