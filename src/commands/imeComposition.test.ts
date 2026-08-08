// @vitest-environment jsdom
// **조합은 확정과 다른 사실이다.**
//
// 한글·일본어·중국어는 확정 전에 조합 상태를 지난다. 그 동안 페이지는 `compositionstart`/
// `compositionupdate` 를 받고, 아직 값이 아닌 글자를 보여 주며, 백스페이스는 글자가 아니라
// 자모를 지운다. 확정 문자열만 넣을 수 있으면 그 구간을 한 번도 안 지나고 "한글이 들어간다" 고
// 말하게 된다 — 반쪽 증명이다.
//
// 그래서 조합이 계약의 축으로 선다. 넣는 것과 푸는 것 둘 다 — 푸는 자리가 없으면 조합이 열린
// 채로 남아 다음 입력이 그 위에 얹힌다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = vi.hoisted(() => ({
  sendInput: vi.fn(async () => {}),
  inputState: vi.fn(async () => ({ attached: true })),
  markText: vi.fn(async (_label: string, _text: string) => {}),
  typeText: vi.fn(async () => {}),
  evalJs: vi.fn(async () => "ok"),
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
const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const at = (el: Element, x: number, y: number, w: number, h: number) => {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
};
function mountSurface(): string {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
    `<div data-surface="b-main-t1" data-node="tauri/plugin-view/b-main-t1/surface"></div></div></div>`;
  at(document.querySelector("#box")!, 0, 0, 900, 700);
  at(document.querySelector("[data-surface]")!, 0, 0, 800, 600);
  return `win/main/${VIEW}/node/tauri/plugin-view/b-main-t1/surface`;
}

beforeEach(() => {
  host.markText.mockClear();
  registerDomCatalog();
});
afterEach(() => {
  for (const { name } of catalogJson()) if (name.startsWith("ui.")) unregister(name);
  document.body.innerHTML = "";
});

describe("조합은 계약의 축이다", () => {
  it("계약이 그 자리를 선언한다", () => {
    expect(read("../lib/contentViews.ts")).toMatch(/markText\(label: string, text: string\)/);
  });

  it("두 프레임워크가 모두 채운다", () => {
    expect(read("../framework/tauri/contentViews.ts")).toContain("markText");
    expect(read("../framework/electron/contentViews.ts")).toContain("markText");
  });
});

describe("ui.input.compose", () => {
  it("조합 중 글자를 그 표면에 넣는다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.compose", { address: addr, text: "한" }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(host.markText).toHaveBeenCalledWith("b-main-t1", "한");
    expect((out.data as { composing?: string }).composing).toBe("한");
  });

  // 조합을 열어 두면 다음 입력이 그 위에 얹힌다 — 끝내는 자리가 있어야 한다.
  it("text 없이 부르면 조합을 푼다", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.compose", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(host.markText).toHaveBeenCalledWith("b-main-t1", "");
    expect((out.data as { composing?: string | null }).composing).toBe(null);
  });

  it("표면이 아닌 노드는 이름으로 거절한다", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><button data-node="btn"></button></div>`;
    const out = await execute("ui.input.compose", { address: `win/main/${VIEW}/node/btn`, text: "ㄱ" }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("NOT_A_SURFACE");
  });

  it("카탈로그가 조합과 확정을 구별해 밝힌다", () => {
    const spec = getSpec("ui.input.compose");
    expect(spec?.returns).toContain("composing");
    expect(String(spec?.description)).toMatch(/composition/i);
  });
});
