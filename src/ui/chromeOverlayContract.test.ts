import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

describe("chrome overlay contract", () => {
  it("exposes every chrome surface that must remain above embedded browsers", () => {
    const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
    const modal = readFileSync(resolve(ROOT, "src/components/NewProjectModal.tsx"), "utf8");

    expect(app).toContain('data-node="rail/add"');
    expect(app).toContain('data-node="sidebar/right"');
    expect(app).toContain('data-node="sidebar/right/resizer"');
    expect(modal).toContain('data-node="modal/project-new"');
    expect(modal).toContain('data-node="modal/project-new/card"');
    expect(modal).toContain('data-node="modal/project-new/close"');
  });

  it("keeps both side chrome surfaces outside the focus-lighting plane", () => {
    const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
    const openingTag = (node: string) =>
      app.match(
        new RegExp(`<div\\s+[^>]*data-node="${node}"[^>]*>`),
      )?.[0] ?? "";

    expect(openingTag("rail/left")).toContain(
      'data-focus-lighting="exempt"',
    );
    expect(openingTag("sidebar/right")).toContain(
      'data-focus-lighting="exempt"',
    );
  });

  it("declares modal activation as a native-surface occlusion transaction", () => {
    const modal = readFileSync(resolve(ROOT, "src/components/NewProjectModal.tsx"), "utf8");
    const tauri = readFileSync(resolve(ROOT, "src/framework/tauri/install.ts"), "utf8");

    expect(modal).toContain("useOverlayActive();");
    expect(tauri).toContain('invoke("webview_overlay_active", { active })');
  });
});
