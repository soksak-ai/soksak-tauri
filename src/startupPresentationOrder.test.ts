import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname);

function region(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  if (startAt < 0) throw new Error(`missing region start: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  if (endAt < 0) throw new Error(`missing region end after ${start}: ${end}`);
  return source.slice(startAt, endAt);
}

function expectOrdered(source: string, markers: string[]): void {
  let cursor = 0;
  for (const marker of markers) {
    const position = source.indexOf(marker, cursor);
    expect(position, `missing ordered startup marker: ${marker}`).toBeGreaterThanOrEqual(0);
    cursor = position + marker.length;
  }
}

describe("startup presentation geometry barrier", () => {
  const main = readFileSync(resolve(SRC, "main.tsx"), "utf8");

  it("startup owns initial zoom once; App does not race presentation through a mount effect", () => {
    const app = readFileSync(resolve(SRC, "App.tsx"), "utf8");
    expect(app).not.toContain("applyWindowZoom(");
    expect(app).not.toContain("windowZoomMounted");
  });

  it("control-plane render waits for saved zoom application before adapter composition/presentation", () => {
    const branch = region(
      main,
      'if (currentWindowLabel() === "main") {',
      "beginBootPluginEventBuffer();",
    );
    expectOrdered(branch, [
      "<OrchestratorApp />",
      "await applySavedWindowZoom();",
      "await presentWindow();",
    ]);
  });

  it("workspace render waits for saved zoom application before adapter composition/presentation", () => {
    const branch = region(main, "<App />", 'bootStamp("render")');
    expectOrdered(branch, [
      "<App />",
      "await applySavedWindowZoom();",
      "await presentWindow();",
    ]);
  });

  it("Tauri presentation still composes the post-zoom DOM geometry before native reveal", () => {
    const install = readFileSync(resolve(SRC, "framework/tauri/install.ts"), "utf8");
    const present = region(
      install,
      "export function presentTauriWindow()",
      "/**\n * 오버레이 히트테스트 게이트",
    );
    expectOrdered(present, [
      "await waitForPublicTitlebar()",
      "await composeTitlebarComposition()",
      'invoke<{ presented: boolean; headless?: boolean }>("window_startup_present"',
    ]);
  });
});
