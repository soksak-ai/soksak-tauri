// Electron 콘텐츠 뷰 구현 — 콘텐츠가 **문서 안**에 산다.
//
// `<webview>` 는 HTMLElement 다. 그러므로 이 프레임워크에는 갚을 빚이 없다: 자리의 자식으로
// 두면 자리가 움직일 때 함께 움직이고, 가리는 일은 평범한 쌓임으로 끝나며, 그 위의 마우스는
// 이 문서에 온다. 홀도 스탠드인도 클립도 z 조작도 여기서는 **쓰지 않는다** — 그 장치는 콘텐츠가
// 문서 밖인 프레임워크가 자기 사정을 갚는 물건이고(tauri.fix), 여기서 돌면 멀쩡한 판을 비운다.
//
// 프로세스는 갈리므로 크래시 격리는 그대로이고, 제어면(loadURL·goBack·setZoomLevel·
// executeJavaScript·openDevTools…)도 태그가 그대로 준다.
//
// 요소는 label 로 찾는다 — 그것이 다른 구현에서 창을 찾는 키와 같은 키다. 두 구현이 같은
// 이름 공간을 쓰지 않으면 호출자가 어느 쪽인지 알게 된다.
import { moduleState } from "../../lib/moduleState";
import {
  CONTENT_VIEW_BODY,
  contentViewSlotVisible,
  findContentViewSlot,
  type ContentViewHost,
} from "../../lib/contentViews";
import {
  clearCompositionParticipant,
  compositionOwnerViewId,
  contentCompositionTopologyPath,
  contentViewNodePath,
  declareCompositionParticipant,
  setCompositionParticipantVisible,
} from "../../lib/compositionParticipants";
import { currentWindowLabel } from "../../lib/webviewLabels";
import { bridgeContentViewEvents } from "../../lib/contentViewEvents";
import { forgetContentViewSurface, noteContentViewSurface } from "./presentationLedger";
import { invoke } from "../index";

/** label → 사건 해지. 뷰를 닫을 때 함께 끊는다 — 안 끊으면 죽은 label 로 뿌린다. */
// 갈아끼우기 경계 밖 — 이 표가 새것이 되면 채운 쪽은 이미 채웠다고 알아 다시 채우지 않는다.
const bridges = moduleState("framework/electron.fix#bridges", () => new Map<string, () => void>());

/**
 * 이 구현의 숨김 — **평범한 `visibility` 다.**
 *
 * 문서 밖에 사는 표면은 별도 합성 레이어라 `visibility:hidden` 으로 빠지지 않는다. 그래서
 * 그쪽의 보정은 Tauri 어댑터가 소유한다. 문서 안 게스트에는 그 사정이 없다 —
 * 실측 2026-08-03(scripts/electron/guest-under-effects.test.mjs): `visibility:hidden` 하나로
 * 게스트가 사라졌다(중앙 픽셀 234 → 0).
 *
 * `display:none` 은 쓰지 않는다. 상자를 레이아웃에서 빼면 되살릴 때 게스트가 0×0 뷰포트로
 * 붙어 URL 은 맞는데 화면만 백지가 되고, 크기가 돌아오는 것이 "누가 bounds 를 다시 불러
 * 주는가"라는 우연에 달린다(실측 2026-07-30).
 */
function setShown(el: HTMLElement, shown: boolean): void {
  el.style.visibility = shown ? "visible" : "hidden";
}

/**
 * 자리 안에 채운다 — **좌표를 쓰지 않는다.**
 *
 * 콘텐츠가 문서 밖인 프레임워크는 표면을 좌표로 민다. 그 모델을 문서 안에서 흉내내면 자리와
 * 표면이 서로 다른 두 기준이 되고, 하나는 반드시 늦는다 — 슬롯은 새 자리에 가 있는데 표면은
 * 아직 옛 자리인 프레임이 생긴다(빈 판·경계의 잔상). 자식으로 두면 그 갈림 자체가 없다.
 *
 * 자리가 좌표계를 안 가지면 `inset:0` 이 엉뚱한 조상에 걸린다 — 그 어긋남은 오류가 아니라
 * "브라우저가 이상한 데 있다"로 나타난다. 그래서 채우는 쪽이 좌표계를 보장한다.
 */
