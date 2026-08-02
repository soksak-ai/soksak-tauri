// 콘텐츠 뷰 사건 다리 — <webview> 태그가 내는 것을 앱이 아는 이름으로 바꿔 뿌린다.
//
// 앱은 `browser-<event>` 를 label 로 걸러 구독한다(src/plugins/deps.ts). Tauri 는 webview.rs 가
// 그것을 emit 하지만, 콘텐츠가 DOM 안에 사는 프레임워크에서는 그 사건이 이미 이 렌더러에 있다 —
// 프로세스 밖으로 보냈다가 되받을 이유가 없다. emitLocal 이 그 자리다.
//
// **이름과 필드는 원본 그대로다.** 구독자는 어디서 왔는지 모르고, 다르면 같은 코드가
// 프레임워크마다 다른 것을 본다.
//
// 원본은 Rust 다: `webview.rs` 의 페이로드가 `#[serde(rename_all = "camelCase")]` 라 실제로
// 나가는 이름은 `canBack`·`canForward` 다. 소비자도 그것을 읽는다(발행된 browser-native·
// browser-chromium 이 `p.canBack` 을 본다). 이 자리는 한때 스네이크를 실었고 주석과 검사가
// 그 틀린 기준을 지키고 있었다 — 그 사이 이 프레임워크가 낸 사건은 아무도 못 읽었고, 증상은
// 오류가 아니라 **항상 비활성인 뒤로가기 버튼**이었다(실측 2026-08-01).
import { emitLocal } from "../framework";

/** 사건 이름 — 정본은 `crates/soksak-spec-content-view/src/lib.rs` 다(webview-event-scan 게이트가
 *  두 값을 대조한다). TS 는 Rust 상수를 못 읽으므로 사본이고, 갈리면 이 프레임워크가 낸 사건은
 *  아무에게도 안 닿는다. */
/**
 * 콘텐츠 뷰 사건의 와이어 이름 — 정본은 `crates/soksak-spec-content-view/src/lib.rs` 다.
 *
 * 이름에 `browser` 가 없다. 코어가 소유한 실체는 콘텐츠 뷰이고 "브라우저"는 플러그인의
 * 낱말이다(C1). 플러그인은 짧은 키로 구독하므로(`app.webview.on(label, "nav", …)`) 이 표는
 * 플러그인에 노출되지 않는다 — 조립하지 말고 **여기서 골라라**.
 */
export const CONTENT_VIEW_EVENT = {
  nav: "content-view-navigated",
  title: "content-view-title",
  loading: "content-view-loading",
  status: "content-view-status",
  openExternal: "content-view-open-external",
  /** 사용자가 이 뷰를 눌렀다 — 칸 결합이 따라가야 할 유일한 사실(spec-content-view ACTIVATED). */
  activated: "content-view-activated",
  /** 프레임워크가 손잡이로 알린 창-열기 요청 — 이음매가 라벨로 바꿔 `openExternal` 로 다시
   *  뿌린다. 이름을 가르는 이유는 spec-content-view OPEN_EXTERNAL_RAW 머리말에 있다. */
  openExternalRaw: "content-view-open-external:raw",
} as const;

/**
 * 태그가 내는 사건의 필드 — **이벤트 객체 위에 바로 붙는다.**
 *
 * CustomEvent 의 detail 이 아니다. detail 로 읽으면 값이 늘 undefined 라 아무 사건도 안 나가고,
 * 그 침묵은 오류가 아니라 "주소창이 about:blank 에 멈춘다"로 나타난다(실측 2026-07-28:
 * 페이지는 렌더됐는데 URL 바가 안 따라왔다).
 */
function field<T>(e: Event, key: string): T | undefined {
  return (e as unknown as Record<string, T>)[key];
}

/** 태그가 내는 사건 → 앱이 아는 사건. 원본은 frameworks/tauri/src/webview.rs 다. */
type Tag = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
};

/**
 * 항행 — 주소와 **문서가 바뀌었는지**를 함께 싣는다.
 *
 * `inPage` 가 없으면 소비자는 새 문서와 같은 문서 안 이동을 구분할 수 없고, "이전 제목이 남지
 * 않게 주소로 되돌린다" 같은 규칙이 모든 항행에서 돈다. 같은 문서를 다시 항행할 때 엔진은
 * 제목을 다시 안 내므로 진짜 제목이 주소로 덮인다(실측 2026-08-02: 탭 이름이 "Google" 이
 * 아니라 `www.google.com` 으로 굳었다 — 사건은 다 도착했고 뒤에 온 nav 셋이 매번 덮었다).
 */
function nav(label: string, inPage: boolean) {
  return (e: Event) => {
    const url = field<string>(e, "url");
    if (typeof url === "string") emitLocal(CONTENT_VIEW_EVENT.nav, { label, url, inPage });
  };
}

/**
 * 태그에게 물어본다 — **못 물으면 그 사실이 답이다.**
 *
 * `canGoBack`/`canGoForward` 는 내부에서 게스트 id 를 잡는다(`getWebContentsId`). 그래서
 * `dom-ready` 전에 오는 적재 사건에서 부르면 던지고, 그 예외는 사건 핸들러 안이라 **Uncaught**
 * 로 새어 부팅 경로를 끊는다(실측 2026-08-01 스택: canGoBack → getWebContentsId).
 *
 * 아직 못 여는 것은 사실이다: 준비 전에는 히스토리가 없으므로 `false` 가 맞다. 조용히 넘기지
 * 않고 그 값을 그대로 싣는다 — 준비 뒤의 사건이 곧바로 참값을 실어 온다.
 */
