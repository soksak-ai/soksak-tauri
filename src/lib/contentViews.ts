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
import { moduleState } from "../lib/moduleState";
import { engineProvision, invoke } from "../framework";
import { bridgeContentViewEvents } from "./contentViewEvents";
import { applyParked } from "./layerPark";

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
  /**
   * 콘텐츠 뷰 **안**으로 진짜 입력을 넣는다 — 뷰 좌표(CSS px).
   *
   * 스크립트로 만든 클릭에는 사용자 활성화가 없어서 엔진이 창-열기 같은 것을 막는다(실측
   * 2026-08-02: `_blank` 링크를 스크립트로 눌러도 창-열기 요청이 0회였다). 그래서 검증이
   * "잴 방법이 없다"로 멈췄다 — 없으면 만드는 것까지가 이 자리의 몫이다(A27).
   *
   * 못 하는 구현은 이름을 달고 거절한다. 조용히 성공하면 부른 쪽은 눌렀다고 믿는다.
   */
  sendInput(label: string, x: number, y: number): Promise<void>;
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
  sendInput: async (label) => {
    // **이 구현에는 아직 통로가 없다.** 콘텐츠가 OS 자식 뷰라, 입력을 넣으려면 그 뷰가 사는
    // 창에 좌표를 실은 네이티브 사건을 얹어야 한다 — 이 프로세스의 입력 모니터는 읽기만 하고
    // 쓰는 자리는 없다. 없는 명령을 부르면 유령 공백이 생기므로 이름을 달고 거절한다.
    //
    // 사용자 클릭은 이 구현에서도 이미 앱에 닿는다(모니터가 좌표를 나른다) — 없는 것은
    // **구동**뿐이다. 그 차이를 조용한 성공으로 덮지 않는다.
    throw new Error(`이 콘텐츠 뷰 구현은 입력 주입 통로가 없습니다: ${label}`);
  },
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
// 갈아끼우기 경계 밖 — 이 표가 새것이 되면 채운 쪽은 이미 채웠다고 알아 다시 채우지 않는다.
const bridges = moduleState("lib/contentViews#bridges", () => new Map<string, () => void>());
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
/**
 * 이 태그가 제어면을 받을 준비가 됐다는 약속. **만들 때 건다.**
 *
 * `dom-ready` 는 한 번만 난다 — 나중에 구독하면 영영 못 받는다. 그래서 태그를 만드는 자리에서
 * 곧바로 걸어 둔다: 준비가 먼저 나도 그 사실이 약속에 남는다.
 *
 * 제어면은 준비된 뒤에만 부를 수 있고, 태그 구현이 그 규칙을 예외로 강제한다("DOM 에 붙고
 * dom-ready 가 난 뒤에야 부를 수 있다"). 부르는 쪽마다 타이밍을 맞추면 한 곳만 어긋나도
 * **Uncaught 로 부팅이 끊긴다** — 실측 2026-08-01: Electron 부팅마다 그 예외가 났고 다른
 * 프레임워크에서는 조용해 한쪽에서만 죽었다. 그래서 규칙을 **이 문 하나**에 둔다.
 */
const READY = moduleState(
  "lib/contentViews#ready",
  () => new WeakMap<HTMLElement, Promise<void>>(),
);

/**
 * 준비를 기다리는 상한. **기다림은 끝나야 한다** — 게스트가 죽으면 `dom-ready` 는 영영 안 오고,
 * 상한이 없으면 그 제어면 호출 하나가 부른 쪽을 영원히 붙잡는다(행). 종결 사건은 `dom-ready`
 * 이고 이 수는 그것이 안 올 때의 탈출구다.
 */
const READY_LIMIT_MS = 3000;

/** 태그를 만든 자리가 부른다 — 준비 사건을 놓치지 않게 곧바로 건다. */
function armReady(el: HTMLElement): void {
  READY.set(
    el,
    new Promise<void>((done, fail) => {
      const timer = setTimeout(() => {
        el.removeEventListener("dom-ready", on);
        // 이름을 달고 실패한다 — 조용히 지나가면 그 다음 줄이 안 붙은 태그에 제어면을 부른다.
        fail(new Error("콘텐츠 뷰가 준비되지 않았습니다(dom-ready 없음)"));
      }, READY_LIMIT_MS);
      const on = () => {
        clearTimeout(timer);
        el.removeEventListener("dom-ready", on);
        done();
      };
      el.addEventListener("dom-ready", on);
    }),
  );
  // 아무도 안 기다리는 사이 실패가 나면 처리 안 된 reject 가 된다 — 한 번 받아 둔다.
  READY.get(el)?.catch(() => {});
}

function ready(el: HTMLElement): Promise<void> {
  // 걸어 두지 않은 태그(남이 만든 것)는 기다릴 근거가 없다 — 그대로 지나간다.
  return READY.get(el) ?? Promise.resolve();
}

function must<T>(el: HTMLElement | null, label: string, name: string): T {
  if (!el) throw new Error(`콘텐츠 뷰가 없습니다: ${label}`);
  const fn = (el as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`콘텐츠 뷰가 ${name} 을 제공하지 않습니다: ${label}`);
  }
  return fn.bind(el) as T;
}

