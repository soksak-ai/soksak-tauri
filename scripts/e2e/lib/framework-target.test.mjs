// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requireTargetFramework } from "./framework-target.mjs";

// 규칙 — 재려던 것과 답한 것이 같아야 그 판이 그 프레임워크의 판이다.
//
// 두 프레임워크가 한 홈을 쓰고 같은 cored 소켓을 나눈다. 그래서 Electron 을 띄우고 판정을
// 돌려도 소켓을 Tauri 가 쥐고 있으면 하니스가 Tauri 에 묻는다 — 실측 2026-08-08: Electron
// 인수를 돌렸는데 `pane-presentation-host=available`(Tauri 의 답)이 나왔고 보고서 신원도
// `framework: tauri` 였다. 그 판은 Electron 것이 아니다.
//
// 판정이 무엇을 재는지 모른 채 답을 내면 그 답은 거짓이다.
describe("requireTargetFramework", () => {
  it("재려던 것과 답한 것이 같으면 통과한다", () => {
    expect(requireTargetFramework("electron", "electron")).toBe("electron");
  });

  it("다르면 이름을 달고 멈춘다 — 다른 앱의 판을 그 프레임워크의 판으로 적지 않는다", () => {
    expect(() => requireTargetFramework("electron", "tauri"))
      .toThrow(/electron[\s\S]*tauri/);
  });

  // 지목이 없으면 무엇을 재는지 모르는 실행이다. 답한 것을 그대로 믿으면 그 실행은 자기가
  // 무엇을 쟀는지 모른 채 보고서를 쓴다.
  it("지목이 없으면 답한 것을 그대로 쓰되 그 사실을 숨기지 않는다", () => {
    expect(requireTargetFramework(undefined, "tauri")).toBe("tauri");
    expect(requireTargetFramework("", "electron")).toBe("electron");
  });

  it("아무도 답하지 않으면 통과가 아니다", () => {
    expect(() => requireTargetFramework("electron", "")).toThrow(/framework/);
    expect(() => requireTargetFramework(undefined, null)).toThrow(/framework/);
  });
});

// 규칙 — 재시작은 지목한 앱이 소켓을 쥐었을 때만 준비됐다고 답한다.
//
// `host_ready` 가 "창이 답하는가" 만 보면 다른 앱이 답해도 통과한다. 두 프레임워크가 한 홈의
// 소켓을 나누므로, 그 통과는 "내 앱이 준비됐다" 가 아니라 "누군가 답한다" 일 뿐이다 —
// 실측 2026-08-08: Electron 을 띄웠는데 Tauri 가 소켓을 쥔 채 판정이 끝까지 돌았다.
//
// 사람이 로그를 보고 가려내면 그건 기계 판정이 아니다. 재시작이 그 자리에서 세운다.
describe("재시작의 준비 판정", () => {
  const MAKEFILE = readFileSync(new URL("../../../Makefile", import.meta.url), "utf8");

  it("프레임워크별 재시작은 그 앱이 소켓을 쥐었는지 확인한다", () => {
    for (const target of ["restart-dev", "restart-electron"]) {
      const at = MAKEFILE.indexOf(`\n${target}:`);
      expect(at, target).toBeGreaterThan(-1);
      // 레시피는 탭으로 들여쓴 줄들이다 — 다음 타깃 선언 전까지가 그 자리다.
      const rest = MAKEFILE.slice(at + 1);
      const end = rest.search(/\n[A-Za-z][A-Za-z0-9_.-]*:/);
      const recipe = end === -1 ? rest : rest.slice(0, end);
      expect(recipe, target).toContain("framework.info");
    }
  });

  it("재시작마다 자기 프레임워크 이름을 들고 판정한다", () => {
    expect(MAKEFILE).toMatch(/restart-dev:[\s\S]*?RESTART_FRAMEWORK=tauri/);
    expect(MAKEFILE).toMatch(/restart-electron:[\s\S]*?RESTART_FRAMEWORK=electron/);
  });
});
