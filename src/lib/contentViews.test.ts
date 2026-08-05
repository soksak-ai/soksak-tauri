// 콘텐츠 뷰 계약 — 코어가 아는 것 전부.
//
// 코어는 **누가 걸었는지 묻지 않는다.** 그래서 여기서 재는 것은 셋뿐이다: 등록부가 건 것을
// 돌려주는가, 안 걸렸을 때 이름을 달고 거절하는가, 자리 선언을 읽는가.
//
// 구현이 계약을 지키는지는 각 프레임워크의 검사가 본다(framework/<name>/contentViews.test.ts).
// 그 둘의 표면이 정확히 같은지는 아래 마지막 검사가 본다 — 갈리면 호출자가 어느 쪽인지 알게
// 되고, 아는 순간 경계가 샌다.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

async function load() {
  vi.resetModules();
  return import("./contentViews");
}

const stubHost = () =>
  ({
    open: vi.fn(),
    close: vi.fn(),
    list: vi.fn(),
    alive: vi.fn(),
    navigate: vi.fn(),
    bounds: vi.fn(),
    visible: vi.fn(),
    history: vi.fn(),
    stop: vi.fn(),
    zoom: vi.fn(),
    devtools: vi.fn(),
    evalJs: vi.fn(),
    injectScript: vi.fn(),
    openWindow: vi.fn(),
    sendInput: vi.fn(),
    wheel: vi.fn(),
    typeText: vi.fn(),
  }) as unknown as import("./contentViews").ContentViewHost;

describe("콘텐츠 뷰 계약", () => {
  beforeEach(async () => {
    (await load()).__resetContentViewHostForTest();
    document.body.innerHTML = "";
  });

  // 능력으로 고르던 자리를 없앴다(2026-08-03). 콘텐츠가 네이티브 자식인지 태그인지는 앱이
  // 고르는 것이 아니라 프레임워크가 **줄 수 있는 것**이다 — 한쪽은 태그를 못 주고 다른 쪽은
  // label 로 부르는 OS 자식 뷰를 못 준다. 그래서 거는 쪽도 프레임워크다.
  it("건 것을 돌려준다 — 프레임워크 이름도 능력도 묻지 않는다", async () => {
    const m = await load();
    const host = stubHost();
    m.registerContentViewHost(host);
    expect(m.contentViewHost()).toBe(host);
    expect(m.hasContentViewHost()).toBe(true);
  });

  // 빈 구현을 돌려주면 부른 쪽은 열었다고 믿은 채 아무것도 안 보이는 화면을 본다.
  it("아무도 안 걸었으면 이름을 달고 거절한다", async () => {
    const m = await load();
    expect(m.hasContentViewHost()).toBe(false);
    expect(() => m.contentViewHost()).toThrow("걸려 있지 않습니다");
  });

  it("자리 선언을 label 로 읽는다", async () => {
    const m = await load();
    const a = document.createElement("div");
    a.setAttribute(m.CONTENT_VIEW_BODY, "b-1");
    const b = document.createElement("div");
    b.setAttribute(m.CONTENT_VIEW_BODY, "b-2");
    document.body.append(a, b);
    expect(m.findContentViewSlot("b-2", document)).toBe(b);
    // 선언하지 않은 label 은 **자리가 없는** 뷰다 — 없는 것을 아무 자리로 채우지 않는다.
    expect(m.findContentViewSlot("b-9", document)).toBeNull();
  });

  it("문서 안 콘텐츠 뷰의 직접·계산 가시성을 상태로 노출한다", async () => {
    const m = await load();
    const slot = document.createElement("div");
    slot.setAttribute(m.CONTENT_VIEW_BODY, "b-1");
    const view = document.createElement("webview");
    view.setAttribute("data-content-view", "b-1");
    view.style.visibility = "hidden";
    slot.appendChild(view);
    document.body.appendChild(slot);

    expect(m.contentViewDomFacts(document)).toEqual([
      expect.objectContaining({
        label: "b-1",
        directVisibility: "hidden",
        computedVisibility: "hidden",
        slotLabel: "b-1",
      }),
    ]);
  });
});

// 한쪽에만 있는 동작이 생기면 그 차이는 오류가 아니라 "이 프레임워크에서는 안 되는 기능"으로
// 나타난다. 그때 호출자가 프레임워크를 알아야 하고, 아는 순간 경계가 샌다.
describe("두 구현의 표면이 정확히 같다", () => {
  it("키가 하나도 어긋나지 않는다", async () => {
    vi.resetModules();
    const { nativeHost } = await import("../framework/tauri/contentViews");
    const { domHost } = await import("../framework/electron/contentViews");
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(domHost)).toEqual(keys(nativeHost));
    // 오라클 생존 — 표면이 비면 위 단언이 공짜로 통과한다.
    expect(keys(nativeHost).length).toBeGreaterThan(10);
  });
});
