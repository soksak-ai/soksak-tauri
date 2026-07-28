// 활동 백필 — 과거를 한 번 채우고 라이브 구독으로 잇는다.
//
// 백필은 **편의**이고 구독이 본체다. 백필이 없어도 피드는 그 순간부터 정확히 자란다. 그래서
// 백필 실패는 부팅을 막을 이유가 되지 못한다 — 던지면 부팅 경로에 unhandledrejection 이 남고,
// 그 한 줄이 원장을 오류로 물들여 진짜 결함을 가린다(실측 2026-07-28).
//
// 그렇다고 삼키지도 않는다. 삼키면 "백필이 왜 비었는가"가 영영 안 보이고, 없는 것과 실패한
// 것이 같은 값이 되어 다음 사람이 그 자리를 다시 조사한다. 사유를 그대로 남긴다 — 프레임워크가
// 거절할 때 왜 거절하는지를 표에 적어 두었으므로(cored 의 UNSERVED), 그 문장이 곧 답이다.

/** 백필 한 번. 실패해도 던지지 않고 빈 피드를 돌려준다. */
export async function backfillFeed<T>(
  load: () => Promise<T[]>,
  note: (reason: string) => void,
): Promise<T[]> {
  try {
    const entries = await load();
    if (!Array.isArray(entries)) {
      note(`활동 백필을 건너뛴다 — 배열이 아닌 답: ${JSON.stringify(entries)?.slice(0, 200)}`);
      return [];
    }
    return entries;
  } catch (e) {
    note(`활동 백필을 건너뛴다 — ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
