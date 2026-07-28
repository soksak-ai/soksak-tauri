// 콘텐츠 뷰 호스트 — "이 앱이 웹 콘텐츠를 어떻게 보여주는가"의 단일 소유자.
//
// 이것은 프레임워크 어댑터가 아니다. 어댑터는 벤더 SDK 를 감싸는 자리이고 정책·상태를 갖지
// 않는다(framework/contract.ts). 여기 있는 것은 **앱의 구조 선택**이다: 콘텐츠를 네이티브
// 자식 뷰로 띄울 것인가, DOM 안에 둘 것인가.
//
// 그 선택은 프레임워크 이름이 아니라 **능력**이 정한다(engineProvision.nativeChildWebview).
// Tauri/macOS 는 자식이 네이티브라 명령이 프로세스를 건너야 하고, Electron 은 <webview> 가
// HTMLElement 라 같은 문서 안에서 끝난다 — 그 경우 invoke 로 나갔다 돌아오는 것은 자기
// 자신에게 왕복하는 셈이다.
//
// 두 구현이 같은 계약을 만족한다는 것이 요점이다. 호출자(plugins/api.ts)는 어느 쪽인지 모른다.
import { engineProvision, invoke } from "../framework";
import { bridgeContentViewEvents } from "./contentViewEvents";

/** 콘텐츠 뷰 하나에 할 수 있는 일 — 앱의 webview_* 표면과 이름·인자가 같다. */
export interface ContentViewHost {
  open(label: string, opts: Record<string, unknown>): Promise<void>;
  close(label: string): Promise<void>;
  list(): Promise<string[]>;
  alive(label: string): Promise<boolean>;
  navigate(label: string, url: string): Promise<void>;
  bounds(label: string, x: number, y: number, w: number, h: number): Promise<boolean>;
  visible(label: string, visible: boolean, focus?: boolean): Promise<void>;
  history(label: string, delta: number): Promise<void>;
  stop(label: string): Promise<void>;
  zoom(label: string, factor: number): Promise<number>;
  devtools(label: string): Promise<boolean>;
  evalJs(label: string, js: string): Promise<string>;
  /** 스크립트 주입. 반환은 해지 — 주입을 되돌릴 수 없는 구현은 해지가 no-op 임을 스스로 밝힌다. */
  injectScript(label: string, code: string, phase: "document-start" | "document-end"): () => void;
  /** 앱 밖 창으로 연다(외부 브라우저가 아니라 이 앱의 새 창). */
  openWindow(url: string): Promise<void>;
}

/**
 * 네이티브 자식 뷰 구현 — 명령이 프로세스를 건넌다.
 *
 * 이름과 인자는 앱의 것 그대로다. 번역하면 새 드리프트 면이 생긴다.
 */
export const nativeHost: ContentViewHost = {
  open: (label, opts) => invoke("webview_open", { label, ...opts }),
  close: (label) => invoke("webview_close", { label }),
  list: () => invoke("webview_list"),
  alive: (label) => invoke("webview_alive", { label }),
  navigate: (label, url) => invoke("webview_navigate", { label, url }),
  bounds: (label, x, y, w, h) => invoke("webview_bounds", { label, x, y, w, h }),
  visible: (label, visible, focus) => invoke("webview_visible", { label, visible, focus }),
  history: (label, delta) => invoke("webview_history", { label, delta }),
  stop: (label) => invoke("webview_stop", { label }),
  zoom: (label, factor) => invoke("webview_zoom_view", { label, factor }),
  devtools: (label) => invoke("webview_devtools", { label }),
  evalJs: (label, js) => invoke("webview_eval", { label, js }),
  injectScript: (label, code, phase) => {
    void invoke("webview_inject_script", { label, code, phase });
    // 네이티브 주입은 해지 통로가 없다 — 없는 것을 있는 척하지 않는다.
    return () => {};
  },
  openWindow: (url) => invoke("webview_open_window", { url }),
};

/** 활성 호스트 — 능력이 고르고, 프레임워크 이름은 여기 없다. */
export function contentViewHost(): ContentViewHost {
  return engineProvision.nativeChildWebview ? nativeHost : domHost;
}

// ── DOM 구현 ─────────────────────────────────────────────────────────────────
//
// 콘텐츠가 <webview> 로 페이지 안에 산다. 프로세스는 갈리므로 크래시 격리는 그대로이고,
// 제어면(loadURL·goBack·setZoomLevel·executeJavaScript·openDevTools…)도 태그가 그대로 준다.
//
// 요소는 label 로 찾는다 — 그것이 네이티브 구현에서 창을 찾는 키와 같은 키다. 두 구현이
// 같은 이름 공간을 쓰지 않으면 호출자가 어느 쪽인지 알게 된다.

const HOST_ID = "content-view-host";

/** label → 사건 해지. 뷰를 닫을 때 함께 끊는다 — 안 끊으면 죽은 label 로 뿌린다. */
const bridges = new Map<string, () => void>();

