// @vitest-environment jsdom
// 테마는 코어의 사실이다 — 자식 realm 도 그것을 받아야 한다.
//
// 콘텐츠가 네이티브 자식 웹뷰로 사는 뷰는 자기 문서에서 돈다. 그 문서에는 앱의 스타일시트가
// 없으므로 `:root` 의 테마 변수도 없다. 그런데 그 안에서 그리는 공용 툴바(kit)는
// `color: var(--fg)` 로 색을 정한다.
//
// 실측 2026-08-08: 브라우저 세 종이 **같은 kit** 을 쓰는데 하나만 글자가 검정이었다
// (`rgb(0,0,0)` 대 `rgb(221,221,221)`). 변수는 세 realm 어디에도 없었고, 색은 각 플러그인이
// 자기 스타일시트에 넣은 **폴백**(`var(--fg, #ddd)`)에서 나오고 있었다. 그 폴백을 안 넣은
// 하나가 검정이 됐다. 값 하나가 세 자리에 흩어져 있었고 한 자리가 비어 있었다.
//
// 고칠 자리는 폴백이 아니라 **변수가 안 건너간다**는 것이다. 건네는 순간 폴백은 죽은 경로가
// 된다(그 제거는 kit·플러그인 저장소의 일이다).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { themeCustomProperties } from "./pluginViewTheme";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

describe("자식 realm 은 테마를 받는다", () => {
  it("계약이 테마를 싣는다", () => {
    expect(read("./pluginViewProtocol.ts")).toMatch(/theme:\s*Record<string, string>/);
  });

  it("보내는 쪽이 채운다", () => {
    expect(read("./pluginViewPresentation.ts")).toContain("themeCustomProperties(");
  });

  it("받는 쪽이 자기 문서에 건다", () => {
    const renderer = read("./pluginViewRenderer.ts");
    // 거는 방법은 한 자리가 든다(applyTheme) — 렌더러가 다시 적으면 두 벌이 된다.
    expect(renderer).toContain("applyTheme(document, init.theme)");
  });
});

describe("themeCustomProperties — 이름을 손으로 적지 않는다", () => {
  it("루트에 실제로 걸린 커스텀 속성을 그대로 모은다", () => {
    document.documentElement.style.setProperty("--fg", "#e6e6e6");
    document.documentElement.style.setProperty("--bg", "#1e1e1e");
    const out = themeCustomProperties(document);
    expect(out["--fg"]).toBe("#e6e6e6");
    expect(out["--bg"]).toBe("#1e1e1e");
  });

  it("커스텀 아닌 속성은 담지 않는다", () => {
    document.documentElement.style.setProperty("color", "red");
    expect(Object.keys(themeCustomProperties(document)).every((k) => k.startsWith("--"))).toBe(true);
  });

  // 못 읽은 것을 빈 것으로 답하면 realm 은 테마가 없는 줄 알고 자기 색을 지어낸다.
  it("읽을 수 없으면 빈 목록이 아니라 그 사실이 남는다", () => {
    expect(() => themeCustomProperties(undefined as unknown as Document)).toThrow();
  });
});
