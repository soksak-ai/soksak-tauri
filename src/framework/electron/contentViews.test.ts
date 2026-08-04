// 이 프레임워크의 콘텐츠 뷰 구현 — 콘텐츠가 **문서 안**에 산다.
//
// 계약을 지키는지, 그리고 그 계약을 **이 프레임워크의 방식으로** 지키는지를 함께 본다:
// 표면은 자기 자리의 자식이고, 좌표를 다시 쓰지 않는다. 그 둘이 갈리면 자리와 표면이 두
// 기준이 되고 하나는 반드시 늦는다(빈 판·경계의 잔상).
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
/** emitLocal 이 실제로 불렸는지 — 다리가 걸렸는가의 유일한 관측면. */
const emitted: [string, unknown][] = [];

vi.mock("../index", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  emitLocal: (event: string, payload: unknown) => emitted.push([event, payload]),
}));
vi.mock("../../framework", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  emitLocal: (event: string, payload: unknown) => emitted.push([event, payload]),
}));

async function load() {
  vi.resetModules();
  return import("./contentViews");
}

/** <webview> 태그가 붙이는 메서드를 흉내낸다 — jsdom 에는 그 요소가 없다. */
/** 태그 대역 — 제어면과 함께 **준비 사건**도 낸다.
 *
 *  제어면은 `dom-ready` 뒤에만 부를 수 있다(태그 구현이 예외로 강제한다). 목이 그 사건을 안
 *  내면 이 검사는 실제와 다른 세계를 재고, 진짜 결함(안 붙은 태그에 제어면 호출)을 가린다 —
 *  실측 2026-08-01: Electron 부팅마다 그 예외가 Uncaught 로 났는데 검사는 전부 GREEN 이었다. */
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
  // 준비를 알린다 — 실제 태그가 붙고 나서 내는 그 사건이다.
  el.dispatchEvent(new Event("dom-ready"));
}