/** 요소가 붙는 자리. 없으면 만든다 — 배치는 호출자가 bounds 로 정한다. */
function root(doc: Document): HTMLElement {
  let el = doc.getElementById(HOST_ID);
  if (!el) {
    el = doc.createElement("div");
    el.id = HOST_ID;
    el.style.cssText = "position:absolute;left:0;top:0;width:0;height:0";
    doc.body.appendChild(el);
  }
  return el;
}

// 셀렉터로 찾지 않는다 — label 은 임의 문자열이라 이스케이프가 필요하고, 그 이스케이프는
// 환경마다 있고 없다(jsdom 에는 CSS.escape 가 없다). 속성 비교는 어디서나 같은 답이다.
function find(label: string, doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-content-view]")) {
    if (el.getAttribute("data-content-view") === label) return el;
  }
  return null;
}

/** 태그가 아직 그 메서드를 안 붙였으면 조용히 성공하지 않는다. */
function must<T>(el: HTMLElement | null, label: string, name: string): T {
  if (!el) throw new Error(`콘텐츠 뷰가 없습니다: ${label}`);
  const fn = (el as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`콘텐츠 뷰가 ${name} 을 제공하지 않습니다: ${label}`);
  }
  return fn.bind(el) as T;
}

export const domHost: ContentViewHost = {
  async open(label, opts) {
    const doc = document;
    if (find(label, doc)) return;
    const el = doc.createElement("webview");
    el.setAttribute("data-content-view", label);
    if (typeof opts.url === "string") el.setAttribute("src", opts.url);
    el.style.cssText = "position:absolute;display:none";
    root(doc).appendChild(el);
    // 사건을 앱이 아는 이름으로 잇는다. 이것이 없으면 app.webview.on(label, "nav") 구독자가
    // 영영 안 불리고, 그 침묵은 오류로 보이지 않는다.
    bridges.set(label, bridgeContentViewEvents(el, label));
  },
  async close(label) {
    bridges.get(label)?.();
    bridges.delete(label);
    find(label, document)?.remove();
  },
  async list() {
    return [...document.querySelectorAll("[data-content-view]")].map(
      (e) => e.getAttribute("data-content-view") ?? "",
    );
  },
  async alive(label) {
    return find(label, document) !== null;
  },
  async navigate(label, url) {
    must<(u: string) => void>(find(label, document), label, "loadURL")(url);
  },
  async bounds(label, x, y, w, h) {
    const el = find(label, document);
    if (!el) return false;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    return true;
  },
  async visible(label, visible) {
    const el = find(label, document);
    if (el) el.style.display = visible ? "" : "none";
  },
  async history(label, delta) {
    const el = find(label, document);
    if (delta < 0) must<() => void>(el, label, "goBack")();
    else if (delta > 0) must<() => void>(el, label, "goForward")();
  },
  async stop(label) {
    must<() => void>(find(label, document), label, "stop")();
  },
  async zoom(label, factor) {
    // 태그는 배율이 아니라 레벨을 받는다(level = log1.2(factor)) — 번역은 여기서 한다.
    must<(l: number) => void>(find(label, document), label, "setZoomLevel")(
      Math.log(factor) / Math.log(1.2),
    );
    return factor;
  },
  async devtools(label) {
    must<() => void>(find(label, document), label, "openDevTools")();
    return true;
  },
  async evalJs(label, js) {
    const run = must<(s: string) => Promise<unknown>>(find(label, document), label, "executeJavaScript");
    // `js` 는 **비동기 함수 본문**이다 — 계약의 정본은 WKWebView 의 callAsyncJavaScript(body)
    // 이고, 부르는 쪽은 그렇게 쓴다("return document.title"). 태그의 executeJavaScript 는
    // 그것을 **스크립트**로 평가하므로 최상위 return 이 문법 오류다. 감싸지 않으면 게스트
    // 스크립트가 전부 "Script failed to execute" 로 죽고, 그 한 줄이 브라우저 자동화 전체를
    // 막는다(실측 2026-07-28: dom.text·eval 이 1+1 조차 실패했다).
    return String(await run(`(async () => { ${js} })()`));
  },
  injectScript(label, code, phase) {
    // 태그는 dom-ready 전에 붙인 preload 만 document-start 를 보장한다. 그 통로가 없으므로
    // 여기서는 즉시 실행이고, document-start 요구는 지킬 수 없음을 이름을 달고 알린다 —
    // 조용히 document-end 로 낮추면 주입이 늦어 실패하는 자리가 오류 없이 생긴다.
    if (phase === "document-start") {
      throw new Error(
        `document-start 주입은 이 콘텐츠 뷰가 보장하지 못합니다(태그는 preload 로만 가능): ${label}`,
      );
    }
    const run = must<(s: string) => Promise<unknown>>(find(label, document), label, "executeJavaScript");
    void run(code);
    return () => {};
  },
  async openWindow(url) {
    // 새 창은 프레임워크의 것이다 — DOM 이 만들 수 있는 것이 아니다.
    await invoke("window_create", { url });
  },
};
