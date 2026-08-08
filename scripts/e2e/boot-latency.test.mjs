// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bootLatencyVerdict } from "./lib/boot-latency.mjs";

// 규칙 — 앱이 명령에 답하기까지 걸리는 시간에 기준이 있다.
//
// 기준이 없으면 느려져도 아무도 모른다. 실측 2026-08-08: 앱을 띄우고 명령이 열리기까지
// 10.8 초였는데 그 사실을 재는 자리가 없어 조용히 지나갔다 — 사용자는 앱 켤 때마다 그 10 초를
// 겪는다.
//
// 기준은 0.1 초다. 지금 그 기준을 못 맞추므로 이 판정은 RED 다. 기준을 낮추지 않는다.
describe("부팅 응답 지연", () => {
  it("기준 안이면 green 이다", () => {
    const verdict = bootLatencyVerdict({ startedAtUnixMs: 1_000, respondedAtUnixMs: 1_080 });
    expect(verdict.status).toBe("green");
    expect(verdict.elapsedMs).toBe(80);
  });

  it("기준을 넘으면 red 다 — 잰 값과 기준을 함께 낸다", () => {
    const verdict = bootLatencyVerdict({ startedAtUnixMs: 1_000, respondedAtUnixMs: 11_800 });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("boot-latency=10800ms/100ms");
  });

  // 못 잰 것과 느린 것은 다른 답이다.
  it("응답 시각을 못 읽으면 못 잼이다", () => {
    const verdict = bootLatencyVerdict({ startedAtUnixMs: 1_000, respondedAtUnixMs: null });
    expect(verdict.status).toBe("blocked");
    expect(verdict.reason).toContain("respondedAtUnixMs");
  });

  it("단계 원장이 있으면 어느 단계가 느린지 이름으로 낸다", () => {
    const verdict = bootLatencyVerdict({
      startedAtUnixMs: 1_000,
      respondedAtUnixMs: 11_800,
      steps: [
        { step: "setup", atUnixMs: 1_280 },
        { step: "executor:catalog-registered", atUnixMs: 11_700 },
      ],
    });
    expect(verdict.evidence.some((row) => row.includes("executor:catalog-registered"))).toBe(true);
  });
});
