// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPresentationArmLedger } from "./presentation-arm-ledger.mjs";

// 규칙 — 한 전이의 못 잼이 나머지 전이를 데려가지 않는다.
//
// 표시 궤적 무장은 첫 표시를 기다린다(Tauri FIRST_DISPLAY_TIMEOUT 1초). 그 안에 안 오면
// 그 전이는 못 잰 것이지 제품이 틀린 것이 아니다. 그런데 하니스가 그 자리에서 던져 엔진 실행
// 전체가 죽었고, 같은 실행이 재던 다른 칸까지 함께 사라졌다 — 실측 2026-08-07: browser-chromium
// 이 02-right 무장 실패로 12칸을 통째로 잃었다.
//
// 기록하고 계속 잰다. 판정은 모든 칸을 잰 뒤 마지막에 한 번 한다.
describe("표시 무장 원장", () => {
  it("무장 실패를 기록하고 실행을 잇는다", () => {
    const ledger = createPresentationArmLedger();
    ledger.recordFailure("02-right", { code: "INTERNAL", message: "baseline 없음" });
    expect(ledger.failures()).toEqual([
      '02-right: INTERNAL/"baseline 없음"',
    ]);
  });

  it("한 번도 실패하지 않았으면 빈 원장이다", () => {
    expect(createPresentationArmLedger().failures()).toEqual([]);
  });

  it("여러 전이의 실패를 순서대로 든다 — 하나가 나머지를 가리지 않는다", () => {
    const ledger = createPresentationArmLedger();
    ledger.recordFailure("02-right", { code: "INTERNAL", message: "a" });
    ledger.recordFailure("05-left", { code: "TIMEOUT", message: "b" });
    expect(ledger.failures()).toHaveLength(2);
  });

  // 못 잰 것은 red 가 아니다. 다만 통과도 아니다 — 이름을 달고 blocked 로 답한다.
  it("무장을 한 번이라도 놓친 실행은 그 축을 green 으로 답하지 않는다", () => {
    const ledger = createPresentationArmLedger();
    expect(ledger.unmeasured()).toEqual([]);
    ledger.recordFailure("02-right", { code: "INTERNAL", message: "baseline 없음" });
    expect(ledger.unmeasured()).toEqual([
      'presentation-arm: 02-right: INTERNAL/"baseline 없음"',
    ]);
  });

  it("이름 없는 실패도 이름을 짓는다 — 조용히 사라지지 않는다", () => {
    const ledger = createPresentationArmLedger();
    ledger.recordFailure("02-right", null);
    expect(ledger.failures()[0]).toContain("02-right");
  });
});
