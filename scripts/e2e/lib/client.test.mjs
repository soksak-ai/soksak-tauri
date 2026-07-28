// 컨트롤 창 해소 — 잔재 창이 있어도 결정적이어야 한다.
//
// RED 근거(실측 2026-07-28): 굳은 잔재 창이 포커스 폴백을 점유하자 봉투 없는 window.list 가
// UNKNOWN_COMMAND 로 떨어졌고, 그 창을 회수하려는 도구가 **회수 대상 때문에** 못 돌았다.
// 회수는 회수 대상의 건강에 기대면 안 된다.

import { describe, expect, it } from "vitest";
import { CONTROL_LABEL, resolveControlWindow } from "./client.mjs";

/** 호출 기록을 남기는 rpc 대역. answers 는 (name, at) → 응답. */
function fakeRpc(answers) {
  const calls = [];
  const rpc = async (name, params = {}, at) => {
    calls.push({ name, at });
    return answers(name, at);
  };
  return { rpc, calls };
}

describe("resolveControlWindow", () => {
  it("예약 라벨이 서면 그것을 쓴다 — 폴백을 타지 않는다", async () => {
    const { rpc, calls } = fakeRpc((name, at) =>
      at === CONTROL_LABEL
        ? { ok: true, data: { labels: ["main", "w-1"] } }
        : { ok: false, code: "UNKNOWN_COMMAND" },
    );
    expect(await resolveControlWindow(rpc)).toBe(CONTROL_LABEL);
    // 봉투 없는 질의는 아예 나가지 않는다.
    expect(calls.every((c) => c.at === CONTROL_LABEL)).toBe(true);
  });

  /** 굳은 창이 폴백을 점유해도 해소는 성공해야 한다 — 그게 회수의 전제다. */
  it("잔재 창이 폴백을 점유해도 해소된다", async () => {
    const { rpc } = fakeRpc((name, at) => {
      if (at === CONTROL_LABEL) return { ok: true, data: { labels: ["main", "w-wedged"] } };
      return { ok: false, code: "UNKNOWN_COMMAND", window: "w-wedged" };
    });
    expect(await resolveControlWindow(rpc)).toBe(CONTROL_LABEL);
  });

  it("예약 라벨이 없는 토폴로지면 폴백 경로가 선다", async () => {
    const { rpc } = fakeRpc((name, at) =>
      at === CONTROL_LABEL
        ? { ok: false, code: "UNKNOWN_WINDOW" }
        : { ok: true, data: { labels: ["w-b", "w-a"] } },
    );
    // 정렬 첫 항목이 결정적 타겟이다.
    expect(await resolveControlWindow(rpc)).toBe("w-a");
  });

  /** 닫으려는 창 자신은 뺀다 — 자기 경유 close 는 회신이 유실된다. */
  it("exclude 된 창은 고르지 않는다", async () => {
    const { rpc } = fakeRpc((name, at) =>
      at === CONTROL_LABEL
        ? { ok: false, code: "UNKNOWN_WINDOW" }
        : { ok: true, data: { labels: ["w-a", "w-b"] } },
    );
    expect(await resolveControlWindow(rpc, "w-a")).toBe("w-b");
  });

  it("남는 창이 없으면 그 라벨을 그대로 쓴다 — 회신은 잃어도 닫힘은 성사된다", async () => {
    const { rpc } = fakeRpc((name, at) =>
      at === CONTROL_LABEL
        ? { ok: false, code: "UNKNOWN_WINDOW" }
        : { ok: true, data: { labels: ["w-only"] } },
    );
    expect(await resolveControlWindow(rpc, "w-only")).toBe("w-only");
  });

  it("후보가 하나도 없으면 사유를 달고 실패한다", async () => {
    const { rpc } = fakeRpc(() => ({ ok: false, code: "UNKNOWN_COMMAND" }));
    await expect(resolveControlWindow(rpc)).rejects.toThrow(/컨트롤 창 해소 실패/);
  });

  /** AMBIGUOUS_WINDOW 는 거절이 아니라 후보를 실은 답이다. */
  it("AMBIGUOUS_WINDOW 의 후보로도 해소된다", async () => {
    const { rpc } = fakeRpc((name, at) =>
      at === CONTROL_LABEL
        ? { ok: false, code: "UNKNOWN_WINDOW" }
        : { ok: false, code: "AMBIGUOUS_WINDOW", data: { candidates: ["w-z", "w-c"] } },
    );
    expect(await resolveControlWindow(rpc)).toBe("w-c");
  });
});
