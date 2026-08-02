// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("Tauri native-composition styles", () => {
  it("native content dim은 DOM filter 대신 같은 세기의 단일 veil을 쓴다", () => {
    expect(css).toMatch(/\.tab-body\[data-tauri-hole="content"\]\[data-dim\] \{[^}]*filter: none/);
    expect(css).toMatch(
      /\.tab-body\[data-tauri-hole="content"\]\[data-dim\]::after \{[^}]*background-color: rgb\(0 0 0 \/ var\(--dim\)\)/,
    );
  });

  it("private marker만 pane와 content 배경을 연다", () => {
    expect(css).toMatch(/:root\[data-pane-style="card"\] \.pane\[data-tauri-hole="pane"\]/);
    expect(css).toMatch(/\.tab-body\[data-tauri-hole="content"\] \{[^}]*background: transparent/);
    expect(css).not.toMatch(/\.hole\b/);
  });
});
