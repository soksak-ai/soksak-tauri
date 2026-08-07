// 인수는 프레임워크마다 자기 36칸을 요구한다(BROWSER_ACCEPTANCE_FRAMEWORKS).
//
// 한 저장소가 여러 프레임워크의 실행을 담으므로, 최신 실행 하나만 읽으면 나중에 돈 프레임워크가
// 먼저 돈 프레임워크의 기여를 덮는다 — 이미 잰 칸이 인수에 실리지 않는다. 프레임워크마다
// 자기 최신 실행을 하나씩 고른다.
//
// 순서의 근거는 부르는 쪽이 준다. 보고서는 자기가 언제 끝났는지 아직 안 적으므로(identity 는
// framework·platform·buildId·runId 뿐), 여기서 그 값을 지어내지 않는다.

/**
 * 실행 목록에서 프레임워크마다 가장 최근 실행을 하나씩 고른다.
 *
 * @param {readonly {report: object, orderedAtUnixMs: number}[]} entries
 *   `orderedAtUnixMs` 는 부르는 쪽이 아는 순서 근거다(지금 소비처는 run 디렉터리 mtime).
 * @returns {object[]} 프레임워크당 보고서 하나씩, 프레임워크 이름 순
 */
export function latestReportPerFramework(entries) {
  const newest = new Map();
  for (const entry of entries ?? []) {
    const framework = entry?.report?.identity?.framework;
    if (typeof framework !== "string" || framework.length === 0) continue;
    // 못 읽은 순서를 0 으로 읽으면 옛 기여가 새 기여를 덮고, 그 덮음은 오류 없이 조용하다.
    const orderedAtUnixMs = Number(entry?.orderedAtUnixMs);
    if (!Number.isFinite(orderedAtUnixMs)) continue;
    const held = newest.get(framework);
    if (held && held.orderedAtUnixMs >= orderedAtUnixMs) continue;
    newest.set(framework, { report: entry.report, orderedAtUnixMs });
  }
  return [...newest.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, held]) => held.report);
}