function placeIn(slot: HTMLElement, el: HTMLElement): void {
  if (slot.ownerDocument.defaultView?.getComputedStyle(slot).position === "static") {
    slot.style.position = "relative";
  }
  el.style.cssText = "position:absolute;inset:0";
  slot.appendChild(el);
}

/**
 * 이 프레임워크가 합성에 내놓는 참가자는 **둘**이다: 선언된 자리와 그 안에 사는 태그.
 *
 * 콘텐츠가 문서 밖인 프레임워크는 자리를 네이티브 홀로 투영하고 그 대역을 참가자로 세운다.
 * 여기서는 그럴 것이 없다 — 태그가 자리의 자식이라 자리가 곧 그 표면의 상자다. 그 차이를
 * 지우려고 없는 층을 흉내내면 멀쩡한 판에 한 겹이 더 생긴다.
 *
 * 뷰는 **공개 앵커에서 읽는다.** label 문법에서 뽑으면 그 문법이 바뀌는 날 조용히 남의 뷰를
 * 가리키고, 그 오답은 오류가 아니라 "합성이 안 맞는다"로 나타난다. 앵커가 없으면 이 표면은
 * 소유 뷰를 모르는 것이고, 모르는 것을 지어내지 않는다.
 */
function declareComposition(slot: HTMLElement, el: HTMLElement, label: string): void {
  const viewId = compositionOwnerViewId(slot);
  if (!viewId) return;
  const topologyPath = contentCompositionTopologyPath(currentWindowLabel(), viewId, label);
  const visible = contentViewVisible(slot, el);
  declareCompositionParticipant(slot, { kind: "slot", viewId, topologyPath, visible });
  declareCompositionParticipant(el, { kind: "renderer", viewId, topologyPath, visible });
  el.dataset.node = contentViewNodePath(label);
}

/** 지금 실제로 합성에 참여하는가 — 자리의 합성 가시성과 이 표면 자신의 숨김을 함께 읽는다. */
function contentViewVisible(slot: HTMLElement, el: HTMLElement): boolean {
  return el.style.visibility !== "hidden" && contentViewSlotVisible(slot);
}

// 셀렉터로 찾지 않는다 — label 은 임의 문자열이라 이스케이프가 필요하고, 그 이스케이프는
// 환경마다 있고 없다(jsdom 에는 CSS.escape 가 없다). 속성 비교는 어디서나 같은 답이다.
function find(label: string, doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>("[data-content-view]")) {
    if (el.getAttribute("data-content-view") === label) return el;
  }
  return null;
}

/**
 * 이 태그가 제어면을 받을 준비가 됐다는 약속. **만들 때 건다.**
 *
 * `dom-ready` 는 한 번만 난다 — 나중에 구독하면 영영 못 받는다. 그래서 태그를 만드는 자리에서
 * 곧바로 걸어 둔다: 준비가 먼저 나도 그 사실이 약속에 남는다.
 *
 * 제어면은 준비된 뒤에만 부를 수 있고, 태그 구현이 그 규칙을 예외로 강제한다("DOM 에 붙고
 * dom-ready 가 난 뒤에야 부를 수 있다"). 부르는 쪽마다 타이밍을 맞추면 한 곳만 어긋나도
 * **Uncaught 로 부팅이 끊긴다** — 실측 2026-08-01: 부팅마다 그 예외가 났고 다른 프레임워크에서는
 * 조용해 한쪽에서만 죽었다. 그래서 규칙을 **이 문 하나**에 둔다.
 */
