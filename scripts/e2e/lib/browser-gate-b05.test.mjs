// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB05MachineEvidence } from "./browser-gate-b05.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

const IDENTITY = Object.freeze({
  framework: "tauri",
  platform: "darwin",
  buildId: "b05-build",
  runId: "b05-run",
});

function evidence(engine = "browser") {
  const owners = [`${engine}-left`, `${engine}-right`];
  const transition = (direction, target, offset) => {
    const surfaces = (revision) => owners.map((viewId, index) => ({
      viewId,
      surfaceId: `${engine}-surface-${index}`,
      generation: 1,
      live: true,
      visible: true,
      presented: true,
      presentationRevision: revision,
      presentedAtUnixMs: 1_000 + offset + (revision - 10) * 16,
    }));
    const samples = [0, 1, 2].map((sequence) => ({
      sequence,
      sampledAtUnixMs: 1_000 + offset + sequence * 16,
      surfaces: surfaces(10 + sequence),
    }));
    const counters = { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 };
    return {
      direction,
      targetViewId: target,
      trace: {
        traceId: `${engine}-${direction}`,
        closed: true,
        startedAtUnixMs: 1_000 + offset,
        stimulusAtUnixMs: 1_008 + offset,
        settledAtUnixMs: 1_040 + offset,
        heldAtUnixMs: 1_290 + offset,
        latencyBudgetMs: 500,
        minimumHoldMs: 250,
        ownerViewIds: owners,
        countersBefore: { ...counters },
        countersAfter: { ...counters },
        samples,
        final: {
          sampledAtUnixMs: 1_290 + offset,
          settled: true,
          syncPending: false,
          surfaces: structuredClone(samples.at(-1).surfaces),
        },
      },
    };
  };
  return {
    engine,
    transitions: [
      transition("to-right", owners[1], 0),
      transition("to-left", owners[0], 100),
    ],
  };
}

describe("B05 continuous visible presentation judge", () => {
  it("세 engine의 양방향 닫힌 presentation 원장만 green receipt가 된다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB05MachineEvidence(evidence(engine))).toMatchObject({ status: "green", reason: null });
      expect(judgeBrowserMachineGateEvidence({
        ...IDENTITY,
        engine,
        gate: "B05",
        evidence: evidence(engine),
      })).toMatchObject({ gate: "B05", engine, status: "green", judgeId: "B05-machine-v1" });
    }
    const reordered = evidence();
    reordered.transitions[0].trace.final.surfaces.reverse();
    expect(judgeB05MachineEvidence(reordered).status).toBe("green");
    expect(judgeB05MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
  });

  it("gap·교체·미표시·미정착·픽셀 입력을 각각 RED로 만든다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.countersAfter.gaps = 1; },
      (value) => { value.transitions[0].trace.samples[1].surfaces.pop(); },
      (value) => { value.transitions[0].trace.samples[1].surfaces[0].generation = 2; },
      (value) => { value.transitions[0].trace.samples[1].surfaces[0].presented = false; },
      (value) => { value.transitions[0].trace.final.syncPending = true; },
      (value) => { value.transitions[0].trace.samples[0].blackPixels = 42; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });

  it("늦은 착지와 클릭 뒤 presentation revision 정지를 RED로 만든다", () => {
    const cases = [
      (value) => {
        value.transitions[0].trace.settledAtUnixMs = value.transitions[0].trace.stimulusAtUnixMs + 501;
        value.transitions[0].trace.heldAtUnixMs = value.transitions[0].trace.settledAtUnixMs + 250;
        value.transitions[0].trace.final.sampledAtUnixMs = value.transitions[0].trace.heldAtUnixMs;
      },
      (value) => {
        const trace = value.transitions[0].trace;
        const target = trace.ownerViewIds.indexOf(value.transitions[0].targetViewId);
        for (const sample of trace.samples) sample.surfaces[target].presentationRevision = 10;
        trace.final.surfaces[target].presentationRevision = 10;
      },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });

  it("클릭 전 ACK·짧은 hold·hold 뒤 소실을 각각 RED로 만든다", () => {
    const cases = [
      (value) => {
        const trace = value.transitions[0].trace;
        const target = trace.ownerViewIds.indexOf(value.transitions[0].targetViewId);
        for (const sample of trace.samples.slice(1)) {
          sample.surfaces[target].presentedAtUnixMs = trace.stimulusAtUnixMs - 1;
        }
        trace.final.surfaces[target].presentedAtUnixMs = trace.stimulusAtUnixMs - 1;
      },
      (value) => {
        const trace = value.transitions[0].trace;
        trace.heldAtUnixMs = trace.settledAtUnixMs + trace.minimumHoldMs - 1;
        trace.final.sampledAtUnixMs = trace.heldAtUnixMs;
      },
      (value) => { value.transitions[0].trace.final.surfaces[0].visible = false; },
      (value) => { value.transitions[0].trace.final.sampledAtUnixMs -= 1; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });
});
