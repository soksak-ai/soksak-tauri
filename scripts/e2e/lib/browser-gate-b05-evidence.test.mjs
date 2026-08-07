// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB05MachineEvidence } from "./browser-gate-b05.mjs";
import { mapB05LiveEvidence } from "./browser-gate-b05-evidence.mjs";

const rect = (x) => ({ x, y: 100, w: 300, h: 400 });

function rawTransition(direction, targetViewId, offset) {
  const owners = ["left", "right"];
  const traceId = `trace-${direction}`;
  const times = [1004, 1030, 1070, 1110, 1150, 1190, 1230, 1270, 1310, 1350]
    .map((time) => time + offset);
  const surfaces = (step) => owners.map((viewId, index) => ({
    viewId,
    surfaceId: `surface-${viewId}`,
    generation: 1,
    live: true,
    visible: true,
    painted: true,
    domFrame: rect(50 + index * 340 - Math.min(step, 8) * 8),
    surfaceFrame: rect(50 + index * 340 - Math.min(step, 8) * 8),
  }));
  const presentationEvents = times.map((presentedAtUnixMs, sequence) => ({
    sequence,
    sourceGeneration: 2,
    presentationRevision: 10 + sequence,
    displayTimestampUnixMs: presentedAtUnixMs,
    targetTimestampUnixMs: presentedAtUnixMs + 40,
    callbackObservedAtUnixMs: 1002 + sequence * 40 + offset,
    refreshIntervalMs: 40,
    presentedAtUnixMs,
    surfaces: surfaces(sequence),
  }));
  return {
    direction,
    targetViewId,
    clickReceipt: { address: `win/w/tab/${targetViewId}`, atUnixMs: 1010 + offset },
    layout: {
      transactionId: `layout-${direction}`,
      causeTraceId: traceId,
      phase: "committed",
      mode: "glide",
      startAtUnixMs: 1020 + offset,
      preparedAtUnixMs: 1012 + offset,
      closedAtUnixMs: 1360 + offset,
      moves: [{ viewId: targetViewId, dx: 340 }],
    },
    presentation: {
      traceId,
      closed: true,
      ownerViewIds: owners,
      armedAtUnixMs: 1000 + offset,
      baselineFrameSequence: 0,
      presentationEvents,
      settled: { atUnixMs: 1365 + offset, frameSequence: 9, syncPending: false },
      hold: {
        startedAtUnixMs: 1365 + offset,
        endedAtUnixMs: 1615 + offset,
        surfaces: structuredClone(presentationEvents.at(-1).surfaces),
      },
      violations: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0 },
      observation: { callbackIntervalsSkipped: 0, maxCallbackLatencyMs: 2 },
    },
  };
}

function raw() {
  return {
    engine: "browser",
    transitions: [
      rawTransition("to-right", "right", 0),
      rawTransition("to-left", "left", 1000),
    ],
  };
}

describe("B05 live evidence mapper", () => {
  it("closes click, layout, presentation, settlement, and hold receipts into the judge schema", () => {
    expect(judgeB05MachineEvidence(mapB05LiveEvidence(raw())).status).toBe("green");
  });

  it("keeps a missing click timestamp null instead of estimating it from frames", () => {
    const value = raw();
    delete value.transitions[0].clickReceipt.atUnixMs;
    const evidence = mapB05LiveEvidence(value);
    expect(evidence.transitions[0].trace.stimulus.atUnixMs).toBeNull();
    expect(judgeB05MachineEvidence(evidence).status).toBe("red");
  });
});
