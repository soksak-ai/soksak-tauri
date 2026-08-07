import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { browserImplementations, mapB04PresentationSamples } from "./browser-matrix.mjs";
import { compositionTimelineVerdict } from "../../../packages/dom-webview-compositor/src/index.ts";

// 실측 원본. slot-freeze 한 실행(browser-chromium/flow 01-left)의 close 영수증과 raw DOM trace를
// 그대로 담았다. 값은 손대지 않았다 — 이 fixture가 RED를 만들면 실제 앱이 그 RED를 낸다.
const FIXTURE = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../fixtures/b04-pane-presentation-glide.json"),
  "utf8",
));

const IMPLEMENTATION = browserImplementations["browser-chromium"];

function traceFrom(presentationReceipt) {
  return mapB04PresentationSamples({
    events: IMPLEMENTATION.presentationTrace.events(presentationReceipt, {
      targetViewId: FIXTURE.targetViewId,
      owner: FIXTURE.owner,
    }),
    domSamples: FIXTURE.domTrace.samples,
    owner: FIXTURE.owner,
    targetViewId: FIXTURE.targetViewId,
    transactionId: FIXTURE.transaction.transactionId,
    domCommittedAtUnixMs: FIXTURE.transaction.domCommittedAtUnixMs,
    presentationStartAtUnixMs: FIXTURE.transaction.startAtUnixMs,
    durationMs: FIXTURE.transaction.durationMs,
    moveDx: FIXTURE.transaction.moves.find(({ viewId }) => viewId === FIXTURE.targetViewId).dx,
    railAddress: FIXTURE.railAddress,
    paneAddress: FIXTURE.paneAddress,
    slotAddress: FIXTURE.slotAddress,
  });
}

function nativeErrors(presentationReceipt) {
  const { timeline } = traceFrom(presentationReceipt);
  return compositionTimelineVerdict({
    ...timeline,
    coordinateSpace: { logical: "css-px", scaleFactor: FIXTURE.scaleFactor },
  }).errors.filter((error) => error.startsWith("renderer") || error.startsWith("surface"));
}

/** 표시 원장이 어느 epoch를 관측 시각으로 실었는지만 바꾼 같은 실측 영수증. */
function receiptDatedBy(field) {
  return {
    ...FIXTURE.presentationReceipt,
    presentationEvents: FIXTURE.presentationReceipt.presentationEvents.map((event) => ({
      ...event,
      callbackObservedAtUnixMs: event[field],
    })),
  };
}

describe("B04 native producer epoch — 관측한 값과 관측한 시각은 같은 순간이어야 한다", () => {
  it("표본을 이전 frame의 표시 시각으로 날인하면 실측 좌표가 반올림 예산을 넘는다", () => {
    // 이 값들이 하니스가 보고한 RED 그대로다: renderer[22]·renderer[24]·surface[22].
    const errors = nativeErrors(receiptDatedBy("displayTimestampUnixMs"));
    expect(errors.length).toBeGreaterThan(0);
    const worst = errors
      .map((error) => JSON.parse(error.slice(error.indexOf("=") + 1)).x)
      .reduce((max, value) => Math.max(max, value), 0);
    expect(worst).toBeGreaterThan(0.5);
  });

  it("관측 시각으로 날인한 같은 실측 좌표는 반올림 예산 안에 있다", () => {
    const trace = traceFrom(FIXTURE.presentationReceipt);
    const observed = FIXTURE.presentationReceipt.presentationEvents
      .map((event) => event.callbackObservedAtUnixMs);
    for (const sample of trace.timeline.renderer) {
      expect(observed).toContain(sample.sampledAtUnixMs);
    }
    expect(nativeErrors(FIXTURE.presentationReceipt)).toEqual([]);
  });
});
