import { logicalRectToPhysical } from "../../../packages/dom-webview-compositor/src/index.ts";

const value = (candidate, field) => candidate && typeof candidate === "object"
  ? candidate[field] ?? null
  : null;

function logicalRect(candidate) {
  const rect = value(candidate, "rect") ?? candidate;
  return {
    x: value(rect, "x"),
    y: value(rect, "y"),
    w: value(rect, "w"),
    h: value(rect, "h"),
  };
}

function physicalRect(frame, scaleFactor) {
  try {
    return logicalRectToPhysical(frame, scaleFactor);
  } catch {
    return { x: null, y: null, w: null, h: null };
  }
}

function exposedParticipants(uiTree, kind, scaleFactor) {
  return (Array.isArray(uiTree?.nodes) ? uiTree.nodes : [])
    .filter((node) => node?.dataset?.compositionKind === kind)
    .map((node) => {
      const frame = logicalRect(node);
      return {
        id: node?.nodeIdentity ?? null,
        viewId: node?.dataset?.viewId ?? null,
        topologyPath: node?.dataset?.topologyPath ?? null,
        visible: node?.dataset?.visible === "true" ? true : null,
        logicalFrame: frame,
        physicalFrame: physicalRect(frame, scaleFactor),
      };
    });
}

function surfaceParticipants(receipts, scaleFactor) {
  return (Array.isArray(receipts) ? receipts : []).map((receipt) => {
    const frame = logicalRect(receipt);
    return {
      id: receipt?.surfaceId ?? null,
      viewId: receipt?.viewId ?? null,
      topologyPath: receipt?.topologyPath ?? null,
      visible: receipt?.live === true && receipt?.visible === true ? true : null,
      logicalFrame: frame,
      physicalFrame: physicalRect(frame, scaleFactor),
    };
  });
}

/** Maps independently enumerated public owner, DOM, renderer, and surface ledgers. */
export function mapB03LiveEvidence(raw = {}) {
  const scaleFactor = raw?.scaleFactor ?? null;
  return {
    engine: raw?.engine ?? null,
    coordinateSpace: { logical: "css-px", physical: "device-px", scaleFactor },
    visibleViewIds: Array.isArray(raw?.visibleViewIds) ? [...raw.visibleViewIds] : null,
    slots: exposedParticipants(raw?.uiTree, "slot", scaleFactor),
    renderers: exposedParticipants(raw?.uiTree, "renderer", scaleFactor),
    surfaces: surfaceParticipants(raw?.surfaceReceipts, scaleFactor),
  };
}
