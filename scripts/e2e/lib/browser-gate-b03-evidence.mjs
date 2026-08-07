import { logicalRectToPhysical } from "../../../packages/dom-webview-compositor/src/index.ts";
import { BROWSER_SURFACE_OBSERVATION_SOURCES } from "./browser-surface-rects.mjs";
import { mapWithWiring } from "./browser-machine-judge-support.mjs";

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

/**
 * Maps independently enumerated public owner, DOM, renderer, and surface ledgers.
 *
 * checkpoint 필드는 손으로 나열하지 않고 배선 장부를 통해 읽는다. 이름이 한쪽에서만 바뀌면
 * 값이 null 로 뭉개지는 대신 양쪽 이름이 판정에 실린다.
 */
export function mapB03LiveEvidence(raw = {}) {
  return mapWithWiring(raw, "B03.live", (checkpoint) => {
    const scaleFactor = checkpoint.take("scaleFactor") ?? null;
    const uiTree = checkpoint.take("uiTree");
    const visibleViewIds = checkpoint.take("visibleViewIds");
    const observation = checkpoint.take("surfaceObservation");
    const settledAtUnixMs = checkpoint.take("settledAtUnixMs") ?? null;
    return {
      engine: checkpoint.take("engine") ?? null,
      coordinateSpace: { logical: "css-px", physical: "device-px", scaleFactor },
      // slot·renderer 는 이 함수가 공개 DOM 트리에서 읽는다. surface 는 표면을 소유한 원장이
      // 스스로 이름을 붙인다 — 세 좌표가 어느 관측에서 왔는지가 좌표와 함께 판정에 실린다.
      observation: {
        settledAtUnixMs,
        sampledAtUnixMs: value(observation, "sampledAtUnixMs"),
        sources: {
          slot: BROWSER_SURFACE_OBSERVATION_SOURCES.domProjection,
          renderer: BROWSER_SURFACE_OBSERVATION_SOURCES.domProjection,
          surface: value(observation, "source"),
        },
      },
      visibleViewIds: Array.isArray(visibleViewIds) ? [...visibleViewIds] : null,
      slots: exposedParticipants(uiTree, "slot", scaleFactor),
      renderers: exposedParticipants(uiTree, "renderer", scaleFactor),
      surfaces: surfaceParticipants(value(observation, "receipts"), scaleFactor),
    };
  });
}
