import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

const DIRECTIONS = Object.freeze(["to-left", "to-right"]);
const MAX_SETTLE_LATENCY_MS = 500;
const MIN_STABLE_HOLD_MS = 250;
const COUNTER_KEYS = Object.freeze([
  "replacements",
  "gaps",
  "disappearances",
  "unpresented",
]);
const SURFACE_KEYS = Object.freeze([
  "viewId",
  "surfaceId",
  "generation",
  "live",
  "visible",
  "presented",
  "presentationRevision",
  "presentedAtUnixMs",
]);

function inspectCounters(value, path, failures) {
  if (!requireExactKeys(value, COUNTER_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of COUNTER_KEYS) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      failures.push(`${path}.${key}=integer>=0/${displayValue(value[key])}`);
      valid = false;
    }
  }
  return valid;
}

function inspectSurfaceInventory(surfaces, owners, path, failures) {
  if (!Array.isArray(surfaces)) {
    failures.push(`${path}=array/${displayValue(surfaces)}`);
    return null;
  }
  const byOwner = new Map();
  surfaces.forEach((surface, index) => {
    const at = `${path}[${index}]`;
    if (!requireExactKeys(surface, SURFACE_KEYS, at, failures)) return;
    if (!hasText(surface.viewId) || byOwner.has(surface.viewId)) {
      failures.push(`${at}.viewId=unique-non-empty/${displayValue(surface.viewId)}`);
    } else {
      byOwner.set(surface.viewId, surface);
    }
    if (!hasText(surface.surfaceId)) failures.push(`${at}.surfaceId=non-empty/${displayValue(surface.surfaceId)}`);
    if (!Number.isInteger(surface.generation) || surface.generation < 1) {
      failures.push(`${at}.generation=integer>=1/${displayValue(surface.generation)}`);
    }
    for (const field of ["live", "visible", "presented"]) {
      if (surface[field] !== true) failures.push(`${at}.${field}=true/${displayValue(surface[field])}`);
    }
    if (!Number.isInteger(surface.presentationRevision) || surface.presentationRevision < 1) {
      failures.push(`${at}.presentationRevision=integer>=1/${displayValue(surface.presentationRevision)}`);
    }
    if (!Number.isFinite(surface.presentedAtUnixMs)) {
      failures.push(`${at}.presentedAtUnixMs=finite/${displayValue(surface.presentedAtUnixMs)}`);
    }
  });
  const actualOwners = [...byOwner.keys()].sort();
  if (actualOwners.join("\u0000") !== owners.join("\u0000")) {
    failures.push(`${path}.owners=${owners.join(",")}/${actualOwners.join(",")}`);
  }
  return byOwner;
}

function inventoriesMatchByOwner(actual, expected, owners) {
  const actualByOwner = new Map(actual.map((surface) => [surface.viewId, surface]));
  const expectedByOwner = new Map(expected.map((surface) => [surface.viewId, surface]));
  return owners.every((owner) => (
    JSON.stringify(actualByOwner.get(owner)) === JSON.stringify(expectedByOwner.get(owner))
  ));
}

