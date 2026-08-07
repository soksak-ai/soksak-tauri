import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapB04PresentationSamples, normalizeB04JournalEntries } from "./browser-matrix.mjs";
import { judgeB04MachineEvidence } from "./browser-gates.mjs";
import { compositionTimelineFrameAt } from "../../../packages/dom-webview-compositor/src/index.ts";

// 실측 RED 재현(2026-08-07, tauri/darwin, browser-chromium):
//   "tab-3ujyli: DOM pair sequence[125]=219/220"
// DOM 원장은 여러 관측자가 함께 적는다. 같은 거래의 원장 156 행 중 시각이 뒤집힌 행이 2,
// 같은 ms 로 반올림된 행이 28 이었다(evidence/slot-freeze/last-red/browser-chromium). 최근접
// 결합은 그 자리에서 한 칸 뒤 행을 고를 수 있고, 그 한 줄이 그 엔진의 B02 이후 아홉 칸을
// blocked 로 닫았다.
const VIEW = "tab-3ujyli";
const START_AT_UNIX_MS = 1_786_071_385_870;
const DURATION_MS = 340;
const COMMIT_AT_UNIX_MS = START_AT_UNIX_MS - 8;
const END_AT_UNIX_MS = START_AT_UNIX_MS + DURATION_MS;
const SLOT_FROM = Object.freeze({ x: 60, y: 149, w: 281, h: 421 });
const MOVE_DX = -160;

const TRANSACTION = Object.freeze({
  transactionId: "layout-3",
  sequence: 3,
  phase: "committed",
  mode: "glide",
  startAtUnixMs: START_AT_UNIX_MS,
  durationMs: DURATION_MS,
  preparedAtUnixMs: COMMIT_AT_UNIX_MS - 3,
  domCommittedAtUnixMs: COMMIT_AT_UNIX_MS,
  closedAtUnixMs: COMMIT_AT_UNIX_MS + 1,
  moves: [{ viewId: VIEW, dx: MOVE_DX }],
});

const DECLARED_TIMELINE = Object.freeze({
  startAtUnixMs: START_AT_UNIX_MS,
  durationMs: DURATION_MS,
  timingFunction: [0.4, 0, 0.2, 1],
  from: SLOT_FROM,
  to: { ...SLOT_FROM, x: SLOT_FROM.x - MOVE_DX },
});

const slotXAt = (sampledAtUnixMs) => compositionTimelineFrameAt(
  DECLARED_TIMELINE,
  sampledAtUnixMs,
).x;

const LEDGER_PRODUCER = Object.freeze({
  initial: "arm",
  "layout-dom-commit": "layout-commit",
  "presentation-frame": "frame-callback",
});

const domSample = (sequence, sampledAtUnixMs, trigger, slotX) => ({
  sequence,
  sampledAtUnixMs,
  trigger,
  producer: LEDGER_PRODUCER[trigger],
  transactionId: trigger === "initial" ? null : TRANSACTION.transactionId,
  domCommittedAtUnixMs: trigger === "initial" ? null : COMMIT_AT_UNIX_MS,
  nodes: [
    { address: "rail", connected: true, rect: { x: 0, y: 82, w: 60, h: 518 } },
    { address: "pane", connected: true, rect: { x: slotX, y: 88, w: 281, h: 506 } },
    { address: "slot", connected: true, rect: { x: slotX, y: 149, w: 281, h: 421 } },
  ],
});

const frameSample = (sequence, sampledAtUnixMs) => domSample(
  sequence,
  sampledAtUnixMs,
  "presentation-frame",
  slotXAt(sampledAtUnixMs),
);

const nativeEvent = (sampledAtUnixMs) => {
  const frame = { ...SLOT_FROM, x: slotXAt(sampledAtUnixMs) };
  return {
    sampledAtUnixMs,
    connected: true,
    slotFrame: frame,
    rendererFrame: frame,
    surfaceFrame: frame,
  };
};

// 표시 관측자의 고른 열. 거래 시작 직전 한 행, 거래 중 다섯 행, 착지 직후 한 행.
const DISPLAY_EPOCHS = Object.freeze([
  COMMIT_AT_UNIX_MS,
  START_AT_UNIX_MS + 60,
  START_AT_UNIX_MS + 128,
  START_AT_UNIX_MS + 196,
  START_AT_UNIX_MS + 264,
  START_AT_UNIX_MS + 332,
  START_AT_UNIX_MS + 400,
]);

// 거래 창 밖에서 뒤집힌 두 행. 판정 창은 거래가 소유하므로 여기서 일어난 역행은 표시 열에
// 실리지 않는다 — 그래도 결합은 한 칸 뒤로 간다.
const TAIL_EPOCHS = Object.freeze([START_AT_UNIX_MS + 536, START_AT_UNIX_MS + 468]);

