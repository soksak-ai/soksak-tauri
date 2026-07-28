// 두 구현이 같은 계약을 만족한다 — 호출자는 어느 쪽인지 모른다.
//
// 이 검사가 없으면 한쪽에만 있는 동작이 생기고, 그 차이는 오류가 아니라 "이 프레임워크에서는
// 안 되는 기능"으로 나타난다. 그때 호출자가 프레임워크를 알아야 하고, 아는 순간 경계가 샌다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
/** emitLocal 이 실제로 불렸는지 — 다리가 걸렸는가의 유일한 관측면. */
const emitted: [string, unknown][] = [];
let provision = { chromium: false, nativeChildWebview: true };

vi.mock("../framework", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  get engineProvision() {
    return provision;
  },
  emitLocal: (event: string, payload: unknown) => emitted.push([event, payload]),
}));

async function load() {
  vi.resetModules();
  return import("./contentViews");
}

/** <webview> 태그가 붙이는 메서드를 흉내낸다 — jsdom 에는 그 요소가 없다. */
function stubTag(el: Element) {
  Object.assign(el, {
    loadURL: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    stop: vi.fn(),
    setZoomLevel: vi.fn(),
    openDevTools: vi.fn(),
    executeJavaScript: vi.fn(async () => "ok"),
  });
}

