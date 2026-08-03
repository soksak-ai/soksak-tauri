import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../framework", () => ({
  invoke,
  currentWindow: vi.fn(),
  windowByLabel: vi.fn(),
}));
vi.mock("../lib/projectRoot", () => ({
  validateProjectRoot: async (root: string) => root,
}));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: (label: string) => ["b", label, ""].join("-"),
  currentWindowLabel: () => "main",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));

import { registerWindowCatalog } from "./catalogWindow";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  invoke.mockReset();
  registerWindowCatalog();
});

afterEach(() => {
  for (const name of ["window.open"]) unregister(name);
});

it("window.open은 자동화가 포커스를 보존하도록 focus:false를 네이티브 창 계약에 전달한다", async () => {
  expect(getSpec("window.open")?.params.focus).toMatchObject({ type: "boolean" });

  invoke.mockImplementation(async (command: string) => {
    if (command === "project_owners") return { owners: [] };
    if (command === "window_create") return "w-test";
    throw new Error(`unexpected invoke: ${command}`);
  });

  const result = await execute(
    "window.open",
    { root: "<machine-path>/soksak/core", focus: false },
    {},
  );

  expect(result).toMatchObject({ ok: true, data: { label: "w-test" } });
  expect(invoke).toHaveBeenCalledWith("window_create", {
    init: "root=%2FUsers%2Fmax%2Fsoksak%2Fcore",
    focus: false,
  });
});
