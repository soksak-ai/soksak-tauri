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

test("product sources describe owned surfaces directly", () => {
  const sources = [
    "docs/DEPLOY.md",
    "docs/NAMING.md",
    "crates/soksak-core/src/themes.rs",
    "frameworks/tauri/src/fs.rs",
    "src/components/SettingsModal.tsx",
  ];
  const forbidden = [/third-party forks/i, /upstream project/i, /외부에서 만들어져/, /레퍼런스 마크업/];
  for (const relative of sources) {
    const body = readFileSync(join(root, relative), "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(body), false, `${relative} retains external provenance: ${pattern}`);
    }
  }
});
