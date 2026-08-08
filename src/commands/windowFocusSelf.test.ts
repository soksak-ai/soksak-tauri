// @vitest-environment jsdom
// 자기 창도 라벨로 포커스한다 — "지금 이 웹뷰" 를 거치지 않는다.
//
// 워크스페이스 창의 주 렌더러는 창(WebviewWindow)이 아니라 그 안의 웹뷰다. 그래서 자기 자신을
// 가리키는 포커스가 "현재 웹뷰" 를 잡으려다 프레임워크에서 죽는다 — 실측 2026-08-08:
// `window.focus` 가 `current webview is not a WebviewWindow` 로 실패했고, 라벨을 줘도 같은
// 자리로 갔다(자기 라벨이면 그 경로를 탄다).
//
// 창을 키로 만드는 것은 **창의 일**이고 라벨이 그 창을 가리킨다. 어느 렌더러가 물었는지는
// 상관이 없어야 한다. 포커스가 없으면 그 창의 자식 웹뷰는 `document.hasFocus()` 가 거짓이고,
// 사람이 아무리 타이핑해도 글자가 안 들어간다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined),
}));
const win = vi.hoisted(() => ({ setFocus: vi.fn(async () => {}) }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => calls.invoke(cmd as never, args as never),
  currentWindow: () => win,
}));
vi.mock("../lib/webviewLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webviewLabels")>()),
  currentWindowLabel: () => "w-1",
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";

registerCatalog();

beforeEach(() => {
  calls.invoke.mockReset();
  win.setFocus.mockReset();
  calls.invoke.mockImplementation(async (cmd: string) => (cmd === "window_list" ? ["w-1", "w-2"] : undefined));
});

const named = (cmd: string) => calls.invoke.mock.calls.filter(([c]) => c === cmd);

describe("window.focus — 자기 창도 라벨로 간다", () => {
  it("자기 라벨이면 앱을 전면으로 올리고 그 창을 라벨로 포커스한다", async () => {
    const out = await execute("window.focus", { label: "w-1" }, {});
    expect(out.ok).toBe(true);
    expect(named("window_activate").length, "앱 전면 전환이 빠졌다").toBe(1);
    expect(named("window_focus")[0]?.[1]).toEqual({ label: "w-1" });
  });

  it("지금 이 웹뷰를 거치지 않는다 — 워크스페이스 렌더러는 창이 아니다", async () => {
    await execute("window.focus", {}, {});
    expect(win.setFocus, "창이 아닌 것에 창의 일을 시킨다").not.toHaveBeenCalled();
  });

  it("남의 창은 앱을 전면으로 끌지 않는다", async () => {
    await execute("window.focus", { label: "w-2" }, {});
    expect(named("window_activate").length).toBe(0);
    expect(named("window_focus")[0]?.[1]).toEqual({ label: "w-2" });
  });

  it("없는 창은 이름으로 거절한다", async () => {
    const out = await execute("window.focus", { label: "w-none" }, {});
    expect(out.ok).toBe(false);
    expect(named("window_focus").length).toBe(0);
  });
});
