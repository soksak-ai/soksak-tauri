// @vitest-environment jsdom
// **입력이 안 닿았다는 말만으로는 아무것도 못 고친다.**
//
// 포인터가 표면에 도착하지 않을 때 배달을 가르는 조건은 전부 그 표면과 창의 상태다: 창에
// 붙었는가, 창이 이동 사건을 받도록 켜져 있는가, 이 뷰가 입력 responder 인가, 그리고 엔진이
// hover 를 자르는 기준인 **보이는 사각형**이 어디까지인가.
//
// 실측 2026-08-08: 누름·뗌·끌기는 도착하는데 이동만 0회였다. 세 가지 배달 방법을 바꿔 가며
// 시도했지만 무엇이 자르고 있는지 물어볼 자리가 없어서 매번 추측으로 되돌아갔다. 관측면이
// 없으면 원인은 영영 추측이다.
//
// 그래서 표면 자신이 답한다 — 명령 하나로, 프레임워크가 무엇이든.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = vi.hoisted(() => ({
  sendInput: vi.fn(async () => {}),
  inputState: vi.fn(async (_label: string) => ({ attached: true, visibleRect: { x: 0, y: 0, w: 800, h: 600 } })),
}));
vi.mock("../lib/contentViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/contentViews")>()),
  hasContentViewHost: () => true,
  contentViewHost: () => host,
}));
vi.mock("../lib/webviewLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webviewLabels")>()),
  currentWindowLabel: () => "main",
  browserLabel: (viewId: string) => `b-main-${viewId}`,
}));

import { registerDomCatalog } from "./catalogDom";
import { catalogJson, execute, getSpec, unregister } from "./registry";

const VIEW = "content/view/test.v";
const at = (el: Element, x: number, y: number, w: number, h: number) => {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
};

beforeEach(() => {
  host.inputState.mockClear();
  registerDomCatalog();
});
afterEach(() => {
  for (const { name } of catalogJson()) if (name.startsWith("ui.")) unregister(name);
  document.body.innerHTML = "";
});

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

describe("표면 입력 상태는 계약의 축이다", () => {
  it("계약이 그 자리를 선언한다", () => {
    expect(read("../lib/contentViews.ts")).toMatch(/inputState\(label: string/);
  });

  it("두 프레임워크가 모두 채운다 — 한쪽만 답하면 진단이 프레임워크마다 갈린다", () => {
    expect(read("../framework/tauri/contentViews.ts")).toContain("inputState");
    expect(read("../framework/electron/contentViews.ts")).toContain("inputState");
  });
});

describe("ui.input.state", () => {
  it("표면 주소를 그 표면의 배달 조건으로 답한다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="b-main-t1" data-node="tauri/plugin-view/b-main-t1/surface"></div></div></div>`;
    at(document.querySelector("#box")!, 0, 0, 900, 700);
    at(document.querySelector("[data-surface]")!, 220, 150, 800, 600);
    const out = await execute(
      "ui.input.state",
      { address: `win/main/${VIEW}/node/tauri/plugin-view/b-main-t1/surface` },
      {},
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(host.inputState).toHaveBeenCalledWith("b-main-t1", undefined);
    expect((out.data as Record<string, unknown>).surface).toBe("b-main-t1");
    expect((out.data as { state?: { attached?: boolean } }).state?.attached).toBe(true);
  });

  // 표면이 아닌 노드에 물으면 그 자리에는 답할 사실이 없다 — 빈 값으로 얼버무리지 않는다.
  it("표면이 아닌 노드는 이름으로 거절한다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><button data-node="btn"></button></div>`;
    const out = await execute("ui.input.state", { address: `win/main/${VIEW}/node/btn` }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("NOT_A_SURFACE");
  });

  it("카탈로그가 무엇을 답하는지 밝힌다", () => {
    const spec = getSpec("ui.input.state");
    expect(spec?.returns).toContain("visibleRect");
    expect(spec?.returns).toContain("windowTopmostAtPoint");
  });

  // 좌표로 물을 수 있다고 계약에 적어 놓고 명령이 그 인자를 안 받으면, 부른 쪽은 "알 수 없는
  // 파라미터"만 보고 자기 주소를 의심한다(실측 2026-08-08: 48개 자리를 훑었는데 전부 빈 답이
  // 돌아왔고, 원인은 이 선언 누락이었다).
  it("좌표를 인자로 받는다 — 계약에만 있고 표면에 없으면 못 묻는다", () => {
    const spec = getSpec("ui.input.state");
    expect(spec?.params?.x).toBeDefined();
    expect(spec?.params?.y).toBeDefined();
  });

  it("준 좌표를 그대로 표면에 묻는다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="b-main-t1" data-node="tauri/plugin-view/b-main-t1/surface"></div></div></div>`;
    at(document.querySelector("#box")!, 0, 0, 900, 700);
    at(document.querySelector("[data-surface]")!, 0, 0, 800, 600);
    await execute(
      "ui.input.state",
      { address: `win/main/${VIEW}/node/tauri/plugin-view/b-main-t1/surface`, x: 12, y: 34 },
      {},
    );
    expect(host.inputState).toHaveBeenCalledWith("b-main-t1", { x: 12, y: 34 });
  });
});

// **가려짐은 이동을 막지 않는다 — 이 가설은 기각됐다.**
//
// 표면이 보이고 좌표도 그 안인데 페이지가 mousemove 를 0회 받았다. 처음에는 엔진이 "그 지점의
// 맨 위 창"으로 hover 를 자른다고 보고 그 조건을 거절 사유로 세웠다. 그런데 맨 위가 우리 창인
// 자리에서도 0회였다(실측 2026-08-08) — 가설이 틀렸고, 틀린 근거로 세운 거절은 **없는 제약**을
// 만들어 도착 가능한 이동까지 막았다. 그래서 지웠다.
//
// 남은 사실은 세 가지다: 누름·뗌·끌기는 도착한다, 누름은 엔진이 mouseover/mouseenter 까지
// 만들어 준다(그러니 hover 통로 자체는 살아 있다), 그리고 mouseMoved 만 페이지에 닿지 않는다.
// 그 자리를 가르는 관측면(windowTopmostAtPoint)은 진단으로 남긴다 — 사실이기 때문이다.
describe("가려짐 관측은 남고 거절은 없다", () => {
  it("입력 상태를 좌표로 물을 수 있다", () => {
    expect(read("../lib/contentViews.ts")).toMatch(/inputState\(label: string, at\?/);
  });

  it("가려진 자리라도 이동을 막지 않는다 — 근거 없는 제약은 결함이다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="b-main-t1" data-node="tauri/plugin-view/b-main-t1/surface"></div></div></div>`;
    at(document.querySelector("#box")!, 0, 0, 900, 700);
    at(document.querySelector("[data-surface]")!, 0, 0, 800, 600);
    host.inputState.mockResolvedValueOnce({
      attached: true, windowNumber: 382, topWindowAtPoint: 350, windowTopmostAtPoint: false,
    } as never);
    const out = await execute(
      "ui.input.pointer",
      { address: `win/main/${VIEW}/node/tauri/plugin-view/b-main-t1/surface`, x: 10, y: 10 },
      {},
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(host.sendInput).toHaveBeenCalled();
  });
});
