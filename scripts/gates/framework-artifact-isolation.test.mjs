import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactViolations } from "./framework-artifact-isolation.mjs";

let fixture = "";

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = "";
});

function artifact(source) {
  fixture = mkdtempSync(join(tmpdir(), "soksak-framework-artifact-"));
  mkdirSync(join(fixture, "assets"));
  writeFileSync(join(fixture, "assets", "main.js"), source);
  return fixture;
}

describe("framework artifact isolation", () => {
  it.each([
    ["PaneSurfaceHost", "Tauri pane native owner"],
    ["webview.pane.group", "Tauri pane follow command"],
    ["webview_transition_prepare", "Tauri native bounds transaction"],
    ["data-tauri-hole", "Tauri DOM-hole projection"],
    ["NSWindowOrderingMode", "AppKit native z-order"],
    ["soksak:external-surface-layout-transition", "Tauri external surface transition"],
  ])("rejects %s from an Electron artifact", (needle, reason) => {
    expect(artifactViolations("electron", artifact(`window.marker=${JSON.stringify(needle)}`)))
      .toContainEqual(expect.stringContaining(reason));
  });

  it("rejects the Electron DOM host implementation from a Tauri artifact", () => {
    expect(artifactViolations(
      "tauri",
      artifact('window.marker="framework/electron.fix#bridges"'),
    )).toContainEqual(expect.stringContaining("Electron 렌더러 상태"));
  });
});
