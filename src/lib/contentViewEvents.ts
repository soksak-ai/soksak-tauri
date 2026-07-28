// 콘텐츠 뷰 사건 다리 — <webview> 태그가 내는 것을 앱이 아는 이름으로 바꿔 뿌린다.
//
// 앱은 `browser-<event>` 를 label 로 걸러 구독한다(src/plugins/deps.ts). Tauri 는 webview.rs 가
// 그것을 emit 하지만, 콘텐츠가 DOM 안에 사는 프레임워크에서는 그 사건이 이미 이 렌더러에 있다 —
// 프로세스 밖으로 보냈다가 되받을 이유가 없다. emitLocal 이 그 자리다.
//
// **이름과 필드는 원본 그대로다.** 구독자는 어디서 왔는지 모르고, 다르면 같은 코드가
// 프레임워크마다 다른 것을 본다. 특히 can_back·can_forward 는 스네이크다(원본 필드) — 카멜로
// 바꾸면 소비자가 undefined 를 본다.
import { emitLocal } from "../framework";

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

/** 태그가 내는 사건 → 앱이 아는 사건. 원본은 src-tauri/src/webview.rs 다. */
type Tag = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
};

function nav(label: string) {
  return (e: Event) => {
    const url = field<string>(e, "url");
    if (typeof url === "string") emitLocal("browser-nav", { label, url });
  };
}

function loading(el: Tag, label: string, on: boolean) {
  return () =>
    emitLocal("browser-loading", {
      label,
      loading: on,
      // 뒤·앞 가능 여부는 적재 순간의 사실이다 — 원본이 그 셋을 함께 싣는다.
      can_back: el.canGoBack?.() ?? false,
      can_forward: el.canGoForward?.() ?? false,
    });
}

/**
 * 한 콘텐츠 뷰의 사건을 잇는다. 반환 = 해지.
 *
 * 해지가 없으면 뷰를 닫아도 구독이 남아 죽은 label 로 뿌린다 — 구독자는 그 label 을 아직
 * 살아 있는 것으로 읽는다.
 */
export function bridgeContentViewEvents(el: Tag, label: string): () => void {
  const wired: [string, EventListener][] = [
    ["did-navigate", nav(label)],
    ["did-navigate-in-page", nav(label)],
    [
      "page-title-updated",
      (e) => {
        const title = field<string>(e, "title");
        if (typeof title === "string") emitLocal("browser-title", { label, title });
      },
    ],
    ["did-start-loading", loading(el, label, true)],
    ["did-stop-loading", loading(el, label, false)],
    [
      "update-target-url",
      (e) => {
        // 링크를 벗어나면 빈 문자열이다 — 그것도 사건이라 걸러내지 않는다(상태표시줄이 비어야 한다).
        const url = field<string>(e, "url");
        emitLocal("browser-status", { label, url: typeof url === "string" ? url : "" });
      },
    ],
    [
      "new-window",
      (e) => {
        const url = field<string>(e, "url");
        if (typeof url === "string") emitLocal("browser-open-external", { label, url });
      },
    ],
  ];
  for (const [name, fn] of wired) el.addEventListener(name, fn);
  return () => {
    for (const [name, fn] of wired) el.removeEventListener(name, fn);
  };
}
