// 정체성 어휘 판정의 계약 — 형태소 규칙이라 변형을 놓치지 않는다(정확일치 금지표의 헛점이
// 실사고였다: data-pane-id 를 지웠더니 data-panel/data-divider 계열이 남아 오염이 계속됐다).
import { describe, expect, it } from "vitest";
import { bannedDomName, domNameTokens, externalDomOwner } from "./identityVocabulary.js";

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

  it("외부 소유 이름은 판정 대상이 아니다 — 개명 권한이 우리에게 없다", () => {
    // 실물 근거(2026-07-27 플러그인 census): Tailwind·cmdk·shadcn 을 쓰는 플러그인의
    // 소스에 이 이름들이 리터럴로 실린다 — 금지하면 그 생태계를 통째로 쓸 수 없다.
    for (const ext of ["grid", "grid-cols-2", "grid-rows-4", "group", "group-hover", "cmdk-group", "cmdk-group-heading", "data-slot"]) {
      expect(externalDomOwner(ext), ext).not.toBeNull();
      expect(bannedDomName(ext), ext).toBeNull();
    }
  });

  it("외부 소유 표는 소유권 기록이지 면제 창구가 아니다 — 자체 복합 명명은 그대로 잡는다", () => {
    // grid-cols-N 은 Tailwind 문법이지만 truncate-grid·canvas-frame 류 자체 명명은 아니다.
    for (const bad of ["data-truncate-grid", "canvas-frame", "grid-cols-x", "grid-area", "my-group", "cmdkGroup", "data-slot-id"]) {
      expect(externalDomOwner(bad), bad).toBeNull();
      expect(bannedDomName(bad), bad).not.toBeNull();
    }
  });
});
