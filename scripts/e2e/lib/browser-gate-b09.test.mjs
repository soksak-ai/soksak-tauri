// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { buildB09Sample } from "./browser-gate-b09-evidence.mjs";
import { judgeB09MachineEvidence } from "./browser-gate-b09.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";
import { mapBrowserSurfaceRects } from "./browser-surface-rects.mjs";

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

const PLANE_Z = Object.freeze({
  "rail/add": 120,
  "sidebar/right": 200,
  "modal/project-new": 400,
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
        relation: target === "rail/add" ? "global-layer-order" : "point-overlap",
        chromeRect: { x: 100 + offset, y: 100, w: 40, h: 40 },
        chromeControl: { reachable: true, planeZ: PLANE_Z[target] },
        nativeSurface: {
          viewId,
          surfaceId,
          topologyPath: `window/w-b09/view/${viewId}/content/${surfaceId}`,
          chromeAboveHost: true,
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

const PANE_IMPLEMENTATIONS = Object.freeze([
  { engine: "browser", surface: "framework-native" },
  { engine: "browser-chromium", surface: "engine-windowed" },
]);

const PANE_VIEW_IDS = Object.freeze(["tab-left", "tab-right"]);
const PANE_LABELS = Object.freeze(["b-w-b09-tab-left", "b-w-b09-tab-right"]);

const CHROME_RECTS = Object.freeze({
  "rail/add": { x: 8, y: 200, w: 36, h: 36 },
  "sidebar/right": { x: 600, y: 140, w: 200, h: 400 },
  "modal/project-new": { x: 400, y: 200, w: 300, h: 200 },
});
const PROBE_POINTS = Object.freeze({
  "rail/add": { x: 26, y: 218 },
  "sidebar/right": { x: 700, y: 300 },
  "modal/project-new": { x: 600, y: 300 },
});

/** slot-freeze가 B09 nativeSurface로 그대로 싣는 공개 surface 영수증을 생산자에서 만든다. */
function producedSurfaces(surface) {
  return mapBrowserSurfaceRects({
    framework: "tauri",
    surface,
    windowLabel: "w-b09",
    viewIds: [...PANE_VIEW_IDS],
    labels: [...PANE_LABELS],
    paneComposition: {
      matches: PANE_VIEW_IDS.map((viewId, index) => ({
        viewId,
        chromeAboveHost: true,
        alpha: 1,
        domFrame: { x: index ? 513 : 60, y: 121, w: 281, h: 449 },
        memberMatches: [{
          label: PANE_LABELS[index],
          topologyPath: `window/w-b09/view/${viewId}/content/${PANE_LABELS[index]}`,
          nativeCount: 1,
          ok: true,
          domFrame: { x: 0, y: 28, w: 281, h: 421 },
        }],
      })),
    },
    stats: {
      idMap: { "chromium-tab-left": 11, "chromium-tab-right": 12 },
      ids: [11, 12],
      surfaces: [
        { id: 11, hidden: false, composition: { generation: 4 } },
        { id: 12, hidden: false, composition: { generation: 4 } },
      ],
    },
  });
}

function producedEvidence({ engine, surface }) {
  const surfaces = producedSurfaces(surface);
  const samples = TARGETS.map((target, index) => buildB09Sample({
    target,
    relation: target === "rail/add" ? "global-layer-order" : "point-overlap",
    chromeRect: { ...CHROME_RECTS[target] },
    chromeControl: { reachable: true, planeZ: PLANE_Z[target] },
    nativeSurface: surfaces[index === 0 ? 0 : 1],
    point: { ...PROBE_POINTS[target] },
    hit: { owners: [target] },
  }));
  return { engine, samples };
}

describe("B09 surface receipt는 생산자 shape 그대로 판정된다", () => {
  it("pane 소유 두 구현의 공개 영수증을 그대로 실어도 GREEN이다", () => {
    for (const implementation of PANE_IMPLEMENTATIONS) {
      expect(judgeB09MachineEvidence(producedEvidence(implementation))).toEqual({
        status: "green",
        evidence: [
          `${implementation.engine}/B09:rail-add=global-chrome-above-native;`
            + "right-sidebar+modal=overlap-hit-topmost;native=declared-topology",
        ],
        reason: null,
      });
    }
  });

  it("실측 층 순서 사실을 표본마다 싣는다 — 위반은 blocked 가 아니라 이름 붙은 RED다", () => {
    for (const implementation of PANE_IMPLEMENTATIONS) {
      const value = producedEvidence(implementation);
      expect(value.samples.map((sample) => sample.nativeSurface.chromeAboveHost))
        .toEqual([true, true, true]);

      const inverted = producedEvidence(implementation);
      inverted.samples[1].nativeSurface = {
        ...inverted.samples[1].nativeSurface,
        chromeAboveHost: false,
      };
      const verdict = judgeB09MachineEvidence(inverted);
      expect(verdict.status).toBe("red");
      expect(verdict.evidence).toContain("B09:samples[1].nativeSurface.chromeAboveHost=true/false");
    }
  });

  it("층 순서 사실이 아예 빠지면 누락으로 이름 붙인다 — 침묵으로 통과하지 않는다", () => {
    const value = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    const stripped = { ...value.samples[0].nativeSurface };
    delete stripped.chromeAboveHost;
    value.samples[0].nativeSurface = stripped;
    expect(judgeB09MachineEvidence(value).evidence)
      .toContain("B09:samples[0].nativeSurface.chromeAboveHost=missing");
  });

  it("target 하위 주소가 최상위 소유자여도 GREEN 이다 — 실제 응답은 잎을 답한다", () => {
    const value = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    value.samples[2] = buildB09Sample({
      target: "modal/project-new",
      relation: "point-overlap",
      chromeRect: { ...CHROME_RECTS["modal/project-new"] },
      chromeControl: { reachable: true, planeZ: PLANE_Z["modal/project-new"] },
      nativeSurface: value.samples[2].nativeSurface,
      point: { ...PROBE_POINTS["modal/project-new"] },
      hit: { owners: ["modal/project-new/card", "modal/project-new"] },
    });
    expect(judgeB09MachineEvidence(value).status).toBe("green");
  });

  it("chrome 조작면 도달 불가와 낮은 modal 평면을 RED 이름으로 남긴다", () => {
    const unreachable = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    unreachable.samples[0].chromeControl = { reachable: false, planeZ: 120 };
    expect(judgeB09MachineEvidence(unreachable).evidence)
      .toContain("B09:samples[0].chromeControl.reachable=true/false");

    const lowPlane = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    lowPlane.samples[2].chromeControl = { reachable: true, planeZ: 12 };
    expect(judgeB09MachineEvidence(lowPlane).evidence)
      .toContain("B09:samples[2].chromeControl.planeZ=>=300/12");

    const missingPlane = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    missingPlane.samples[2].chromeControl = { reachable: true, planeZ: null };
    expect(judgeB09MachineEvidence(missingPlane).evidence)
      .toContain("B09:samples[2].chromeControl.planeZ=>=300/null");

    const noControl = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    delete noControl.samples[1].chromeControl;
    expect(judgeB09MachineEvidence(noControl).evidence)
      .toContain("B09:samples[1].chromeControl=missing");
  });

  it("겹침이 없는 overlay 를 좌표로 RED 한다 — 생산자가 던져서 지우지 않는다", () => {
    const value = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    value.samples[1].chromeRect = { x: 0, y: 0, w: 20, h: 20 };
    const verdict = judgeB09MachineEvidence(value);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.some((line) => line.startsWith("B09:samples[1].overlap=positive-area/")))
      .toBe(true);
  });

  it("native surface의 공개 topology 신원이 비면 RED로 이름 붙인다", () => {
    const blank = producedEvidence(PANE_IMPLEMENTATIONS[0]);
    blank.samples[1].nativeSurface = { ...blank.samples[1].nativeSurface, topologyPath: "" };
    expect(judgeB09MachineEvidence(blank).evidence)
      .toContain('B09:samples[1].nativeSurface.topologyPath=non-empty/""');

    const absent = producedEvidence(PANE_IMPLEMENTATIONS[1]);
    const stripped = { ...absent.samples[2].nativeSurface };
    delete stripped.topologyPath;
    absent.samples[2].nativeSurface = stripped;
    expect(judgeB09MachineEvidence(absent).evidence)
      .toContain("B09:samples[2].nativeSurface.topologyPath=missing");
  });
});

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

  it("rail은 전역 sibling 순서를, 실제 overlay는 양의 교집합 내부 hit를 요구한다", () => {
    const cases = [
      (value) => { value.samples[0].relation = "point-overlap"; value.samples[0].nativeSurface.rect.x = 140; },
      (value) => { value.samples[0].hit.point.x = 90; },
      (value) => { value.samples[1].hit.topmostOwner = "rail/add"; },
      (value) => { value.samples[1].hit.stack[0].owner = "modal/project-new"; },
      (value) => { value.samples[2].hit.stack.reverse(); },
      (value) => { value.samples[2].hit.stack[1].surfaceId = "other-surface"; },
      (value) => { value.samples[0].nativeSurface.live = false; },
      (value) => { value.samples[1].nativeSurface.visible = false; },
      (value) => { value.samples[2].nativeSurface.presented = false; },
      (value) => { value.samples[2].target = "sidebar/right"; },
      (value) => { value.samples.pop(); },
      (value) => { value.samples[2].relation = "global-layer-order"; },
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
