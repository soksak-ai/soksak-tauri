// 명령 실행의 관측 — 계측 sink·누적·배선 완료 선언·영속 상태, 그리고 그 넷이 만드는 판정.
//
// 등록부(registry)와 나누는 이유: 등록부는 "무엇을 부를 수 있는가"이고 여기는 "그 실행이
// 보이는가"다. 두 축은 함께 자라지 않는다 — 등록은 부팅에 한 번, 관측은 매 실행이다.
//
// 판정에 등록부가 필요한 곳은 **수 하나**뿐이라 인자로 받는다. 그래야 이 파일이 등록부를
// 모르고, 등록부도 관측의 안을 모른다.

import { activityHealth } from "../state/activityHealth";
import { moduleState } from "../lib/moduleState";
import type { CommandTrace } from "./registry";

// 계측의 건강 — **계측이 죽으면 그 사실도 계측되지 않는다.** 그래서 따로 센다.
//
// 실측(2026-07-31): 명령은 정상으로 답하는데 활동 원장에 아무것도 안 쌓였다. sink 가 붙었는지,
// 마지막으로 언제 계측했는지를 밖에서 물을 길이 없어 원장을 두 번 조회해 시각을 비교했다 —
// 그건 진단이 아니라 수작업이다. 상태는 갈아끼워도 살아남는다.

/** 계측 sink — 붙었는가. 배선이고, 아래 두 축과 수명이 다르다. */
const traceSink = moduleState("commands/registry#traceSink", () => ({
  fn: null as ((t: CommandTrace) => void) | null,
}));

/** 계측 누적 — 얼마나 내보냈는가. sink 를 갈아 끼워도 이 수는 이어진다. */
const traceCount = moduleState("commands/registry#traceCount", () => ({
  emitted: 0,
  lastEmitAt: 0,
}));

/**
 * 배선 완료 선언 — **판정 시점**이다.
 *
 * 부팅이 "다 붙였다"고 말하기 전에는 미설치가 결함이 아니다(아직 붙이는 중이거나 이 부분을
 * 켜지 않은 하니스다). 이 신호 없이 판정하면 부팅 중인 앱과 고장난 앱이 똑같아 보인다.
 */
const runtime = moduleState("commands/registry#runtime", () => ({
  ready: false,
}));

const persistBox = moduleState("commands/registry#persistStats", () => ({
  v: null as Record<string, number> | null,
}));

/** 부팅이 배선을 끝냈다고 선언한다 — 이 뒤로 빠진 배선은 결함이다. */
export function markRuntimeReady(): void {
  runtime.ready = true;
}

/**
 * 영속 상태를 실어 둔다 — 프론트는 Rust 쪽 카운터를 직접 못 읽는다.
 *
 * 발행이 도장을 받은 것과 그 항목이 원장에 남은 것은 다른 사실이다. 쓰기가 실패하면 회복
 * 큐에 담기는데, 세는 자리가 없으면 그 사이 밖에서는 "발행 성공"만 보인다(실측 2026-07-31:
 * 63건이 유실인지 대기인지 구분되지 않았다).
 */
export function noteActivityPersist(stats: Record<string, number>): void {
  persistBox.v = stats;
}

export function setCommandTraceSink(fn: ((t: CommandTrace) => void) | null): void {
  traceSink.fn = fn;
}

/** 계측 한 건 — 누적을 올리고 sink 가 있으면 흘린다. */
export function emitTrace(t: CommandTrace, at: number): void {
  traceCount.emitted += 1;
  traceCount.lastEmitAt = at;
  traceSink.fn?.(t);
}

// 죽은 축은 **모든 응답이 말한다** — 따로 물어봐야 아는 사실은 아무도 안 묻는다.
//
// 실측(2026-07-31): 활동 발행이 끊긴 채로 앱은 멀쩡히 명령에 답했다. 그 사실을 알려면 원장을
// 두 번 조회해 최신 시각을 비교해야 했다. 조회하는 쪽이 무엇을 물었든, 코어가 절름거리고
// 있으면 그 답에 실려 와야 한다.
/** 원장 주인이 답한 감사 — 저장소를 쓰는 프로세스가 둘이면 이것 없이는 판정이 반쪽이다. */
const ledgerBox = moduleState("commands/commandObservation#ledgerBox.v", () => ({
  v: null as Record<string, unknown> | null,
}));

