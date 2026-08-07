// @vitest-environment node
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
