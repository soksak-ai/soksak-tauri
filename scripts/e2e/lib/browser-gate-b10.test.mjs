// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB10MachineEvidence } from "./browser-gate-b10.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

const IDENTITY = Object.freeze({
  framework: "tauri",
  platform: "darwin",
  buildId: "b10-build",
  runId: "b10-run",
});

const SCALE_FACTOR = 1.25;

function physicalRect(frame) {
  const left = Math.round(frame.x * SCALE_FACTOR);
  const top = Math.round(frame.y * SCALE_FACTOR);
  const right = Math.round((frame.x + frame.w) * SCALE_FACTOR);
  const bottom = Math.round((frame.y + frame.h) * SCALE_FACTOR);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function geometryFor(windowGeometry) {
  const contentWidth = windowGeometry.w - 100;
  const gap = 20;
  const width = (contentWidth - gap) / 2;
  const height = windowGeometry.h - 140;
  return [
    { x: windowGeometry.x + 50.2, y: windowGeometry.y + 90.4, w: width, h: height },
    { x: windowGeometry.x + 50.2 + width + gap, y: windowGeometry.y + 90.4, w: width, h: height },
  ];
}

function snapshot(engine, windowGeometry, eventGeneration, transactionGeneration, revision) {
  const viewIds = [`${engine}-left`, `${engine}-right`];
  const frames = geometryFor(windowGeometry);
  const participant = (kind, viewId, frame) => ({
    id: `${engine}-${kind}-${viewId.endsWith("left") ? "left" : "right"}`,
    viewId,
    topologyPath: `workspace/pane/${viewId}/browser`,
    visible: true,
    logicalFrame: { ...frame },
    physicalFrame: physicalRect(frame),
  });
  const slots = viewIds.map((viewId, index) => participant("slot", viewId, frames[index]));
  const renderers = viewIds.map((viewId, index) => participant("renderer", viewId, frames[index]));
  const surfaces = viewIds.map((viewId, index) => participant("surface", viewId, frames[index]));
  return {
    windowGeometry: { ...windowGeometry },
    eventGeneration,
    transactionGeneration,
    visibleViewIds: viewIds,
    slots,
    renderers,
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

const zeroCounters = () => ({
  replacements: 0,
  gaps: 0,
  disappearances: 0,
  unpresented: 0,
});

function evidence(engine = "browser", { extraWide = false } = {}) {
  const baselineWindow = { x: 50, y: 40, w: 800, h: 600 };
  const requests = [
    ["shrink", { x: 80, y: 60, w: 620, h: 480 }],
    ["wide", { x: 20, y: 70, w: 980, h: 520 }],
    ["tall", { x: 90, y: 10, w: 640, h: 760 }],
    ["restore", baselineWindow],
  ];
  if (extraWide) requests.splice(2, 0, ["wide", { x: 10, y: 80, w: 1_020, h: 500 }]);
  const baseline = snapshot(engine, baselineWindow, 100, 10, 20);
  let eventGeneration = baseline.eventGeneration;
  const transactions = requests.map(([phase, requestedWindowGeometry], sequence) => {
    const eventGenerationBefore = eventGeneration;
    eventGeneration += sequence % 2 === 0 ? 2 : 1;
    return {
      sequence,
      phase,
      requestedWindowGeometry: { ...requestedWindowGeometry },
      eventGenerationBefore,
      eventGenerationAfter: eventGeneration,
      transactionGeneration: baseline.transactionGeneration + sequence + 1,
      continuity: {
        countersBefore: zeroCounters(),
        countersAfter: zeroCounters(),
      },
      post: snapshot(
        engine,
        requestedWindowGeometry,
        eventGeneration,
        baseline.transactionGeneration + sequence + 1,
        baseline.presentations[0].revision + sequence + 1,
      ),
    };
  });
  return {
    engine,
    coordinateSpace: {
      logical: "css-px",
      physical: "device-px",
      scaleFactor: SCALE_FACTOR,
    },
    baseline,
    transactions,
  };
}

describe("B10 hostile window resize machine judge", () => {
  it("세 engine에 동일한 공개 frame·generation·presentation·restore 계약을 적용한다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB10MachineEvidence(evidence(engine))).toMatchObject({
        status: "green",
        reason: null,
      });
      expect(judgeBrowserMachineGateEvidence({
        ...IDENTITY,
        engine,
        gate: "B10",
        evidence: evidence(engine),
      })).toMatchObject({
        gate: "B10",
        engine,
        status: "green",
        judgeId: "B10-machine-v1",
      });
    }
    expect(judgeB10MachineEvidence(null)).toEqual({
      status: "not-run",
      evidence: [],
      reason: null,
    });
    expect(judgeB10MachineEvidence(evidence("browser", { extraWide: true })).status).toBe("green");
  });

  it("hostile 순서·요청 geometry·event/transaction generation을 모두 강제한다", () => {
    const cases = [
      (value) => { value.transactions.splice(1, 1); },
      (value) => { value.transactions[1].phase = "tall"; },
      (value) => { value.transactions[0].requestedWindowGeometry.w = 900; },
      (value) => { value.transactions[1].post.windowGeometry.w -= 1; },
      (value) => { value.transactions[2].eventGenerationBefore -= 1; },
      (value) => { value.transactions[2].eventGenerationAfter = value.transactions[2].eventGenerationBefore; },
      (value) => { value.transactions[1].transactionGeneration += 1; },
      (value) => { value.transactions[1].post.transactionGeneration += 1; },
      (value) => { value.transactions[3].sequence = 7; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB10MachineEvidence(value).status).toBe("red");
    }
  });

  it("모든 visible view의 rounding-only 합성·presentation 연속·무교체를 강제한다", () => {
    const cases = [
      (value) => { value.baseline.surfaces[0].physicalFrame.x += 1; },
      (value) => { value.transactions[0].post.renderers[1].physicalFrame.w -= 1; },
      (value) => { value.transactions[1].post.surfaces.pop(); },
      (value) => { value.transactions[1].post.visibleViewIds.pop(); },
      (value) => { value.transactions[2].post.presentations[0].revision -= 1; },
      (value) => { value.transactions[0].post.presentations[0].presented = false; },
      (value) => { value.transactions[1].post.surfaces[0].id = "replacement-surface"; },
      (value) => { value.transactions[1].post.presentations[0].surfaceGeneration = 2; },
      (value) => { value.transactions[2].continuity.countersAfter.gaps = 1; },
      (value) => { value.transactions[0].continuity.countersBefore.replacements = 1; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB10MachineEvidence(value).status).toBe("red");
    }
  });

  it("restore는 window와 모든 공개 frame·identity를 baseline으로 정확히 되돌린다", () => {
    const value = evidence();
    const restore = value.transactions.at(-1).post;
    for (const participant of [
      restore.slots[0],
      restore.renderers[0],
      restore.surfaces[0],
    ]) {
      participant.logicalFrame.x += 8;
      participant.physicalFrame = physicalRect(participant.logicalFrame);
    }
    expect(judgeB10MachineEvidence(value).status).toBe("red");
  });

  it("screenshot·pixel 값은 어느 깊이에서도 machine schema가 아니다", () => {
    const cases = [
      (value) => { value.screenshot = "b10.png"; },
      (value) => { value.baseline.pixelBounds = [0, 0, 1, 1]; },
      (value) => { value.transactions[0].screenshotPassed = true; },
      (value) => { value.transactions[1].post.surfaces[0].markerPixels = { red: 64 }; },
      (value) => { value.transactions[2].continuity.blackPixels = 0; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB10MachineEvidence(value).status).toBe("red");
    }
  });

  it("깨진 중첩 evidence는 예외 없이 RED가 된다", () => {
    const malformed = [
      17,
      {},
      { engine: "browser", coordinateSpace: null, baseline: null, transactions: null },
      { engine: "browser", coordinateSpace: {}, baseline: {}, transactions: [null, [], "bad", {}] },
      (() => {
        const value = evidence();
        value.baseline.slots = [null, null];
        value.transactions[0].continuity = null;
        value.transactions[1].post = null;
        value.transactions[2].post.presentations = [null, null];
        return value;
      })(),
      (() => {
        const value = evidence();
        value.transactions[0].requestedWindowGeometry = [];
        value.transactions[1].post.windowGeometry = "bad";
        value.transactions[2].post.renderers[0].logicalFrame = null;
        return value;
      })(),
    ];
    for (const value of malformed) {
      expect(() => judgeB10MachineEvidence(value)).not.toThrow();
      expect(judgeB10MachineEvidence(value).status).toBe("red");
    }
  });
});
