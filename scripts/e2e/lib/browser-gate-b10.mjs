import { compositionInventoryVerdict } from "../../../packages/dom-webview-compositor/src/index.ts";
import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

const PHASES = Object.freeze(["shrink", "wide", "tall", "restore"]);
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const SNAPSHOT_KEYS = Object.freeze([
  "windowGeometry",
  "eventGeneration",
  "transactionGeneration",
  "visibleViewIds",
  "slots",
  "renderers",
  "surfaces",
  "presentations",
]);
const PARTICIPANT_KEYS = Object.freeze([
  "id",
  "viewId",
  "topologyPath",
  "visible",
  "logicalFrame",
  "physicalFrame",
]);
const PRESENTATION_KEYS = Object.freeze([
  "viewId",
  "surfaceId",
  "surfaceGeneration",
  "revision",
  "live",
  "visible",
  "presented",
]);
const TRANSACTION_KEYS = Object.freeze([
  "sequence",
  "phase",
  "requestedWindowGeometry",
  "eventGenerationBefore",
  "eventGenerationAfter",
  "transactionGeneration",
  "continuity",
  "post",
]);
const COUNTER_KEYS = Object.freeze([
  "replacements",
  "gaps",
  "disappearances",
  "unpresented",
]);
const COMPOSITION_KEYS = Object.freeze(["observer", "steps"]);
const COMPOSITION_STEP_KEYS = Object.freeze(["sequence", "acknowledged", "violations"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(",")}}`;
}

function inspectRect(value, path, failures, { physical = false } = {}) {
  if (!requireExactKeys(value, RECT_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of RECT_KEYS) {
    const number = value[key];
    if (!Number.isFinite(number)
        || (physical && !Number.isInteger(number))
        || ((key === "w" || key === "h") && number <= 0)) {
      failures.push(
        `${path}.${key}=${physical ? "integer" : "finite"}`
          + `${key === "w" || key === "h" ? ">0" : ""}/${displayValue(number)}`,
      );
      valid = false;
    }
  }
  return valid;
}

function inspectGeneration(value, path, failures) {
  if (!Number.isInteger(value) || value < 0) {
    failures.push(`${path}=integer>=0/${displayValue(value)}`);
    return false;
  }
  return true;
}

function inspectVisibleViewIds(value, path, failures) {
  if (!Array.isArray(value)
      || value.length === 0
      || value.some((viewId) => !hasText(viewId))
      || new Set(value).size !== value.length) {
    failures.push(`${path}=unique-non-empty-strings/${displayValue(value)}`);
    return null;
  }
  return [...value].sort();
}

function inspectParticipants(value, kind, path, failures) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${path}=non-empty-array/${displayValue(value)}`);
    return null;
  }
  const byView = new Map();
  const ids = new Set();
  value.forEach((participant, index) => {
    const participantPath = `${path}[${index}]`;
    if (!requireExactKeys(participant, PARTICIPANT_KEYS, participantPath, failures)) return;
    let valid = true;
    if (!hasText(participant.id) || ids.has(participant.id)) {
      failures.push(`${participantPath}.id=unique-non-empty/${displayValue(participant.id)}`);
      valid = false;
    } else ids.add(participant.id);
    if (!hasText(participant.viewId) || byView.has(participant.viewId)) {
      failures.push(`${participantPath}.viewId=unique-non-empty/${displayValue(participant.viewId)}`);
      valid = false;
    }
    if (!hasText(participant.topologyPath)) {
      failures.push(`${participantPath}.topologyPath=non-empty/${displayValue(participant.topologyPath)}`);
      valid = false;
    }
    if (participant.visible !== true) {
      failures.push(`${participantPath}.visible=true/${displayValue(participant.visible)}`);
      valid = false;
    }
    if (!inspectRect(participant.logicalFrame, `${participantPath}.logicalFrame`, failures)) valid = false;
    if (!inspectRect(
      participant.physicalFrame,
      `${participantPath}.physicalFrame`,
      failures,
      { physical: true },
    )) valid = false;
    if (valid) byView.set(participant.viewId, participant);
  });
  return byView;
}

