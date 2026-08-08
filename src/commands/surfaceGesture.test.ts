// @vitest-environment jsdom
// **한 호출이 게스처 하나를 통째로 낸다.**
//
// 네이티브 표면(자식 웹뷰)에 넣는 포인터는 여태 누름·뗌 두 사건뿐이었다. 그래서 그 위에서는
// 더블클릭도, 끌기도, 오른버튼도 낼 방법이 없었다 — 사람 손은 되는데 명령 표면에는 그 자리가
// 없었다는 뜻이고, 없으면 검증도 없다.
//
// 단계를 부르는 쪽이 이어 붙이게 두면 안 된다. 간격을 호출자가 정하게 되고, CLI 왕복은
// 더블클릭 간격(기본 0.5s)을 넘긴다 — 실측 2026-08-08: 두 번 누름을 두 호출로 보내면
// 엔진이 별개의 단발 클릭 둘로 읽었다. 게스처의 단계는 **한 호출 안에서 연속**으로 나간다.
//
// 끌기는 `move` 가 아니다. 버튼이 눌린 채 움직이면 OS 는 mouseDragged 를 낸다. mouseMoved 로
// 보내면 페이지가 받는 mousemove 의 `buttons` 가 0 이라, 버튼이 눌렸는지 보고 끄는 코드는
// 아무 일도 안 한다. 그래서 계약에 `drag` 가 따로 선다.
//
// 투영 노드도 같은 길이다. 그 자리는 다른 realm 의 사실을 비춘 투명 div 이고, 진짜 노드는
// 자식 문서에 산다. 여태 클릭만 `el.click()` 합성으로 넘겼는데 그건 누름도 뗌도 없는 클릭이라
// 더블클릭·끌기를 만들 수 없다. 투영이 놓인 자리가 곧 그 realm 안의 자리이므로, 그 좌표로
// 진짜 포인터를 넣는다 — 사람 손과 같은 경로 하나.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = vi.hoisted(() => ({
  sendInput: vi.fn(async (_label: string, _input: unknown) => {}),
  evalJs: vi.fn(async () => "ok"),
  typeText: vi.fn(async () => {}),
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
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => ({})),
  currentWindow: () => ({ innerPosition: async () => ({ x: 0, y: 0 }), scaleFactor: async () => 1 }),
}));

import { registerDomCatalog } from "./catalogDom";
import { registerSurfaceInputProvider } from "../lib/surfaceInputProviders";
import { catalogJson, execute, unregister } from "./registry";

const VIEW = "content/view/test.v";
const at = (el: Element, x: number, y: number, w: number, h: number) => {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
};

/** 콘텐츠 표면 하나를 그 주소로 세운다. */
function mountSurface(): string {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="${VIEW}">` +
    `<div data-node="cv" data-content-view="b-main-t1"></div></div>`;
  at(document.querySelector("[data-node=cv]")!, 0, 0, 800, 600);
  return `win/main/${VIEW}/node/cv`;
}

/** 투영 노드 하나를 그 realm 의 컨테이너 안에 세운다. */
function mountProjection(node = "urlbar"): string {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="${VIEW}">` +
    `<div id="box"><div data-realm="pv-main-2" data-node="tauri/plugin-view/pv-main-2/${node}"></div></div></div>`;
  at(document.querySelector("#box")!, 100, 50, 400, 40);
  at(document.querySelector("[data-node^='tauri/plugin-view']")!, 110, 60, 80, 20);
  return `win/main/${VIEW}/node/tauri/plugin-view/pv-main-2/${node}`;
}

const sent = (label: string) =>
  host.sendInput.mock.calls.filter(([l]) => l === label).map(([, i]) => i as Record<string, unknown>);

beforeEach(() => {
  host.sendInput.mockClear();
  host.evalJs.mockClear();
  registerDomCatalog();
});
afterEach(() => {
  for (const { name } of catalogJson()) if (name.startsWith("ui.")) unregister(name);
  document.body.innerHTML = "";
});

