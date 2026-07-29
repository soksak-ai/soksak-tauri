// @vitest-environment node
// 색·URL 판정 — **두 구현이 같은 답을 낸다.**
//
// 값이 쓸 수 있는지 정하는 일은 프레임워크의 것이 아니다. 갈리면 색은 "테마가 이쪽에서만
// 안 먹는다"로, URL 은 더 나쁘게 — **한쪽만 막던 스킴을 다른 쪽이 연다**로 나타난다.
//
// 같은 픽스처가 묶는다: 이 파일과 코어의 surface_spec 검사가 같은 JSON 하나를 읽는다.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { parseHexColor } = requireCjs(join(ROOT, "electron/native/window.cjs"));
const { isOpenableUrl } = requireCjs(join(ROOT, "electron/native/webview.cjs"));
const doc = JSON.parse(
  readFileSync(join(ROOT, "crates/soksak-core/fixtures/surface-spec.json"), "utf8"),
);

/** 코어는 RGB 숫자로, 프레임워크는 그 프레임워크가 받는 문자열로 답한다 — 값은 같아야 한다. */
const asHex = (o) =>
  o === null
    ? null
    : `#${[o.r, o.g, o.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

describe("표면 값 규칙 — 코어와 같은 답", () => {
  it("픽스처가 비어 있지 않다 — 비면 이 검사는 아무것도 안 지키면서 통과한다", () => {
    expect(doc.color.length + doc.url.length).toBeGreaterThan(0);
  });

  for (const c of doc.color) {
    it(`color: ${c.why}`, () => expect(parseHexColor(c.in)).toBe(asHex(c.out)));
  }
  for (const c of doc.url) {
    it(`url: ${c.why}`, () => expect(isOpenableUrl(c.in)).toBe(c.out));
  }
});
