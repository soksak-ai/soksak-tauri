import { hostileResizeCompositionPlane } from "./hostile-resize-composition.mjs";

const field = (value, key) => value && typeof value === "object" && Object.hasOwn(value, key)
  ? value[key]
  : null;

const rect = (value) => ({
  x: field(value, "x"),
  y: field(value, "y"),
  w: field(value, "w"),
  h: field(value, "h"),
});

function participants(values) {
  if (!Array.isArray(values)) return null;
  return values.map((value) => ({
    id: field(value, "id"),
    viewId: field(value, "viewId"),
    topologyPath: field(value, "topologyPath"),
    visible: field(value, "visible"),
    logicalFrame: rect(field(value, "logicalFrame")),
    physicalFrame: rect(field(value, "physicalFrame")),
  }));
}

function presentations(values) {
  if (!Array.isArray(values)) return null;
  return values.map((value) => ({
    viewId: field(value, "viewId"),
    surfaceId: field(value, "surfaceId"),
    surfaceGeneration: field(value, "surfaceGeneration"),
    revision: field(value, "revision"),
    live: field(value, "live"),
    visible: field(value, "visible"),
    presented: field(value, "presented"),
  }));
}

function snapshot(value) {
  return {
    windowGeometry: rect(field(value, "windowGeometry")),
    eventGeneration: field(value, "eventGeneration"),
    transactionGeneration: field(value, "transactionGeneration"),
    visibleViewIds: Array.isArray(value?.visibleViewIds) ? [...value.visibleViewIds] : null,
    slots: participants(field(value, "slots")),
    renderers: participants(field(value, "renderers")),
    surfaces: participants(field(value, "surfaces")),
    presentations: presentations(field(value, "presentations")),
  };
}

function counters(value) {
  return {
    replacements: field(value, "replacements"),
    gaps: field(value, "gaps"),
    disappearances: field(value, "disappearances"),
    unpresented: field(value, "unpresented"),
  };
}

function transaction(sample) {
  const observation = sample?.observation ?? null;
  return {
    sequence: field(sample, "step"),
    phase: field(observation, "phase"),
    requestedWindowGeometry: rect(field(observation, "requestedWindowGeometry")),
    eventGenerationBefore: field(observation, "eventGenerationBefore"),
    eventGenerationAfter: field(observation, "eventGenerationAfter"),
    transactionGeneration: field(observation, "transactionGeneration"),
    continuity: {
      countersBefore: counters(observation?.continuity?.countersBefore),
      countersAfter: counters(observation?.continuity?.countersAfter),
    },
    post: snapshot(field(observation, "snapshot")),
  };
}

/**
 * Maps one finite resize command's acknowledged observations without using requested sizes as facts.
 * The baseline is the same command's pre-resize observation, read from the same envelope and the
 * same `snapshot` plane as every step; a missing one stays null instead of being reconstructed.
 *
 * `acknowledgedComposition` is the observer's own per-step verdict, derived from the same samples.
 * The harness never hands that verdict in, so the report cannot disagree with the observations it
 * was made from.
 */
export function mapB10LiveEvidence(raw = {}) {
  const sequence = field(raw, "resizeSequence");
  return {
    engine: field(raw, "engine"),
    acknowledgedComposition: hostileResizeCompositionPlane(sequence),
    resizeElapsedMs: field(sequence, "resizeElapsedMs"),
    coordinateSpace: {
      logical: "css-px",
      physical: "device-px",
      scaleFactor: field(raw, "scaleFactor"),
    },
    baseline: snapshot(field(field(field(sequence, "baseline"), "observation"), "snapshot")),
    transactions: Array.isArray(sequence?.samples)
      ? sequence.samples.map(transaction)
      : null,
  };
}