describe("계약 — 끌기는 이동과 다른 사건이다", () => {
  it("포인터 사건에 drag 가 있다", () => {
    const contract = readFileSync(resolve(__dirname, "../lib/contentViews.ts"), "utf8");
    expect(contract).toMatch(/kind:\s*"down"\s*\|\s*"up"\s*\|\s*"move"\s*\|\s*"drag"/);
  });
});

describe("표면 위의 게스처", () => {
  it("더블클릭은 한 호출 안에서 네 사건으로 나가고 두 번째 누름이 든 수를 2 로 센다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.dblclick", { address: addr, x: 40, y: 12 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("b-main-t1");
    expect(seq.map((s) => `${s.kind}${s.clickCount}`)).toEqual(["down1", "up1", "down2", "up2"]);
    expect(seq.every((s) => s.x === 40 && s.y === 12)).toBe(true);
  });

  it("오른버튼 클릭이 오른버튼으로 나간다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.click", { address: addr, x: 5, y: 6, button: "right" }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(sent("b-main-t1").map((s) => `${s.kind}:${s.button}`)).toEqual(["down:right", "up:right"]);
  });

  // 이동을 앞세우지 않는다 — 누름이 그 자리의 hover 를 만들고, 이동을 못 받는 엔진에서는
  // 앞세운 한 걸음이 끌기 전체를 죽인다(실측 2026-08-08).
  it("끌기는 누르고, drag 로 움직이고, 마지막에 뗀다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.drag", { from: addr, x: 10, y: 10, dx: 60, dy: 20, steps: 3 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("b-main-t1");
    expect(seq.map((s) => s.kind)).toEqual(["down", "drag", "drag", "drag", "up"]);
    expect(seq[0]).toMatchObject({ x: 10, y: 10 });
    expect(seq[seq.length - 1]).toMatchObject({ x: 70, y: 30 });
  });

  // 넣을 수 있는 프레임워크에서는 들어온 뒤 움직인다. 못 넣는 엔진은 그 사실을 이름으로
  // 거절한다(SURFACE_INPUT_UNAVAILABLE) — 여기서 검증하는 것은 **무엇을 보내는가**이지 그
  // 엔진이 받는가가 아니다.
  it("포인터 이동은 표면 안으로 진짜 이동을 넣는다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.pointer", { address: addr, x: 33, y: 44 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    // 들어온 뒤 움직인다 — 사람의 포인터가 하는 순서이고, 엔진이 hover 를 그 짝으로 연다.
    expect(sent("b-main-t1")).toEqual([
      { x: 33, y: 44, kind: "enter", button: "left", clickCount: 1 },
      { x: 33, y: 44, kind: "move", button: "left", clickCount: 1 },
    ]);
  });
});

