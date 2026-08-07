// @vitest-environment node
import { describe, expect, it } from "vitest";
import { REBUILT_BY_THIS_RUN, judgeHeadroom } from "./evidence-headroom.mjs";

describe("증거를 담을 자리를 먼저 답한다", () => {
  it("자리가 있으면 통과한다", () => {
    expect(judgeHeadroom({ freeGib: 8, needGib: 5, phase: "before-run" }).ok).toBe(true);
  });

  it("모자라면 잰 값과 필요한 값과 시점을 이름으로 답한다", () => {
    const verdict = judgeHeadroom({ freeGib: 2, needGib: 5, phase: "before-build" });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("2GiB");
    expect(verdict.message).toContain("5GiB");
    expect(verdict.message).toContain("before-build");
  });

  // 못 읽음을 넉넉함으로 읽으면, 못 잰 실행이 통과한 실행과 같은 답을 낸다.
  it("여유를 못 읽었으면 통과가 아니라 거절이다", () => {
    for (const unreadable of [Number.NaN, undefined, null, "많음"]) {
      expect(judgeHeadroom({ freeGib: unreadable, needGib: 5, phase: "before-run" }).ok).toBe(false);
    }
  });

  // 실측 2026-08-07: 안내대로 target/debug 를 지웠더니 인수 타깃이 첫 단계에서 그대로 다시
  // 빌드해 3.8GiB 를 도로 먹었다 — 비운 게 아니라 같은 자리를 더 오래 쓴 것이다.
  it("회수 안내는 이 실행이 곧 다시 만드는 자리를 가리키지 않는다", () => {
    const { message } = judgeHeadroom({ freeGib: 1, needGib: 5, phase: "before-build" });
    for (const rebuilt of REBUILT_BY_THIS_RUN) {
      expect(message).not.toContain(rebuilt);
    }
  });

  it("회수 안내를 비워 두지 않는다 — 거절은 갈 곳을 함께 준다", () => {
    const { message } = judgeHeadroom({ freeGib: 1, needGib: 5, phase: "before-build" });
    expect(message).toContain("~/.soksak-e2e/evidence");
  });
});
