// @vitest-environment node
import { describe, expect, it } from "vitest";
import { recordResidue, scanCurrentRecord } from "./current-record-provenance.mjs";

describe("current record provenance", () => {
  it("finds former checkouts and implementation precedents", () => {
    const source = [
      "run <machine-path>/ai/cli/old-tool",
      "expected .claude/projects/-Users-max-proj",
      "검증 선례: 구 vtuber claudeCli.ts",
      "Based on xterm.js PR #5704, adapted as an external addon",
      "This is Meta's Astryx design system",
      "List the official Meta design docs",
    ].join("\n");
    expect(recordResidue(source).map((hit) => hit.name)).toEqual([
      "former checkout root",
      "encoded personal checkout",
      "predecessor implementation",
      "outside addon derivation",
      "outside design derivation",
      "outside design document",
    ]);
  });

  it("preserves legal attribution and provider wire facts", () => {
    const source = [
      "저작자: yejune — 라이선스: MIT",
      "프로젝트: https://github.com/yejune/xterm-addon-webkit-ime",
      "형태 출처: claude CLI --output-format stream-json",
      "WebKit bug: https://bugs.webkit.org/show_bug.cgi?id=274700",
      "This file declares the minimal Xterm 6 surface this app consumes.",
    ].join("\n");
    expect(recordResidue(source)).toEqual([]);
  });

  it("the tracked current record is self-contained", () => {
    expect(scanCurrentRecord()).toEqual([]);
  });

  it("does not describe the IME adapter as an external project", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL("../../src/vendor/xterm-addon-webkit-ime/VENDORED.md", import.meta.url), "utf8");
    expect(text).not.toMatch(/yejune|github\.com\/yejune|Vendored|벤더링|외부/iu);
  });
});
