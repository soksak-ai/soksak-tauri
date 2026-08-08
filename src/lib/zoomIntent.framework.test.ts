// @vitest-environment node
// 창 줌은 프레임워크가 채운다 — 코어가 한쪽의 명령 이름을 직접 부르지 않는다.
//
// 실측 2026-08-08: 부팅 때마다 Electron 창의 활동 피드에 이 거절이 떴다.
//
//   reject: 확대 배율: 렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를
//   건널 이유가 사라졌다
//
// `applyWindowZoom` 이 `invoke("webview_zoom")` 을 직접 불렀기 때문이다. 그 이름은 콘텐츠가
// 네이티브 자식 웹뷰로 사는 프레임워크의 것이고, 콘텐츠가 DOM 안에 사는 쪽에는 그런 자리가
// 없다. 한쪽의 구현 이름을 코어가 부르면 다른 쪽은 부팅마다 거절을 낸다.
//
// 계약에 축을 세우고 각 어댑터가 자기 방식으로 채운다(`presentWindow` 와 같은 모양).
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** 프레임워크 폴더 밖에서 이 이름을 부르는 자리. */
function callersOutsideFrameworks(name: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel === "src/framework") continue; // 프레임워크의 구현이 사는 자리
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(ROOT, rel), "utf8");
      if (new RegExp(`invoke\\(\\s*"${name}"`).test(source)) hits.push(rel);
    }
  };
  walk("src");
  return hits;
}

describe("창 줌은 계약이 정하고 어댑터가 채운다", () => {
  it("계약에 창 줌 축이 있다", () => {
    expect(read("src/framework/contract.ts")).toMatch(/setWindowZoom\s*\(/);
  });

  it("두 어댑터가 그 축을 채운다 — 하나만 채우면 다른 쪽이 부팅마다 거절한다", () => {
    expect(read("src/framework/tauri/index.ts")).toContain("setWindowZoom");
    expect(read("src/framework/electron/index.ts")).toContain("setWindowZoom");
  });

  it("코어는 프레임워크의 명령 이름을 직접 부르지 않는다", () => {
    expect(
      callersOutsideFrameworks("webview_zoom"),
      "한쪽의 구현 이름을 코어가 부른다 — 다른 쪽에는 그 자리가 없다",
    ).toEqual([]);
  });
});
