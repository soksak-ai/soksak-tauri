import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Tauri physical window resize boundary", () => {
  it("does not expose tao's fire-and-forget setSize as an awaited resize", () => {
    const source = readFileSync("src/framework/tauri/index.ts", "utf8");
    expect(source).not.toContain("setPhysicalSize: (w, h) => win.setSize(new PhysicalSize(w, h))");
    expect(source).toContain('tauriInvoke("window_set_physical_size", { label, width: w, height: h })');
  });
});
