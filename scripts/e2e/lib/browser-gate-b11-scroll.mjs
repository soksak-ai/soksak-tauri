import { B11_WHEEL_LEDGER_KEYS } from "./browser-gate-b11.mjs";

/**
 * B11 휠 반쪽의 관측 통로.
 *
 * 판정이 요구하는 축과 페이지가 답하는 이름을 여기 한 자리에서 잇는다 — 프로브와 옮기기가
 * 각자 필드를 나열하면 반드시 하나가 갈린다.
 *
 * 휠이 페이지에 닿은 사실은 DOM 에도 투영돼야 한다. 두 엔진 모두 스크롤을 합성 쪽에서 먼저
 * 옮기고 passive wheel 리스너 발화는 그 뒤에 온다. scroll 사건만 기다리고 원장을 읽으면
 * 언제나 아직 세지 않은 0 을 읽는다 — 기다릴 수 없는 사실은 잴 수 없다.
 */

/** 판정 축 ← 페이지가 답하는 이름. */
const LEDGER_FIELD = Object.freeze({
  scrollSeq: "seq",
  wheelEvents: "wheelEvents",
  wheelDeltaY: "wheelDeltaY",
});

/** 프로브가 한 번에 읽는 값. 왼쪽은 답의 이름, 오른쪽은 페이지에서 그 값을 얻는 식이다. */
const PROBE_FIELD = Object.freeze({
  y: "scrollY",
  h: "document.documentElement.scrollHeight",
  v: "innerHeight",
  seq: "Number(document.documentElement.dataset.scrollSeq||0)",
  wheelSeq: "Number(document.documentElement.dataset.wheelSeq||0)",
  wheelEvents: "Number(window.__browserFixture?.wheelEvents)",
  wheelDeltaY: "Number(window.__browserFixture?.wheelDeltaY)",
});

const uncovered = B11_WHEEL_LEDGER_KEYS.filter((key) => !(LEDGER_FIELD[key] in PROBE_FIELD));
if (uncovered.length > 0) {
  throw new Error(`B11 휠 원장 축을 프로브가 답하지 않는다: ${uncovered.join(",")}`);
}

/** 좌표·문서 크기·두 사건 좌표를 한 번에 읽는다. 따로 재면 서로 다른 순간이 한 값에 섞인다. */
export function wheelLedgerProbeJs() {
  const fields = Object.entries(PROBE_FIELD).map(([name, expression]) => `${name}:${expression}`);
  return `return { ${fields.join(", ")} };`;
}

/** 프로브가 답한 한 순간을 판정 축으로 옮긴다. 축 목록은 판정이 소유한다. */
export function wheelLedgerStage(read) {
  const stage = {};
  for (const key of B11_WHEEL_LEDGER_KEYS) stage[key] = Number(read?.[LEDGER_FIELD[key]]);
  return stage;
}

function seenSeq(value, axis) {
  const seq = Number(value);
  if (!Number.isFinite(seq)) throw new Error(`${axis} 대기 좌표는 유한수여야 한다: ${value}`);
  return seq;
}

/** 페이지가 실제로 움직인 사실. */
export function scrollMovedSelector(seenScrollSeq) {
  return `html[data-scroll-seq]:not([data-scroll-seq="${seenSeq(seenScrollSeq, "scrollSeq")}"])`;
}

/** 휠이 페이지에 닿은 사실. 스크롤이 옮겨진 사실과 다른 사건이라 따로 기다린다. */
export function wheelReachedSelector(seenWheelSeq) {
  return `html[data-wheel-seq]:not([data-wheel-seq="${seenSeq(seenWheelSeq, "wheelSeq")}"])`;
}