describe("DOM 콘텐츠 뷰 구현", () => {
  beforeEach(() => {
    invoke.mockClear();
    emitted.length = 0;
    document.body.innerHTML = "";
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

  // RED 근거(2026-08-03): DOM 구현이 **콘텐츠가 문서 밖인 프레임워크의 모델을 베끼고 있었다** —
  // 전역 층(`#content-view-host`)에 붙이고 좌표(left/top/width/height)로 밀었다. 그러면 자리와
  // 표면이 서로 다른 두 기준이 되고 하나는 반드시 늦는다: 슬롯은 새 자리에 가 있는데 표면은
  // 아직 옛 자리인 프레임이 생긴다(빈 판·경계의 잔상). 문서 안 콘텐츠는 자기 자리의 **자식**이면
  // 그 갈림 자체가 없다.
  it("선언된 자리의 자식이 된다 — 전역 층에 붙지 않는다", async () => {
    const m = await load();
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-1");
    document.body.appendChild(slot);

    await m.domHost.open("b-1", { url: "https://x" });
    const el = document.querySelector<HTMLElement>('[data-content-view="b-1"]')!;
    expect(el.parentElement).toBe(slot);
    // 좌표가 아니라 채움이다 — 좌표를 쓰는 순간 두 기준이 된다.
    expect(el.style.inset).toBe("0px");
    expect(el.style.left).toBe("");
    // 전역 층은 없다. 있으면 누군가 다시 거기에 붙인다.
    expect(document.getElementById("content-view-host")).toBeNull();
  });

  it("자리가 좌표계를 안 가지면 채우는 쪽이 보장한다", async () => {
    const m = await load();
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-2");
    document.body.appendChild(slot);
    await m.domHost.open("b-2", {});
    // static 이면 inset:0 이 엉뚱한 조상에 걸린다 — 그 어긋남은 오류가 아니라 "이상한 데 있다"다.
    expect(slot.style.position).toBe("relative");
  });

  // 자리를 선언하지 않은 뷰도 있다(오프스크린 추출 — 보일 일이 없는 뷰). 그것은 화면에 놓이는
  // 뷰와 **다른 것**이고, 자리 있는 뷰를 이렇게 다루면 좌표가 두 기준이 된다.
  it("자리 없는 뷰는 자기 상자를 들고 산다", async () => {
    const m = await load();
    await m.domHost.open("headless-1", { url: "https://x" });
    const el = document.querySelector<HTMLElement>('[data-content-view="headless-1"]')!;
    expect(el.parentElement).toBe(document.body);
    expect(await m.domHost.bounds("headless-1", -20000, -20000, 1280, 720)).toBe(true);
    expect([el.style.left, el.style.width]).toEqual(["-20000px", "1280px"]);
  });

  // 재입법(2026-08-03) — 옛 검사는 "bounds 가 left/top/width/height 를 쓴다"였다. 그것은
  // **콘텐츠가 문서 밖인 프레임워크의 모델**이다(좌표로 민다). DOM 구현의 콘텐츠는 문서 안에
  // 있고 자기 자리와 함께 움직인다 — 좌표를 다시 쓸 이유가 없고, 쓰면 자리와 표면이 갈린다.
  // 그러므로 이 자리에서 bounds 는 **명령이 아니라 대조**다.
  it("DOM 구현은 배치를 쓰지 않고 대조한다", async () => {
    const m = await load();
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-1");
    document.body.appendChild(slot);
    await m.domHost.open("b-1", {});
    const el = document.querySelector<HTMLElement>('[data-content-view="b-1"]')!;

    // 요청 좌표를 요소에 쓰지 않는다 — 자리가 좌표의 주인이다.
    slot.getBoundingClientRect = () => ({ x: 10, y: 20, width: 30, height: 40 }) as DOMRect;
    expect(await m.domHost.bounds("b-1", 10, 20, 30, 40)).toBe(true);
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(["", "", "", ""]);

    // 자리와 요청이 어긋나면 **false** 다. true 를 돌려주면 조용한 성공이 되고, 부른 쪽은
    // 옮겼다고 믿은 채 화면만 다르다.
    expect(await m.domHost.bounds("b-1", 999, 20, 30, 40)).toBe(false);
    // 없는 뷰의 배치도 false 다.
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

  it("확정 텍스트를 게스트 webContents 입력자로 보낸다", async () => {
    const m = await load();
    await m.domHost.open("b-1", {});
    const el = document.querySelector('[data-content-view="b-1"]')!;
    stubTag(el);
    Object.assign(el, { getWebContentsId: vi.fn(() => 17) });

    await (m.domHost as unknown as { typeText(label: string, text: string): Promise<void> })
      .typeText("b-1", "한글 입력");
    expect(invoke).toHaveBeenCalledWith("webview_type_text", {
      id: 17,
      text: "한글 입력",
    });
  });

  it("없는 뷰·없는 메서드는 이름을 달고 실패한다 — 조용히 성공하지 않는다", async () => {
    const m = await load();
    await expect(m.domHost.navigate("nope", "u")).rejects.toThrow("콘텐츠 뷰가 없습니다");
    await m.domHost.open("b-2", {});
    // 준비는 났는데 태그 메서드가 없는 요소(jsdom 의 기본 상태) — 준비를 안 내면 그 앞에서
    // 준비 상한에 걸려, 이 검사가 재려던 "없는 메서드"에 닿지 못한다.
    document
      .querySelector('[data-content-view="b-2"]')!
      .dispatchEvent(new Event("dom-ready"));
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
    // 주입은 **준비를 기다린 뒤** 실행된다 — 안 붙은 태그에 제어면을 부르면 Uncaught 다.
    // 그래서 해지 함수는 즉시 돌아오고 실행은 다음 틱이다.
    await new Promise((r) => setTimeout(r, 0));
    expect((el as unknown as Record<string, ReturnType<typeof vi.fn>>).executeJavaScript)
      .toHaveBeenCalledWith("1");
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
    expect(emitted[emitted.length - 1]).toEqual(["content-view-navigated", { label: "b-1", url: "https://x", inPage: false }]);

    await m.domHost.close("b-1");
    // 닫힌 뒤에도 뿌리면 구독자가 그 label 을 살아 있는 것으로 읽는다.
    const after = emitted.length;
    el.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://y" }));
    expect(emitted.length, "닫은 뒤에도 뿌린다").toBe(after);
  });
});

/**
 * `js` 는 **비동기 함수 본문**이다 — 계약의 정본은 WKWebView 의 callAsyncJavaScript(body) 이고,
 * 플러그인도 그렇게 부른다("return document.title").
 *
 * RED 근거(실측 2026-07-28): Electron 은 executeJavaScript 로 그것을 **스크립트**로 평가해
 * `return` 이 최상위에 오면 문법 오류다. 살아있는 앱에서 dom.text·eval 이 전부
 * "Script failed to execute" 로 죽었고, 그 사유는 브라우저 자동화 전체를 막았다.
 * 흉내로 문자열을 대조하지 않는다 — 만들어진 코드를 **실제로 평가**해 값을 본다.
 */
describe("게스트 스크립트 — js 는 함수 본문이다", () => {
  it("본문에 return 이 있어도 값이 나온다", async () => {
    const m = await load();
    await m.domHost.open("b-eval", {});
    const el = document.querySelector('[data-content-view="b-eval"]')! as unknown as Record<
      string,
      unknown
    >;
    el.executeJavaScript = async (code: string) => (0, eval)(code);
    // 제어면은 준비 뒤에만 부를 수 있다 — 실제 태그가 내는 그 사건을 여기서도 낸다.
    (el as unknown as EventTarget).dispatchEvent(new Event("dom-ready"));
    expect(await m.domHost.evalJs("b-eval", "return 1 + 1")).toBe("2");
  });

  it("await 을 쓰는 본문도 그대로 선다", async () => {
    const m = await load();
    await m.domHost.open("b-eval2", {});
    const el = document.querySelector('[data-content-view="b-eval2"]')! as unknown as Record<
      string,
      unknown
    >;
    el.executeJavaScript = async (code: string) => (0, eval)(code);
    // 제어면은 준비 뒤에만 부를 수 있다 — 실제 태그가 내는 그 사건을 여기서도 낸다.
    (el as unknown as EventTarget).dispatchEvent(new Event("dom-ready"));
    expect(await m.domHost.evalJs("b-eval2", "const v = await Promise.resolve(7); return v")).toBe(
      "7",
    );
  });
});

describe("DOM 콘텐츠 뷰의 숨김", () => {
  it("공개 슬롯에서 열리면 그 DOM 가시성을 초기값으로 사용한다", async () => {
    const { domHost } = await load();
    const project = document.createElement("div");
    project.dataset.projectPlane = "p1";
    project.dataset.projectActive = "1";
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-visible");
    project.appendChild(slot);
    document.body.appendChild(project);
    await domHost.open("b-visible", { url: "https://example.com" });
    expect(document.querySelector<HTMLElement>('[data-content-view="b-visible"]')?.style.visibility)
      .toBe("visible");
  });

  // `display:none` 은 상자를 레이아웃에서 빼고, 다시 켤 때 게스트가 0×0 뷰포트로 붙는다 —
  // URL 은 맞는데 화면만 백지다(실측 2026-07-30: 되돌아온 탭에서 innerWidth/innerHeight = 0,
  // 컨테이너는 586×428). 크기가 돌아오는 것은 **누군가 bounds 를 다시 불러 줄 때뿐**이라,
  // 복원이 우연에 달린다.
  //
  // 재입법 2026-08-03 — 옛 검사는 화면 밖으로 옮기는 파킹(translateX(-200vw))까지 요구했다.
  // 그것은 **문서 밖에 사는 표면의 사정**이다: 별도 합성 레이어라 `visibility:hidden` 으로
  // 안 빠진다(lib/layerPark 머리말). 문서 안 게스트에는 그 사정이 없고, 실측이 그렇게 답했다
  // (scripts/electron/guest-under-effects.test.mjs: visibility 만으로 중앙 픽셀 234 → 0).
  // 그럴 이유가 없는 자리에 남의 장치를 두면 그 자체가 다음 결함의 자리다.
  it("숨겨도 상자를 잃지 않는다 — display:none 도 오프스크린 파킹도 쓰지 않는다", async () => {
    const { domHost: host } = await load();
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "b-1");
    document.body.appendChild(slot);

    await host.open("b-1", { url: "https://example.com" });
    const el = document.querySelector('[data-content-view="b-1"]') as HTMLElement;
    expect(el).toBeTruthy();

    await host.visible("b-1", false);
    expect(el.style.display).not.toBe("none");
    expect(el.style.visibility).toBe("hidden");
    // 화면 밖으로 옮기지 않는다 — 문서 안 게스트는 그냥 안 그려지면 된다.
    expect(el.style.transform === "" || el.style.transform === "none").toBe(true);
    // 상자는 그대로다 — 자리를 채우고 있으므로 켤 때 다시 재어 줄 사람이 없어도 된다.
    expect(el.style.inset).toBe("0px");

    await host.visible("b-1", true);
    expect(el.style.visibility).toBe("visible");
    expect(el.style.inset).toBe("0px");
  });

  // 만든 직후도 같은 규칙이다 — 자리에 놓이기 전에 보이면 옛 자리에서 한 번 그려진다.
  it("만들 때도 숨겨 둔다", async () => {
    const { domHost } = await load();
    await domHost.open("b-2", { url: "https://example.com" });
    const el = document.querySelector('[data-content-view="b-2"]') as HTMLElement;
    expect(el.style.display).not.toBe("none");
    expect(el.style.visibility).toBe("hidden");
  });
});

/** 주입은 **그 문서와 함께 산다.** 페이지가 이동하면 주입된 것도 사라지므로, 한 번만 넣으면
 *  첫 문서에서만 살아 있고 그 뒤로는 조용히 없다 — 계약이 "매 내비게이션 재주입"이라고 적어
 *  두었는데 DOM 구현은 한 번만 넣고 있었다. 해지도 진짜여야 한다: `() => {}` 를 돌려주면
 *  부르는 쪽은 껐다고 믿고 다음 문서에서 또 도는 스크립트를 본다. */
describe("게스트 스크립트 주입 — 문서가 새로 설 때마다", () => {
  beforeEach(() => {
    invoke.mockClear();
    document.body.innerHTML = "";
  });

  it("이동할 때마다 다시 넣는다 — 한 번만 넣으면 다음 문서에는 없다", async () => {
    const m = await load();
    await m.domHost.open("b-1", { url: "https://x" });
    const el = document.querySelector('[data-content-view="b-1"]')!;
    stubTag(el);
    m.domHost.injectScript("b-1", "sentinel()", "document-end");
    await Promise.resolve();
    await Promise.resolve();
    const run = (el as unknown as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    expect(run).toHaveBeenCalledWith("sentinel()");
    const first = run.mock.calls.length;
    // 페이지가 새로 섰다 — 태그는 이동마다 dom-ready 를 다시 낸다.
    el.dispatchEvent(new Event("dom-ready"));
    expect(run.mock.calls.length).toBeGreaterThan(first);
  });

  it("해지하면 다음 문서에서는 안 넣는다 — 껐다는 말이 사실이어야 한다", async () => {
    const m = await load();
    await m.domHost.open("b-2", { url: "https://x" });
    const el = document.querySelector('[data-content-view="b-2"]')!;
    stubTag(el);
    const off = m.domHost.injectScript("b-2", "sentinel()", "document-end");
    await Promise.resolve();
    await Promise.resolve();
    const run = (el as unknown as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    off();
    const before = run.mock.calls.length;
    el.dispatchEvent(new Event("dom-ready"));
    expect(run.mock.calls.length).toBe(before);
  });
});