describe("콘텐츠 뷰 호스트", () => {
  beforeEach(() => {
    invoke.mockClear();
    emitted.length = 0;
    document.body.innerHTML = "";
  });

  it("능력이 구현을 고른다 — 프레임워크 이름은 쓰지 않는다", async () => {
    const m = await load();
    provision = { chromium: false, nativeChildWebview: true };
    expect(m.contentViewHost()).toBe(m.nativeHost);
    provision = { chromium: true, nativeChildWebview: false };
    expect(m.contentViewHost()).toBe(m.domHost);
  });

  it("두 구현의 표면이 정확히 같다", async () => {
    const m = await load();
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(m.domHost)).toEqual(keys(m.nativeHost));
    // 오라클 생존 — 표면이 비면 위 단언이 공짜로 통과한다.
    expect(keys(m.nativeHost).length).toBeGreaterThan(10);
  });

  it("네이티브 구현은 이름과 인자를 번역하지 않는다", async () => {
    const m = await load();
    await m.nativeHost.open("b-1", { url: "https://x" });
    expect(invoke).toHaveBeenCalledWith("webview_open", { label: "b-1", url: "https://x" });
    await m.nativeHost.bounds("b-1", 1, 2, 3, 4);
    expect(invoke).toHaveBeenCalledWith("webview_bounds", { label: "b-1", x: 1, y: 2, w: 3, h: 4 });
  });

  it("DOM 구현은 요소를 만들고 label 로 찾는다", async () => {
    const m = await load();
    await m.domHost.open("b-1", { url: "https://x" });
    expect(await m.domHost.list()).toEqual(["b-1"]);
    expect(await m.domHost.alive("b-1")).toBe(true);
    // 같은 label 을 두 번 열어도 하나다 — 중복은 배치가 갈리는 조용한 결함이 된다.
    await m.domHost.open("b-1", { url: "https://y" });
    expect(await m.domHost.list()).toEqual(["b-1"]);
    await m.domHost.close("b-1");
    expect(await m.domHost.alive("b-1")).toBe(false);
  });

  it("DOM 구현은 프로세스를 건너지 않는다", async () => {
    const m = await load();
    await m.domHost.open("b-1", { url: "https://x" });
    await m.domHost.bounds("b-1", 10, 20, 30, 40);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("DOM 구현이 배치를 실제로 반영한다", async () => {
    const m = await load();
    await m.domHost.open("b-1", {});
    expect(await m.domHost.bounds("b-1", 10, 20, 30, 40)).toBe(true);
    const el = document.querySelector<HTMLElement>('[data-content-view="b-1"]')!;
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual([
      "10px", "20px", "30px", "40px",
    ]);
    // 없는 뷰의 배치는 false 다 — true 를 돌려주면 호출자가 놓인 줄 안다.
    expect(await m.domHost.bounds("nope", 0, 0, 1, 1)).toBe(false);
  });

  it("태그 제어면으로 위임한다", async () => {
    const m = await load();
    await m.domHost.open("b-1", {});
    const el = document.querySelector('[data-content-view="b-1"]')!;
    stubTag(el);
    const tag = el as unknown as Record<string, ReturnType<typeof vi.fn>>;

    await m.domHost.navigate("b-1", "https://z");
    expect(tag.loadURL).toHaveBeenCalledWith("https://z");
    await m.domHost.history("b-1", -1);
    expect(tag.goBack).toHaveBeenCalled();
    await m.domHost.history("b-1", 1);
    expect(tag.goForward).toHaveBeenCalled();
    await m.domHost.stop("b-1");
    expect(tag.stop).toHaveBeenCalled();
    expect(await m.domHost.evalJs("b-1", "1")).toBe("ok");
    // 배율 → 레벨 번역(level = log1.2(factor)). 1.2 배는 정확히 한 단계다.
    await m.domHost.zoom("b-1", 1.2);
    expect(tag.setZoomLevel.mock.calls[0][0]).toBeCloseTo(1, 6);
  });

  it("없는 뷰·없는 메서드는 이름을 달고 실패한다 — 조용히 성공하지 않는다", async () => {
    const m = await load();
    await expect(m.domHost.navigate("nope", "u")).rejects.toThrow("콘텐츠 뷰가 없습니다");
    await m.domHost.open("b-2", {});
    // 태그 메서드가 아직 안 붙은 요소(jsdom 의 기본 상태)
    await expect(m.domHost.navigate("b-2", "u")).rejects.toThrow("loadURL");
  });

  it("새 창은 프레임워크의 것이다 — DOM 구현도 그것만은 건넌다", async () => {
    const m = await load();
    await m.domHost.openWindow("https://x");
    expect(invoke).toHaveBeenCalledWith("window_create", { url: "https://x" });
  });

  it("지킬 수 없는 주입 시점은 이름을 달고 실패한다", async () => {
    const m = await load();
    await m.domHost.open("b-1", {});
    const el = document.querySelector('[data-content-view="b-1"]')!;
    stubTag(el);
    // document-start 는 preload 로만 보장된다. 조용히 document-end 로 낮추면 주입이 늦어
    // 실패하는 자리가 오류 없이 생긴다 — 그것이 이 검사가 막는 것이다.
    expect(() => m.domHost.injectScript("b-1", "1", "document-start")).toThrow("document-start");
    expect(typeof m.domHost.injectScript("b-1", "1", "document-end")).toBe("function");
    expect((el as unknown as Record<string, ReturnType<typeof vi.fn>>).executeJavaScript)
      .toHaveBeenCalledWith("1");
  });

  it("네이티브 주입은 해지가 no-op 임을 스스로 밝힌다", async () => {
    const m = await load();
    const off = m.nativeHost.injectScript("b-1", "1", "document-start");
    expect(invoke).toHaveBeenCalledWith("webview_inject_script", {
      label: "b-1", code: "1", phase: "document-start",
    });
    expect(() => off()).not.toThrow();
  });

  // open 이 사건 다리를 걸지 않으면 app.webview.on 구독자가 영영 안 불린다. 다리 자체가
  // 검사돼 있어도 **거는 자리**가 빠지면 그 침묵은 어디에도 안 남는다(실측: 배선을 지웠는데
  // 아무 검사도 실패하지 않았다).
  it("open 이 사건 다리를 걸고 close 가 끊는다", async () => {
    const m = await load();
    await m.domHost.open("b-1", {});
    const el = document.querySelector('[data-content-view="b-1"]')!;

    const before = emitted.length;
    // `<webview>` 는 필드를 **이벤트 객체 위에** 붙인다 — detail 로 흉내내면 다리가 detail 을
    // 읽어도 통과하고, 그 통과는 살아있는 앱에서 주소창이 안 따라오는 것으로 나타난다.
    el.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://x" }));
    expect(emitted.length, "다리가 안 걸렸다").toBeGreaterThan(before);
    expect(emitted[emitted.length - 1]).toEqual(["browser-nav", { label: "b-1", url: "https://x" }]);

    await m.domHost.close("b-1");
    // 닫힌 뒤에도 뿌리면 구독자가 그 label 을 살아 있는 것으로 읽는다.
    const after = emitted.length;
    el.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://y" }));
    expect(emitted.length, "닫은 뒤에도 뿌린다").toBe(after);
  });
});
