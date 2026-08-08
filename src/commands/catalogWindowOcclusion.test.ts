import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke,
  currentWindow: vi.fn(),
  windowByLabel: vi.fn(),
}));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: (label: string) => ["b", label, ""].join("-"),
  currentWindowLabel: () => "main",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));

import { registerWindowCatalog } from "./catalogWindow";
import { execute, unregister } from "./registry";

beforeEach(() => {
  invoke.mockReset();
  registerWindowCatalog();
});

afterEach(() => unregister("window.occlusion"));

it("가림 감지를 적용한 모든 native webview 수를 공개한다", async () => {
  invoke.mockResolvedValue(4);
  const result = await execute("window.occlusion", { enabled: false }, {});
  expect(result).toMatchObject({ ok: true, data: { occlusion: false, webviews: 4 } });
  expect(invoke).toHaveBeenCalledWith("plugin:webview-capture|set_occlusion", {
    enabled: false,
  });
});
