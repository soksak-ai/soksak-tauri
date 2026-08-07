import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

/**
 * 네 영수증이 같은 시계를 답했는가. 답이 하나면 그 이름을, 갈렸거나 없으면 null 을 낸다.
 *
 * 크기로 가르지 않는다 — 4,041,616ms 와 3,630ms 는 크기가 다를 뿐 같은 답을 받을 이유가 없다.
 * 무엇을 선언했는가가 가른다.
 */
const B05_CLOCK_KEYS = Object.freeze(["presentation", "stimulus", "layout", "settlement"]);

function sameB05Clock(clocks, path, failures, unmeasured) {
  if (!requireExactKeys(clocks, B05_CLOCK_KEYS, `${path}.clocks`, failures)) return null;
  const declared = B05_CLOCK_KEYS.map((key) => (
    hasText(clocks[key]) ? clocks[key] : null
  ));
  const named = () => B05_CLOCK_KEYS
    .map((key, index) => `${key}=${declared[index] ?? "none"}`)
    .join(",");
  // 시계가 갈린 것과 안 밝힌 것은 다른 답이다. 갈렸으면 그 둘을 한 창에서 맞댄 것 자체가
  // 계약 위반이고(red), 안 밝혔으면 맞댈 기준이 없는 것이라 못 잼이다.
  if (declared.some((value) => value === null)) {
    unmeasured.push(`${path}.clocks-undeclared=${named()}`);
    return null;
  }
  const [expected] = declared;
  if (declared.some((value) => value !== expected)) {
    failures.push(`${path}.clocks=one/${named()}`);
    return null;
  }
  return expected;
}

const DIRECTIONS = Object.freeze(["to-left", "to-right"]);
const MAX_FIRST_PRESENTED_MS = 50;
const MAX_ACTIVE_FRAME_GAP_MS = 50;
const MAX_CLICK_TO_SETTLED_MS = 550;
const POST_SETTLE_HOLD_MS = 250;
const ROUNDING_TOLERANCE_PX = 1;
const VIOLATION_KEYS = Object.freeze([
  "replacements",
  "gaps",
  "disappearances",
  "unpresented",
  "droppedEvents",
]);

function inspectRect(value, path, failures) {
  if (!requireExactKeys(value, ["x", "y", "w", "h"], path, failures)) return false;
  let valid = true;
  for (const field of ["x", "y", "w", "h"]) {
    if (!Number.isFinite(value[field]) || ((field === "w" || field === "h") && value[field] <= 0)) {
      failures.push(`${path}.${field}=finite${field === "w" || field === "h" ? ">0" : ""}/${displayValue(value[field])}`);
      valid = false;
    }
  }
  return valid;
}

function inspectSurface(surface, path, failures) {
  if (!requireExactKeys(surface, [
    "viewId", "surfaceId", "generation", "live", "visible", "painted", "domFrame", "surfaceFrame",
  ], path, failures)) return false;
  if (!hasText(surface.viewId)) failures.push(`${path}.viewId=non-empty/${displayValue(surface.viewId)}`);
  if (!hasText(surface.surfaceId)) failures.push(`${path}.surfaceId=non-empty/${displayValue(surface.surfaceId)}`);
  if (!Number.isInteger(surface.generation) || surface.generation < 1) {
    failures.push(`${path}.generation=integer>=1/${displayValue(surface.generation)}`);
  }
  for (const field of ["live", "visible", "painted"]) {
    if (surface[field] !== true) failures.push(`${path}.${field}=true/${displayValue(surface[field])}`);
  }
  const domValid = inspectRect(surface.domFrame, `${path}.domFrame`, failures);
  const surfaceValid = inspectRect(surface.surfaceFrame, `${path}.surfaceFrame`, failures);
  if (domValid && surfaceValid) {
    for (const field of ["x", "y", "w", "h"]) {
      const delta = Math.abs(surface.domFrame[field] - surface.surfaceFrame[field]);
      if (delta > ROUNDING_TOLERANCE_PX) {
        failures.push(`${path}.${field}.delta<=${ROUNDING_TOLERANCE_PX}/${delta}`);
      }
    }
  }
  return true;
}

function inspectInventory(surfaces, owners, path, failures) {
  if (!Array.isArray(surfaces)) {
    failures.push(`${path}=array/${displayValue(surfaces)}`);
    return null;
  }
  const byOwner = new Map();
  surfaces.forEach((surface, index) => {
    const at = `${path}[${index}]`;
    if (!inspectSurface(surface, at, failures)) return;
    if (byOwner.has(surface.viewId)) failures.push(`${at}.viewId=unique/${surface.viewId}`);
    else byOwner.set(surface.viewId, surface);
  });
  const actual = [...byOwner.keys()].sort();
  if (actual.join("\u0000") !== owners.join("\u0000")) {
    failures.push(`${path}.owners=${owners.join(",")}/${actual.join(",")}`);
  }
  return byOwner;
}

