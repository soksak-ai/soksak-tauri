import { displayValue } from "./browser-machine-judge-support.mjs";

/**
 * 센티널 뷰 준비 판정.
 *
 * 코어의 tab.open 은 마운트를 기다렸다 `mounted` 로 답한다 — 그 답이 이 뷰가 명령을 받을 수
 * 있는지에 대한 단일 진실이다. 픽스처 블록은 그 계약을 강제하지만 센티널 블록은 답을 읽지
 * 않고 다음 명령을 보냈다(실측 baseline: browser-chromium-offscreen 12칸이 전부
 * `sentinel navigate 실패 NO_VIEW` 로 blocked — navigate 는 소유자가 아니었다).
 *
 * 읽지 않은 계약은 없는 계약이고, 소유자를 못 짚는 사유는 12칸을 엉뚱한 자리로 보낸다.
 */
export const SENTINEL_MOUNT_CONTRACT = "tab.open.mounted";

/** tab.open 영수증(+선택적 status.query 목록)만으로 판정한다. 수치는 receipt 가 실은 값 그대로. */
export function judgeSentinelMount({ engine, receipt, statuses = [] }) {
  const failures = [];
  const tabId = receipt?.tabId;
  const mounted = receipt?.mounted;
  if (typeof tabId !== "string" || tabId.length === 0) {
    failures.push(`tabId=string/${displayValue(tabId)}`);
  }
  if (mounted !== true) failures.push(`mounted=true/${displayValue(mounted)}`);
  const status = (Array.isArray(statuses) ? statuses : []).find(
    (entry) => entry && entry.tabId === tabId,
  ) ?? null;
  const ok = failures.length === 0;
  return {
    engine,
    tabId: typeof tabId === "string" ? tabId : null,
    mounted: mounted === true,
    status,
    failures,
    ok,
    reason: ok ? null : formatReason(engine, failures, status),
  };
}

function formatReason(engine, failures, status) {
  const parts = [
    `${engine} sentinel view is not actionable`,
    `contract=${SENTINEL_MOUNT_CONTRACT}`,
    `failures=${failures.join(",")}`,
    "owner=plugin view mount",
  ];
  if (status) {
    parts.push(`status=${status.code}${status.message ? `: ${status.message}` : ""}`);
  }
  return parts.join(" | ");
}

/** 통과하면 판정을 돌려주고, 아니면 소유자를 이름으로 든 사유로 던진다. */
export function assertSentinelMounted(input) {
  const verdict = judgeSentinelMount(input);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict;
}
