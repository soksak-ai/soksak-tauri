// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB09MachineEvidence } from "./browser-gate-b09.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

const TARGETS = Object.freeze([
  "rail/add",
  "sidebar/right",
  "modal/project-new",
]);

const IDENTITY = Object.freeze({
  framework: "tauri",
  platform: "darwin",
  buildId: "b09-build",
  runId: "b09-run",
});

function evidence(engine = "browser") {
  return {
    engine,
    samples: TARGETS.map((target, index) => {
      const viewId = `${engine}-view-${index}`;
      const surfaceId = `${engine}-surface-${index}`;
      const offset = index * 200;
      return {
        target,
        chromeRect: { x: 100 + offset, y: 100, w: 40, h: 40 },
        nativeSurface: {
          viewId,
          surfaceId,
          live: true,
          visible: true,
          presented: true,
          rect: { x: 120 + offset, y: 120, w: 100, h: 100 },
        },
        hit: {
          point: { x: 130 + offset, y: 130 },
          topmostOwner: target,
          stack: [
            { kind: "chrome", owner: target, surfaceId: null },
            { kind: "native-surface", owner: viewId, surfaceId },
          ],
        },
      };
    }),
  };
}

describe("B09 chrome-over-native public hit judge", () => {
  it("세 engine의 rail +, right sidebar, modal에 동일 schema를 적용한다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB09MachineEvidence(evidence(engine))).toMatchObject({
        status: "green",
        reason: null,
      });
      expect(judgeBrowserMachineGateEvidence({
        ...IDENTITY,
        engine,
        gate: "B09",
        evidence: evidence(engine),
      })).toMatchObject({
        gate: "B09",
        engine,
        status: "green",
        judgeId: "B09-machine-v1",
      });
    }
    expect(judgeB09MachineEvidence(null)).toEqual({
      status: "not-run",
      evidence: [],
      reason: null,
    });
  });

  it("양의 교집합·그 안의 hit point·chrome 최상단·native 하단을 모두 요구한다", () => {
    const cases = [
      (value) => { value.samples[0].nativeSurface.rect.x = 140; },
      (value) => { value.samples[0].hit.point.x = 110; },
      (value) => { value.samples[1].hit.topmostOwner = "rail/add"; },
      (value) => { value.samples[1].hit.stack[0].owner = "modal/project-new"; },
      (value) => { value.samples[2].hit.stack.reverse(); },
      (value) => { value.samples[2].hit.stack[1].surfaceId = "other-surface"; },
      (value) => { value.samples[0].nativeSurface.live = false; },
      (value) => { value.samples[1].nativeSurface.visible = false; },
      (value) => { value.samples[2].nativeSurface.presented = false; },
      (value) => { value.samples[2].target = "sidebar/right"; },
      (value) => { value.samples.pop(); },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB09MachineEvidence(value).status).toBe("red");
    }
  });

  it("screenshot·pixel 성공값은 어느 깊이에서도 machine schema가 아니다", () => {
    const cases = [
      (value) => { value.screenshotPassed = true; },
      (value) => { value.samples[0].pixelVisible = true; },
      (value) => { value.samples[1].hit.screenshot = "b09.png"; },
      (value) => { value.samples[2].hit.stack[0].pixelTopmost = true; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB09MachineEvidence(value).status).toBe("red");
    }
  });

  it("깨진 중첩 evidence는 예외를 던지지 않고 RED 영수증을 낸다", () => {
    const malformed = [
      17,
      {},
      { engine: "browser", samples: [null, null, null] },
      { engine: "browser", samples: [{}, [], "bad"] },
      (() => {
        const value = evidence();
        value.samples[0].nativeSurface = null;
        value.samples[1].chromeRect = "bad";
        value.samples[2].hit = null;
        return value;
      })(),
      (() => {
        const value = evidence();
        value.samples[0].hit.stack = [null, { kind: "native-surface" }];
        value.samples[1].hit.point = { x: Number.NaN, y: Number.POSITIVE_INFINITY };
        value.samples[2].nativeSurface.rect = [];
        return value;
      })(),
    ];
    for (const value of malformed) {
      expect(() => judgeB09MachineEvidence(value)).not.toThrow();
      expect(judgeB09MachineEvidence(value).status).toBe("red");
    }
  });
});
