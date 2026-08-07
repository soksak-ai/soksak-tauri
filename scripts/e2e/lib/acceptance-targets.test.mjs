// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_FRAMEWORKS } from "./browser-gate-identity.mjs";
import { acceptanceTargetsIn } from "./acceptance-targets.mjs";

const MAKEFILE = readFileSync(new URL("../../../Makefile", import.meta.url), "utf8");

// 규칙 — 인수가 세는 프레임워크마다 그것을 재는 자리가 있어야 한다.
//
// 인수 합계는 BROWSER_ACCEPTANCE_FRAMEWORKS 를 전부 센다(2 × 36 = 72). 그런데 그것을 재는
// Makefile 타깃은 Tauri 하나뿐이었다 — Electron 36칸은 하니스가 못 재서가 아니라 **부를 자리가
// 없어서** 영원히 missing 이었다. 세는 축과 재는 자리가 갈리면 인수는 달성 불가능한 채로
// 조용히 red 를 낸다.
describe("인수 대상마다 실행 자리가 있다", () => {
  it("세는 프레임워크와 실행 타깃이 같은 집합이다", () => {
    expect(acceptanceTargetsIn(MAKEFILE).sort())
      .toEqual([...BROWSER_ACCEPTANCE_FRAMEWORKS].sort());
  });

  it("타깃 이름은 프레임워크 이름에서 파생한다 — 손으로 적은 목록을 읽지 않는다", () => {
    for (const framework of BROWSER_ACCEPTANCE_FRAMEWORKS) {
      expect(MAKEFILE).toContain(`e2e-browser-acceptance-${framework}:`);
    }
  });
});

// 선언만 있고 실체가 없으면 그것도 거짓말이다.
describe("인수 타깃이 부르는 자리는 실재한다", () => {
  it("넘기는 실행물 변수와 재시작 타깃이 Makefile 에 선언돼 있다", () => {
    const declared = new Set(
      [...MAKEFILE.matchAll(/^([A-Za-z0-9_-]+)\s*[:?]?=/gm)].map(([, name]) => name),
    );
    const targets = new Set(
      [...MAKEFILE.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map(([, name]) => name),
    );
    const missing = [];
    for (const [, variable] of MAKEFILE.matchAll(/ACCEPTANCE_EXECUTABLE="\$\(([A-Za-z0-9_]+)\)"/g)) {
      if (!declared.has(variable)) missing.push(`변수 ${variable}`);
    }
    for (const [, restart] of MAKEFILE.matchAll(/ACCEPTANCE_RESTART=([A-Za-z0-9_-]+)/g)) {
      if (!targets.has(restart)) missing.push(`타깃 ${restart}`);
    }
    expect(missing).toEqual([]);
  });
});

// 판정이 무엇을 재는지 모른 채 답을 내면 그 답은 거짓이다.
//
// 실측 2026-08-08: Electron 인수를 돌렸는데 소켓을 Tauri 가 쥐고 있어 하니스가 Tauri 에 물었고,
// 열 칸이 green 으로 찍혔지만 보고서 신원은 `framework: tauri` 였다.
describe("인수 실행은 자기가 무엇을 재는지 지목한다", () => {
  it("프레임워크 타깃마다 자기 이름을 넘긴다", () => {
    for (const framework of BROWSER_ACCEPTANCE_FRAMEWORKS) {
      expect(MAKEFILE).toContain(`ACCEPTANCE_FRAMEWORK=${framework}`);
    }
  });

  it("몸통이 그 이름을 두 실행기에 넘긴다", () => {
    const passes = [...MAKEFILE.matchAll(/BROWSER_TARGET_FRAMEWORK="\$\(ACCEPTANCE_FRAMEWORK\)"/g)];
    expect(passes.length).toBeGreaterThanOrEqual(2);
  });
});
