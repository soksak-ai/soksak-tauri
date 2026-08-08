// 앱이 명령에 답하기까지 걸리는 시간에 기준이 있다.
//
// 기준이 없으면 느려져도 아무도 모른다. 실측 2026-08-08: 앱을 띄우고 명령이 열리기까지
// 10.8 초였는데 그 사실을 재는 자리가 없어 조용히 지나갔다 — 사용자는 앱 켤 때마다 그 10 초를
// 겪는다. Rust setup 은 0.28s, 프론트 부팅 단계는 0.06s 였다. 나머지가 통째로 계측 공백이었다.

/** 앱을 띄우고 명령이 열리기까지의 기준. 사람이 기다린다고 느끼지 않는 한계다. */
export const BOOT_LATENCY_BUDGET_MS = 100;

/**
 * 부팅 응답 지연을 판정한다.
 *
 * 못 잰 것과 느린 것은 다른 답이다 — 응답 시각을 못 읽으면 blocked 이고, 읽었는데 기준을
 * 넘으면 red 다. 단계 원장이 있으면 어느 단계가 느린지 이름으로 낸다.
 */
export function bootLatencyVerdict({ startedAtUnixMs, respondedAtUnixMs, steps = [] } = {}) {
  const started = typeof startedAtUnixMs === "number" ? startedAtUnixMs : Number.NaN;
  // Number(null) 은 0 이다 — 못 읽음이 유효한 시각으로 둔갑하지 않게 타입부터 본다.
  const responded = typeof respondedAtUnixMs === "number" ? respondedAtUnixMs : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(responded)) {
    return {
      status: "blocked",
      elapsedMs: null,
      evidence: [],
      reason: `boot latency could not be measured: startedAtUnixMs=${startedAtUnixMs} respondedAtUnixMs=${respondedAtUnixMs}`,
    };
  }
  const elapsedMs = responded - started;
  if (elapsedMs <= BOOT_LATENCY_BUDGET_MS) {
    return { status: "green", elapsedMs, evidence: [], reason: null };
  }
  const evidence = [`boot-latency=${elapsedMs}ms/${BOOT_LATENCY_BUDGET_MS}ms`];
  // 가장 오래 걸린 구간을 이름으로 낸다 — 총합만 알면 고칠 자리를 못 찾는다.
  let previous = started;
  let worst = null;
  for (const row of steps) {
    const at = Number(row?.atUnixMs);
    if (!Number.isFinite(at)) continue;
    const span = at - previous;
    if (!worst || span > worst.span) worst = { step: row.step, span };
    previous = at;
  }
  const tail = responded - previous;
  if (!worst || tail > worst.span) worst = { step: "after-last-step", span: tail };
  if (worst) evidence.push(`slowest=${worst.step}:${worst.span}ms`);
  return { status: "red", elapsedMs, evidence, reason: null };
}
