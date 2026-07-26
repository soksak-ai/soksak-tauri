// 정체성 어휘 판정의 계약 — 형태소 규칙이라 변형을 놓치지 않는다(정확일치 금지표의 헛점이
// 실사고였다: data-pane-id 를 지웠더니 data-panel/data-divider 계열이 남아 오염이 계속됐다).
import { describe, expect, it } from "vitest";
import { bannedDomName, domNameTokens } from "./identityVocabulary.js";

describe("identityVocabulary — 삭제어 형태소 판정", () => {
  it("변형을 포함해 잡는다 — 하이픈·캐멀 어느 표기든", () => {
    for (const bad of [
      "data-panel",
      "data-panel-id",
      "my-divider-line",
      "eGroupHost",
      "tabSlot",
      "cellBody",
      "grid-area",
      "bodywrap",
    ]) {
      expect(bannedDomName(bad), bad).not.toBeNull();
    }
  });

  it("정본 어휘와 부분 문자열 유사어는 통과한다 — 형태소 단위라 오탐이 없다", () => {
    for (const good of [
      "data-pane",
      "data-tab-id",
      "pane-gutter",
      "data-gutter",
      "space-body",
      "grouping-x", // "group" 토큰이 아니라 "grouping" — 형태소 불일치
      "cellar", // "cell" 아님
    ]) {
      expect(bannedDomName(good), good).toBeNull();
    }
  });

  it("토큰화는 경계를 정확히 가른다", () => {
    expect(domNameTokens("data-paneId")).toEqual(["data", "pane", "id"]);
    expect(domNameTokens("eGroupHost")).toEqual(["e", "group", "host"]);
  });
});
