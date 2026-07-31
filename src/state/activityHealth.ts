// 활동 발행의 건강 — 조용히 죽는 것을 막는다.
//
// 발행 자리는 실패를 삼키고 있었다(`.catch(() => {})`). 라이브 동작을 막지 않으려는 것이었고
// 그 판단은 옳지만, **막지 않는 것과 사실을 안 남기는 것은 다르다**. 삼킨 실패가 세어지지도
// 않아서, 발행이 끊겨도 앱은 멀쩡히 명령에 답했고 밖에서는 알 방법이 없었다.
//
// 실측(2026-07-31): 허브 발행이 16:54:27 에 끊겼다. 사람이 원장을 두 번 조회해 최신 시각을
// 비교하고서야 알았다 — 그건 진단이 아니라 수작업이다. 기계가 한 번 물어보면 알아야 한다.
//
// 상태는 갈아끼워도 살아남는다(moduleState) — 관측이 끊기는 바로 그 순간에 관측 상태까지
// 사라지면 남는 것이 없다.

import { moduleState } from "../lib/moduleState";

/** 연속 실패가 이 수에 닿으면 건강하지 않다고 말한다. 한 번의 실패는 일시적일 수 있다. */
export const UNHEALTHY_AFTER = 2;

interface Counters {
  attempts: number;
  ok: number;
  failed: number;
  consecutiveFailures: number;
  lastOkAt: number;
  lastFailAt: number;
  lastError: string;
  /** 마지막으로 받은 적재 도장(seq). 허브의 원장 seq 와 대조하면 도장을 누가 찍었는지 갈린다. */
  lastStamp: number;
  /**
   * 도장이 뒤로 간 횟수 — 원장 seq 는 단조 증가한다(id 가 `a{seq:016}` 이라 사전순이 곧 시간순).
   * 뒤로 갔다면 답한 원장이 바뀌었거나 재개 지점을 잃은 것이고, 그때 적재는 기존 행을 **덮어쓴다**
   * (PERSIST_SQL 이 ON CONFLICT DO UPDATE). 즉 조용한 과거 파괴라 반드시 이름으로 드러나야 한다.
   */
  stampRegressions: number;
}

const counters = moduleState<Counters>("state/activityHealth#counters", () => ({
  attempts: 0,
  ok: 0,
  failed: 0,
  consecutiveFailures: 0,
  lastOkAt: 0,
  lastFailAt: 0,
  lastError: "",
  lastStamp: 0,
  stampRegressions: 0,
}));

/**
 * 응답에서 적재 도장을 읽는다 — **resolve 는 적재의 증거가 아니다.**
 *
 * 허브는 적재하면 도장(seq)을 찍어 항목을 돌려준다(cored ledger::admit — 도장을 찍고 영속까지
 * 한 뒤 그 항목을 응답에 싣는다). 그러니 응답에 seq 가 있으면 원장에 남은 것이고, 없으면
 * 발행 호출은 갔는데 원장에는 안 남은 것이다.
 *
 * 실측(2026-07-31): 발행이 resolve 해서 성공으로 세어지는 동안 원장은 정지해 있었다. 호출의
 * 성공만 세면 그 두 상태가 똑같아 보인다 — 경계를 세는 자리가 여기다.
 */
export function stampOf(reply: unknown): number | null {
  if (!reply || typeof reply !== "object") return null;
  const seq = (reply as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

/** 발행 한 번의 결과를 남긴다. 성공은 연속 실패를 걷지만 지난 실패를 지우지는 않는다. */
export function notePublish(
  ok: boolean,
  at: number,
  error?: string,
  stamp?: number,
): void {
  counters.attempts += 1;
  if (ok) {
    if (stamp !== undefined) {
      if (counters.lastStamp > 0 && stamp < counters.lastStamp) {
        counters.stampRegressions += 1;
      }
      counters.lastStamp = stamp;
    }
    counters.ok += 1;
    counters.consecutiveFailures = 0;
    counters.lastOkAt = at;
    return;
  }
  counters.failed += 1;
  counters.consecutiveFailures += 1;
  counters.lastFailAt = at;
  counters.lastError = error ?? "";
}

export interface ActivityHealth extends Counters {
  /** 한 번이라도 성공했고 연속 실패가 문턱 아래인가. 시도 0 은 건강이 아니라 미확인이다. */
  healthy: boolean;
}

export function activityHealth(): ActivityHealth {
  return {
    ...counters,
    healthy:
      counters.ok > 0 &&
      counters.consecutiveFailures < UNHEALTHY_AFTER &&
      counters.stampRegressions === 0,
  };
}
