import { describe, expect, it } from "vitest";
import {
  compositionTimelineFrameAt,
  compositionTimelineVerdict,
} from "../../../packages/dom-webview-compositor/src/index.ts";
import { mapB04PresentationSamples } from "./browser-matrix.mjs";
import { b04DomLedgerProducerErrors } from "./browser-gate-b04-slot-timeline.mjs";

// 실측 재현(2026-08-07, buildId d83e0827, tauri/darwin).
// ~/.soksak-e2e/evidence/slot-freeze/runs/65bac3d9…/<engine>/<name>/dom-presentation-raw.json 의
// presentation-frame 표본에서 관측자 이름과 시각을 거래 시작 기준 offset 으로 그대로 옮겼다.
//
// 한 거래를 여러 관측자가 함께 적는다 — 표시 callback(frame-callback, ~17ms)과 최후 수단
// recorder(interval, ~8.5ms)와 경계 anchor(commit-anchor·animation-end·settlement)가 한 배열에
// 섞인다. 그 합집합의 최대/중앙 간격은 표시 주기가 아니라 서로 다른 두 주기가 겹치며 만드는
// 맥놀이다. 그래서 합집합은 두 방향으로 다 틀린다.
//   browser/01-left           합집합 10/5=2.00 → 없는 결함  · 표시 callback 18/17=1.06 (누락 0)
//   browser-chromium/02-right 합집합 9/8=1.13 → 조용한 통과 · 표시 callback 40/17=2.35 (2 frame 누락)
const CLEAN_DISPLAY_LEDGER = Object.freeze({
  startAtUnixMs: 1_786_082_931_963,
  commitOffsetMs: -92,
  moveDx: -160,
  from: Object.freeze({ x: 60, y: 149, w: 281, h: 421 }),
  frames: Object.freeze([
    [-91, "commit-anchor"], [-90, "frame-callback"], [-83, "interval"], [-75, "interval"],
    [-66, "interval"], [-57, "interval"], [-55, "frame-callback"], [-52, "frame-callback"],
    [-49, "interval"], [-40, "interval"], [-35, "frame-callback"], [-32, "interval"],
    [-23, "interval"], [-18, "frame-callback"], [-15, "interval"], [-5, "interval"],
    [-1, "frame-callback"], [3, "interval"], [12, "interval"], [15, "frame-callback"],
    [20, "interval"], [28, "interval"], [33, "frame-callback"], [37, "interval"],
    [45, "interval"], [49, "frame-callback"], [53, "interval"], [62, "interval"],
    [65, "frame-callback"], [70, "interval"], [78, "interval"], [82, "frame-callback"],
    [87, "interval"], [95, "interval"], [99, "frame-callback"], [103, "interval"],
    [112, "interval"], [115, "frame-callback"], [120, "interval"], [128, "interval"],
    [132, "frame-callback"], [137, "interval"], [145, "interval"], [149, "frame-callback"],
    [153, "interval"], [162, "interval"], [165, "frame-callback"], [170, "interval"],
    [178, "interval"], [182, "frame-callback"], [187, "interval"], [195, "interval"],
    [199, "frame-callback"], [203, "interval"], [212, "interval"], [215, "frame-callback"],
    [220, "interval"], [228, "interval"], [232, "frame-callback"], [237, "interval"],
    [245, "interval"], [249, "frame-callback"], [253, "interval"], [262, "interval"],
    [265, "frame-callback"], [270, "interval"], [278, "interval"], [282, "frame-callback"],
    [287, "interval"], [295, "interval"], [299, "frame-callback"], [303, "interval"],
    [311, "interval"], [315, "frame-callback"], [320, "interval"], [328, "interval"],
    [332, "frame-callback"], [337, "interval"], [345, "interval"], [349, "frame-callback"],
    [353, "interval"], [359, "settlement"], [361, "interval"], [371, "interval"],
    [374, "frame-callback"], [379, "interval"],
  ]),
});

