// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB05MachineEvidence } from "./browser-gate-b05.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

const IDENTITY = Object.freeze({
  framework: "tauri", platform: "darwin", buildId: "b05-build", runId: "b05-run",
});

const rect = (x) => ({ x, y: 120, w: 320, h: 480 });

function evidence(engine = "browser") {
  const owners = [`${engine}-left`, `${engine}-right`];
  const transition = (direction, targetViewId, offset) => {
    const traceId = `${engine}-${direction}`;
    const times = [1_004, 1_030, 1_070, 1_110, 1_150, 1_190, 1_230, 1_270, 1_310, 1_350]
      .map((time) => time + offset);
    const surfaces = (step) => owners.map((viewId, ownerIndex) => {
      const frame = rect(100 + ownerIndex * 400 - Math.min(step, 8) * 10);
      return {
        viewId,
        surfaceId: `${engine}-surface-${ownerIndex}`,
        generation: 1,
        live: true,
        visible: true,
        painted: true,
        domFrame: frame,
        surfaceFrame: { ...frame },
      };
    });
    const presentationEvents = times.map((presentedAtUnixMs, sequence) => ({
      sequence,
      sourceGeneration: 3,
      presentationRevision: 20 + sequence,
      presentedAtUnixMs,
      surfaces: surfaces(sequence),
    }));
    return {
      direction,
      targetViewId,
      trace: {
        traceId,
        closed: true,
        ownerViewIds: owners,
        armedAtUnixMs: 1_000 + offset,
        stimulus: { address: `win/w/node/${targetViewId}`, atUnixMs: 1_010 + offset },
        layout: {
          transactionId: `${traceId}-layout`,
          causeTraceId: traceId,
          phase: "committed",
          mode: "glide",
          startAtUnixMs: 1_020 + offset,
          preparedAtUnixMs: 1_012 + offset,
          closedAtUnixMs: 1_360 + offset,
          moves: [{ viewId: targetViewId, dx: 410 }],
        },
        baselineFrameSequence: 0,
        presentationEvents,
        settled: { atUnixMs: 1_365 + offset, frameSequence: 9, syncPending: false },
        hold: {
          startedAtUnixMs: 1_365 + offset,
          endedAtUnixMs: 1_615 + offset,
          surfaces: structuredClone(presentationEvents.at(-1).surfaces),
        },
        violations: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0 },
      },
    };
  };
  return {
    engine,
    transitions: [
      transition("to-right", owners[1], 0),
      transition("to-left", owners[0], 1_000),
    ],
  };
}

describe("B05 actual presentation continuity judge", () => {
  it("세 engine의 양방향 실제 presentation 사건 원장만 GREEN receipt가 된다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB05MachineEvidence(evidence(engine))).toMatchObject({ status: "green", reason: null });
      expect(judgeBrowserMachineGateEvidence({
        ...IDENTITY, engine, gate: "B05", evidence: evidence(engine),
      })).toMatchObject({ gate: "B05", engine, status: "green", judgeId: "B05-machine-v1" });
    }
    expect(judgeB05MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
  });

  it("지연·프레임 공백·revision 정지·source 교체를 RED로 만든다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.presentationEvents[1].presentedAtUnixMs += 31; },
      (value) => { value.transitions[0].trace.presentationEvents[3].presentedAtUnixMs += 11; },
      (value) => { value.transitions[0].trace.presentationEvents[2].presentationRevision -= 1; },
      (value) => { value.transitions[0].trace.presentationEvents[2].sourceGeneration += 1; },
      (value) => { value.transitions[0].trace.settled.atUnixMs += 196; },
    ];
    for (const mutate of cases) {
      const value = evidence(); mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });

  it("표면 교체·소실·미표시·DOM 불일치·hold 회귀를 RED로 만든다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].generation = 2; },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces.pop(); },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].visible = false; },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].painted = false; },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].surfaceFrame.x += 2; },
      (value) => { value.transitions[0].trace.hold.endedAtUnixMs -= 1; },
      (value) => { value.transitions[0].trace.hold.surfaces[0].visible = false; },
      (value) => { value.transitions[0].trace.violations.droppedEvents = 1; },
    ];
    for (const mutate of cases) {
      const value = evidence(); mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });

  it("증거가 예산·픽셀·누적 counter를 끼워 기준을 바꾸지 못한다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.latencyBudgetMs = 10_000; },
      (value) => { value.transitions[0].trace.presentationEvents[0].blackPixels = 0; },
      (value) => { value.transitions[0].trace.countersBefore = { gaps: 0 }; },
    ];
    for (const mutate of cases) {
      const value = evidence(); mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });
});
