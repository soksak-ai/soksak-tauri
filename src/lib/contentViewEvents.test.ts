// 콘텐츠 뷰가 사건을 뿌린다 — 안 뿌리면 구독자가 **조용히** 굶는다.
//
// 앱은 `browser-<event>` 전역 사건을 label 로 걸러 구독한다(src/plugins/deps.ts:60).
// Tauri 는 webview.rs 가 그것을 emit 한다. 콘텐츠가 DOM 안에 사는 프레임워크에서는 아무도
// 안 뿌렸다 — app.webview.on(label, "nav") 이 영영 안 불린다. 오류는 어디에도 안 남는다.
//
// 다섯과 그 페이로드는 원본 그대로다(frameworks/tauri/src/webview.rs):
//   browser-nav            { label, url }
//   browser-title          { label, title }
//   browser-loading        { label, loading, can_back, can_forward }
//   browser-status         { label, url }
//   browser-open-external  { label, url }
// 이름이나 필드를 바꾸면 같은 구독 코드가 프레임워크마다 다른 것을 본다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
vi.mock("../framework", () => ({
  invoke: vi.fn(async () => undefined),
  engineProvision: { chromium: true, nativeChildWebview: false },
  emitLocal: (name: string, payload: unknown) => emit(name, payload),
}));

async function load() {
  vi.resetModules();
  return import("./contentViewEvents");
}

/**
 * `<webview>` 가 실제로 내는 사건 — **필드는 이벤트 객체 위에 바로 붙는다.**
 *
 * CustomEvent 의 detail 이 아니다. 흉내를 detail 로 내면 다리가 detail 을 읽어도 통과하고,
 * 그 통과는 살아있는 앱에서 "주소창이 about:blank 에 멈춘다"로 나타난다(실측 2026-07-28:
 * 페이지는 렌더됐는데 URL 바가 안 따라왔다). 흉내가 실물과 다르면 검증한 것은 내 해석뿐이다.
 */
function tagEvent(name: string, fields: Record<string, unknown>): Event {
  return Object.assign(new Event(name), fields);
}

/** <webview> 태그가 내는 사건을 흉내내는 요소 — jsdom 에는 그 요소가 없다. */
function fakeTag() {
  const el = document.createElement("div");
  el.setAttribute("data-content-view", "b-1");
  Object.assign(el, {
    canGoBack: () => true,
    canGoForward: () => false,
    getURL: () => "https://x/page",
  });
  document.body.appendChild(el);
  return el;
}

describe("콘텐츠 뷰 사건 다리", () => {
  beforeEach(() => {
    emit.mockClear();
    document.body.innerHTML = "";
  });

  it("항행은 browser-nav 로 나간다 — 이름·필드가 원본 그대로", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("did-navigate", { url: "https://x/page" }));
    expect(emit).toHaveBeenCalledWith("browser-nav", { label: "b-1", url: "https://x/page" });
  });

  it("제목은 browser-title 로 나간다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("page-title-updated", { title: "T" }));
    expect(emit).toHaveBeenCalledWith("browser-title", { label: "b-1", title: "T" });
  });

  // can_back·can_forward 는 스네이크다(원본 필드). 카멜로 바꾸면 소비자가 undefined 를 본다.
  it("적재 상태는 browser-loading 으로 나가고 뒤·앞 가능 여부를 싣는다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(new Event("did-start-loading"));
    expect(emit).toHaveBeenCalledWith("browser-loading", {
      label: "b-1", loading: true, can_back: true, can_forward: false,
    });
    el.dispatchEvent(new Event("did-stop-loading"));
    expect(emit).toHaveBeenCalledWith("browser-loading", {
      label: "b-1", loading: false, can_back: true, can_forward: false,
    });
  });

  it("링크 hover 는 browser-status, 벗어나면 빈 문자열", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("update-target-url", { url: "https://y" }));
    expect(emit).toHaveBeenCalledWith("browser-status", { label: "b-1", url: "https://y" });
    el.dispatchEvent(tagEvent("update-target-url", { url: "" }));
    expect(emit).toHaveBeenCalledWith("browser-status", { label: "b-1", url: "" });
  });

  it("새 창 요구는 browser-open-external 로 나간다 — 앱 안 새 탭으로 여는 신호다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("new-window", { url: "https://z" }));
    expect(emit).toHaveBeenCalledWith("browser-open-external", { label: "b-1", url: "https://z" });
  });

  it("해지하면 더 안 나간다 — 뷰를 닫아도 구독이 남으면 죽은 label 로 뿌린다", async () => {
    const m = await load();
    const el = fakeTag();
    const off = m.bridgeContentViewEvents(el, "b-1");
    off();
    el.dispatchEvent(tagEvent("did-navigate", { url: "https://x" }));
    expect(emit).not.toHaveBeenCalled();
  });
});
