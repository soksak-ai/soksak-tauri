import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

test("strategy documents describe product decisions without external provenance", () => {
  const english = readFileSync(join(root, "docs/multiplatform-engine-strategy.md"), "utf8");
  const korean = readFileSync(join(root, "docs/multiplatform-engine-strategy.ko.md"), "utf8");
  const forbidden = [
    /research agents/i,
    /Elanis repo/i,
    /tauri fork/i,
    /track upstream/i,
    /upstream WKWebView/i,
    /근거 1차 소스/,
    /업스트림 릭 픽스/,
    /tauri 7-crate 포크/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(english), false, `English retains external provenance: ${pattern}`);
    assert.equal(pattern.test(korean), false, `Korean retains external provenance: ${pattern}`);
  }
});
