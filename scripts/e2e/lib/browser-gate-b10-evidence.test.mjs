// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB10MachineEvidence } from "./browser-gate-b10.mjs";
import { mapB10LiveEvidence } from "./browser-gate-b10-evidence.mjs";

const scaleFactor = 2;
const physical = (frame) => ({
  x: Math.round(frame.x * scaleFactor),
  y: Math.round(frame.y * scaleFactor),
  w: Math.round((frame.x + frame.w) * scaleFactor) - Math.round(frame.x * scaleFactor),
  h: Math.round((frame.y + frame.h) * scaleFactor) - Math.round(frame.y * scaleFactor),
});
const zero = () => ({ replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 });

function snapshot(windowGeometry, eventGeneration, transactionGeneration, revision) {
  const viewIds = ["left", "right"];
  const frames = viewIds.map((_, index) => ({
    x: windowGeometry.x + 20 + index * ((windowGeometry.w - 60) / 2 + 20),
    y: windowGeometry.y + 50,
    w: (windowGeometry.w - 60) / 2,
    h: windowGeometry.h - 80,
  }));
  const participants = (kind) => viewIds.map((viewId, index) => ({
    id: `${kind}-${viewId}`,
    viewId,
    topologyPath: `workspace/pane/${viewId}/browser`,
    visible: true,
    logicalFrame: frames[index],
    physicalFrame: physical(frames[index]),
  }));
  const surfaces = participants("surface");
  return {
    windowGeometry,
    eventGeneration,
    transactionGeneration,
    visibleViewIds: viewIds,
    slots: participants("slot"),
    renderers: participants("renderer"),
    surfaces,
    presentations: viewIds.map((viewId, index) => ({
      viewId,
      surfaceId: surfaces[index].id,
      surfaceGeneration: 1,
      revision,
      live: true,
      visible: true,
      presented: true,
    })),
  };
}

function raw() {
  const baselineGeometry = { x: 0, y: 0, w: 800, h: 600 };
  const requests = [
    ["shrink", { x: 10, y: 10, w: 620, h: 480 }],
    ["wide", { x: 0, y: 20, w: 980, h: 520 }],
    ["tall", { x: 20, y: 0, w: 640, h: 760 }],
    ["restore", baselineGeometry],
  ];
  const baseline = snapshot(baselineGeometry, 10, 20, 30);
  let generation = baseline.eventGeneration;
  return {
    engine: "browser",
    scaleFactor,
    resizeSequence: {
      baseline: { snapshot: baseline },
      samples: requests.map(([phase, requestedWindowGeometry], sequence) => {
        const eventGenerationBefore = generation;
        generation += 1;
        const transactionGeneration = baseline.transactionGeneration + sequence + 1;
        return {
          step: sequence,
          size: { w: requestedWindowGeometry.w, h: requestedWindowGeometry.h },
          observation: {
            phase,
            requestedWindowGeometry,
            eventGenerationBefore,
            eventGenerationAfter: generation,
            transactionGeneration,
            continuity: { countersBefore: zero(), countersAfter: zero() },
            snapshot: snapshot(
              requestedWindowGeometry,
              generation,
              transactionGeneration,
              baseline.presentations[0].revision + sequence + 1,
            ),
          },
        };
      }),
    },
  };
}

describe("B10 live evidence mapper", () => {
  it("closes baseline and every finite resize observation into transactions", () => {
    expect(judgeB10MachineEvidence(mapB10LiveEvidence(raw())).status).toBe("green");
  });

  it("reads the baseline from the same resize command that produced the samples", () => {
    const value = raw();
    const evidence = mapB10LiveEvidence(value);
    expect(evidence.baseline.windowGeometry).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(evidence.baseline.eventGeneration).toBe(10);
    expect(evidence.baseline.transactionGeneration).toBe(20);
  });

  it("leaves the baseline null when the command observed nothing before the first resize", () => {
    const value = raw();
    delete value.resizeSequence.baseline;
    const evidence = mapB10LiveEvidence(value);
    expect(evidence.baseline.windowGeometry).toEqual({ x: null, y: null, w: null, h: null });
    expect(evidence.baseline.eventGeneration).toBeNull();
    expect(judgeB10MachineEvidence(evidence).status).toBe("red");
  });

  it("does not substitute requested size for a missing observed window geometry", () => {
    const value = raw();
    delete value.resizeSequence.samples[0].observation.snapshot.windowGeometry;
    const evidence = mapB10LiveEvidence(value);
    expect(evidence.transactions[0].post.windowGeometry.x).toBeNull();
    expect(judgeB10MachineEvidence(evidence).status).toBe("red");
  });
});