function inspectPresentations(value, owners, surfaces, path, failures) {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${path}=non-empty-array/${displayValue(value)}`);
    return null;
  }
  const byView = new Map();
  value.forEach((presentation, index) => {
    const presentationPath = `${path}[${index}]`;
    if (!requireExactKeys(presentation, PRESENTATION_KEYS, presentationPath, failures)) return;
    let valid = true;
    if (!hasText(presentation.viewId) || byView.has(presentation.viewId)) {
      failures.push(`${presentationPath}.viewId=unique-non-empty/${displayValue(presentation.viewId)}`);
      valid = false;
    }
    if (!hasText(presentation.surfaceId)) {
      failures.push(`${presentationPath}.surfaceId=non-empty/${displayValue(presentation.surfaceId)}`);
      valid = false;
    }
    if (!Number.isInteger(presentation.surfaceGeneration) || presentation.surfaceGeneration < 1) {
      failures.push(
        `${presentationPath}.surfaceGeneration=integer>=1/`
          + `${displayValue(presentation.surfaceGeneration)}`,
      );
      valid = false;
    }
    if (!Number.isInteger(presentation.revision) || presentation.revision < 1) {
      failures.push(`${presentationPath}.revision=integer>=1/${displayValue(presentation.revision)}`);
      valid = false;
    }
    for (const field of ["live", "visible", "presented"]) {
      if (presentation[field] !== true) {
        failures.push(`${presentationPath}.${field}=true/${displayValue(presentation[field])}`);
        valid = false;
      }
    }
    const surface = surfaces?.get(presentation.viewId);
    if (surface && presentation.surfaceId !== surface.id) {
      failures.push(
        `${presentationPath}.surfaceId=public-surface-id/`
          + `${displayValue(surface.id)}/${displayValue(presentation.surfaceId)}`,
      );
      valid = false;
    }
    if (valid) byView.set(presentation.viewId, presentation);
  });
  if (owners && canonical([...byView.keys()].sort()) !== canonical(owners)) {
    failures.push(`${path}.owners=${displayValue(owners)}/${displayValue([...byView.keys()].sort())}`);
  }
  return byView;
}

function inspectSnapshot(value, path, coordinateSpace, failures) {
  if (!requireExactKeys(value, SNAPSHOT_KEYS, path, failures)) return null;
  const windowValid = inspectRect(value.windowGeometry, `${path}.windowGeometry`, failures);
  const eventValid = inspectGeneration(value.eventGeneration, `${path}.eventGeneration`, failures);
  const transactionValid = inspectGeneration(
    value.transactionGeneration,
    `${path}.transactionGeneration`,
    failures,
  );
  const owners = inspectVisibleViewIds(value.visibleViewIds, `${path}.visibleViewIds`, failures);
  const slots = inspectParticipants(value.slots, "slot", `${path}.slots`, failures);
  const renderers = inspectParticipants(value.renderers, "renderer", `${path}.renderers`, failures);
  const surfaces = inspectParticipants(value.surfaces, "surface", `${path}.surfaces`, failures);
  const presentations = inspectPresentations(
    value.presentations,
    owners,
    surfaces,
    `${path}.presentations`,
    failures,
  );

  let inventoryValid = false;
  if (isRecord(coordinateSpace)) {
    try {
      const verdict = compositionInventoryVerdict({
        coordinateSpace,
        visibleViewIds: value.visibleViewIds,
        slots: value.slots,
        renderers: value.renderers,
        surfaces: value.surfaces,
      });
      failures.push(...verdict.errors.map((error) => `${path}.inventory:${error}`));
      inventoryValid = verdict.ok;
    } catch (error) {
      failures.push(`${path}.inventory=invalid/${displayValue(error instanceof Error ? error.message : error)}`);
    }
  }

  if (!(windowValid && eventValid && transactionValid && owners && slots
      && renderers && surfaces && presentations && inventoryValid)) return null;
  return {
    value,
    owners,
    participants: { slots, renderers, surfaces },
    presentations,
  };
}

function inspectCounters(value, path, failures) {
  if (!requireExactKeys(value, COUNTER_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of COUNTER_KEYS) {
    if (!Number.isInteger(value[key]) || value[key] !== 0) {
      failures.push(`${path}.${key}=0/${displayValue(value[key])}`);
      valid = false;
    }
  }
  return valid;
}

function inspectContinuity(value, path, failures) {
  if (!requireExactKeys(value, ["countersBefore", "countersAfter"], path, failures)) return;
  inspectCounters(value.countersBefore, `${path}.countersBefore`, failures);
  inspectCounters(value.countersAfter, `${path}.countersAfter`, failures);
}

function sameRect(a, b) {
  return a != null && b != null && RECT_KEYS.every((key) => a[key] === b[key]);
}

function compareStableOwnersAndIdentities(baseline, current, path, failures) {
  if (!(baseline && current)) return;
  if (canonical(baseline.owners) !== canonical(current.owners)) {
    failures.push(`${path}.visibleViewIds=baseline`);
  }
  for (const owner of baseline.owners) {
    for (const kind of ["slots", "renderers", "surfaces"]) {
      const expected = baseline.participants[kind].get(owner);
      const actual = current.participants[kind].get(owner);
      if (!expected || !actual) continue;
      if (actual.id !== expected.id || actual.topologyPath !== expected.topologyPath) {
        failures.push(`${path}.${kind}.${owner}=stable-public-identity`);
      }
    }
    const expectedPresentation = baseline.presentations.get(owner);
    const actualPresentation = current.presentations.get(owner);
    if (expectedPresentation && actualPresentation
        && (actualPresentation.surfaceId !== expectedPresentation.surfaceId
          || actualPresentation.surfaceGeneration !== expectedPresentation.surfaceGeneration)) {
      failures.push(`${path}.presentations.${owner}=stable-surface-identity`);
    }
  }
}

function requireNewPresentation(previous, current, path, failures) {
  if (!(previous && current)) return;
  for (const owner of previous.owners) {
    const before = previous.presentations.get(owner);
    const after = current.presentations.get(owner);
    if (before && after && !(after.revision > before.revision)) {
      failures.push(
        `${path}.presentations.${owner}.revision=>${before.revision}/${displayValue(after.revision)}`,
      );
    }
  }
}

function phaseGeometryValid(phase, requested, baselineWindow) {
  if (!(requested && baselineWindow)) return false;
  if (phase === "shrink") return requested.w < baselineWindow.w && requested.h < baselineWindow.h;
  if (phase === "wide") return requested.w > baselineWindow.w && requested.h < baselineWindow.h;
  if (phase === "tall") return requested.w < baselineWindow.w && requested.h > baselineWindow.h;
  return phase === "restore" && sameRect(requested, baselineWindow);
}

function geometrySignature(snapshot) {
  const normalizedParticipants = (values) => [...values]
    .sort((a, b) => String(a.viewId).localeCompare(String(b.viewId)))
    .map((participant) => ({
      id: participant.id,
      viewId: participant.viewId,
      topologyPath: participant.topologyPath,
      visible: participant.visible,
      logicalFrame: participant.logicalFrame,
      physicalFrame: participant.physicalFrame,
    }));
  return {
    windowGeometry: snapshot.windowGeometry,
    visibleViewIds: [...snapshot.visibleViewIds].sort(),
    slots: normalizedParticipants(snapshot.slots),
    renderers: normalizedParticipants(snapshot.renderers),
    surfaces: normalizedParticipants(snapshot.surfaces),
    presentationIdentities: [...snapshot.presentations]
      .sort((a, b) => String(a.viewId).localeCompare(String(b.viewId)))
      .map(({ viewId, surfaceId, surfaceGeneration }) => ({
        viewId,
        surfaceId,
        surfaceGeneration,
      })),
  };
}

function inspectTransaction(
  transaction,
  index,
  baseline,
  previous,
  coordinateSpace,
  failures,
) {
  const path = `transactions[${index}]`;
  if (!requireExactKeys(transaction, TRANSACTION_KEYS, path, failures)) return null;
  if (!Number.isInteger(transaction.sequence) || transaction.sequence !== index) {
    failures.push(`${path}.sequence=${index}/${displayValue(transaction.sequence)}`);
  }
  if (!PHASES.includes(transaction.phase)) {
    failures.push(`${path}.phase=known/${displayValue(transaction.phase)}`);
  }
  const requestedValid = inspectRect(
    transaction.requestedWindowGeometry,
    `${path}.requestedWindowGeometry`,
    failures,
  );
  const eventBeforeValid = inspectGeneration(
    transaction.eventGenerationBefore,
    `${path}.eventGenerationBefore`,
    failures,
  );
  const eventAfterValid = inspectGeneration(
    transaction.eventGenerationAfter,
    `${path}.eventGenerationAfter`,
    failures,
  );
  const transactionValid = inspectGeneration(
    transaction.transactionGeneration,
    `${path}.transactionGeneration`,
    failures,
  );
  inspectContinuity(transaction.continuity, `${path}.continuity`, failures);
  const post = inspectSnapshot(transaction.post, `${path}.post`, coordinateSpace, failures);

  if (requestedValid && baseline && PHASES.includes(transaction.phase)
      && !phaseGeometryValid(
        transaction.phase,
        transaction.requestedWindowGeometry,
        baseline.value.windowGeometry,
      )) {
    failures.push(`${path}.requestedWindowGeometry=${transaction.phase}-hostile-geometry`);
  }
  if (eventBeforeValid && previous
      && transaction.eventGenerationBefore !== previous.value.eventGeneration) {
    failures.push(
      `${path}.eventGenerationBefore=previous/`
        + `${previous.value.eventGeneration}/${displayValue(transaction.eventGenerationBefore)}`,
    );
  }
  if (eventBeforeValid && eventAfterValid
      && !(transaction.eventGenerationAfter > transaction.eventGenerationBefore)) {
    failures.push(`${path}.eventGenerationAfter=>eventGenerationBefore`);
  }
  if (transactionValid && previous
      && transaction.transactionGeneration !== previous.value.transactionGeneration + 1) {
    failures.push(
      `${path}.transactionGeneration=previous+1/`
        + `${previous.value.transactionGeneration + 1}/${displayValue(transaction.transactionGeneration)}`,
    );
  }
  if (post) {
    if (requestedValid && !sameRect(post.value.windowGeometry, transaction.requestedWindowGeometry)) {
      failures.push(`${path}.post.windowGeometry=requestedWindowGeometry`);
    }
    if (eventAfterValid && post.value.eventGeneration !== transaction.eventGenerationAfter) {
      failures.push(`${path}.post.eventGeneration=eventGenerationAfter`);
    }
    if (transactionValid
        && post.value.transactionGeneration !== transaction.transactionGeneration) {
      failures.push(`${path}.post.transactionGeneration=transactionGeneration`);
    }
    compareStableOwnersAndIdentities(baseline, post, `${path}.post`, failures);
    requireNewPresentation(previous, post, `${path}.post`, failures);
  }
  return post;
}

/**
 * 각 단계에서 관측면이 스스로 낸 합성 판정. 계약 위반은 하니스가 실행을 끊어 숨기는 사실이
 * 아니라 이 자리에서 수치 이름으로 남는 red 다. 판정을 선언하지 않은 관측면은 green 이 아니라
 * "선언 없음"으로 red 다 — 안 물어본 것과 통과한 것은 같은 사실이 아니다.
 */
function inspectAcknowledgedComposition(value, transactionCount, failures) {
  if (!requireExactKeys(value, COMPOSITION_KEYS, "acknowledgedComposition", failures)) return;
  if (!hasText(value.observer)) {
    failures.push(`acknowledgedComposition.observer=declared/${displayValue(value.observer)}`);
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    failures.push(`acknowledgedComposition.steps=non-empty-array/${displayValue(value.steps)}`);
    return;
  }
  if (transactionCount !== null && value.steps.length !== transactionCount) {
    failures.push(
      `acknowledgedComposition.steps.length=${transactionCount}/${value.steps.length}`,
    );
  }
  value.steps.forEach((step, index) => {
    const path = `acknowledgedComposition.steps[${index}]`;
    if (!requireExactKeys(step, COMPOSITION_STEP_KEYS, path, failures)) return;
    if (step.sequence !== index) {
      failures.push(`${path}.sequence=${index}/${displayValue(step.sequence)}`);
    }
    if (step.acknowledged !== true) {
      failures.push(`${path}.acknowledged=true/${displayValue(step.acknowledged)}`);
    }
    if (!Array.isArray(step.violations)) {
      failures.push(`${path}.violations=array/${displayValue(step.violations)}`);
      return;
    }
    for (const violation of step.violations) {
      failures.push(`${path}:${hasText(violation) ? violation : displayValue(violation)}`);
    }
  });
}

/**
 * 픽셀 입력 없이 공개 slot/renderer/surface frame과 유한 generation 원장만으로
 * hostile window resize의 합성 정합·presentation 연속·baseline 복원을 판정한다.
 */
export function judgeB10MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(
    value,
    ["engine", "acknowledgedComposition", "coordinateSpace", "baseline", "transactions"],
    "evidence",
    failures,
  )) return finishMachineVerdict("B10", failures, "B10:unreachable");
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);

  let coordinateValid = false;
  if (requireExactKeys(
    value.coordinateSpace,
    ["logical", "physical", "scaleFactor"],
    "coordinateSpace",
    failures,
  )) {
    coordinateValid = value.coordinateSpace.logical === "css-px"
      && value.coordinateSpace.physical === "device-px"
      && Number.isFinite(value.coordinateSpace.scaleFactor)
      && value.coordinateSpace.scaleFactor > 0;
    if (value.coordinateSpace.logical !== "css-px") {
      failures.push(`coordinateSpace.logical=css-px/${displayValue(value.coordinateSpace.logical)}`);
    }
    if (value.coordinateSpace.physical !== "device-px") {
      failures.push(`coordinateSpace.physical=device-px/${displayValue(value.coordinateSpace.physical)}`);
    }
    if (!(Number.isFinite(value.coordinateSpace.scaleFactor)
        && value.coordinateSpace.scaleFactor > 0)) {
      failures.push(
        `coordinateSpace.scaleFactor=finite>0/${displayValue(value.coordinateSpace.scaleFactor)}`,
      );
    }
  }

  const baseline = inspectSnapshot(
    value.baseline,
    "baseline",
    coordinateValid ? value.coordinateSpace : null,
    failures,
  );
  if (!Array.isArray(value.transactions) || value.transactions.length < PHASES.length) {
    failures.push(`transactions=at-least-${PHASES.length}/${displayValue(value.transactions?.length)}`);
  } else {
    let previous = baseline;
    let lastPost = null;
    let lastRank = -1;
    const seenPhases = new Set();
    value.transactions.forEach((transaction, index) => {
      const phase = transaction?.phase;
      const rank = PHASES.indexOf(phase);
      if (rank >= 0) {
        if (rank < lastRank) failures.push(`transactions[${index}].phase=ordered/${displayValue(phase)}`);
        lastRank = Math.max(lastRank, rank);
        seenPhases.add(phase);
      }
      const post = inspectTransaction(
        transaction,
        index,
        baseline,
        previous,
        coordinateValid ? value.coordinateSpace : null,
        failures,
      );
      if (post) {
        previous = post;
        lastPost = post;
      }
    });
    for (const phase of PHASES) {
      if (!seenPhases.has(phase)) failures.push(`phase=${phase}=missing`);
    }
    if (value.transactions.at(-1)?.phase !== "restore") failures.push("transactions.final.phase=restore");
    if (value.transactions.slice(0, -1).some((transaction) => transaction?.phase === "restore")) {
      failures.push("transactions.restore=final-only");
    }
    if (baseline && lastPost
        && canonical(geometrySignature(lastPost.value))
          !== canonical(geometrySignature(baseline.value))) {
      failures.push("transactions.final.post=exact-baseline-geometry");
    }
  }
  inspectAcknowledgedComposition(
    value.acknowledgedComposition,
    Array.isArray(value.transactions) ? value.transactions.length : null,
    failures,
  );
  return finishMachineVerdict(
    "B10",
    failures,
    `${value.engine}/B10:hostile>=4;generation-ordered;slot+renderer+surface=rounding-only;`
      + "presentation=continuous;replacements=0;restore=exact;composition=acknowledged-green",
  );
}