function traceInput({ displayEpochs, tailEpochs }) {
  const frameEpochs = [...displayEpochs, ...tailEpochs];
  const domSamples = [
    domSample(0, COMMIT_AT_UNIX_MS - 54, "initial", SLOT_FROM.x),
    domSample(1, COMMIT_AT_UNIX_MS, "layout-dom-commit", SLOT_FROM.x),
    ...frameEpochs.map((at, index) => frameSample(index + 2, at)),
  ];
  return {
    events: [...displayEpochs, ...tailEpochs]
      .slice()
      .sort((left, right) => left - right)
      .map(nativeEvent),
    domSamples,
    owner: { rendererId: "pv-1", surfaceId: `b-${VIEW}` },
    targetViewId: VIEW,
    transactionId: TRANSACTION.transactionId,
    domCommittedAtUnixMs: COMMIT_AT_UNIX_MS,
    presentationStartAtUnixMs: START_AT_UNIX_MS,
    durationMs: DURATION_MS,
    moveDx: MOVE_DX,
    railAddress: "rail",
    paneAddress: "pane",
    slotAddress: "slot",
    clocks: { window: "unix-anchored-monotonic", presentation: "unix-anchored-monotonic", slot: "unix-anchored-monotonic" },
  };
}

function evidenceFor(trace) {
  const transition = (direction) => ({
    direction,
    targetViewId: VIEW,
    motionMode: TRANSACTION.mode,
    clocks: trace.clocks,
    journal: { afterSequence: 2, entries: normalizeB04JournalEntries([TRANSACTION]) },
    samples: trace.samples,
    timeline: trace.timeline,
  });
  return {
    engine: "browser-chromium",
    coordinateSpace: { logical: "css-px", scaleFactor: 1 },
    transitions: [transition("to-left"), transition("to-right")],
  };
}

describe("B04 DOM 짝 순서", () => {
  it("원장이 뒤집힌 자리에서도 결합을 끊지 않고 역행을 수로 싣는다", () => {
    const trace = mapB04PresentationSamples(traceInput({
      displayEpochs: DISPLAY_EPOCHS,
      tailEpochs: TAIL_EPOCHS,
    }));
    // 표본은 빼지 않는다. 빼면 뒤 표본이 앞으로 밀려 자리(index)로 세는 판정에서 구멍이
    // 사라지고, 재지 않은 것이 재서 통과한 것과 같은 값이 된다.
    expect(trace.joins).toHaveLength(DISPLAY_EPOCHS.length + TAIL_EPOCHS.length);
    expect(trace.pairing.domSequenceRegressions).toEqual(["[8]=9/10"]);
    expect(trace.joins.filter(({ domSequenceRegressed }) => domSequenceRegressed))
      .toHaveLength(1);
    expect(trace.joins.map(({ domSequence }) => domSequence))
      .toEqual([1, 3, 4, 5, 6, 7, 8, 10, 9]);
  });

  it("거래 창 밖의 역행은 그 거래의 판정을 물들이지 않는다", () => {
    const trace = mapB04PresentationSamples(traceInput({
      displayEpochs: DISPLAY_EPOCHS,
      tailEpochs: TAIL_EPOCHS,
    }));
    const verdict = judgeB04MachineEvidence(evidenceFor(trace));
    expect(verdict.evidence).not.toEqual(expect.arrayContaining([
      expect.stringContaining("sampledAtUnixMs"),
    ]));
    expect(verdict).toMatchObject({ status: "green", reason: null });
  });

  it("거래 창 안에서 뒤집힌 원장은 표시 열의 이름으로 red 가 된다", () => {
    const swapped = [...DISPLAY_EPOCHS];
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    const trace = mapB04PresentationSamples(traceInput({
      displayEpochs: swapped,
      tailEpochs: [],
    }));
    expect(trace.pairing.domSequenceRegressions).toHaveLength(1);
    const verdict = judgeB04MachineEvidence(evidenceFor(trace));
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining("timeline:slot[4]:sampledAtUnixMs="),
    ]));
  });

  it("역행 계수를 실행 산출물에 싣는다", () => {
    const matrix = readFileSync(resolve(import.meta.dirname, "browser-matrix.mjs"), "utf8");
    // 던지는 것은 측정 불가뿐이다. 역행 비교는 이름을 세는 자리로 남고 예외로 실행을 끊지 않는다.
    expect(matrix).not.toContain("domSequence < priorDomSequence) {");
    const run = readFileSync(resolve(import.meta.dirname, "../slot-freeze.mjs"), "utf8");
    expect(run).toContain("pairing: flowPresentationTrace.pairing");
  });
});
