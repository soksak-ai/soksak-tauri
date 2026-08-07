import { setTimeout as sleepMs } from "node:timers/promises";

/** B05 계약의 정착 뒤 유지 창. 판정과 같은 수치를 하니스가 실제로 관측해야 한다. */
export const B05_POST_SETTLE_HOLD_MS = 250;

/**
 * 유지 창을 표시 원장이 덮도록 두는 표시 여유(ms).
 *
 * display link는 refresh 간격마다만 사건을 낸다. 유지 창 끝과 마지막 사건이 같은 순간일 수
 * 없으므로, 30Hz 기준 두 refresh(=약 66ms 이하)를 덮는 여유를 선언한다.
 */
export const B05_HOLD_SLACK_MS = 60;

const finite = (value) => (Number.isFinite(value) ? value : null);

/**
 * 정착 뒤 유지 창을 관측이 덮도록 선언한 유한 대기.
 *
 * "되기를 기다리는" 폴링이 아니라 B05가 요구하는 관측 창 자체다. display link는 스트림으로
 * 노출되지 않고 원장은 close에서만 답하므로, 창을 여는 수단은 이 유한 대기 하나뿐이다.
 *
 * 대기 자체는 증거가 아니다 — 유지 창의 시작·끝·표면 재고는 전부 실제 표시 사건 epoch로
 * 판정한다. 그래서 이 값을 짧게 잡으면 GREEN이 아니라 RED가 나온다.
 */
export async function awaitPostSettleHold({
  holdMs = B05_POST_SETTLE_HOLD_MS,
  slackMs = B05_HOLD_SLACK_MS,
  sleep = sleepMs,
} = {}) {
  const waitMs = holdMs + slackMs;
  await sleep(waitMs);
  return waitMs;
}

/**
 * 코어 정착 영수증과 native display 원장을 결합해 정착 프레임과 유지 창을 고른다.
 *
 * 두 생산자의 실제 수치만 쓴다 — 정착 epoch는 코어 장벽이, 표시 시각과 표면 재고는 display
 * 원장이 답한 것이다. 어느 한쪽이 답하지 않으면 그 자리는 null로 남는다. 없는 값을 프레임에서
 * 되짚어 만들면 "못 읽음"이 "0"으로 둔갑한다.
 */
export function resolveB05Settlement({ settleReceipt, presentationReceipt } = {}) {
  const events = Array.isArray(presentationReceipt?.presentationEvents)
    ? presentationReceipt.presentationEvents
    : [];
  const settledAtUnixMs = finite(settleReceipt?.settledAtUnixMs);
  const syncPending = typeof settleReceipt?.syncPending === "boolean"
    ? settleReceipt.syncPending
    : null;
  const settledFrame = settledAtUnixMs === null
    ? null
    : events.filter((event) => finite(event?.presentedAtUnixMs) !== null
        && event.presentedAtUnixMs <= settledAtUnixMs).at(-1) ?? null;
  const lastFrame = events.at(-1) ?? null;
  return {
    // 정착 영수증이 답한 시계. 이 시각이 표시 원장의 시각과 비교되므로 여기서 잃으면 안 된다.
    // 판정 스키마의 `settled` 안이 아니라 옆에 둔다 — 시각이 아니라 그 시각의 출처다.
    clock: typeof settleReceipt?.clock === "string" ? settleReceipt.clock : null,
    settled: {
      atUnixMs: settledAtUnixMs,
      frameSequence: Number.isInteger(settledFrame?.sequence) ? settledFrame.sequence : null,
      syncPending,
    },
    hold: {
      startedAtUnixMs: settledAtUnixMs,
      endedAtUnixMs: finite(lastFrame?.presentedAtUnixMs),
      surfaces: Array.isArray(lastFrame?.surfaces) ? lastFrame.surfaces : null,
    },
  };
}