describe("투영 노드 위의 게스처 — 그 realm 에 진짜 포인터로", () => {
  it("클릭이 realm 표면의 그 자리로 간다", async () => {
    const addr = mountProjection();
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    // 투영 자리(110,60,80x20) - 컨테이너(100,50) → realm 안 (10,10) 의 가운데 (50,20)
    expect(sent("pv-main-2").map((s) => `${s.kind}@${s.x},${s.y}`)).toEqual(["down@50,20", "up@50,20"]);
  });

  it("더블클릭도 거절하지 않고 그 realm 에서 성립한다", async () => {
    const addr = mountProjection();
    const out = await execute("ui.input.dblclick", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(sent("pv-main-2").map((s) => s.clickCount)).toEqual([1, 1, 2, 2]);
  });

  it("한 realm 안 두 노드 사이를 끈다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-realm="pv-main-2" data-node="tauri/plugin-view/pv-main-2/a"></div>` +
      `<div data-realm="pv-main-2" data-node="tauri/plugin-view/pv-main-2/b"></div></div></div>`;
    at(document.querySelector("#box")!, 100, 50, 400, 40);
    at(document.querySelector("[data-node$='/a']")!, 110, 60, 20, 20);
    at(document.querySelector("[data-node$='/b']")!, 210, 60, 20, 20);
    const out = await execute("ui.input.drag", {
      from: `win/main/${VIEW}/node/tauri/plugin-view/pv-main-2/a`,
      to: `win/main/${VIEW}/node/tauri/plugin-view/pv-main-2/b`,
      steps: 2,
    }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("pv-main-2");
    expect(seq.map((s) => s.kind)).toEqual(["down", "drag", "drag", "up"]);
    expect(seq[0]).toMatchObject({ x: 20, y: 20 });
    expect(seq[seq.length - 1]).toMatchObject({ x: 120, y: 20 });
  });

  it("포인터 이동도 그 realm 으로 간다", async () => {
    const addr = mountProjection();
    const out = await execute("ui.input.pointer", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(sent("pv-main-2").map((s) => s.kind)).toEqual(["enter", "move"]);
  });
});

// 투영은 두 가지를 비춘다. 하나는 **다른 realm 의 노드**(주소줄·버튼)이고, 다른 하나는 그
// realm 이 콘텐츠에 내준 **자리**(페이지가 놓이는 표면)다. 둘은 이름 모양이 같다 —
// `…/plugin-view/<가운데>/…` — 그런데 가운데 토막의 뜻이 다르다: 앞은 renderer realm 이고
// 뒤는 콘텐츠 표면의 label 이다.
//
// 실측 2026-08-08: 이름 모양으로 갈랐더니 콘텐츠 표면을 realm 으로 읽었고, 좌표 기준도 realm
// 컨테이너로 잡혔다. 그리고 탭 노드에서 표면을 찾는 옛 경로는 `data-content-view` 를 봤는데
// 그 속성은 한 프레임워크에만 있어서, 다른 프레임워크에서는 클릭이 조용히 호스트 DOM 으로
// 샜다 — 응답은 `clicked:true` 였고 페이지에는 아무것도 도착하지 않았다.
//
// 이름으로 추측하지 않는다. 투영이 자기가 무엇인지 **선언**한다.
describe("투영은 자기가 무엇인지 선언한다", () => {
  it("자리 투영은 그 표면의 label 을 단다", () => {
    const source = readFileSync(
      resolve(__dirname, "../framework/tauri/pluginViewPresentation.ts"), "utf8",
    );
    expect(source).toMatch(/dataset\.surface = frame\.label/);
    expect(source).toMatch(/dataset\.realm = frame\.realm/);
  });

  it("자리 투영을 가리키면 그 콘텐츠 표면으로 가고, 좌표는 표면 자기 기준이다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="chromium-tab-1" data-node="tauri/plugin-view/chromium-tab-1/surface"></div>` +
      `</div></div>`;
    at(document.querySelector("#box")!, 100, 50, 900, 700);
    at(document.querySelector("[data-surface]")!, 220, 150, 800, 600);
    const addr = `win/main/${VIEW}/node/tauri/plugin-view/chromium-tab-1/surface`;
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    // 표면 안의 왼쪽 위는 (0,0) 이다 — 그 표면이 화면 어디에 놓였는지는 페이지가 알 바 아니다.
    expect(sent("chromium-tab-1").map((s) => `${s.kind}@${s.x},${s.y}`)).toEqual(["down@0,0", "up@0,0"]);
  });

  it("자리 투영 위의 끌기도 표면 좌표로 간다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="offscreen-tab-9" data-node="tauri/plugin-view/offscreen-tab-9/surface"></div>` +
      `</div></div>`;
    at(document.querySelector("#box")!, 0, 0, 900, 700);
    at(document.querySelector("[data-surface]")!, 220, 150, 800, 600);
    const addr = `win/main/${VIEW}/node/tauri/plugin-view/offscreen-tab-9/surface`;
    const out = await execute("ui.input.drag", { from: addr, x: 10, y: 20, dx: 100, dy: 0, steps: 2 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("offscreen-tab-9");
    expect(seq.map((s) => s.kind)).toEqual(["down", "drag", "drag", "up"]);
    expect(seq[0]).toMatchObject({ x: 10, y: 20 });
    expect(seq[seq.length - 1]).toMatchObject({ x: 110, y: 20 });
  });
});

// 표면이 있다고 해서 **이 프레임워크가 그 표면을 쥔 것은 아니다.** 사이드카 엔진이 그리는
// 표면은 그 플러그인이 소유하고, 코어의 입력 통로는 거기 닿지 않는다.
//
// 실측 2026-08-08: chromium·offscreen 표면에 게스처를 보냈더니 "실행이 예기치 못하게
// 실패했습니다" 가 나왔다 — 무엇이 왜 안 됐는지가 응답에 없으면 부른 쪽은 자기 주소를 의심한다.
// 거절은 이름을 달고, 어느 표면인지 말해야 한다.
describe("남의 표면은 이름을 달고 거절한다", () => {
  it("입력 통로가 그 표면에 닿지 않으면 코드와 표면 이름으로 답한다", async () => {
    const addr = mountSurface();
    host.sendInput.mockRejectedValueOnce(new Error("webview 없음: b-main-t1"));
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("SURFACE_INPUT_UNAVAILABLE");
    expect(String(out.message)).toContain("b-main-t1");
    expect(String(out.message)).toContain("webview 없음");
  });

  it("끌기도 같은 이름으로 거절한다 — 예외로 새지 않는다", async () => {
    const addr = mountSurface();
    host.sendInput.mockRejectedValueOnce(new Error("webview 없음: b-main-t1"));
    const out = await execute("ui.input.drag", { from: addr, dx: 40 }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("SURFACE_INPUT_UNAVAILABLE");
  });
});

// 표면의 주인이 따로 있으면 **그 주인에게** 간다 — 코어의 통로가 안 닿는 표면도 게스처가 된다.
//
// 실측 2026-08-08: 브라우저 세 종 중 프레임워크가 쥔 하나만 게스처가 됐고, 엔진 사이드카가
// 그리는 둘은 "webview 없음" 으로 거절됐다. 코어가 그 엔진을 알아서 고치면 결합이고, 주인이
// 스스로 답하게 하면 코어는 아무 엔진도 모른 채 배달만 한다.
describe("표면의 주인에게 배달한다", () => {
  it("주인이 있으면 프레임워크가 아니라 주인이 받는다", async () => {
    const addr = mountSurface();
    const owner = {
      owns: (label: string) => label === "b-main-t1",
      sendInput: vi.fn(async () => {}),
      inputState: vi.fn(async () => ({ attached: true })),
    };
    const dispose = registerSurfaceInputProvider("plugin-x", owner);
    try {
      const out = await execute("ui.input.click", { address: addr, x: 3, y: 4 }, {});
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(owner.sendInput).toHaveBeenCalledTimes(2);
      expect(host.sendInput).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("주인이 없으면 그대로 프레임워크가 받는다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.click", { address: addr, x: 3, y: 4 }, {});
    expect(out.ok).toBe(true);
    expect(host.sendInput).toHaveBeenCalled();
  });

  it("끌기도 주인에게 간다 — 한 통로만 고치면 다른 게스처가 조용히 남는다", async () => {
    const addr = mountSurface();
    const owner = {
      owns: () => true,
      sendInput: vi.fn(async () => {}),
      inputState: vi.fn(async () => ({ attached: true })),
    };
    const dispose = registerSurfaceInputProvider("plugin-x", owner);
    try {
      await execute("ui.input.dblclick", { address: addr }, {});
      await execute("ui.input.drag", { from: addr, dx: 40, steps: 2 }, {});
      expect(owner.sendInput.mock.calls.length).toBeGreaterThanOrEqual(8);
      expect(host.sendInput).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
