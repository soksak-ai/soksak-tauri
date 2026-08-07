import { describe, expect, it } from "vitest";
import { mapB04PresentationSamples, normalizeB04JournalEntries } from "./browser-matrix.mjs";
import { judgeB04MachineEvidence } from "./browser-gates.mjs";

// 실측 RED 재현. evidence/slot-freeze/last-red/browser/01-left 의 composition-trace.json 과
// layout-transaction.json 에서 시각·rect 를 그대로 옮겼다. DOM sample 은 initial·DOM-commit·
// 시작/중간/착지 frame 만 남기고 sequence 를 다시 매겼으며 address 는 짧게 줄였다. 판정에
// 쓰이는 값(시각, rect, transaction epoch, dx)은 기록 그대로다.
const TRANSACTION = Object.freeze({
  closedAtUnixMs: 1_786_071_385_780,
  domCommittedAtUnixMs: 1_786_071_385_779,
  durationMs: 340,
  mode: "glide",
  moves: [{ dx: -160, viewId: "tab-gftlwv" }],
  phase: "committed",
  preparedAtUnixMs: 1_786_071_385_776,
  sequence: 3,
  startAtUnixMs: 1_786_071_385_870,
  transactionId: "layout-3",
});

// 원장 표본은 언제나 관측자 이름을 싣는다(ui.trace.multi 의 producers). 이 픽스처가 남긴
// presentation-frame 은 표시 callback 이 읽은 frame 이다.
const LEDGER_PRODUCER = Object.freeze({
  initial: "arm",
  "layout-dom-commit": "layout-commit",
  "presentation-frame": "frame-callback",
});

const domSample = (sequence, sampledAtUnixMs, trigger, railX, paneX, slotX) => ({
  sequence,
  sampledAtUnixMs,
  trigger,
  producer: LEDGER_PRODUCER[trigger],
  transactionId: trigger === "initial" ? null : TRANSACTION.transactionId,
  domCommittedAtUnixMs: trigger === "initial" ? null : TRANSACTION.domCommittedAtUnixMs,
  nodes: [
    { address: "rail", connected: true, rect: { x: railX, y: 82, w: 160, h: 518 } },
    { address: "pane", connected: true, rect: { x: paneX, y: 88, w: 281, h: 506 } },
    { address: "slot", connected: true, rect: { x: slotX, y: 149, w: 281, h: 421 } },
    { address: "pane-other", connected: true, rect: { x: 513, y: 88, w: 281, h: 506 } },
    { address: "slot-other", connected: true, rect: { x: 513, y: 149, w: 281, h: 421 } },
  ],
});

const DOM_SAMPLES = Object.freeze([
  domSample(0, 1_786_071_385_725, "initial", 347, 60, 60),
  domSample(1, 1_786_071_385_779, "layout-dom-commit", 347, 60, 60),
  domSample(2, 1_786_071_385_779, "presentation-frame", 347, 60, 60),
  domSample(3, 1_786_071_385_986, "presentation-frame", 207.1, 136.4, 136.4),
  domSample(4, 1_786_071_386_218, "presentation-frame", 54, 220, 220),
]);

// native display producer 가 낸 시각. 같은 `...UnixMs` 이름이지만 DOM/journal 보다
// 4,041,616ms 뒤처진 epoch다. frame 은 기록 그대로 이동 전 x 에 머문다.
const NATIVE_EVENTS = Object.freeze([
  { sampledAtUnixMs: 1_786_067_343_619.7163, x: 220 },
  { sampledAtUnixMs: 1_786_067_343_636.3967, x: 220 },
  { sampledAtUnixMs: 1_786_067_343_653.077, x: 60 },
  { sampledAtUnixMs: 1_786_067_343_786.52, x: 60 },
  { sampledAtUnixMs: 1_786_067_343_936.6433, x: 60 },
  { sampledAtUnixMs: 1_786_067_344_086.7668, x: 60 },
  { sampledAtUnixMs: 1_786_067_344_220.2097, x: 60 },
  { sampledAtUnixMs: 1_786_067_344_253.5706, x: 60 },
].map(({ sampledAtUnixMs, x }) => ({
  sampledAtUnixMs,
  connected: true,
  slotFrame: { x, y: 149, w: 281, h: 421 },
  rendererFrame: { x, y: 149, w: 281, h: 421 },
  surfaceFrame: { x, y: 149, w: 281, h: 421 },
})));

