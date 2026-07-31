// 부팅 단계는 어느 창의 것인지 말한다 — 창이 둘일 때 원장이 가리지 못하면 진단이 멈춘다.
//
// 실측(2026-08-01): 백지 창을 진단하는데 `painted` 가 둘 있었고 둘 다 창을 안 실었다. 그래서
// "둘 다 그렸다고 말했다"까지만 알고, 어느 쪽이 거짓말인지 못 갈랐다.
import { describe, it, expect, vi } from "vitest";
import { bootFactPayload } from "./bootFact";

vi.mock("./webviewLabels", () => ({ currentWindowLabel: () => "w-test" }));

describe("boot.step payload", () => {
  it("창을 싣는다", () => {
    expect(bootFactPayload("painted").window).toBe("w-test");
  });

  it("step 과 message 를 함께 싣는다 — 사람이 읽는 줄과 기계가 읽는 필드가 같은 사실이다", () => {
    const p = bootFactPayload("boot:done");
    expect(p.step).toBe("boot:done");
    expect(p.message).toBe("· boot boot:done");
  });

  it("단계 고유 사실을 함께 실을 수 있다", () => {
    expect(bootFactPayload("plugin-activate", { ms: 120 }).ms).toBe(120);
  });

  it("extra 는 step·window 를 덮어쓰지 못한다", () => {
    // 덮어쓸 수 있으면 같은 이름의 필드가 발행 자리마다 다른 뜻이 된다.
    const p = bootFactPayload("real", { step: "fake", window: "w-fake" });
    expect(p.step).toBe("real");
    expect(p.window).toBe("w-test");
  });
});
