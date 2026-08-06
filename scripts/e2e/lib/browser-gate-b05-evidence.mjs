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
    presentedAtUnixMs: field(event, "presentedAtUnixMs"),
    surfaces: surfaces(field(event, "surfaces")),
  }));
}

function moves(values) {
  if (!Array.isArray(values)) return null;
  return values.map((move) => ({ viewId: field(move, "viewId"), dx: field(move, "dx") }));
}

function mapTransition(raw) {
  const presentation = raw?.presentation?.trace ?? raw?.presentation ?? null;
  const click = raw?.clickReceipt ?? null;
  const layout = raw?.layout ?? null;
  return {
    direction: field(raw, "direction"),
    targetViewId: field(raw, "targetViewId"),
    trace: {
      traceId: field(presentation, "traceId"),
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
        atUnixMs: field(presentation?.settled, "atUnixMs"),
        frameSequence: field(presentation?.settled, "frameSequence"),
        syncPending: field(presentation?.settled, "syncPending"),
      },
      hold: {
        startedAtUnixMs: field(presentation?.hold, "startedAtUnixMs"),
        endedAtUnixMs: field(presentation?.hold, "endedAtUnixMs"),
        surfaces: surfaces(field(presentation?.hold, "surfaces")),
      },
      violations: {
        replacements: field(presentation?.violations, "replacements"),
        gaps: field(presentation?.violations, "gaps"),
        disappearances: field(presentation?.violations, "disappearances"),
        unpresented: field(presentation?.violations, "unpresented"),
        droppedEvents: field(presentation?.violations, "droppedEvents"),
      },
    },
  };
}

/** Joins only acknowledged public click/layout/presentation receipts. */
export function mapB05LiveEvidence(raw = {}) {
  return {
    engine: field(raw, "engine"),
    transitions: Array.isArray(raw?.transitions) ? raw.transitions.map(mapTransition) : null,
  };
}
