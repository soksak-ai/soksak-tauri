// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB05MachineEvidence } from "./browser-gate-b05.mjs";
import { mapB05LiveEvidence } from "./browser-gate-b05-evidence.mjs";
import { resolveB05Settlement } from "./browser-gate-b05-hold.mjs";

const rect = (x) => ({ x, y: 100, w: 300, h: 400 });

const FIRST_FRAME_AT = 1004;
const FRAME_INTERVAL_MS = 16;
const FRAME_COUNT = 36;
const MOTION_FRAMES = 12;

function rawTransition(direction, targetViewId, offset) {
  const owners = ["left", "right"];
  const traceId = `trace-${direction}`;
  const surfaces = (step) => owners.map((viewId, index) => ({
    viewId,
    surfaceId: `surface-${viewId}`,
    generation: 1,
    live: true,
    visible: true,
    painted: true,
    domFrame: rect(50 + index * 340 - Math.min(step, MOTION_FRAMES) * 8),
    surfaceFrame: rect(50 + index * 340 - Math.min(step, MOTION_FRAMES) * 8),
  }));
  const presentationEvents = Array.from({ length: FRAME_COUNT }, (_, sequence) => {
    const presentedAtUnixMs = FIRST_FRAME_AT + sequence * FRAME_INTERVAL_MS + offset;
    return {
      sequence,
      sourceGeneration: 2,
      presentationRevision: 10 + sequence,
      displayTimestampUnixMs: presentedAtUnixMs,
      targetTimestampUnixMs: presentedAtUnixMs + FRAME_INTERVAL_MS,
      callbackObservedAtUnixMs: presentedAtUnixMs + 1,
      refreshIntervalMs: FRAME_INTERVAL_MS,
      presentedAtUnixMs,
      surfaces: surfaces(sequence),
    };
  });
  const presentation = {
    traceId,
    closed: true,
    ownerViewIds: owners,
    armedAtUnixMs: 1000 + offset,
    baselineFrameSequence: 0,
    presentationEvents,
    violations: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0 },
    observation: { callbackIntervalsSkipped: 0, maxCallbackLatencyMs: 2 },
  };
  const settleReceipt = {
    waitedMs: 270,
    animations: 1,
    settledAtUnixMs: 1310 + offset,
    syncPending: false,
  };
  return {
    direction,
    targetViewId,
    clickReceipt: { address: `win/w/tab/${targetViewId}`, atUnixMs: 1040 + offset },
    layout: {
      transactionId: `layout-${direction}`,
      causeTraceId: traceId,
      phase: "committed",
      mode: "glide",
      startAtUnixMs: 1060 + offset,
      preparedAtUnixMs: 1050 + offset,
      closedAtUnixMs: 1300 + offset,
      moves: [{ viewId: targetViewId, dx: 340 }],
    },
    presentation,
    settlement: resolveB05Settlement({ settleReceipt, presentationReceipt: presentation }),
  };
}

function raw() {
  return {
    engine: "browser",
    transitions: [
      rawTransition("to-right", "right", 0),
      rawTransition("to-left", "left", 2000),
    ],
  };
}

describe("B05 live evidence mapper", () => {
  it("closes click, layout, presentation, settlement, and hold receipts into the judge schema", () => {
    expect(judgeB05MachineEvidence(mapB05LiveEvidence(raw()))).toMatchObject({ status: "green" });
  });

  it("keeps a missing click timestamp null instead of estimating it from frames", () => {
    const value = raw();
    delete value.transitions[0].clickReceipt.atUnixMs;
    const evidence = mapB05LiveEvidence(value);
    expect(evidence.transitions[0].trace.stimulus.atUnixMs).toBeNull();
    expect(judgeB05MachineEvidence(evidence).status).toBe("red");
  });

  it("keeps a missing settlement epoch null instead of taking the last frame as settlement", () => {
    const value = raw();
    value.transitions[0].settlement.settled.atUnixMs = null;
    const evidence = mapB05LiveEvidence(value);
    expect(evidence.transitions[0].trace.settled.atUnixMs).toBeNull();
    expect(judgeB05MachineEvidence(evidence).status).toBe("red");
  });

  it("reads the hold window from the settlement join, not from the presentation receipt", () => {
    const value = raw();
    const held = value.transitions[0].settlement.hold;
    expect(held.startedAtUnixMs).toBe(1310);
    expect(held.endedAtUnixMs).toBe(FIRST_FRAME_AT + (FRAME_COUNT - 1) * FRAME_INTERVAL_MS);
    const evidence = mapB05LiveEvidence(value);
    expect(evidence.transitions[0].trace.hold.surfaces).toHaveLength(2);
  });
});