const READY = moduleState(
  "framework/electron.fix#ready",
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
    // 선언된 자리가 있으면 그 안에 산다. 없으면 **자리가 없는 뷰**다 — 화면에 놓이지 않고
    // 자기 상자만 들고 산다(오프스크린 추출처럼 보일 일이 없는 뷰). 그 둘은 다른 것이고,
    // 자리 있는 뷰를 자리 없는 뷰처럼 다루면 좌표가 두 기준이 된다.
    const slot = findContentViewSlot(label, doc);
    if (slot) placeIn(slot, el);
    else {
      el.style.cssText = "position:absolute";
      doc.body.appendChild(el);
    }
    // 공개 슬롯이 있으면 그 DOM 합성 가시성을 그대로 따른다. 좌표나 이전 프레임 상태로
    // 추측하지 않는다. 자리 없는 오프스크린 뷰는 보일 이유가 없으므로 숨긴다.
    setShown(el, slot ? contentViewSlotVisible(slot) : false);
    // 자리에 놓인 표면만 합성 참가자다 — 화면에 놓이지 않은 뷰를 참가자로 세면 판정은
    // 아무 데도 없는 상자를 자리와 대조한다.
    if (slot) declareComposition(slot, el, label);
    // **주소는 붙인 뒤에 준다.** 안 붙은 태그에 `src` 를 주면 태그 구현이 내부적으로 적재를
    // 시작하다 "DOM 에 붙고 dom-ready 가 난 뒤에야 부를 수 있다"로 던진다 — 그 예외는
    // **Uncaught 라 부팅 경로를 거기서 끊는다**(실측 2026-08-01: 부팅마다).
    if (typeof opts.url === "string") el.setAttribute("src", opts.url);
    // 사건을 앱이 아는 이름으로 잇는다. 이것이 없으면 app.webview.on(label, "nav") 구독자가
    // 영영 안 불리고, 그 침묵은 오류로 보이지 않는다.
    bridges.set(label, bridgeContentViewEvents(el, label));
    // 표시 원장이 읽을 실체 사실(세대·그렸는가)도 **여기서** 건다 — `dom-ready` 는 한 번만
    // 나므로 나중에 구독하면 멀쩡히 그려진 표면이 "안 그렸다"로 기록된다.
    noteContentViewSurface(label, el);
  },
  async close(label) {
    bridges.get(label)?.();
    bridges.delete(label);
    forgetContentViewSurface(label);
    const el = find(label, document);
    // 자리는 플러그인의 것이고 표면보다 오래 산다 — 선언을 안 걷으면 원장은 닫힌 뷰의
    // 자리를 살아 있는 참가자로 세고 없는 표면을 기다린다.
    const slot = el?.closest<HTMLElement>(`[${CONTENT_VIEW_BODY}]`);
    if (slot) clearCompositionParticipant(slot);
    el?.remove();
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
  /**
   * 자리 있는 뷰에게 이것은 **명령이 아니라 대조**다.
   *
   * 표면은 이미 자기 자리를 채우고 있다 — 좌표를 다시 쓰면 자리와 표면이 두 기준이 되고,
   * 하나는 반드시 늦는다. 그래서 여기서는 쓰지 않고 **맞는지 답한다.** 어긋나면 `false` 다:
   * `true` 를 돌려주면 부른 쪽은 옮겼다고 믿은 채 화면만 다르다(조용한 성공).
   *
   * 자리가 없는 뷰에게는 요청이 유일한 기하다 — 그 상자를 그대로 쓴다.
   */
  async bounds(label, x, y, w, h) {
    const el = find(label, document);
    if (!el) return false;
    const slot = el.closest(`[${CONTENT_VIEW_BODY}]`);
    if (!slot) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      return true;
    }
    const r = slot.getBoundingClientRect();
    // 1px 은 서브픽셀 반올림의 폭이다 — 그보다 크게 벌어지면 자리와 요청이 다른 것을 가리킨다.
    return (
      Math.abs(r.x - x) <= 1 &&
      Math.abs(r.y - y) <= 1 &&
      Math.abs(r.width - w) <= 1 &&
      Math.abs(r.height - h) <= 1
    );
  },
  async visible(label, visible) {
    const el = find(label, document);
    // 상자는 건드리지 않는다 — 숨김이 상자를 지우면 복원이 "누가 bounds 를 다시 불러 주는가"에
    // 달리고, 그 우연이 백지 탭으로 나타난다.
    if (!el) return;
    setShown(el, visible);
    // 선언은 요청이 아니라 결과를 싣는다 — 자리가 이미 접혀 있으면 보이라는 요청 하나로
    // 참가자가 보인다고 말하게 되고, 그 거짓 참이 합성 판정을 공짜로 통과시킨다.
    const slot = el.closest<HTMLElement>(`[${CONTENT_VIEW_BODY}]`);
    if (slot) {
      const shown = contentViewVisible(slot, el);
      setCompositionParticipantVisible(slot, shown);
      setCompositionParticipantVisible(el, shown);
    }
  },
  // Electron 표면은 슬롯의 DOM 자식이므로 DOM 커밋이 곧 표시 경계다.
  async presentationSettled(_labels) {},
  async chromePresentationSettled() {},
  async history(label, delta) {
    if (delta < 0) (await onReady<() => void>(label, "goBack"))();
    else if (delta > 0) (await onReady<() => void>(label, "goForward"))();
  },
  async stop(label) {
    (await onReady<() => void>(label, "stop"))();
  },
  // 태그가 이미 두 갈래를 준다 — 캐시를 버리는 쪽은 이름이 다르다.
  async reload(label, ignoreCache) {
    const method = ignoreCache ? "reloadIgnoringCache" : "reload";
    (await onReady<() => void>(label, method))();
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
    // `js` 는 **비동기 함수 본문**이다 — 계약의 정본은 callAsyncJavaScript(body) 이고, 부르는
    // 쪽은 그렇게 쓴다("return document.title"). 태그의 executeJavaScript 는 그것을
    // **스크립트**로 평가하므로 최상위 return 이 문법 오류다. 감싸지 않으면 게스트 스크립트가
    // 전부 "Script failed to execute" 로 죽고, 그 한 줄이 브라우저 자동화 전체를 막는다
    // (실측 2026-07-28: dom.text·eval 이 1+1 조차 실패했다).
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
  async sendInput(label, { x, y, kind, button, clickCount }) {
    // **태그는 전달하지 않는다**(계측 2026-08-02: 게스트에 arm 한 리스너가 아무것도 못 받았다).
    // 게스트의 webContents 에 직접 보내야 하고, 그 핸들은 프레임워크만 쥔다. 태그가 아는 것은
    // 자기 손잡이(id)뿐이라 그것을 넘긴다.
    const getId = await onReady<() => number>(label, "getWebContentsId");
    await invoke("webview_send_input", {
      id: getId(), x: Math.round(x), y: Math.round(y), kind, button, clickCount,
    });
  },
  async markText(label, text) {
    // 이쪽은 게스트에 조합을 직접 세운다 — 태그에는 그 자리가 없고, 그 핸들은 프레임워크만 쥔다.
    const getId = await onReady<() => number>(label, "getWebContentsId");
    await invoke("webview_mark_text", { id: getId(), text });
  },
  async inputState(label, at) {
    // 이쪽 표면은 문서 안의 태그다 — 배달을 가르는 사실도 문서의 사실이다: 그 자리가 지금
    // 문서에 있고 얼마만큼 보이는가. 게스트 자신의 상태는 그 프로세스만 안다.
    const el = find(label, document);
    if (el === null) return { attached: false, why: `그 표면이 이 문서에 없습니다: ${label}` };
    const rect = el.getBoundingClientRect();
    const getId = await onReady<() => number>(label, "getWebContentsId");
    const guest = await invoke<Record<string, unknown>>("webview_input_state", { id: getId() });
    // 이쪽 표면은 문서 안에 살아서 그 자리를 가리는 것도 문서가 안다 — 같은 질문에 같은
    // 이름으로 답한다(가려짐이 프레임워크마다 다른 이름이면 부른 쪽이 두 벌을 알아야 한다).
    const point = at === undefined
      ? {}
      : (() => {
          const top = el.ownerDocument.elementFromPoint(rect.left + at.x, rect.top + at.y);
          return {
            askedPoint: { x: at.x, y: at.y },
            windowTopmostAtPoint: top === el || el.contains(top),
          };
        })();
    return {
      attached: true,
      visibleRect: { x: 0, y: 0, w: Math.round(rect.width), h: Math.round(rect.height) },
      ...point,
      ...guest,
    };
  },
  async wheel(label, x, y, dx, dy) {
    const getId = await onReady<() => number>(label, "getWebContentsId");
    await invoke("webview_send_wheel", {
      id: getId(),
      x: Math.round(x),
      y: Math.round(y),
      dx: Math.round(dx),
      dy: Math.round(dy),
    });
  },
  async captureFull(label, path, width, height) {
    const getId = await onReady<() => number>(label, "getWebContentsId");
    return invoke("webview_capture_full", { id: getId(), path, width, height });
  },
  async typeText(label, text) {
    const getId = await onReady<() => number>(label, "getWebContentsId");
    await invoke("webview_type_text", { id: getId(), text });
  },
  async openWindow(url) {
    // 새 창은 프레임워크의 것이다 — DOM 이 만들 수 있는 것이 아니다.
    await invoke("window_create", { url });
  },
};
