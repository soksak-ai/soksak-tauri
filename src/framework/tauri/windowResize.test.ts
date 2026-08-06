import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const invoke = vi.fn();
  const sdkSetSize = vi.fn();
  const windowHandle = {
    label: "w-logical-size-red",
    setTitle: vi.fn(),
    setSize: sdkSetSize,
    setPosition: vi.fn(),
    setFocus: vi.fn(),
    setTheme: vi.fn(),
    outerPosition: vi.fn(),
    innerPosition: vi.fn(),
    outerSize: vi.fn(),
    scaleFactor: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    onResized: vi.fn(),
    onMoved: vi.fn(),
    onDragDropEvent: vi.fn(),
    listen: vi.fn(),
  };
  return { invoke, sdkSetSize, windowHandle };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class Channel {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({
  getName: vi.fn(),
  getVersion: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => tauri.windowHandle,
}));
vi.mock("@tauri-apps/api/window", () => {
  class LogicalSize {
    constructor(public width: number, public height: number) {}
  }
  class LogicalPosition {
    constructor(public x: number, public y: number) {}
  }
  class PhysicalPosition {
    constructor(public x: number, public y: number) {}
  }
  class Window {
    static async getByLabel() { return tauri.windowHandle; }
  }
  return {
    getCurrentWindow: () => tauri.windowHandle,
    LogicalSize,
    LogicalPosition,
    PhysicalPosition,
    Window,
  };
});

import { tauriFramework } from "./index";

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.sdkSetSize.mockReset().mockResolvedValue(undefined);
});

describe("Tauri physical window resize boundary", () => {
  it("does not expose tao's fire-and-forget setSize as an awaited resize", () => {
    const source = readFileSync("src/framework/tauri/index.ts", "utf8");
    expect(source).not.toContain("setPhysicalSize: (w, h) => win.setSize(new PhysicalSize(w, h))");
    expect(source).toContain('tauriInvoke("window_set_physical_size", { label, width: w, height: h })');
  });
});

describe("Tauri logical window resize boundary", () => {
  it("resolves only after the native AppKit transaction ACK, never the SDK setSize promise", async () => {
    let acknowledge!: () => void;
    tauri.invoke.mockImplementation((command: string) => {
      if (command !== "window_set_logical_size") {
        throw new Error(`unexpected command: ${command}`);
      }
      return new Promise<void>((resolve) => { acknowledge = resolve; });
    });

    let settled = false;
    const applied = tauriFramework.currentWindow().setSize(960, 640);
    void applied.then(() => { settled = true; });
    await Promise.resolve();

    expect(
      tauri.sdkSetSize,
      "Tauri SDK setSize resolves before AppKit applies/layouts/displays the new content size",
    ).not.toHaveBeenCalled();
    expect(tauri.invoke).toHaveBeenCalledWith("window_set_logical_size", {
      label: "w-logical-size-red",
      width: 960,
      height: 640,
    });
    expect(settled, "logical setSize exposed completion before the native receipt").toBe(false);

    acknowledge();
    await applied;
    expect(settled).toBe(true);
  });
});
