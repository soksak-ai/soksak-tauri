// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const code = (path: string) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("Electron pure-DOM composition boundary", () => {
  it("installs only the DOM content host, resize evidence, and Electron CSS", () => {
    const source = code("src/framework/electron/install.ts");
    expect(source).toContain("registerContentViewHost(domHost)");
    expect(source).toContain("registerWindowResizeProbe");
    expect(source).toContain('adoptFrameworkStyles("electron", styles)');
    expect(source).not.toMatch(
      /registerPluginViewPresentationHost|registerLayoutTransitionHost|PaneSurfaceHost|hole|veil|railHoleClip|nativeMotion/,
    );
  });

  it("places a webview as the slot's DOM child and owns no native follow or z-order", () => {
    const source = code("src/framework/electron/contentViews.ts");
    expect(source).toContain("slot.appendChild(el)");
    expect(source).toContain('el.style.cssText = "position:absolute;inset:0"');
    expect(source).not.toMatch(
      /ResizeObserver|layout\.reflow|layout\.resize-gesture|webview_transition_prepare|data-tauri-hole|data-external-surface|PaneSurfaceHost|zIndex|z-index|setInterval|requestAnimationFrame/,
    );
  });

  it("selects Electron at the build leaf without importing Tauri", () => {
    const leaf = code("src/framework/selected.electron.ts");
    expect(leaf).toContain('from "./electron"');
    expect(leaf).not.toMatch(/tauri/i);

    const electronIndex = code("src/framework/electron/index.ts");
    expect(electronIndex).toContain('install: () => import("./install")');
    expect(electronIndex).not.toMatch(/framework\/tauri|\.\.\/tauri|@tauri-apps/);
  });

  it("keeps nativeSurface presentation behind the empty adapter registry", () => {
    const commonHost = code("src/components/PluginViewHost.tsx");
    const electronInstall = code("src/framework/electron/install.ts");
    expect(commonHost).toMatch(
      /reg\.decl\.nativeSurface\s*\?\s*pluginViewPresentationHost\(\)\s*:\s*null/,
    );
    expect(electronInstall).not.toContain("registerPluginViewPresentationHost");
  });
});
