// 콘텐츠 뷰가 사건을 뿌린다 — 안 뿌리면 구독자가 **조용히** 굶는다.
//
// 앱은 `browser-<event>` 전역 사건을 label 로 걸러 구독한다(src/plugins/deps.ts:60).
// Tauri 는 webview.rs 가 그것을 emit 한다. 콘텐츠가 DOM 안에 사는 프레임워크에서는 아무도
// 안 뿌렸다 — app.webview.on(label, "nav") 이 영영 안 불린다. 오류는 어디에도 안 남는다.
//
// 다섯과 그 페이로드는 원본 그대로다(frameworks/tauri/src/webview.rs):
//   content-view-navigated            { label, url, inPage }
//   content-view-title          { label, title }
//   content-view-loading        { label, loading, canBack, canForward }
//   content-view-status         { label, url }
//   content-view-open-external  { label, url }
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

  it("항행은 content-view-navigated 로 나간다 — 이름·필드가 원본 그대로", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("did-navigate", { url: "https://x/page" }));
    expect(emit).toHaveBeenCalledWith("content-view-navigated", {
      label: "b-1",
      url: "https://x/page",
      inPage: false,
    });
  });

  /** **같은 문서 안 이동인지가 사실이다.** 그 축이 없으면 소비자가 둘을 구분 못 해 "이전
   *  제목을 주소로 되돌린다" 같은 규칙이 모든 항행에서 돌고, 엔진이 제목을 다시 안 내므로
   *  진짜 제목이 주소로 덮인 채 굳는다(실측 2026-08-02: 탭이 "Google" 이 아니라
   *  www.google.com 이었다). */
  it("같은 문서 안 이동은 inPage 로 구분된다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("did-navigate-in-page", { url: "https://x/page#a" }));
    expect(emit).toHaveBeenCalledWith("content-view-navigated", {
      label: "b-1",
      url: "https://x/page#a",
      inPage: true,
    });
  });

  it("제목은 content-view-title 로 나간다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("page-title-updated", { title: "T" }));
    expect(emit).toHaveBeenCalledWith("content-view-title", { label: "b-1", title: "T" });
  });

  // canBack·canForward 는 카멜이다 — Rust 페이로드가 `rename_all = "camelCase"` 라 실제로
  // 나가는 이름이 그것이고, 발행된 플러그인도 `p.canBack` 을 읽는다. 이 검사는 한때 스네이크를
  // 고정하고 있었다: 기준이 틀리면 검사는 결함을 지킨다(실측 2026-08-01, 기준 정정).
  it("적재 상태는 content-view-loading 으로 나가고 뒤·앞 가능 여부를 싣는다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(new Event("did-start-loading"));
    expect(emit).toHaveBeenCalledWith("content-view-loading", {
      label: "b-1", loading: true, canBack: true, canForward: false,
    });
    el.dispatchEvent(new Event("did-stop-loading"));
    expect(emit).toHaveBeenCalledWith("content-view-loading", {
      label: "b-1", loading: false, canBack: true, canForward: false,
    });
  });

  it("링크 hover 는 content-view-status, 벗어나면 빈 문자열", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("update-target-url", { url: "https://y" }));
    expect(emit).toHaveBeenCalledWith("content-view-status", { label: "b-1", url: "https://y" });
    el.dispatchEvent(tagEvent("update-target-url", { url: "" }));
    expect(emit).toHaveBeenCalledWith("content-view-status", { label: "b-1", url: "" });
  });

  /** 창-열기 요구는 **태그가 알려주지 않는다.** 이 엔진에서 `new-window` 사건은 사라졌다
   *  (계측 2026-08-02: 새 탭 링크를 눌러도 0회, 같은 태그의 `page-title-updated` 는 5회).
   *  죽은 구독은 오류를 내지 않고 아무 일도 안 일으켜서, 새 탭/새 창 설정이 적용될 통로가
   *  없었다. 다시 걸면 이 검사가 잡는다. */
  it("태그의 new-window 는 듣지 않는다 — 이 엔진에 없는 사건이다", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "b-1");
    el.dispatchEvent(tagEvent("new-window", { url: "https://z" }));
    expect(emit).not.toHaveBeenCalledWith(
      "content-view-open-external",
      expect.objectContaining({ url: "https://z" }),
    );
  });

  /** 산 통로는 프레임워크다 — 손잡이(webContents id)로 알려 온다. 이음매가 라벨로 바꿔
   *  계약 모양으로 다시 뿌린다. 손잡이를 그대로 흘리면 그 방법이 없는 프레임워크에서
   *  소비자가 조용히 아무것도 못 받는다. */
  it("프레임워크가 손잡이로 알린 것을 라벨로 바꿔 계약 이름으로 뿌린다", async () => {
    const m = await load();
    const el = document.createElement("div");
    el.setAttribute("data-content-view", "b-9");
    Object.assign(el, { getWebContentsId: () => 42 });
    document.body.appendChild(el);
    let raw: ((p: Record<string, unknown>) => void) | null = null;
    const off = m.relayFrameworkContentViewEvents((name: string, cb: typeof raw) => {
      expect(name).toBe("content-view-open-external:raw");
      raw = cb;
      return () => {};
    });
    raw!({ id: 42, url: "https://z" });
    expect(emit).toHaveBeenCalledWith("content-view-open-external", {
      label: "b-9",
      url: "https://z",
    });
    off();
    document.body.innerHTML = "";
  });

  /** 못 찾은 손잡이는 버린다 — 빈 라벨로 뿌리면 아무 뷰도 아닌 사건이 소비자에게 간다. */
  it("모르는 손잡이는 뿌리지 않는다", async () => {
    const m = await load();
    let raw: ((p: Record<string, unknown>) => void) | null = null;
    m.relayFrameworkContentViewEvents((_n: string, cb: typeof raw) => {
      raw = cb;
      return () => {};
    });
    emit.mockClear();
    raw!({ id: 999, url: "https://z" });
    expect(emit).not.toHaveBeenCalled();
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