function ask(el: Tag, name: "canGoBack" | "canGoForward"): boolean {
  // 태그에 묶어 부른다 — 함수만 떼면 `this` 가 없어 그 자체로 던진다.
  try {
    return el[name]?.() ?? false;
  } catch {
    return false;
  }
}

function loading(el: Tag, label: string, on: boolean) {
  return () => {
    emitLocal(CONTENT_VIEW_EVENT.loading, {
      label,
      loading: on,
      // 뒤·앞 가능 여부는 적재 순간의 사실이다 — 원본이 그 셋을 함께 싣는다.
      canBack: ask(el, "canGoBack"),
      canForward: ask(el, "canGoForward"),
    });
  };
}

/**
 * 한 콘텐츠 뷰의 사건을 잇는다. 반환 = 해지.
 *
 * 해지가 없으면 뷰를 닫아도 구독이 남아 죽은 label 로 뿌린다 — 구독자는 그 label 을 아직
 * 살아 있는 것으로 읽는다.
 */
export function bridgeContentViewEvents(el: Tag, label: string): () => void {
  const wired: [string, EventListener][] = [
    ["did-navigate", nav(label, false)],
    ["did-navigate-in-page", nav(label, true)],
    [
      "page-title-updated",
      (e) => {
        const title = field<string>(e, "title");
        if (typeof title === "string") emitLocal(CONTENT_VIEW_EVENT.title, { label, title });
      },
    ],
    ["did-start-loading", loading(el, label, true)],
    ["did-stop-loading", loading(el, label, false)],
    [
      "update-target-url",
      (e) => {
        // 링크를 벗어나면 빈 문자열이다 — 그것도 사건이라 걸러내지 않는다(상태표시줄이 비어야 한다).
        const url = field<string>(e, "url");
        emitLocal(CONTENT_VIEW_EVENT.status, { label, url: typeof url === "string" ? url : "" });
      },
    ],
    // `new-window` 는 여기서 듣지 않는다. **이 엔진에서 그 사건은 사라졌다** — 계측
    // 2026-08-02: 새 탭 링크를 눌러도 0회(같은 태그의 `page-title-updated` 는 5회 났다).
    // 죽은 구독은 오류를 내지 않고 그냥 아무 일도 안 일으켜서, 새 탭/새 창 설정이 적용될
    // 통로가 없었다. 산 통로는 프레임워크의 창-열기 핸들러이고, 그쪽이 계약 이름으로 낸다.
  ];
  for (const [name, fn] of wired) el.addEventListener(name, fn);
  return () => {
    for (const [name, fn] of wired) el.removeEventListener(name, fn);
  };
}

/**
 * 프레임워크가 낸 원시 사건을 **계약 모양으로** 바꿔 뿌린다.
 *
 * 콘텐츠가 프로세스 밖에 있는 프레임워크는 자기 손잡이(webContents id)로 말할 수밖에 없다.
 * 그 손잡이는 알아낸 방법의 흔적이지 사실이 아니다 — 구독자가 그것을 읽으면 그 방법이 없는
 * 프레임워크에서 조용히 아무 일도 안 일어난다. 사실은 **어느 뷰인가**이고, 그 답은 라벨이다.
 *
 * 그래서 이음매에서 한 번 번역한다. 앱은 계약 모양 하나만 안다.
 */
export function activatedLabelOf(id: unknown, doc: Document = document): string | null {
  if (typeof id !== "number") return null;
  for (const el of doc.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>(
    "[data-content-view]",
  )) {
    try {
      if (el.getWebContentsId?.() === id) return el.getAttribute("data-content-view");
    } catch {
      // 아직 안 붙은 태그는 묻는 즉시 던진다 — 못 찾은 것과 같다.
    }
  }
  return null;
}

/**
 * 프레임워크가 낸 원시 사건을 **계약 모양으로** 다시 뿌린다 — 창마다 한 번 건다.
 *
 * 콘텐츠가 다른 프로세스인 프레임워크는 자기 손잡이(webContents id)로 말할 수밖에 없다. 그
 * 손잡이는 알아낸 방법의 흔적이지 사실이 아니다. 사실은 **어느 뷰인가**이고 답은 라벨이다.
 * 소비자가 손잡이를 읽으면 그 방법이 없는 프레임워크에서 조용히 아무 일도 안 일어난다.
 *
 * 반환은 해지다. 못 찾은 손잡이는 **버린다** — 아직 안 붙었거나 이미 죽은 뷰이고, 빈 라벨로
 * 뿌리면 아무 뷰도 아닌 사건이 소비자에게 간다.
 */
export function relayFrameworkContentViewEvents(
  listen: (name: string, cb: (p: Record<string, unknown>) => void) => () => void,
): () => void {
  const off = listen(CONTENT_VIEW_EVENT.openExternalRaw, (p) => {
    const label = activatedLabelOf(p.id);
    const url = typeof p.url === "string" ? p.url : "";
    if (label && url) emitLocal(CONTENT_VIEW_EVENT.openExternal, { label, url });
  });
  return off;
}
