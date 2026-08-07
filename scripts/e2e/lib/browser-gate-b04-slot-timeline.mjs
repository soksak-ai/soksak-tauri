import { sameRect } from "../../../packages/dom-webview-compositor/src/index.ts";

/**
 * 한 timeline 은 한 관측자의 표시 열이다.
 *
 * DOM 원장(ui.trace.multi)은 한 거래를 여러 관측자가 함께 적는다 — 표시 callback
 * (frame-callback), 가려진 문서에서만 쓰는 최후 수단 recorder(interval), 그리고 경계
 * anchor(commit-anchor·animation-end·settlement)가 한 배열에 시각 순으로 섞인다. 그 배열을
 * 그대로 timeline 으로 넘기면 display-gap 은 표시 주기가 아니라 서로 다른 두 주기가 겹치며
 * 만드는 맥놀이를 잰다. 맥놀이의 최대/중앙 비는 표시가 고를 때도 2 에 가깝고, 표시가 실제로
 * 굶었을 때는 8ms recorder 가 그 구멍을 메워 1 에 가까워진다 — 두 방향으로 다 틀린다.
 *
 * 실측(2026-08-07, buildId d83e0827, tauri/darwin):
 *   browser/01-left           합집합 10/5=2.00 → 없는 결함  · 표시 callback 18/17=1.06 (누락 0)
 *   browser-chromium/02-right 합집합 9/8=1.13 → 조용한 통과 · 표시 callback 40/17=2.35 (2 frame 누락)
 *
 * 그래서 slot timeline 은 표시 관측자 하나만 싣는다. 표시 관측자가 한 번도 안 온 창은
 * recorder 표본으로 대신하지 않고 빈 열로 남는다 — 못 본 것을 본 것으로 바꾸지 않는다.
 */
export const B04_DISPLAY_PRODUCER = "frame-callback";

/**
 * 살아 있는 원장은 표본마다 관측자 이름을 싣는다(ui.trace.multi close 계약). 이름이 없으면
 * 어느 관측자의 열인지 물을 수 없고, 표시 열은 조용히 비어 다른 이름의 결함으로 보고된다.
 * 그래서 이 검사는 원장이 실제로 도착하는 자리에서 한 번 한다.
 */
export function b04DomLedgerProducerErrors(samples) {
  if (!Array.isArray(samples)) return ["samples=array"];
  return samples.flatMap((sample, index) => (
    typeof sample?.producer === "string" && sample.producer.length > 0
      ? []
      : [`samples[${index}].producer=non-empty`]
  ));
}

/**
 * 거래 창 자르기 — 시작 직전 한 표본, 거래 중 전부, 착지 직후 한 표본.
 * slot·renderer·surface 는 같은 창으로 잘라야 서로 다른 구간을 비교하지 않는다.
 */
export function b04TransactionWindow(values, at, { startAtUnixMs, endAtUnixMs }) {
  const before = values.filter((value) => at(value) <= startAtUnixMs).at(-1);
  const during = values.filter((value) => (
    at(value) > startAtUnixMs && at(value) < endAtUnixMs
  ));
  const after = values.find((value) => at(value) >= endAtUnixMs);
  return [before, ...during, after].filter((value, index, all) => (
    value !== undefined && all.indexOf(value) === index
  ));
}

/**
 * 원장 표본에서 slot 표시 열을 만든다.
 *
 * @param {object} input
 * @param {readonly object[]} input.presentationSamples 이 거래의 DOM commit·표시 표본
 * @param {string} input.slotAddress
 * @param {string} input.targetViewId
 * @param {number} input.startAtUnixMs
 * @param {number} input.endAtUnixMs
 * @param {(rect: unknown, name: string) => {x:number,y:number,w:number,h:number}} input.finiteRect
 */
export function b04SlotDisplayTimeline({
  presentationSamples,
  slotAddress,
  targetViewId,
  startAtUnixMs,
  endAtUnixMs,
  finiteRect,
}) {
  // 표시 관측자가 한 번도 안 온 창은 빈 열로 남긴다. recorder 표본을 대신 싣지 않고, 판정을
  // 예외로 끊지도 않는다 — 그 사실은 `slot:samples=0/3` 이라는 이름으로 게이트에 실린다.
  const display = presentationSamples.filter(({ producer }) => producer === B04_DISPLAY_PRODUCER);
  const rows = b04TransactionWindow(
    display,
    (sample) => sample.sampledAtUnixMs,
    { startAtUnixMs, endAtUnixMs },
  ).map((domSample, sequence) => {
    const matches = (domSample.nodes ?? []).filter((node) => node?.address === slotAddress);
    if (matches.length !== 1 || matches[0].connected !== true) {
      throw new Error(`${targetViewId}: timeline slot[${sequence}]=${matches.length}/1 connected`);
    }
    return {
      sequence,
      sampledAtUnixMs: domSample.sampledAtUnixMs,
      frame: finiteRect(matches[0].rect, `${targetViewId}:timeline-slot[${sequence}]`),
    };
  });
  // 한 표시 epoch에는 표시된 frame이 하나뿐이다. 같은 ms 로 반올림된 두 표시 callback이
  // 같은 rect라면 궤적 위의 한 점이다. rect가 다르면 한 epoch에 두 frame을 주장하는 것이므로
  // 둘 다 남겨 RED로 센다.
  return rows.reduce((collapsed, row) => {
    const previous = collapsed[collapsed.length - 1];
    if (previous
        && previous.sampledAtUnixMs === row.sampledAtUnixMs
        && sameRect(previous.frame, row.frame)) return collapsed;
    collapsed.push(row);
    return collapsed;
  }, []).map((row, sequence) => ({ ...row, sequence }));
}
