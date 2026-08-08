// @vitest-environment jsdom
// **사람이 페이지를 클릭하면 그 페이지가 받아야 한다.**
//
// 이 프레임워크에서 콘텐츠는 메인 웹뷰 **아래**에 깔린 자식 표면이다. 그래서 사람이 페이지 위를
// 눌러도 그 사건은 위에 있는 메인 웹뷰가 받는다 — 아래로 저절로 내려가지 않는다(CSS 로는 네이티브
// 형제에게 클릭을 넘길 수 없다).
//
// 실측 2026-08-08: 명령으로 넣은 클릭은 세 브라우저 모두 링크를 따라갔는데, 사람이 손으로 누르면
// 아무 일도 안 일어났다. 주입 경로만 살아 있었고 사람 경로는 처음부터 없었다.
//
// 뷰 안의 노드(주소줄·버튼)는 이미 이 방식으로 넘긴다. 빠져 있던 것은 **콘텐츠 자리**다.
import { describe, expect, it, vi, beforeEach } from "vitest";

type Sent = [string, { kind: string; x: number; y: number; button: string; clickCount: number }];
const host = vi.hoisted(() => ({
  sendInput: vi.fn(async (_label: string, _input: {
    kind: string; x: number; y: number; button: string; clickCount: number;
  }) => {}),
}));
vi.mock("../../lib/contentViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/contentViews")>()),
  hasContentViewHost: () => true,
  contentViewHost: () => host,
}));

import { installContentInputForwarding } from "./contentInputForward";

const at = (el: Element, x: number, y: number, w: number, h: number) => {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
};

function mountSlot(label = "b-w-1-tab-1"): HTMLElement {
  document.body.innerHTML = `<div data-content-view-body="${label}"></div>`;
  const slot = document.querySelector<HTMLElement>("[data-content-view-body]")!;
  at(slot, 100, 50, 800, 600);
  return slot;
}

const fire = (el: Element, type: string, clientX: number, clientY: number, init: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, composed: true, ...init }));

beforeEach(() => host.sendInput.mockClear());

describe("콘텐츠 자리 위의 포인터는 그 표면으로 간다", () => {
  it("누름과 뗌이 표면 좌표로 넘어간다", () => {
    const slot = mountSlot();
    const stop = installContentInputForwarding(document);
    fire(slot, "mousedown", 150, 80);
    fire(slot, "mouseup", 150, 80);
    stop();
    expect((host.sendInput.mock.calls as Sent[]).map(([label, i]) => `${label}:${i.kind}@${i.x},${i.y}`)).toEqual([
      "b-w-1-tab-1:down@50,30",
      "b-w-1-tab-1:up@50,30",
    ]);
  });

  it("오른버튼과 든 수를 그대로 나른다 — 문맥 메뉴와 더블클릭이 성립한다", () => {
    const slot = mountSlot();
    const stop = installContentInputForwarding(document);
    fire(slot, "mousedown", 100, 50, { button: 2, detail: 1 });
    fire(slot, "mousedown", 100, 50, { button: 0, detail: 2 });
    stop();
    expect((host.sendInput.mock.calls as Sent[]).map(([, i]) => `${i.button}/${i.clickCount}`)).toEqual(["right/1", "left/2"]);
  });

  // 버튼이 눌린 채 움직이면 끌기다 — 이동으로 보내면 그 realm 의 buttons 가 0 이라 끌기가 죽는다.
  it("버튼을 쥔 이동은 끌기로 간다", () => {
    const slot = mountSlot();
    const stop = installContentInputForwarding(document);
    fire(slot, "mousemove", 120, 60, { buttons: 1 });
    fire(slot, "mousemove", 130, 70, { buttons: 0 });
    stop();
    expect((host.sendInput.mock.calls as Sent[]).map(([, i]) => i.kind)).toEqual(["drag", "move"]);
  });

  // 콘텐츠 자리 밖은 호스트의 것이다 — 넘기면 사이드바 클릭이 페이지로 샌다.
  it("자리 밖의 포인터는 넘기지 않는다", () => {
    mountSlot();
    document.body.insertAdjacentHTML("beforeend", `<button id="chrome">x</button>`);
    const stop = installContentInputForwarding(document);
    fire(document.getElementById("chrome")!, "mousedown", 10, 10);
    stop();
    expect(host.sendInput).not.toHaveBeenCalled();
  });

  // 해지하면 멈춘다 — 남기면 사라진 표면으로 계속 보낸다.
  it("해지하면 더 이상 넘기지 않는다", () => {
    const slot = mountSlot();
    installContentInputForwarding(document)();
    fire(slot, "mousedown", 150, 80);
    expect(host.sendInput).not.toHaveBeenCalled();
  });
});