const STARVED_DISPLAY_LEDGER = Object.freeze({
  startAtUnixMs: 1_786_083_213_340,
  commitOffsetMs: -83,
  moveDx: 160,
  from: Object.freeze({ x: 220, y: 149, w: 281, h: 421 }),
  frames: Object.freeze([
    [-83, "commit-anchor"], [-74, "interval"], [-66, "interval"], [-57, "interval"],
    [-48, "interval"], [-40, "interval"], [-32, "interval"], [-31, "frame-callback"],
    [-23, "interval"], [-15, "interval"], [-6, "interval"], [2, "interval"],
    [9, "frame-callback"], [10, "interval"], [19, "interval"], [20, "frame-callback"],
    [27, "interval"], [35, "interval"], [36, "frame-callback"], [44, "interval"],
    [53, "interval"], [53, "frame-callback"], [61, "interval"], [70, "interval"],
    [70, "frame-callback"], [79, "interval"], [86, "frame-callback"], [87, "interval"],
    [95, "interval"], [103, "frame-callback"], [104, "interval"], [112, "interval"],
    [119, "frame-callback"], [120, "interval"], [129, "interval"], [136, "frame-callback"],
    [137, "interval"], [146, "interval"], [153, "frame-callback"], [154, "interval"],
    [162, "interval"], [170, "frame-callback"], [170, "interval"], [179, "interval"],
    [185, "frame-callback"], [187, "interval"], [196, "interval"], [203, "frame-callback"],
    [204, "interval"], [212, "interval"], [219, "frame-callback"], [220, "interval"],
    [229, "interval"], [236, "frame-callback"], [237, "interval"], [245, "interval"],
    [253, "frame-callback"], [254, "interval"], [262, "interval"], [270, "frame-callback"],
    [270, "interval"], [279, "interval"], [286, "frame-callback"], [287, "interval"],
    [296, "interval"], [304, "interval"], [308, "frame-callback"], [312, "interval"],
    [320, "interval"], [322, "frame-callback"], [329, "interval"], [336, "frame-callback"],
    [337, "interval"], [346, "interval"], [355, "settlement"], [357, "interval"],
    [357, "settlement"], [357, "frame-callback"], [365, "interval"], [371, "frame-callback"],
    [373, "interval"],
  ]),
});

const DURATION_MS = 340;
const DISPLAY_PRODUCER = "frame-callback";
const NATIVE_PERIOD_MS = 16.6833;

const tenth = (value) => Math.round(value * 10) / 10;

function declaredTrajectory(ledger) {
  return {
    startAtUnixMs: ledger.startAtUnixMs,
    durationMs: DURATION_MS,
    timingFunction: [0.4, 0, 0.2, 1],
    from: ledger.from,
    to: { ...ledger.from, x: ledger.from.x - ledger.moveDx },
  };
}

/** 선언 궤적 위의 관측. 기준은 판정과 같은 곡선 한 자리에서 읽는다. */
function slotRectAt(ledger, sampledAtUnixMs) {
  const frame = compositionTimelineFrameAt(declaredTrajectory(ledger), sampledAtUnixMs);
  return { x: tenth(frame.x), y: tenth(frame.y), w: tenth(frame.w), h: tenth(frame.h) };
}

function domSample(ledger, sequence, sampledAtUnixMs, trigger, producer) {
  const slot = slotRectAt(ledger, sampledAtUnixMs);
  return {
    sequence,
    sampledAtUnixMs,
    trigger,
    producer,
    transactionId: trigger === "initial" ? null : "layout-5",
    domCommittedAtUnixMs: trigger === "initial"
      ? null
      : ledger.startAtUnixMs + ledger.commitOffsetMs,
    nodes: [
      { address: "rail", connected: true, rect: { x: 347, y: 82, w: 160, h: 518 } },
      { address: "pane", connected: true, rect: { ...slot, y: 88, h: 506 } },
      { address: "slot", connected: true, rect: slot },
    ],
  };
}

function domSamplesOf(ledger, keep = () => true) {
  const commitAt = ledger.startAtUnixMs + ledger.commitOffsetMs;
  return [
    domSample(ledger, 0, commitAt - 50, "initial", "arm"),
    domSample(ledger, 1, commitAt, "layout-dom-commit", "layout-commit"),
    ...ledger.frames.filter((entry) => keep(entry)).map(([offset, producer], index) => (
      domSample(ledger, index + 2, ledger.startAtUnixMs + offset, "presentation-frame", producer)
    )),
  ];
}

/** Native 표시 관측자 한 열이 renderer/surface 를 함께 낸다. */
function nativeEvents(ledger) {
  const events = [];
  const end = ledger.startAtUnixMs + DURATION_MS + 20;
  for (let at = ledger.startAtUnixMs - 12; at <= end; at += NATIVE_PERIOD_MS) {
    const frame = slotRectAt(ledger, Math.round(at));
    events.push({
      sampledAtUnixMs: Math.round(at),
      connected: true,
      slotFrame: frame,
      rendererFrame: frame,
      surfaceFrame: frame,
    });
  }
  return events;
}

