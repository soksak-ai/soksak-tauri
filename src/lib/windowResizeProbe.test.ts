import { describe, expect, it, vi, beforeEach } from "vitest";

const outerPosition = vi.fn();
const outerSize = vi.fn();

vi.mock("../framework", () => ({
  currentWindow: () => ({ outerPosition, outerSize }),
}));

import {
  RESIZE_OBSERVATION_KEYS,
  RESIZE_PARTICIPANT_KEYS,
  RESIZE_PRESENTATION_KEYS,
  RESIZE_SNAPSHOT_KEYS,
  RESIZE_TRANSACTION_PHASES,
  composeResizeObservation,
  registerWindowResizeProbe,
  resizeCompositionViolations,
  sampleWindowResizeProbe,
  type ResizeCompositionObservation,
} from "./windowResizeProbe";

const participant = (viewId: string, id: string) => ({
  id,
  viewId,
  topologyPath: `window/w-1/view/${viewId}`,
  visible: true as const,
  logicalFrame: { x: 0, y: 0, w: 100, h: 50 },
  physicalFrame: { x: 0, y: 0, w: 200, h: 100 },
});

const counters = () => ({ replacements: 0, gaps: 0, disappearances: 0, unpresented: 0 });

const observed = (): ResizeCompositionObservation => ({
  eventGeneration: 4,
  transactionGeneration: 2,
  visibleViewIds: ["v1"],
  slots: [participant("v1", "slot/v1")],
  renderers: [participant("v1", "renderer/v1")],
  surfaces: [participant("v1", "surface/v1")],
  presentations: [{
    viewId: "v1",
    surfaceId: "surface/v1",
    surfaceGeneration: 1,
    revision: 7,
    live: true,
    visible: true,
    presented: true,
  }],
  eventGenerationBefore: 3,
  eventGenerationAfter: 4,
  continuity: { countersBefore: counters(), countersAfter: counters() },
});

describe("resize 관측 봉투 계약", () => {
  it("한 축은 한 이름으로만 불린다", () => {
    expect(RESIZE_SNAPSHOT_KEYS).toEqual([
      "windowGeometry",
      "eventGeneration",
      "transactionGeneration",
      "visibleViewIds",
      "slots",
      "renderers",
      "surfaces",
      "presentations",
    ]);
    expect(RESIZE_PARTICIPANT_KEYS).toEqual([
      "id", "viewId", "topologyPath", "visible", "logicalFrame", "physicalFrame",
    ]);
    expect(RESIZE_PRESENTATION_KEYS).toEqual([
      "viewId", "surfaceId", "surfaceGeneration", "revision", "live", "visible", "presented",
    ]);
    expect(RESIZE_TRANSACTION_PHASES).toEqual(["shrink", "wide", "tall", "restore"]);
  });

  it("관측 봉투는 요청면과 관측면을 같은 키로 싣는다", () => {
    expect(RESIZE_OBSERVATION_KEYS).toEqual([
      "phase",
      "requestedWindowGeometry",
      "eventGenerationBefore",
      "eventGenerationAfter",
      "transactionGeneration",
      "continuity",
      "snapshot",
      "contractViolations",
    ]);
  });

  it("계약을 지킨 관측은 위반 이름을 하나도 남기지 않는다", () => {
    expect(resizeCompositionViolations(observed())).toEqual([]);
  });

  it("다른 이름으로 부른 축은 그 축 이름으로 거절한다", () => {
    const renamed = { ...observed() } as Record<string, unknown>;
    // Electron 은 같은 축을 transaction 으로 불러 왔다.
    renamed.transaction = renamed.transactionGeneration;
    delete renamed.transactionGeneration;
    expect(resizeCompositionViolations(renamed)).toContain(
      "transactionGeneration=integer>=0/undefined",
    );

    const generation = { ...observed() } as Record<string, unknown>;
    // Tauri 는 같은 축을 generation 으로 불러 왔다.
    generation.generation = generation.transactionGeneration;
    delete generation.transactionGeneration;
    expect(resizeCompositionViolations(generation)).toContain(
      "transactionGeneration=integer>=0/undefined",
    );
  });

  it("빠진 사실은 자리 이름으로 드러난다", () => {
    const broken = observed();
    broken.presentations = [{ ...broken.presentations[0], revision: 0 }];
    broken.surfaces = [];
    broken.visibleViewIds = [];
    expect(resizeCompositionViolations(broken)).toEqual(expect.arrayContaining([
      "presentations[0].revision=integer>=1/0",
      "surfaces=non-empty-array/[]",
      "visibleViewIds=unique-non-empty-strings/[]",
    ]));
  });

  it("세대는 정수 0 이상이고 단계는 이전보다 커야 한다", () => {
    const broken = observed();
    broken.transactionGeneration = -1;
    broken.eventGenerationAfter = broken.eventGenerationBefore;
    expect(resizeCompositionViolations(broken)).toEqual(expect.arrayContaining([
      "transactionGeneration=integer>=0/-1",
      "eventGenerationAfter=>eventGenerationBefore/3/3",
    ]));
  });
});