function inspectTransition(transition, index, failures, traceIds) {
  const path = `transitions[${index}]`;
  if (!requireExactKeys(transition, ["direction", "targetViewId", "trace"], path, failures)) return;
  if (!DIRECTIONS.includes(transition.direction)) {
    failures.push(`${path}.direction=known/${displayValue(transition.direction)}`);
  }
  if (!hasText(transition.targetViewId)) {
    failures.push(`${path}.targetViewId=non-empty/${displayValue(transition.targetViewId)}`);
  }
  const trace = transition.trace;
  if (!requireExactKeys(trace, [
    "traceId",
    "closed",
    "startedAtUnixMs",
    "stimulusAtUnixMs",
    "settledAtUnixMs",
    "heldAtUnixMs",
    "latencyBudgetMs",
    "minimumHoldMs",
    "ownerViewIds",
    "countersBefore",
    "countersAfter",
    "samples",
    "final",
  ], `${path}.trace`, failures)) return;
  if (!hasText(trace.traceId) || traceIds.has(trace.traceId)) {
    failures.push(`${path}.trace.traceId=unique-non-empty/${displayValue(trace.traceId)}`);
  } else {
    traceIds.add(trace.traceId);
  }
  if (trace.closed !== true) failures.push(`${path}.trace.closed=true/${displayValue(trace.closed)}`);
  const times = [trace.startedAtUnixMs, trace.stimulusAtUnixMs, trace.settledAtUnixMs, trace.heldAtUnixMs];
  if (times.some((time) => !Number.isFinite(time))
      || !(times[0] <= times[1] && times[1] <= times[2] && times[2] <= times[3])) {
    failures.push(`${path}.trace.times=started<=stimulus<=settled<=held/${displayValue(times)}`);
  }
  if (!Number.isFinite(trace.latencyBudgetMs)
      || trace.latencyBudgetMs <= 0
      || trace.latencyBudgetMs > MAX_SETTLE_LATENCY_MS) {
    failures.push(`${path}.trace.latencyBudgetMs=0<value<=${MAX_SETTLE_LATENCY_MS}/${displayValue(trace.latencyBudgetMs)}`);
  } else if (Number.isFinite(trace.stimulusAtUnixMs) && Number.isFinite(trace.settledAtUnixMs)
      && trace.settledAtUnixMs - trace.stimulusAtUnixMs > trace.latencyBudgetMs) {
    failures.push(`${path}.trace.settleLatency<=budget/${trace.settledAtUnixMs - trace.stimulusAtUnixMs}/${trace.latencyBudgetMs}`);
  }
  if (!Number.isFinite(trace.minimumHoldMs) || trace.minimumHoldMs < MIN_STABLE_HOLD_MS) {
    failures.push(`${path}.trace.minimumHoldMs=>=${MIN_STABLE_HOLD_MS}/${displayValue(trace.minimumHoldMs)}`);
  } else if (Number.isFinite(trace.settledAtUnixMs) && Number.isFinite(trace.heldAtUnixMs)
      && trace.heldAtUnixMs - trace.settledAtUnixMs < trace.minimumHoldMs) {
    failures.push(`${path}.trace.holdDuration>=minimum/${trace.heldAtUnixMs - trace.settledAtUnixMs}/${trace.minimumHoldMs}`);
  }
  const ownerViewIds = Array.isArray(trace.ownerViewIds) ? trace.ownerViewIds : [];
  const owners = [...ownerViewIds].sort();
  if (owners.length === 0
      || owners.some((owner) => !hasText(owner))
      || new Set(owners).size !== owners.length) {
    failures.push(`${path}.trace.ownerViewIds=unique-non-empty/${displayValue(trace.ownerViewIds)}`);
  }
  if (!owners.includes(transition.targetViewId)) {
    failures.push(`${path}.targetViewId=visible-owner/${displayValue(transition.targetViewId)}`);
  }
  const beforeValid = inspectCounters(trace.countersBefore, `${path}.trace.countersBefore`, failures);
  const afterValid = inspectCounters(trace.countersAfter, `${path}.trace.countersAfter`, failures);
  if (beforeValid && afterValid) {
    for (const key of COUNTER_KEYS) {
      if (trace.countersAfter[key] !== trace.countersBefore[key]) {
        failures.push(`${path}.trace.${key}=no-increase/${trace.countersBefore[key]}/${trace.countersAfter[key]}`);
      }
    }
  }
  if (!Array.isArray(trace.samples) || trace.samples.length < 2) {
    failures.push(`${path}.trace.samples=at-least-2/${displayValue(trace.samples?.length)}`);
    return;
  }

  const identityByOwner = new Map();
  const revisionByOwner = new Map();
  const firstRevisionByOwner = new Map();
  let lastInventory = null;
  trace.samples.forEach((sample, sampleIndex) => {
    const samplePath = `${path}.trace.samples[${sampleIndex}]`;
    if (!requireExactKeys(sample, ["sequence", "sampledAtUnixMs", "surfaces"], samplePath, failures)) return;
    if (!Number.isInteger(sample.sequence) || sample.sequence !== sampleIndex) {
      failures.push(`${samplePath}.sequence=${sampleIndex}/${displayValue(sample.sequence)}`);
    }
    const previousTime = trace.samples[sampleIndex - 1]?.sampledAtUnixMs;
    if (!Number.isFinite(sample.sampledAtUnixMs)
        || sample.sampledAtUnixMs < trace.startedAtUnixMs
        || sample.sampledAtUnixMs > trace.settledAtUnixMs
        || (sampleIndex > 0 && !(sample.sampledAtUnixMs > previousTime))) {
      failures.push(`${samplePath}.sampledAtUnixMs=ordered-within-trace/${displayValue(sample.sampledAtUnixMs)}`);
    }
    const inventory = inspectSurfaceInventory(sample.surfaces, owners, `${samplePath}.surfaces`, failures);
    if (!inventory) return;
    lastInventory = sample.surfaces;
    for (const owner of owners) {
      const surface = inventory.get(owner);
      if (!surface) continue;
      const identity = `${surface.surfaceId}/${surface.generation}`;
      if (!identityByOwner.has(owner)) identityByOwner.set(owner, identity);
      else if (identityByOwner.get(owner) !== identity) {
        failures.push(`${samplePath}.${owner}.surface-identity=stable/${identityByOwner.get(owner)}/${identity}`);
      }
      const previousRevision = revisionByOwner.get(owner) ?? 0;
      if (surface.presentationRevision < previousRevision) {
        failures.push(`${samplePath}.${owner}.presentationRevision=monotonic/${previousRevision}/${surface.presentationRevision}`);
      }
      revisionByOwner.set(owner, surface.presentationRevision);
      if (!firstRevisionByOwner.has(owner)) firstRevisionByOwner.set(owner, surface.presentationRevision);
      if (Number.isFinite(surface.presentedAtUnixMs)
          && surface.presentedAtUnixMs > sample.sampledAtUnixMs) {
        failures.push(`${samplePath}.${owner}.presentedAtUnixMs<=sample/${surface.presentedAtUnixMs}/${sample.sampledAtUnixMs}`);
      }
    }
  });

  if (Number.isFinite(trace.stimulusAtUnixMs)) {
    const firstSampleAt = trace.samples[0]?.sampledAtUnixMs;
    const lastSampleAt = trace.samples.at(-1)?.sampledAtUnixMs;
    if (!(firstSampleAt <= trace.stimulusAtUnixMs && lastSampleAt >= trace.stimulusAtUnixMs)) {
      failures.push(`${path}.trace.samples=bracket-stimulus/${displayValue([firstSampleAt, trace.stimulusAtUnixMs, lastSampleAt])}`);
    }
  }

  if (requireExactKeys(trace.final, ["sampledAtUnixMs", "settled", "syncPending", "surfaces"], `${path}.trace.final`, failures)) {
    if (!Number.isFinite(trace.final.sampledAtUnixMs)
        || trace.final.sampledAtUnixMs < trace.heldAtUnixMs) {
      failures.push(`${path}.trace.final.sampledAtUnixMs>=held/${displayValue(trace.final.sampledAtUnixMs)}/${displayValue(trace.heldAtUnixMs)}`);
    }
    if (trace.final.settled !== true) failures.push(`${path}.trace.final.settled=true/${displayValue(trace.final.settled)}`);
    if (trace.final.syncPending !== false) {
      failures.push(`${path}.trace.final.syncPending=false/${displayValue(trace.final.syncPending)}`);
    }
    const finalInventory = inspectSurfaceInventory(
      trace.final.surfaces, owners, `${path}.trace.final.surfaces`, failures,
    );
    if (finalInventory && lastInventory
        && !inventoriesMatchByOwner(trace.final.surfaces, lastInventory, owners)) {
      failures.push(`${path}.trace.final.surfaces=last-sample`);
    }
    const target = finalInventory?.get(transition.targetViewId);
    const firstRevision = firstRevisionByOwner.get(transition.targetViewId);
    if (target && Number.isInteger(firstRevision)
        && target.presentationRevision <= firstRevision) {
      failures.push(`${path}.trace.target.presentationRevision=>baseline/${target.presentationRevision}/${firstRevision}`);
    }
    if (target && Number.isFinite(trace.stimulusAtUnixMs)) {
      if (!(target.presentedAtUnixMs >= trace.stimulusAtUnixMs
          && target.presentedAtUnixMs <= trace.settledAtUnixMs)) {
        failures.push(`${path}.trace.target.presentedAtUnixMs=within-stimulus-settle/${target.presentedAtUnixMs}`);
      } else if (target.presentedAtUnixMs - trace.stimulusAtUnixMs > trace.latencyBudgetMs) {
        failures.push(`${path}.trace.target.presentationLatency<=budget/${target.presentedAtUnixMs - trace.stimulusAtUnixMs}/${trace.latencyBudgetMs}`);
      }
    }
  }
}

/** 녹화와 독립된 유한 presentation 원장 판정. 픽셀의 시각 품질은 visualReview가 별도로 답한다. */
export function judgeB05MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "transitions"], "evidence", failures)) {
    return finishMachineVerdict("B05", failures, "B05:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (!Array.isArray(value.transitions) || value.transitions.length < 2) {
    failures.push(`transitions=at-least-2/${displayValue(value.transitions?.length)}`);
  } else {
    const traceIds = new Set();
    value.transitions.forEach((transition, index) => inspectTransition(transition, index, failures, traceIds));
    const directions = new Set(value.transitions.map((transition) => transition?.direction));
    for (const direction of DIRECTIONS) {
      if (!directions.has(direction)) failures.push(`direction=${direction}=missing`);
    }
  }
  return finishMachineVerdict(
    "B05",
    failures,
    `${value.engine}/B05:directions=2;continuous-live-visible-presented;violations=0`,
  );
}
