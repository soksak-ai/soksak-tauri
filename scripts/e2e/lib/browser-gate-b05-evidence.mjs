import { mapWithWiring } from "./browser-machine-judge-support.mjs";

const field = (value, key) => value && typeof value === "object" && Object.hasOwn(value, key)
  ? value[key]
  : null;

const rect = (value) => ({
  x: field(value, "x"),
  y: field(value, "y"),
  w: field(value, "w"),
  h: field(value, "h"),
});

function surfaces(values) {
  if (!Array.isArray(values)) return null;
  return values.map((surface) => ({
    viewId: field(surface, "viewId"),
    surfaceId: field(surface, "surfaceId"),
    generation: field(surface, "generation"),
    live: field(surface, "live"),
    visible: field(surface, "visible"),
    painted: field(surface, "painted"),
    domFrame: rect(field(surface, "domFrame")),
    surfaceFrame: rect(field(surface, "surfaceFrame")),
  }));
}

function presentationEvents(values) {
  if (!Array.isArray(values)) return null;
  return values.map((event) => ({
    sequence: field(event, "sequence"),
    sourceGeneration: field(event, "sourceGeneration"),
    presentationRevision: field(event, "presentationRevision"),
    displayTimestampUnixMs: field(event, "displayTimestampUnixMs"),
    targetTimestampUnixMs: field(event, "targetTimestampUnixMs"),
    callbackObservedAtUnixMs: field(event, "callbackObservedAtUnixMs"),
    refreshIntervalMs: field(event, "refreshIntervalMs"),
    presentedAtUnixMs: field(event, "presentedAtUnixMs"),
    surfaces: surfaces(field(event, "surfaces")),
  }));
}

function moves(values) {
  if (!Array.isArray(values)) return null;
  return values.map((move) => ({ viewId: field(move, "viewId"), dx: field(move, "dx") }));
}

/**
 * 한 전이 인계 기록을 판정 스키마로 옮긴다.
 *
 * 하니스가 전이마다 짓는 기록은 통째로 이 mapper 를 위한 것이다. 그래서 그 기록의 필드는 손으로
 * 나열하지 않고 배선 장부를 통해 읽는다 — 이름이 한쪽에서만 바뀌면 값이 null 로 뭉개지는 대신
 * 양쪽 이름이 판정에 실린다.
 */
function mapTransition(raw, index) {
  return mapWithWiring(raw, `B05.transition[${index}]`, (checkpoint) => {
    const presentationReceipt = checkpoint.take("presentation") ?? null;
    const presentation = presentationReceipt?.trace ?? presentationReceipt;
    const click = checkpoint.take("clickReceipt") ?? null;
    const layout = checkpoint.take("layout") ?? null;
    // 정착·유지는 코어 정착 영수증과 display 원장을 결합한 것이다(browser-gate-b05-hold.mjs).
    // 그 결합을 여기서 다시 하지 않는다 — 한 사실은 한 자리에서만 만든다.
    const settlement = checkpoint.take("settlement") ?? null;
    return {
      direction: checkpoint.take("direction") ?? null,
      targetViewId: checkpoint.take("targetViewId") ?? null,
      trace: {
        traceId: field(presentation, "traceId"),
        // 규칙 — 시계 선언: 이 인과 사슬은 네 영수증의 시각을 한 줄로 세운다. 같은 접미사가
        // 같은 시계를 뜻하지 않으므로, 네 영수증이 각자 답한 시계를 그대로 싣는다.
        clocks: {
          presentation: field(presentation, "clock"),
          stimulus: field(click, "clock"),
          layout: field(layout, "clock"),
          settlement: field(settlement, "clock"),
        },
        closed: field(presentation, "closed"),
        ownerViewIds: Array.isArray(presentation?.ownerViewIds)
          ? [...presentation.ownerViewIds]
          : null,
        armedAtUnixMs: field(presentation, "armedAtUnixMs"),
        stimulus: {
          address: field(click, "address"),
          atUnixMs: field(click, "atUnixMs"),
        },
        layout: {
          transactionId: field(layout, "transactionId"),
          causeTraceId: field(layout, "causeTraceId"),
          phase: field(layout, "phase"),
          mode: field(layout, "mode"),
          startAtUnixMs: field(layout, "startAtUnixMs"),
          preparedAtUnixMs: field(layout, "preparedAtUnixMs"),
          closedAtUnixMs: field(layout, "closedAtUnixMs"),
          moves: moves(field(layout, "moves")),
        },
        baselineFrameSequence: field(presentation, "baselineFrameSequence"),
        presentationEvents: presentationEvents(field(presentation, "presentationEvents")),
        settled: {
          atUnixMs: field(settlement?.settled, "atUnixMs"),
          frameSequence: field(settlement?.settled, "frameSequence"),
          syncPending: field(settlement?.settled, "syncPending"),
        },
        hold: {
          startedAtUnixMs: field(settlement?.hold, "startedAtUnixMs"),
          endedAtUnixMs: field(settlement?.hold, "endedAtUnixMs"),
          surfaces: surfaces(field(settlement?.hold, "surfaces")),
        },
        violations: {
          replacements: field(presentation?.violations, "replacements"),
          gaps: field(presentation?.violations, "gaps"),
          disappearances: field(presentation?.violations, "disappearances"),
          unpresented: field(presentation?.violations, "unpresented"),
          droppedEvents: field(presentation?.violations, "droppedEvents"),
        },
        observation: {
          callbackIntervalsSkipped: field(presentation?.observation, "callbackIntervalsSkipped"),
          maxCallbackLatencyMs: field(presentation?.observation, "maxCallbackLatencyMs"),
        },
      },
    };
  });
}

/** Joins only acknowledged public click/layout/presentation/settlement receipts. */
export function mapB05LiveEvidence(raw = {}) {
  return mapWithWiring(raw, "B05.live", (checkpoint) => {
    const transitions = checkpoint.take("transitions");
    return {
      engine: checkpoint.take("engine") ?? null,
      transitions: Array.isArray(transitions) ? transitions.map(mapTransition) : null,
    };
  });
}
