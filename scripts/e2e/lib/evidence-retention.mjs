// 한도를 지키는 것은 회수의 일이지 판정의 일이 아니다.
//
// 저장소는 전체 한도를 든다. 그 한도는 옳다 — 넘으면 파일시스템이 먼저 차서 제품과 무관한 red 가
// 남는다. 그런데 지난 실행을 아무도 회수하지 않으면 언젠가 **모든** 실행이 잴 자리를 못 얻는다.
// 실측 2026-08-08: 36칸 중 15칸이 "증거 저장소 전체 2GiB hard cap 초과" 로 blocked 였다 —
// 제품과 무관한 이유로 판정면의 절반이 닫혔다.
//
// 한도를 낮추지 않는다. 자리를 만든다.

/**
 * 새 실행이 잴 자리를 만들기 위해 회수할 지난 실행의 이름.
 *
 * 오래된 것부터 회수한다. 가장 최근 실행과 지켜야 할 이름은 남긴다 — 되짚을 근거까지 지우면
 * 자리는 생겨도 그 판을 다시 읽을 수 없다. 순서를 못 읽은 실행은 회수 대상이 아니다(못 읽음을
 * "가장 오래됨" 으로 읽으면 최신 기여가 먼저 사라진다).
 *
 * @param {{runs: readonly {runId: string, bytes: number, finishedAtUnixMs: number}[],
 *          storeLimitBytes: number, needBytes: number, keep?: readonly string[]}} input
 * @returns {string[]} 회수 순서대로
 */
export function runsToReclaim({ runs, storeLimitBytes, needBytes, keep = [] }) {
  const rows = [...(runs ?? [])];
  const held = new Set(keep);
  const total = rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);
  let free = Number(storeLimitBytes) - total;
  if (!Number.isFinite(free) || free >= Number(needBytes)) return [];

  // 최신 하나는 언제나 남긴다 — 순서를 읽을 수 있는 것 중에서 고른다.
  const ordered = rows
    .filter((row) => Number.isFinite(Number(row.finishedAtUnixMs)))
    .sort((left, right) => Number(left.finishedAtUnixMs) - Number(right.finishedAtUnixMs));
  const newest = ordered[ordered.length - 1];
  if (newest) held.add(newest.runId);

  const reclaim = [];
  for (const row of ordered) {
    if (free >= Number(needBytes)) break;
    if (held.has(row.runId)) continue;
    reclaim.push(row.runId);
    free += Number(row.bytes ?? 0);
  }
  return reclaim;
}