/** 준비를 기다린 뒤 제어면을 부른다 — 이 문을 지나지 않는 호출이 그 예외를 만든다. */
async function onReady<T>(label: string, name: string): Promise<T> {
  const el = find(label, document);
  if (!el) throw new Error(`콘텐츠 뷰가 없습니다: ${label}`);
  await ready(el);
  return must<T>(el, label, name);
}

export const domHost: ContentViewHost = {
  async open(label, opts) {
    const doc = document;
    if (find(label, doc)) return;
    const el = doc.createElement("webview");
    // 준비 약속을 **만들자마자** 건다 — dom-ready 는 한 번만 나고, 나중에 구독하면 놓친다.
    armReady(el);
    el.setAttribute("data-content-view", label);
    // 파킹으로 숨긴다 — display:none 은 상자를 레이아웃에서 빼고, 되살릴 때 게스트가 0×0
    // 뷰포트로 붙는다(URL 은 맞는데 화면만 백지). 규칙은 layerPark 가 단일 진실이다.
    el.style.cssText = "position:absolute";
    applyParked(el, false);
    root(doc).appendChild(el);
    // **주소는 붙인 뒤에 준다.** 안 붙은 태그에 `src` 를 주면 그 프레임워크의 태그 구현이
    // 내부적으로 적재를 시작하다 "DOM 에 붙고 dom-ready 가 난 뒤에야 부를 수 있다"로 던진다 —
    // 그 예외는 **Uncaught 라 부팅 경로를 거기서 끊는다**(실측 2026-08-01: Electron 부팅마다).
    // 다른 프레임워크에서는 조용해서 한쪽에서만 죽는다.
    if (typeof opts.url === "string") el.setAttribute("src", opts.url);
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
    (await onReady<(u: string) => void>(label, "loadURL"))(url);
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
    // 크기는 건드리지 않는다 — 숨김이 상자를 지우면 복원이 "누가 bounds 를 다시 불러 주는가"에
    // 달리고, 그 우연이 백지 탭으로 나타난다.
    if (el) applyParked(el, visible);
  },
  async history(label, delta) {
    if (delta < 0) (await onReady<() => void>(label, "goBack"))();
    else if (delta > 0) (await onReady<() => void>(label, "goForward"))();
  },
  async stop(label) {
    (await onReady<() => void>(label, "stop"))();
  },
  async zoom(label, factor) {
    // 태그는 배율이 아니라 레벨을 받는다(level = log1.2(factor)) — 번역은 여기서 한다.
    (await onReady<(l: number) => void>(label, "setZoomLevel"))(
      Math.log(factor) / Math.log(1.2),
    );
    return factor;
  },
  async devtools(label) {
    (await onReady<() => void>(label, "openDevTools"))();
    return true;
  },
  async evalJs(label, js) {
    const run = await onReady<(s: string) => Promise<unknown>>(label, "executeJavaScript");
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
    // **한 번이 아니다.** 주입된 스크립트는 그 문서와 함께 산다 — 페이지가 이동하면 함께
    // 사라진다. 한 번만 넣으면 첫 문서에서만 살아 있고 그 뒤로는 조용히 없다. 계약이 "매
    // 내비게이션 재주입"이라고 적어 두었는데(app.webview.injectScript) 이 자리는 안 지켰다.
    //
    // 태그는 이동마다 `dom-ready` 를 다시 낸다. 그 사건마다 다시 넣는다.
    const el = find(label, document);
    if (!el) throw new Error(`콘텐츠 뷰가 없습니다: ${label}`);
    const run = () => {
      const fn = (el as unknown as { executeJavaScript?: (s: string) => Promise<unknown> })
        .executeJavaScript;
      // 안 붙은 태그에 제어면을 부르면 Uncaught 다 — 있을 때만 부른다.
      if (typeof fn === "function") void fn.call(el, code);
    };
    // 첫 문서는 이미 서 있을 수 있다(사건이 지나간 뒤에 구독하면 못 듣는다).
    void ready(el).then(run);
    el.addEventListener("dom-ready", run);
    // 해지가 **진짜여야** 한다. `() => {}` 를 돌려주면 부르는 쪽은 껐다고 믿고, 다음 문서에서
    // 또 도는 스크립트를 본다.
    return () => el.removeEventListener("dom-ready", run);
  },
  async sendInput(label, x, y) {
    // **태그는 전달하지 않는다**(계측 2026-08-02: 게스트에 arm 한 리스너가 아무것도 못 받았다).
    // 게스트의 webContents 에 직접 보내야 하고, 그 핸들은 프레임워크만 쥔다. 태그가 아는 것은
    // 자기 손잡이(id)뿐이라 그것을 넘긴다.
    const getId = await onReady<() => number>(label, "getWebContentsId");
    await invoke("webview_send_input", { id: getId(), x: Math.round(x), y: Math.round(y) });
  },
  async openWindow(url) {
    // 새 창은 프레임워크의 것이다 — DOM 이 만들 수 있는 것이 아니다.
    await invoke("window_create", { url });
  },
};
