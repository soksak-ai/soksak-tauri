// 활동 백필 — 없으면 없는 대로 시작한다.
//
// 오케스트레이터는 부팅에서 activity_recent 로 과거를 채우고 그다음 라이브 구독으로 잇는다.
// 백필은 **편의**이고 구독이 본체다 — 백필이 없어도 피드는 그 순간부터 정확히 자란다.
//
// 실측(2026-07-28, Electron 라이브 활동 원장): 그 호출이 거절되자 unhandledrejection 이 났다.
// 거절 자체는 옳다(링버퍼는 앱 프로세스의 것이라 이 프로세스가 답할 수 없고, 그 사유가 표에
// 적혀 있다). 틀린 것은 호출자가 그 답을 받지 못한 것이다.
//
// 삼키면 안 된다. 삼키면 "백필이 왜 비었는가"가 영영 안 보인다 — 없는 것과 실패한 것을 같은
// 값으로 만들면 다음 사람이 그 자리를 다시 조사한다. 그래서 빈 피드로 시작하되 사유는 남긴다.
import { describe, expect, it } from "vitest";
import { backfillFeed } from "./activityBackfill";

describe("활동 백필", () => {
  it("답이 오면 그대로 채운다", async () => {
    const entries = [{ seq: 1 }, { seq: 2 }];
    const noted: string[] = [];
    const out = await backfillFeed(async () => entries, (m) => noted.push(m));
    expect(out).toBe(entries);
    expect(noted).toEqual([]);
  });

  it("거절이면 빈 피드로 시작하고 사유를 남긴다", async () => {
    const noted: string[] = [];
    const out = await backfillFeed(
      async () => {
        throw new Error("activity_recent 은(는) 이 프로세스가 서빙하지 않습니다 — 링버퍼는…");
      },
      (m) => noted.push(m),
    );
    expect(out).toEqual([]);
    expect(noted).toHaveLength(1);
    // 사유가 그대로 실린다 — 요약하면 표에 적어 둔 근거가 지워진다.
    expect(noted[0]).toContain("activity_recent");
    expect(noted[0]).toContain("링버퍼");
  });

  // 던지지 않는 것이 요점이다 — 던지면 부팅 경로에 unhandledrejection 이 남는다.
  it("어떤 실패에도 던지지 않는다", async () => {
    await expect(
      backfillFeed(async () => {
        throw new Error("무엇이든");
      }, () => {}),
    ).resolves.toEqual([]);
  });

  it("배열이 아닌 답도 빈 피드다 — 모양이 다른 답을 그대로 싣지 않는다", async () => {
    const noted: string[] = [];
    const out = await backfillFeed(async () => ({ nope: true }) as never, (m) => noted.push(m));
    expect(out).toEqual([]);
    expect(noted).toHaveLength(1);
  });
});
