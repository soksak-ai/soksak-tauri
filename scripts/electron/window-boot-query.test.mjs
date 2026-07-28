// @vitest-environment node
// 새 창의 **부트 지시**가 창까지 간다.
//
// `window_create` 의 init 은 새 창이 무엇을 열지 말하는 쿼리다. 버리면 창은 뜨는데 안이 비고,
// 그 증상은 오류가 아니라 "창은 났는데 프로젝트가 없다"로 보인다 — 실측(2026-07-29):
// 멀티윈도우 하니스에서 두 창이 똑같이 빈 트리를 답했다.
//
// 앱은 같은 값을 conf url 의 쿼리로 얹는다. 두 프레임워크가 같은 자리에 실어야 프론트가
// 프레임워크를 가리지 않는다.

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const table = requireCjs(join(ROOT, "electron/native/window.cjs"));
const { bootQuery } = table;

/** 창 생성을 흉내내어 무엇이 넘어갔는지 남긴다. */
function ctxWith(seen) {
  return {
    labels: () => [],
    windowFor: () => null,
    createWindow: (label, rect, q) => {
      seen.push({ label, rect, q });
      return { focus: () => {}, isDestroyed: () => false };
    },
  };
}

describe("새 창의 부트 지시", () => {
  it("init 이 창까지 간다 — 버리면 창은 나고 안이 빈다", () => {
    const seen = [];
    table.window_create.answer(ctxWith(seen), { label: "w-1", init: "project=/p" });
    expect(seen).toHaveLength(1);
    expect(seen[0].q).toBe("project=/p");
  });

  it("앞의 물음표는 벗긴다 — 두 번 붙으면 URL 이 달라진다", () => {
    expect(bootQuery("?project=/p")).toBe("project=/p");
  });

  it("없으면 없음 — 빈 문자열을 얹으면 물음표 하나가 남아 URL 이 달라진다", () => {
    for (const empty of [undefined, null, "", "   ", "?"]) {
      expect(bootQuery(empty)).toBe(null);
    }
    const seen = [];
    table.window_create.answer(ctxWith(seen), { label: "w-2" });
    expect(seen[0].q).toBe(null);
  });
});