export function noteLedgerAudit(audit: Record<string, unknown> | null): void {
  ledgerBox.v = audit;
}

export function degradedAxes(registeredCount: number): string[] | undefined {
  const bad: string[] = [];
  const a = activityHealth();
  if (!runtime.ready) return undefined;
  if (a.attempts === 0) {
    // 시도 0 은 "건강"이 아니라 **미확인**이다. 침묵시키면 발행 배선이 통째로 빠진 창과
    // 잘 도는 창이 똑같아 보인다 — 0 의 두 얼굴을 여기서도 가른다.
    bad.push("activity: 허브 발행을 한 번도 시도하지 않음(배선 미확인)");
  } else if (a.ledgerSwitches > 0) {
    // 한 창의 발행이 두 원장으로 갈렸다 — 어느 쪽도 그 창의 전부를 갖지 못한다.
    bad.push(
      `activity: 답한 원장이 ${a.ledgerSwitches}회 바뀌었다(현재 ${a.ledger || "이름 없음"}) — 발행이 두 원장으로 갈렸다`,
    );
  } else if (a.stampRegressions > 0) {
    // 도장이 뒤로 갔다 = 답한 원장이 바뀌었거나 재개 지점을 잃었다. 그 상태의 적재는 기존
    // 행을 덮어쓰므로(ON CONFLICT DO UPDATE) 과거가 조용히 파괴된다.
    bad.push(
      `activity: 적재 도장이 뒤로 갔다 ${a.stampRegressions}회(마지막 seq ${a.lastStamp}) — 원장이 갈렸거나 재개 지점을 잃었다`,
    );
  } else if (!a.healthy) {
    bad.push(
      `activity: 허브 발행 연속 실패 ${a.consecutiveFailures}회(누적 ${a.failed}/${a.attempts})${a.lastError ? ` — ${a.lastError}` : ""}`,
    );
  }
  if (registeredCount === 0) bad.push("commands: 등록부가 비어 있음(등록 0개)");
  // 원장 주인의 사실 — 이쪽 프로세스가 성해도 저쪽이 막혔으면 원장은 안 자란다.
  if (ledgerBox.v) {
    const reg = Number(ledgerBox.v.time_regressions ?? 0);
    if (reg > 0) {
      bad.push(
        `activity: 원장에 시간 역행 ${reg}건(첫 seq ${ledgerBox.v.first_regression_seq}) — 그 구간은 덮어써졌고 복구할 수 없다`,
      );
    }
    const lp = (ledgerBox.v.persist ?? {}) as Record<string, number>;
    if ((lp.failures ?? 0) > 0 || (lp.pending ?? 0) > 0) {
      bad.push(
        `activity: 원장 주인의 쓰기가 막힌다(실패 누계 ${lp.failures ?? 0} · 대기 ${lp.pending ?? 0})${lp.lastError ? ` — ${String(lp.lastError).slice(0, 80)}` : ""}`,
      );
    }
  }
  // sink 미설치는 "조용함"이 아니라 결함이다 — 이 창의 모든 실행이 원장에서 사라진다.
  if (!traceSink.fn) bad.push("commands: 실행 계측 sink 미설치(이 창의 실행이 원장에 안 남음)");
  // 영속이 밀리면 도장은 받았는데 원장에는 없다 — 그 차이는 조회로만 드러나고, 조회하는
  // 사람이 그 차이를 알 이유가 없다. 응답이 먼저 말한다.
  if (persistBox.v && ((persistBox.v.pending ?? 0) > 0 || (persistBox.v.failures ?? 0) > 0)) {
    bad.push(
      `activity: 원장 영속이 밀렸다(대기 ${persistBox.v.pending ?? 0} · 실패 누계 ${persistBox.v.failures ?? 0} · 버림 ${persistBox.v.drops ?? 0}) — 도장은 받았지만 원장에 없는 항목이 있다`,
    );
  }
  return bad.length > 0 ? bad : undefined;
}

export function commandHealth(registeredCount: number): Record<string, unknown> {
  return {
    persist: persistBox.v ?? { unknown: 1 },
    ready: runtime.ready,
    commands: {
      registered: registeredCount,
      traceSinkInstalled: traceSink.fn !== null,
      emitted: traceCount.emitted,
      lastEmitAt: traceCount.lastEmitAt,
    },
    activity: activityHealth(),
    degradedAxes: degradedAxes(registeredCount) ?? [],
  };
}
