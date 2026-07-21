// @vitest-environment jsdom
// ui.* 투명성 완성 계약 — 노드의 "유효 시각/상호작용 상태"(보이나·눌리나·무엇이 가리나)를
// 코어가 노출한다. 지금까지 ui.tree(존재)·ui.measure(기하)는 있었으나, 그 사이의 반쪽
// (effective state)이 빠져 플러그인이 private DOM 을 재발명했다(db-studio probe-clickpath).
//
// 두 축을 검증한다:
//  1) deepElementFromPoint — shadow DOM 을 관통하는 히트테스트(ui.tree/nodeScan 과 대칭).
//     ui.hit 이 document.elementFromPoint 얕은 호출이라 shadow host 에서 멈추던 비대칭 결함.
//  2) ui.measure — style 에 상호작용/가시성 축(pointerEvents/opacity/visibility) 상시 포함,
//     props[] 로 임의 computed prop 요청(하드코딩 필드 한계 제거), occlusion 도달성 판정.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "main" }));

import { registerDomCatalog, deepElementFromPoint } from "./catalogDom";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  registerDomCatalog();
});
afterEach(() => {
  for (const c of [
    "ui.tree", "ui.measure", "ui.slot", "ui.focus.state",
    "ui.input.click", "ui.input.dblclick", "ui.input.fill",
    "ui.input.drag", "ui.input.dnd", "ui.hit", "webview.emitNative",
  ]) unregister(c);
  document.body.innerHTML = "";
});

describe("deepElementFromPoint — shadow 관통 히트테스트", () => {
  it("중첩 shadow root 를 관통해 최심 요소를 반환한다", () => {
    const host1 = document.createElement("div");
    const sr1 = host1.attachShadow({ mode: "open" });
    const host2 = document.createElement("div");
    const sr2 = host2.attachShadow({ mode: "open" });
    const leaf = document.createElement("button"); // shadowRoot 없음 → 재귀 종료
    Object.defineProperty(sr1, "elementFromPoint", { value: () => host2, configurable: true });
    Object.defineProperty(sr2, "elementFromPoint", { value: () => leaf, configurable: true });
    const doc = { elementFromPoint: () => host1 } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(5, 5, doc)).toBe(leaf);
  });

  it("shadow 가 없으면 최상단 요소를 그대로 반환한다", () => {
    const el = document.createElement("span");
    const doc = { elementFromPoint: () => el } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBe(el);
  });

  it("shadow 가 자기 host 를 반환하면 멈춘다(무한 루프 방지)", () => {
    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    Object.defineProperty(sr, "elementFromPoint", { value: () => host, configurable: true });
    const doc = { elementFromPoint: () => host } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBe(host);
  });

  it("좌표에 아무것도 없으면 null", () => {
    const doc = { elementFromPoint: () => null } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBeNull();
  });
});

// ui.measure 는 resolveElement(collectExposed) 를 거친다 — .plugin-view-container[data-view-addr]
// 안의 [data-node] 를 절대 주소로 수집. 테스트는 그 구조를 세팅하고 주소로 호출한다.
function mountNode(html: string): void {
  document.body.innerHTML =
    `<div class="plugin-view-container" data-view-addr="content/view/test.v">${html}</div>`;
}
const ADDR = "win/main/content/view/test.v/node/btn";

describe("ui.measure — 상호작용/가시성 축", () => {
  it("style 에 pointerEvents/opacity/visibility 를 상시 포함한다", async () => {
    mountNode(`<button data-node="btn" style="pointer-events:none;opacity:0.5;visibility:hidden">x</button>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect(r.ok).toBe(true);
    const style = (r.data as { style: Record<string, string> }).style;
    // 기존 레이아웃 필드(하위호환) + 새 상호작용/가시성 축.
    expect(style.display).toBeDefined();
    expect(style.pointerEvents).toBe("none");
    expect(style.opacity).toBe("0.5");
    expect(style.visibility).toBe("hidden");
  });

  it("props[] 로 임의 computed 속성을 추가 조회한다(하드코딩 한계 제거)", async () => {
    mountNode(`<button data-node="btn" style="z-index:7;background-color:rgb(1,2,3)">x</button>`);
    const r = await execute("ui.measure", { address: ADDR, props: ["zIndex", "backgroundColor"] }, {});
    expect(r.ok).toBe(true);
    const style = (r.data as { style: Record<string, string> }).style;
    expect(style.zIndex).toBe("7");
    expect(style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("occlusion:true 면 도달성 판정을 함께 반환한다", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const r = await execute("ui.measure", { address: ADDR, occlusion: true }, {});
    expect(r.ok).toBe(true);
    const occ = (r.data as { occlusion?: Record<string, unknown> }).occlusion;
    // 형태 계약 — reachable(boolean) 과 topTag 를 보고한다(실제 히트 결과는 레이아웃 의존).
    expect(occ).toBeDefined();
    expect(typeof occ!.reachable).toBe("boolean");
    expect("topTag" in occ!).toBe(true);
  });

  it("occlusion 생략 시 도달성 필드는 없다(측정만)", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect((r.data as Record<string, unknown>).occlusion).toBeUndefined();
  });
});

describe("ui.measure/ui.hit — 스펙 선언", () => {
  it("ui.measure 가 props/occlusion 을 선언한다", () => {
    const spec = getSpec("ui.measure");
    expect(spec!.params.props).toBeDefined();
    expect(spec!.params.occlusion).toBeDefined();
  });
});