function timelineOf(ledger, domSamples) {
  const { timeline } = mapB04PresentationSamples({
    events: nativeEvents(ledger),
    domSamples,
    owner: { rendererId: "pv-1", surfaceId: "b-tab-a" },
    targetViewId: "tab-a",
    transactionId: "layout-5",
    domCommittedAtUnixMs: ledger.startAtUnixMs + ledger.commitOffsetMs,
    presentationStartAtUnixMs: ledger.startAtUnixMs,
    durationMs: DURATION_MS,
    moveDx: ledger.moveDx,
    railAddress: "rail",
    paneAddress: "pane",
    slotAddress: "slot",
  });
  return timeline;
}

function displayGapErrors(ledger, domSamples) {
  return compositionTimelineVerdict({
    ...timelineOf(ledger, domSamples),
    coordinateSpace: { logical: "css-px", scaleFactor: 2 },
  }).errors.filter((error) => error.startsWith("slot:display-gap"));
}

describe("B04 slot timeline 은 한 관측자의 표시 열이다", () => {
  it("표시 callback 이 한 frame 도 안 건너뛴 실측 거래를 결함으로 세지 않는다", () => {
    const ledger = CLEAN_DISPLAY_LEDGER;
    expect(compositionTimelineVerdict({
      ...timelineOf(ledger, domSamplesOf(ledger)),
      coordinateSpace: { logical: "css-px", scaleFactor: 2 },
    }).errors).toEqual([]);
  });

  it("표시 callback 이 실제로 건너뛴 frame 을 8ms recorder 로 메우지 않는다", () => {
    const ledger = STARVED_DISPLAY_LEDGER;
    // 활강 시작을 가로질러 표시 callback 이 -31ms 와 +9ms 사이 40ms 를 비웠다. 그 사이에도
    // recorder 는 8ms 마다 왔고, 합집합만 보면 간격은 9/8 로 고르다.
    expect(displayGapErrors(ledger, domSamplesOf(ledger))).toEqual(["slot:display-gap=40/17"]);
  });

  it("timeline 에는 표시 관측자의 epoch 만 실린다", () => {
    const ledger = CLEAN_DISPLAY_LEDGER;
    const display = ledger.frames.filter(([, producer]) => producer === DISPLAY_PRODUCER);
    const expected = [
      ...display.filter(([offset]) => offset <= 0).slice(-1),
      ...display.filter(([offset]) => offset > 0 && offset < DURATION_MS),
      ...display.filter(([offset]) => offset >= DURATION_MS).slice(0, 1),
    ].map(([offset]) => ledger.startAtUnixMs + offset);
    expect(timelineOf(ledger, domSamplesOf(ledger)).slot.map(({ sampledAtUnixMs }) => sampledAtUnixMs))
      .toEqual(expected);
  });

  it("표시 관측자가 한 번도 안 왔으면 recorder 표본으로 대신하지 않고 빈 열로 남긴다", () => {
    const ledger = CLEAN_DISPLAY_LEDGER;
    const domSamples = domSamplesOf(ledger, ([, producer]) => producer !== DISPLAY_PRODUCER);
    const timeline = timelineOf(ledger, domSamples);
    expect(timeline.slot).toEqual([]);
    // 출발점은 표시 열이 아니라 활강 이전 DOM 사실에서 읽으므로 굶은 창에서도 그대로다.
    expect(timeline.from).toEqual(ledger.from);
    expect(compositionTimelineVerdict({
      ...timeline,
      coordinateSpace: { logical: "css-px", scaleFactor: 2 },
    }).errors).toEqual(["slot:samples=0/3"]);
  });

  it("관측자 이름 없는 원장 표본은 표시 열로 읽지 않는다", () => {
    const ledger = CLEAN_DISPLAY_LEDGER;
    const domSamples = domSamplesOf(ledger).map((sample) => (
      sample.producer === DISPLAY_PRODUCER ? { ...sample, producer: undefined } : sample
    ));
    expect(timelineOf(ledger, domSamples).slot).toEqual([]);
    // 이름 없는 원장은 살아 있는 실행에서 그 자체로 실패다 — 원장이 도착하는 자리에서 센다.
    expect(b04DomLedgerProducerErrors(domSamples))
      .toEqual(expect.arrayContaining([expect.stringContaining(".producer=non-empty")]));
    expect(b04DomLedgerProducerErrors(domSamplesOf(ledger))).toEqual([]);
  });
});