describe("코어가 채우는 요청면", () => {
  it("windowGeometry 는 관측값이고 requestedWindowGeometry 만 요청을 싣는다", () => {
    const observation = composeResizeObservation({
      request: { kind: "step", step: 2, size: { w: 1200, h: 800 }, phase: "wide" },
      windowGeometry: { x: 11, y: 22, w: 1200, h: 800 },
      observed: observed(),
    });
    expect(observation.snapshot.windowGeometry).toEqual({ x: 11, y: 22, w: 1200, h: 800 });
    expect(observation.requestedWindowGeometry).toEqual({ x: 11, y: 22, w: 1200, h: 800 });
    expect(observation.phase).toBe("wide");
    expect(Object.keys(observation.snapshot)).toEqual([...RESIZE_SNAPSHOT_KEYS]);
  });

  it("관측한 창 기하가 요청과 다르면 그대로 답한다", () => {
    const observation = composeResizeObservation({
      request: { kind: "step", step: 0, size: { w: 1200, h: 800 }, phase: "shrink" },
      windowGeometry: { x: 0, y: 0, w: 640, h: 480 },
      observed: observed(),
    });
    expect(observation.snapshot.windowGeometry).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    expect(observation.requestedWindowGeometry).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  });

  it("baseline 은 요청면이 없다", () => {
    const observation = composeResizeObservation({
      request: { kind: "baseline" },
      windowGeometry: { x: 0, y: 0, w: 900, h: 600 },
      observed: observed(),
    });
    expect(observation.phase).toBeNull();
    expect(observation.requestedWindowGeometry).toBeNull();
  });
});

describe("관측면 등록부", () => {
  beforeEach(() => {
    registerWindowResizeProbe(null);
    outerPosition.mockReset().mockResolvedValue({ x: 5, y: 6 });
    outerSize.mockReset().mockResolvedValue({ width: 1000, height: 700 });
  });

  it("probe 가 없는 프레임워크는 관측하지 않았다고 답한다", async () => {
    expect(await sampleWindowResizeProbe({ kind: "baseline" })).toBeNull();
  });

  it("관측자에게는 요청 크기를 알려주지 않는다", async () => {
    const probe = vi.fn(() => observed());
    registerWindowResizeProbe(probe);
    await sampleWindowResizeProbe({ kind: "step", step: 3, size: { w: 800, h: 600 }, phase: "tall" });
    expect(probe).toHaveBeenCalledWith({ kind: "step", step: 3 });
    expect(JSON.stringify(probe.mock.calls[0])).not.toContain("800");
  });

  it("창 기하는 어댑터가 아니라 중립 창 표면에서 잰다", async () => {
    registerWindowResizeProbe(() => observed());
    const observation = await sampleWindowResizeProbe({
      kind: "step", step: 0, size: { w: 1000, h: 700 }, phase: "restore",
    });
    expect(observation?.snapshot.windowGeometry).toEqual({ x: 5, y: 6, w: 1000, h: 700 });
    expect(observation?.contractViolations).toEqual([]);
  });

  it("어댑터가 계약을 어기면 봉투에 위반 이름이 실린다", async () => {
    registerWindowResizeProbe(() => ({ ...observed(), transactionGeneration: null } as never));
    const observation = await sampleWindowResizeProbe({ kind: "baseline" });
    expect(observation?.contractViolations).toContain("transactionGeneration=integer>=0/null");
  });
});
