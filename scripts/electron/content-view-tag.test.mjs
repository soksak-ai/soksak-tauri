// @vitest-environment node
// 콘텐츠 뷰가 실제로 설 수 있는가 — <webview> 태그는 기본으로 꺼져 있다.
//
// 앱의 콘텐츠 뷰 DOM 구현(src/lib/contentViews.ts)은 <webview> 요소로 선다. Electron 은 그
// 태그를 **기본으로 끈다**(webviewTag: false). 꺼진 채로 두면 요소는 만들어지지만 아무것도
// 그리지 않고 제어 메서드도 없다 — 그 실패는 예외가 아니라 **빈 사각형**으로 나타난다.
//
// 그래서 창을 만드는 자리가 이것을 켜야 하고, 그 사실을 여기서 못박는다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frameworks", "electron", "main.cjs");

describe("콘텐츠 뷰의 전제", () => {
  it("창은 <webview> 태그를 켜고 만든다", () => {
    const src = readFileSync(MAIN, "utf8");
    // 오라클 생존 — 파일을 못 읽었거나 창 생성이 사라졌으면 아래 단언이 공짜로 통과한다.
    expect(src).toContain("webPreferences");
    expect(src).toMatch(/webviewTag:\s*true/);
  });

  it("격리는 그대로다 — 태그를 켜는 것이 노드를 여는 것이 아니다", () => {
    const src = readFileSync(MAIN, "utf8");
    expect(src).toMatch(/contextIsolation:\s*true/);
    expect(src).toMatch(/nodeIntegration:\s*false/);
  });
});
