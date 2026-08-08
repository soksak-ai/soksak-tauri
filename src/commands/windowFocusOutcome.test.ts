// @vitest-environment jsdom
// **포커스했다고 답했는데 안 됐으면 그것은 답이 아니다.**
//
// 실측 2026-08-08: `window.focus` 가 `{ focused: true }` 를 답했는데 그 창은 키가 아니었다
// (`ui.input.state` 의 `windowIsKey: false`). 다른 앱이 활성일 때 이 앱의 창을 앞으로 올려도
// OS 는 키보드 포커스를 넘기지 않는다 — 요청은 성공하고 결과는 안 온다.
//
// 그 위에서 키보드 명령이 전부 거절되고, 부른 쪽은 포커스를 줬는데 왜 안 되는지 모른다.
// 요청과 결과는 다른 사실이므로 응답이 둘 다 실어야 한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ invoke: vi.fn(async (_c: string, _a?: unknown): Promise<unknown> => undefined) }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => calls.invoke(cmd, args),
  currentWindow: () => ({ setFocus: async () => {} }),
}));
vi.mock("../lib/webviewLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webviewLabels")>()),
  currentWindowLabel: () => "w-1",
}));

import { registerCatalog } from "./catalog";
import { execute, getSpec } from "./registry";

registerCatalog();

beforeEach(() => {
  calls.invoke.mockReset();
  calls.invoke.mockImplementation(async (cmd: string) => (cmd === "window_list" ? ["w-1", "w-2"] : undefined));
});

describe("window.focus 는 결과를 답한다", () => {
  it("정말 키가 됐는지 함께 답한다 — 요청과 결과는 다른 사실이다", async () => {
    calls.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "window_list") return ["w-1", "w-2"];
      if (cmd === "window_is_key") return true;
      return undefined;
    });
    const out = await execute("window.focus", { label: "w-1" }, {});
    expect(out.ok).toBe(true);
    expect((out.data as { key?: boolean }).key).toBe(true);
    expect(getSpec("window.focus")?.returns).toContain("key");
  });

  // 다른 앱이 활성이면 창을 올려도 키보드는 안 온다 — 그 사실이 응답에 있어야 부른 쪽이 안다.
  it("키가 못 됐으면 그 사실과 무엇을 하면 되는지를 답한다", async () => {
    calls.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "window_list") return ["w-1", "w-2"];
      if (cmd === "window_is_key") return false;
      return undefined;
    });
    const out = await execute("window.focus", { label: "w-1" }, {});
    expect((out.data as { key?: boolean }).key).toBe(false);
    expect(String(out.message)).toMatch(/키보드/);
  });
});
