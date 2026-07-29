// @vitest-environment node
// 창 자리·포커스·라벨 판정 — **두 구현이 같은 답을 낸다.**
//
// 창을 만드는 일은 프레임워크의 것이라 구현이 둘이다. 하지만 **무엇을 만들지** 정하는 규칙이
// 갈리면 라벨 모양이 어긋나 두 프레임워크의 복원 manifest 가 서로를 못 읽고, rect 판정이
// 갈리면 같은 복원이 한쪽에서만 자리를 지킨다.
//
// 같은 픽스처가 묶는다 — 이 파일과 코어의 window_spec 검사가 같은 JSON 하나를 읽는다.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { rectOf, shouldFocus, isWorkspace } = requireCjs(join(ROOT, "frameworks/electron/native/window.cjs"));
const doc = JSON.parse(
  readFileSync(join(ROOT, "crates/soksak-core/fixtures/window-rect.json"), "utf8"),
);

describe("창 생성 규칙 — 코어와 같은 답", () => {
  it("픽스처가 비어 있지 않다 — 비면 이 검사는 아무것도 안 지키면서 통과한다", () => {
    expect(doc.rect.length + doc.focus.length + doc.workspaceLabel.length).toBeGreaterThan(0);
  });

  for (const c of doc.rect) {
    it(`rect: ${c.why}`, () => expect(rectOf(c.in)).toEqual(c.out));
  }
  for (const c of doc.focus) {
    it(`focus: ${c.why}`, () => expect(shouldFocus(c.in ?? undefined)).toBe(c.out));
  }
  for (const c of doc.workspaceLabel) {
    it(`label: ${c.why}`, () => expect(isWorkspace(c.in)).toBe(c.out));
  }
});