function observedEvidence(events) {
  const trace = mapB04PresentationSamples({
    events,
    domSamples: [...DOM_SAMPLES],
    owner: { rendererId: "pv-1", surfaceId: "b-tab-gftlwv" },
    targetViewId: TRANSACTION.moves[0].viewId,
    transactionId: TRANSACTION.transactionId,
    domCommittedAtUnixMs: TRANSACTION.domCommittedAtUnixMs,
    presentationStartAtUnixMs: TRANSACTION.startAtUnixMs,
    durationMs: TRANSACTION.durationMs,
    moveDx: TRANSACTION.moves[0].dx,
    railAddress: "rail",
    paneAddress: "pane",
    slotAddress: "slot",
  });
  const transition = (direction) => ({
    direction,
    targetViewId: TRANSACTION.moves[0].viewId,
    motionMode: TRANSACTION.mode,
    journal: { afterSequence: 2, entries: normalizeB04JournalEntries([TRANSACTION]) },
    samples: trace.samples,
    timeline: trace.timeline,
  });
  return {
    evidence: {
      engine: "browser",
      coordinateSpace: { logical: "css-px", scaleFactor: 1 },
      // B04는 두 방향을 함께 요구한다. 기록된 한 방향을 두 번 넣어 방향 개수 실패가
      // 실측 실패를 가리지 않게 한다.
      transitions: [transition("to-left"), transition("to-right")],
    },
    trace,
  };
}

describe("B04 실측 FLOW trace", () => {
  it("다른 epoch로 관측한 native producer를 좌표 delta가 아니라 epoch 거리로 이름 짓는다", () => {
    const { evidence, trace } = observedEvidence([...NATIVE_EVENTS]);
    // 모든 native 시각이 DOM commit epoch보다 작게 비교되어 전 event가 클릭 이전 DOM 표본에
    // 붙는다. 그래서 pane은 한 번도 움직이지 않은 것으로 기록된다.
    expect(trace.joins.map(({ trigger }) => trigger)).toEqual(
      new Array(NATIVE_EVENTS.length).fill("initial"),
    );
    expect(trace.samples.map(({ pane }) => pane.frame.x)).toEqual([60, 60]);
    expect(trace.timeline.renderer).toHaveLength(1);

    const verdict = judgeB04MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toEqual(expect.arrayContaining([
      // 원인: 두 producer가 같은 거래를 관측했다고 볼 수 없다.
      "B04:transitions[0].samples:presentation:window-gap=4041616.4294433594",
      "B04:transitions[0].timeline:renderer:window-gap=4041616.4294433594",
      "B04:transitions[0].timeline:surface:window-gap=4041616.4294433594",
      // 그 결과로 보고되던 증상들. 원인 없이 이 값들만 보면 native 표본이 모자란다거나
      // pane이 움직이지 않았다는 잘못된 결론에 이른다.
      'B04:transitions[0].composition:s0:renderer={"x":160,"y":0,"w":0,"h":0}',
      'B04:transitions[0].composition:s0:surface={"x":160,"y":0,"w":0,"h":0}',
      "B04:transitions[0].pane-dx=-160/0",
      "B04:transitions[0].pane-dx=non-zero/0",
    ]));
  });

  it("같은 좌표를 같은 epoch로 옮기면 증상이 사라지고 이동하지 않은 native ledger가 남는다", () => {
    // 기록된 native 시각을 실측 skew만큼 되돌린다. 좌표는 하나도 바꾸지 않는다.
    const skewMs = 1_786_071_385_725 - 1_786_067_343_619.7163;
    const { evidence, trace } = observedEvidence(NATIVE_EVENTS.map((event) => ({
      ...event,
      sampledAtUnixMs: event.sampledAtUnixMs + skewMs,
    })));
    // 이제 prepared 표본은 클릭 이전 DOM에, committed 표본은 착지 DOM에 붙는다.
    expect(trace.samples.map(({ pane }) => pane.frame.x)).toEqual([60, 220]);
    expect(trace.timeline.renderer.length).toBeGreaterThanOrEqual(3);

    const verdict = judgeB04MachineEvidence(evidence);
    const failures = verdict.evidence;
    expect(failures).not.toEqual(expect.arrayContaining([
      expect.stringContaining("window-gap"),
    ]));
    expect(failures).not.toEqual(expect.arrayContaining([
      expect.stringContaining("pane-dx"),
    ]));
    expect(failures).not.toEqual(expect.arrayContaining([
      expect.stringContaining("timeline:renderer:samples"),
    ]));
    // 남는 것은 실제 결함이다: native ledger가 거래 내내 이동 전 x(60)에 머물러 착지 시각에
    // 선언 궤적과 160 css px 어긋난다. 기준은 그대로 이 값을 RED로 센다.
    expect(verdict.status).toBe("red");
    expect(failures).toEqual(expect.arrayContaining([
      'B04:transitions[0].composition:s1:renderer={"x":160,"y":0,"w":0,"h":0}',
      'B04:transitions[0].composition:s1:surface={"x":160,"y":0,"w":0,"h":0}',
    ]));
  });
});
