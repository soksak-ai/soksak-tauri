// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("Tauri native-composition styles", () => {
  it("조명은 코어 공통 평면의 책임이라 Tauri가 별도 dim veil을 중복하지 않는다", () => {
    expect(css).not.toMatch(/\[data-dim\]/);
    expect(css).not.toMatch(/brightness\(/);
  });

  it("private marker만 pane·frame·content 배경을 연다", () => {
    expect(css).toMatch(/:root\[data-pane-style="card"\] \.pane\[data-tauri-hole="pane"\]/);
    // 공용 DOM 본문 배경(:root[data-pane-style] .tab-body)보다 구체적이어야 실제 계산
    // 스타일이 투명해진다. !important로 덮지 않고 Tauri가 자기 marker의 소유권을 명시한다.
    expect(css).toMatch(
      /:root\[data-pane-style\] \[data-tauri-hole="content"\] \{[^}]*background: transparent/,
    );
    // 실제 슬롯의 투명만으로는 불충분하다. 그 조상 tab-body가 var(--bg)를 칠하면 아래의
    // WKWebView는 전부 검게 가려진다. frame marker가 그 공용 배경을 반드시 비워야 한다.
    expect(css).toMatch(
      /:root\[data-pane-style\] \.tab-body\[data-tauri-hole-frame\] \{[^}]*background: transparent/,
    );
    expect(css).not.toContain("!important");
    expect(css).not.toMatch(/\.hole\b/);
  });
});
