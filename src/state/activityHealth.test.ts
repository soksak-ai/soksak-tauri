// 발행은 조용히 죽지 않는다 — 기계가 한 번 물어보면 알 수 있어야 한다.
//
// 실측(2026-07-31): 활동 허브 발행이 16:54:27 에 끊겼는데 앱은 멀쩡히 명령에 답하고 있었다.
// 원장에 아무것도 안 쌓이는 것을 사람이 두 번 조회해 시각을 비교하고서야 알았다 — 그건
// 진단이 아니라 수작업이다. 발행 자리는 `.catch(() => {})` 로 실패를 통째로 삼키고 있었고,
// 삼킨 실패는 세어지지도 않았다.
//
// 라이브 동작을 막지 않는 것과 사실을 안 남기는 것은 다르다. 막지 않되 **센다**.
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("활동 발행 건강 — 조용한 실패 금지", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("성공은 마지막 성공 시각을 남긴다", async () => {
    const m = await import("./activityHealth");
    // 오라클 생존 — 처음부터 성공으로 보이면 이 검사는 아무것도 판정하지 못한다.
    expect(m.activityHealth().ok).toBe(0);
    expect(m.activityHealth().healthy).toBe(false);

    m.notePublish(true, 1000);

    const h = m.activityHealth();
    expect(h.ok).toBe(1);
    expect(h.lastOkAt).toBe(1000);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.healthy).toBe(true);
  });

  it("실패는 연속 실패 수와 사유를 남긴다", async () => {
    const m = await import("./activityHealth");
    m.notePublish(true, 1000);
    m.notePublish(false, 2000, "소켓 없음");
    m.notePublish(false, 3000, "소켓 없음");

    const h = m.activityHealth();
    expect(h.failed).toBe(2);
    expect(h.consecutiveFailures).toBe(2);
    expect(h.lastError).toBe("소켓 없음");
    // 연속 실패가 쌓이면 건강하지 않다 — "마지막에 한 번 성공했다"는 근거가 되지 못한다.
    expect(h.healthy).toBe(false);
  });

  it("다시 성공하면 연속 실패가 걷힌다", async () => {
    const m = await import("./activityHealth");
    m.notePublish(false, 1000, "x");
    m.notePublish(false, 2000, "x");
    m.notePublish(true, 3000);

    const h = m.activityHealth();
    expect(h.consecutiveFailures).toBe(0);
    expect(h.healthy).toBe(true);
    // 지난 실패는 지워지지 않는다 — 회복은 사실을 덮지 않는다.
    expect(h.failed).toBe(2);
  });

  it("도장 없는 응답은 성공이 아니다 — resolve 는 적재의 증거가 아니다", async () => {
    const m = await import("./activityHealth");
    // 허브는 적재하면 도장(seq)을 찍어 돌려준다. 도장이 없으면 발행은 갔는데 원장에 안 남은
    // 것이다 — 실측(2026-07-31): 발행이 resolve 해서 성공으로 세어지는 동안 원장은 정지해
    // 있었고, 앱 안에서는 그 사실을 알 길이 없었다.
    expect(m.stampOf({ seq: 7, ts: 1 })).toBe(7);
    expect(m.stampOf({ ok: true })).toBeNull();
    expect(m.stampOf(null)).toBeNull();
    expect(m.stampOf({ seq: "7" })).toBeNull();
  });

  it("답한 원장이 바뀌면 그 사실을 남긴다", async () => {
    const m = await import("./activityHealth");
    // 두 원장이 각자 단조 증가하면 seq 만으로는 둘 다 정상으로 보인다 — 자기가 어느 원장에
    // 쓰는지는 원장이 이름을 대야 안다(실측 2026-07-31: 앱 도장 2068, 허브 원장 84810 인데
    // 앱은 아무 이상도 감지하지 못했다).
    m.notePublish(true, 1000, undefined, 10, "/home/a/data/soksak.db");
    expect(m.activityHealth().ledgerSwitches).toBe(0);
    expect(m.activityHealth().ledger).toBe("/home/a/data/soksak.db");

    m.notePublish(true, 2000, undefined, 11, "/home/b/data/soksak.db");

    const h = m.activityHealth();
    expect(h.ledgerSwitches).toBe(1);
    expect(h.ledger).toBe("/home/b/data/soksak.db");
    expect(h.healthy).toBe(false);
  });

  it("원장 이름이 없는 도장은 미확인이다", async () => {
    const m = await import("./activityHealth");
    m.notePublish(true, 1000, undefined, 10);
    // 이름을 안 준 허브는 대조할 수 없다 — 없는 것을 같다고 세면 갈림이 영영 안 보인다.
    expect(m.activityHealth().ledger).toBe("");
    expect(m.activityHealth().unnamedLedger).toBe(1);
  });

  it("건강 상태는 갈아끼워도 사라지지 않는다", async () => {
    const first = await import("./activityHealth");
    first.notePublish(true, 1000);
    vi.resetModules();
    const second = await import("./activityHealth");
    expect(second).not.toBe(first);
    expect(second.activityHealth().ok).toBe(1);
  });
});