function sameSurfaceIdentity(actual, expected, owners) {
  return owners.every((owner) => {
    const left = actual.get(owner);
    const right = expected.get(owner);
    return left && right
      && left.surfaceId === right.surfaceId
      && left.generation === right.generation;
  });
}

function sameInventory(actual, expected, owners) {
  return owners.every((owner) => JSON.stringify(actual.get(owner)) === JSON.stringify(expected.get(owner)));
}

function inspectTransition(transition, index, failures, unmeasured, traceIds) {
  const path = `transitions[${index}]`;
  if (!requireExactKeys(transition, ["direction", "targetViewId", "trace"], path, failures)) return;
  if (!DIRECTIONS.includes(transition.direction)) failures.push(`${path}.direction=known/${displayValue(transition.direction)}`);
  if (!hasText(transition.targetViewId)) failures.push(`${path}.targetViewId=non-empty/${displayValue(transition.targetViewId)}`);

  const trace = transition.trace;
  if (!requireExactKeys(trace, [
    "traceId", "clocks", "closed", "ownerViewIds", "armedAtUnixMs", "stimulus", "layout",
    "baselineFrameSequence", "presentationEvents", "settled", "hold", "violations",
    "observation",
  ], `${path}.trace`, failures)) return;
  // 규칙 — 시계 선언: 이 게이트의 판정은 네 영수증의 시각을 한 줄로 세운 인과 사슬이다.
  // `...UnixMs` 라는 같은 이름은 같은 시계를 뜻하지 않으므로, 넷이 같은 이름을 답할 때만 그
  // 사슬이 성립한다. 선언이 갈리면 지연·순서를 재는 대신 그 사실 하나를 이름으로 낸다 —
  // 안 그러면 시계 차이가 flicker·지연·역행이라는 네 증상으로 흩어져 보고된다.
  const declaredClocks = sameB05Clock(trace.clocks, `${path}.trace`, failures, unmeasured);
  if (!hasText(trace.traceId) || traceIds.has(trace.traceId)) {
    failures.push(`${path}.trace.traceId=unique-non-empty/${displayValue(trace.traceId)}`);
  } else traceIds.add(trace.traceId);
  // 안 답한 자리(null)와 틀린 값은 다른 답이다. 자기 궤적을 가진 구현은 코어 원장이 답하는 값을
  // 다 답하지 못할 수 있고, 계약이 그 자리를 null 로 두는 것은 지어내지 않기 위해서다 — 그
  // null 을 "틀린 값" 으로 읽으면 없는 사실이 red 가 된다. 답했는데 틀리면 여전히 red 다.
  if (trace.closed === null) unmeasured.push(`${path}.trace.closed-unanswered`);
  else if (trace.closed !== true) failures.push(`${path}.trace.closed=true/${displayValue(trace.closed)}`);
  if (trace.armedAtUnixMs === null) unmeasured.push(`${path}.trace.armedAtUnixMs-unanswered`);
  else if (!Number.isFinite(trace.armedAtUnixMs)) {
    failures.push(`${path}.trace.armedAtUnixMs=finite/${displayValue(trace.armedAtUnixMs)}`);
  }

  const owners = Array.isArray(trace.ownerViewIds) ? [...trace.ownerViewIds].sort() : [];
  if (owners.length === 0 || owners.some((owner) => !hasText(owner)) || new Set(owners).size !== owners.length) {
    failures.push(`${path}.trace.ownerViewIds=unique-non-empty/${displayValue(trace.ownerViewIds)}`);
  }
  if (!owners.includes(transition.targetViewId)) failures.push(`${path}.targetViewId=owner/${displayValue(transition.targetViewId)}`);

  if (requireExactKeys(trace.stimulus, ["address", "atUnixMs"], `${path}.trace.stimulus`, failures)) {
    if (!hasText(trace.stimulus.address)) failures.push(`${path}.trace.stimulus.address=non-empty`);
    if (!Number.isFinite(trace.stimulus.atUnixMs)) failures.push(`${path}.trace.stimulus.atUnixMs=finite/${displayValue(trace.stimulus.atUnixMs)}`);
  }

  if (requireExactKeys(trace.layout, [
    "transactionId", "causeTraceId", "phase", "mode", "startAtUnixMs",
    "preparedAtUnixMs", "closedAtUnixMs", "moves",
  ], `${path}.trace.layout`, failures)) {
    if (!hasText(trace.layout.transactionId)) failures.push(`${path}.trace.layout.transactionId=non-empty`);
    if (trace.layout.causeTraceId !== trace.traceId) failures.push(`${path}.trace.layout.causeTraceId=traceId`);
    if (trace.layout.phase !== "committed") failures.push(`${path}.trace.layout.phase=committed/${displayValue(trace.layout.phase)}`);
    if (!new Set(["glide", "snap"]).has(trace.layout.mode)) failures.push(`${path}.trace.layout.mode=glide|snap/${displayValue(trace.layout.mode)}`);
    if (!Number.isFinite(trace.layout.preparedAtUnixMs) || !Number.isFinite(trace.layout.closedAtUnixMs)
        || trace.layout.preparedAtUnixMs > trace.layout.closedAtUnixMs) {
      failures.push(`${path}.trace.layout.times=prepared<=closed`);
    }
    if (trace.layout.mode === "snap" && trace.layout.startAtUnixMs !== null) {
      failures.push(`${path}.trace.layout.startAtUnixMs=null-for-snap`);
    }
    if (trace.layout.mode === "glide" && (!Number.isFinite(trace.layout.startAtUnixMs)
        || trace.layout.startAtUnixMs < trace.layout.preparedAtUnixMs
        || trace.layout.startAtUnixMs > trace.layout.closedAtUnixMs)) {
      failures.push(`${path}.trace.layout.startAtUnixMs=within-transaction`);
    }
    if (!Array.isArray(trace.layout.moves) || !trace.layout.moves.some((move) => (
      requireExactKeys(move, ["viewId", "dx"], `${path}.trace.layout.moves[]`, failures)
      && move.viewId === transition.targetViewId && Number.isFinite(move.dx) && Math.abs(move.dx) >= 0.5
    ))) failures.push(`${path}.trace.layout.moves=target-non-zero`);
  }

  if (!Array.isArray(trace.presentationEvents) || trace.presentationEvents.length < 2) {
    failures.push(`${path}.trace.presentationEvents=at-least-2/${displayValue(trace.presentationEvents?.length)}`);
    return;
  }
  const eventBySequence = new Map();
  const firstIdentity = new Map();
  let firstGeneration = null;
  let previousRevision = 0;
  let previousAt = -Infinity;
  trace.presentationEvents.forEach((event, eventIndex) => {
    const at = `${path}.trace.presentationEvents[${eventIndex}]`;
    if (!requireExactKeys(event, [
      "sequence", "sourceGeneration", "presentationRevision", "displayTimestampUnixMs",
      "targetTimestampUnixMs", "callbackObservedAtUnixMs", "refreshIntervalMs",
      "presentedAtUnixMs", "surfaces",
    ], at, failures)) return;
    if (!Number.isInteger(event.sequence) || event.sequence !== eventIndex) failures.push(`${at}.sequence=${eventIndex}/${displayValue(event.sequence)}`);
    if (!Number.isInteger(event.sourceGeneration) || event.sourceGeneration < 1) failures.push(`${at}.sourceGeneration=integer>=1`);
    if (firstGeneration === null) firstGeneration = event.sourceGeneration;
    else if (event.sourceGeneration !== firstGeneration) failures.push(`${at}.sourceGeneration=stable/${firstGeneration}/${event.sourceGeneration}`);
    if (!Number.isInteger(event.presentationRevision) || event.presentationRevision <= previousRevision) {
      failures.push(`${at}.presentationRevision=strict-increase/${previousRevision}/${displayValue(event.presentationRevision)}`);
    }
    if (!Number.isFinite(event.presentedAtUnixMs) || event.presentedAtUnixMs <= previousAt) {
      failures.push(`${at}.presentedAtUnixMs=strict-increase/${previousAt}/${displayValue(event.presentedAtUnixMs)}`);
    }
    for (const field of [
      "displayTimestampUnixMs", "targetTimestampUnixMs", "callbackObservedAtUnixMs", "refreshIntervalMs",
    ]) {
      if (!Number.isFinite(event[field])) failures.push(`${at}.${field}=finite/${displayValue(event[field])}`);
    }
    if (Number.isFinite(event.displayTimestampUnixMs)
        && event.presentedAtUnixMs !== event.displayTimestampUnixMs) {
      failures.push(`${at}.presentedAtUnixMs=displayTimestampUnixMs`);
    }
    if (Number.isFinite(event.displayTimestampUnixMs)
        && Number.isFinite(event.targetTimestampUnixMs)
        && event.targetTimestampUnixMs <= event.displayTimestampUnixMs) {
      failures.push(`${at}.targetTimestampUnixMs>displayTimestampUnixMs`);
    }
    if (Number.isFinite(event.refreshIntervalMs) && event.refreshIntervalMs <= 0) {
      failures.push(`${at}.refreshIntervalMs>0`);
    }
    previousRevision = event.presentationRevision;
    previousAt = event.presentedAtUnixMs;
    const inventory = inspectInventory(event.surfaces, owners, `${at}.surfaces`, failures);
    if (inventory) {
      if (firstIdentity.size === 0) for (const [owner, surface] of inventory) firstIdentity.set(owner, surface);
      else if (!sameSurfaceIdentity(inventory, firstIdentity, owners)) failures.push(`${at}.surface-identity=stable`);
    }
    eventBySequence.set(event.sequence, { event, inventory });
  });

  if (!Number.isInteger(trace.baselineFrameSequence) || !eventBySequence.has(trace.baselineFrameSequence)) {
    failures.push(`${path}.trace.baselineFrameSequence=event/${displayValue(trace.baselineFrameSequence)}`);
  }
  const baseline = eventBySequence.get(trace.baselineFrameSequence)?.event;
  // 시계가 갈렸으면 아래 시각 비교는 궤적이 아니라 시계 차이를 잰다. 원인을 이미 이름으로
  // 냈으므로 그 위에 증상을 겹쳐 적지 않는다.
  if (declaredClocks === null) return;
  // 안 답한 값으로 순서를 비교하면 없는 사실이 증상으로 번진다 — 원인은 위에서 이름을 냈다.
  if (trace.armedAtUnixMs === null) return;
  const postClickEvents = trace.presentationEvents.filter((event) => event.presentedAtUnixMs >= trace.stimulus.atUnixMs);
  if (!baseline || !(trace.armedAtUnixMs <= baseline.presentedAtUnixMs
      && baseline.presentedAtUnixMs <= trace.stimulus.atUnixMs)) {
    failures.push(`${path}.trace.baseline=armed<=baseline<=stimulus`);
  }
  if (postClickEvents.length === 0
      || postClickEvents[0].presentedAtUnixMs - trace.stimulus.atUnixMs > MAX_FIRST_PRESENTED_MS) {
    failures.push(`${path}.trace.firstPresentedLatency<=${MAX_FIRST_PRESENTED_MS}`);
  }

  if (requireExactKeys(trace.settled, ["atUnixMs", "frameSequence", "syncPending"], `${path}.trace.settled`, failures)) {
    if (trace.settled.syncPending !== false) failures.push(`${path}.trace.settled.syncPending=false`);
    if (!Number.isFinite(trace.settled.atUnixMs)
        || trace.settled.atUnixMs - trace.stimulus.atUnixMs > MAX_CLICK_TO_SETTLED_MS) {
      failures.push(`${path}.trace.settleLatency<=${MAX_CLICK_TO_SETTLED_MS}`);
    }
    const settledEvent = eventBySequence.get(trace.settled.frameSequence)?.event;
    if (!settledEvent || settledEvent.presentedAtUnixMs > trace.settled.atUnixMs
        || trace.settled.atUnixMs - settledEvent.presentedAtUnixMs > MAX_ACTIVE_FRAME_GAP_MS) {
      failures.push(`${path}.trace.settled.frameSequence=recent-event`);
    }
    const active = trace.presentationEvents.filter((event) => (
      event.presentedAtUnixMs >= trace.stimulus.atUnixMs && event.presentedAtUnixMs <= trace.settled.atUnixMs
    ));
    for (let activeIndex = 1; activeIndex < active.length; activeIndex += 1) {
      const gap = active[activeIndex].presentedAtUnixMs - active[activeIndex - 1].presentedAtUnixMs;
      if (gap > MAX_ACTIVE_FRAME_GAP_MS) failures.push(`${path}.trace.activeFrameGap<=${MAX_ACTIVE_FRAME_GAP_MS}/${gap}`);
    }
  }

  if (requireExactKeys(trace.hold, ["startedAtUnixMs", "endedAtUnixMs", "surfaces"], `${path}.trace.hold`, failures)) {
    if (!Number.isFinite(trace.hold.startedAtUnixMs) || !Number.isFinite(trace.hold.endedAtUnixMs)
        || trace.hold.startedAtUnixMs < trace.settled.atUnixMs
        || trace.hold.endedAtUnixMs - trace.hold.startedAtUnixMs < POST_SETTLE_HOLD_MS) {
      failures.push(`${path}.trace.hold=after-settle-and>=${POST_SETTLE_HOLD_MS}ms`);
    }
    const held = inspectInventory(trace.hold.surfaces, owners, `${path}.trace.hold.surfaces`, failures);
    const settledInventory = eventBySequence.get(trace.settled.frameSequence)?.inventory;
    if (held && settledInventory && !sameInventory(held, settledInventory, owners)) {
      failures.push(`${path}.trace.hold.surfaces=settled-inventory`);
    }
  }

  if (requireExactKeys(trace.violations, VIOLATION_KEYS, `${path}.trace.violations`, failures)) {
    // gaps 는 **관측된 사건들의 표시 시각 차**로 계산된다. 관측자가 콜백을 놓치면 그 프레임을
    // 아예 못 보고 다음 사건의 간격이 벌어져 gaps 가 오른다 — 합성기는 정상으로 표시했는데도.
    // 그 둘을 계산으로 가를 수 없으므로 관측 자기보고가 가른다.
    const observerMissed = Number(trace.observation?.callbackIntervalsSkipped);
    for (const key of VIOLATION_KEYS) {
      if (trace.violations[key] === 0) continue;
      if (key === "gaps" && Number.isFinite(observerMissed) && observerMissed > 0) {
        unmeasured.push(
          `${path}.trace.violations.gaps=${displayValue(trace.violations.gaps)}`
          + ` (callbackIntervalsSkipped=${displayValue(observerMissed)})`,
        );
        continue;
      }
      failures.push(`${path}.trace.violations.${key}=0/${displayValue(trace.violations[key])}`);
    }
  }

  if (requireExactKeys(trace.observation, [
    "callbackIntervalsSkipped", "maxCallbackLatencyMs",
  ], `${path}.trace.observation`, failures)) {
    // 관측자가 놓친 콜백은 제품의 결함이 아니라 이 실행의 관측 한계다 — red 로 적으면 JS
    // 스레드가 한 번 밀렸느냐가 판정을 가른다. 못 잼은 통과가 아니라 다른 이름이다.
    if (!Number.isInteger(trace.observation.callbackIntervalsSkipped)) {
      failures.push(`${path}.trace.observation.callbackIntervalsSkipped=integer/${displayValue(trace.observation.callbackIntervalsSkipped)}`);
    } else if (trace.observation.callbackIntervalsSkipped !== 0) {
      unmeasured.push(`${path}.trace.observation.callbackIntervalsSkipped=${displayValue(trace.observation.callbackIntervalsSkipped)}`);
    }
    if (!Number.isFinite(trace.observation.maxCallbackLatencyMs)
        || trace.observation.maxCallbackLatencyMs < 0) {
      failures.push(`${path}.trace.observation.maxCallbackLatencyMs=finite>=0/${displayValue(trace.observation.maxCallbackLatencyMs)}`);
    }
  }

  const ordered = [
    trace.armedAtUnixMs,
    baseline?.presentedAtUnixMs,
    trace.stimulus.atUnixMs,
    trace.layout.preparedAtUnixMs,
    trace.layout.closedAtUnixMs,
    trace.settled.atUnixMs,
    trace.hold.startedAtUnixMs,
    trace.hold.endedAtUnixMs,
  ];
  if (ordered.some((value) => !Number.isFinite(value))
      || ordered.some((value, orderedIndex) => orderedIndex > 0 && value < ordered[orderedIndex - 1])) {
    failures.push(`${path}.trace.causal-times=armed<=baseline<=stimulus<=prepared<=closed<=settled<=hold`);
  }
}

/** 실제 presentation 사건 원장만 판정한다. 녹화·PNG·stats 시점 추론은 이 입력에 들어올 수 없다. */
export function judgeB05MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  const unmeasured = [];
  if (!requireExactKeys(value, ["engine", "transitions"], "evidence", failures)) {
    return finishMachineVerdict("B05", failures, "B05:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (!Array.isArray(value.transitions) || value.transitions.length < 2) {
    failures.push(`transitions=at-least-2/${displayValue(value.transitions?.length)}`);
  } else {
    const traceIds = new Set();
    value.transitions.forEach((transition, index) => inspectTransition(transition, index, failures, unmeasured, traceIds));
    const directions = new Set(value.transitions.map((transition) => transition?.direction));
    for (const direction of DIRECTIONS) if (!directions.has(direction)) failures.push(`direction=${direction}=missing`);
  }
  return finishMachineVerdict(
    "B05",
    failures,
    `${value.engine}/B05:actual-presentation-events;stable-surface;rounding-only;hold=${POST_SETTLE_HOLD_MS}ms`,
    unmeasured,
  );
}
