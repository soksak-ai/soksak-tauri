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

/** 관측면이 한 단계에서 스스로 낸 합성 판정. 하니스가 아니라 앱이 선언하는 사실이다. */
const acknowledged = (generation) => ({
  schemaVersion: 1,
  kind: "resize-composition-sample",
  generation,
  sampledAtUnixMs: 1_770_000_000_000 + generation,
  checks: { generation: true },
  issues: [],
  verdict: "green",
});

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
      resizeElapsedMs: 320,
      baseline: { status: "observed", observation: { snapshot: baseline } },
      samples: requests.map(([phase, requestedWindowGeometry], sequence) => {
        const eventGenerationBefore = generation;
        generation += 1;
        const transactionGeneration = baseline.transactionGeneration + sequence + 1;
        return {
          step: sequence,
          size: { w: requestedWindowGeometry.w, h: requestedWindowGeometry.h },
          observation: {
            ...acknowledged(sequence + 1),
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

  it("leaves the baseline null when the command could not observe before the first resize", () => {
    const value = raw();
    value.resizeSequence.baseline = { status: "unavailable", reason: "no settled transaction" };
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

  it("records a clean wiring ledger on the green path", () => {
    expect(mapB10LiveEvidence(raw()).evidenceWiring).toEqual({
      source: "B10.live",
      unconsumed: [],
      unproduced: [],
      error: null,
    });
  });

  it("names a drifted envelope field on both sides instead of mapping it to null", () => {
    const value = raw();
    value.resize = value.resizeSequence;
    delete value.resizeSequence;
    const evidence = mapB10LiveEvidence(value);
    expect(evidence.evidenceWiring).toEqual({
      source: "B10.live",
      unconsumed: ["resize"],
      unproduced: ["resizeSequence"],
      error: null,
    });
    const verdict = judgeB10MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B10:wiring.B10.live.resize=produced-not-consumed");
    expect(verdict.evidence).toContain("B10:wiring.B10.live.resizeSequence=consumed-not-produced");
  });

  it("names an envelope field that throws instead of killing the harness", () => {
    const value = raw();
    Object.defineProperty(value, "scaleFactor", {
      enumerable: true,
      get() {
        throw new TypeError("scale factor read failed");
      },
    });
    let verdict;
    expect(() => {
      verdict = judgeB10MachineEvidence(mapB10LiveEvidence(value));
    }).not.toThrow();
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      'B10:wiring.B10.live=mapper-threw/"TypeError: scale factor read failed"',
    );
  });
});
