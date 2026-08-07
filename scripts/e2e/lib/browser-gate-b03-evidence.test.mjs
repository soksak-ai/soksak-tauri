// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB03MachineEvidence } from "./browser-gates.mjs";
import { mapB03LiveEvidence } from "./browser-gate-b03-evidence.mjs";
import { browserSurfaceObservation } from "./browser-surface-rects.mjs";

const rect = (x) => ({ x, y: 40.25, w: 300.5, h: 420.25 });

function raw() {
  const viewIds = ["left", "right"];
  const nodes = viewIds.flatMap((viewId, index) => ["slot", "renderer"].map((kind) => ({
    address: `win/w/content/view/browser/tab/${viewId}/${kind}`,
    nodeIdentity: `${kind}-${viewId}`,
    dataset: {
      compositionKind: kind,
      viewId,
      visible: "true",
      topologyPath: `workspace/pane/${viewId}/browser`,
    },
    rect: rect(50 + index * 340),
  })));
  return {
    engine: "browser",
    scaleFactor: 2,
    settledAtUnixMs: 1_700_000_000_000,
    visibleViewIds: viewIds,
    uiTree: { nodes },
    surfaceObservation: {
      source: "appkit-pane-member",
      sampledAtUnixMs: 1_700_000_000_010,
      receipts: viewIds.map((viewId, index) => ({
        viewId,
        surfaceId: `surface-${viewId}`,
        topologyPath: `workspace/pane/${viewId}/browser`,
        live: true,
        visible: true,
        rect: rect(50 + index * 340),
      })),
    },
  };
}

describe("B03 live evidence mapper", () => {
  it("independent owner ledger, exposed slot/renderer nodes, and live surfaces form the closed schema", () => {
    expect(judgeB03MachineEvidence(mapB03LiveEvidence(raw())).status).toBe("green");
  });

  // slot·renderer 는 메인 문서를 읽고 surface 는 표면 원장을 읽는다. 그 사실이 봉투에 실려야
  // 판정에 들어간다 — 어느 원장에서 왔는지 모르는 좌표는 일치해도 증명이 아니다.
  it("carries the ledger each observation came from", () => {
    expect(mapB03LiveEvidence(raw()).observation).toEqual({
      settledAtUnixMs: 1_700_000_000_000,
      sampledAtUnixMs: 1_700_000_000_010,
      sources: {
        slot: "dom-projection",
        renderer: "dom-projection",
        surface: "appkit-pane-member",
      },
    });
  });

  it("does not invent a missing native topology identity", () => {
    const value = raw();
    delete value.surfaceObservation.receipts[0].topologyPath;
    const evidence = mapB03LiveEvidence(value);
    expect(evidence.surfaces[0].topologyPath).toBeNull();
    expect(judgeB03MachineEvidence(evidence).status).toBe("red");
  });

  it("names a drifted checkpoint field on both sides instead of mapping it to null", () => {
    const value = raw();
    value.surfaceLedger = value.surfaceObservation;
    delete value.surfaceObservation;
    const evidence = mapB03LiveEvidence(value);
    expect(evidence.evidenceWiring).toEqual({
      source: "B03.live",
      unconsumed: ["surfaceLedger"],
      unproduced: ["surfaceObservation"],
      error: null,
    });
    const verdict = judgeB03MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    // 배선 이름이 값 증상보다 앞에 선다. surfaces=non-empty 만 보고 표면 소실을 쫓지 않는다.
    expect(verdict.evidence).toEqual([
      "B03:wiring.B03.live.surfaceLedger=produced-not-consumed",
      "B03:wiring.B03.live.surfaceObservation=consumed-not-produced",
      "B03:observation.sampledAtUnixMs=finite/null",
      "B03:observation.sources.surface=known/null",
      "B03:surfaces=non-empty/[]",
      "B03:inventory:surfaces=non-empty",
      "B03:inventory:visible-owners=left,right/left,right/left,right/",
    ]);
  });

  it("names a checkpoint field that throws instead of killing the harness", () => {
    const value = raw();
    Object.defineProperty(value, "engine", {
      enumerable: true,
      get() {
        throw new TypeError("engine checkpoint read failed");
      },
    });
    let verdict;
    expect(() => {
      verdict = judgeB03MachineEvidence(mapB03LiveEvidence(value));
    }).not.toThrow();
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      'B03:wiring.B03.live=mapper-threw/"TypeError: engine checkpoint read failed"',
    );
  });

  // 실측 재현(run slot-freeze-4aeda1ec · browser-chromium-offscreen): 자리는 창 좌표
  // {x:60,y:149}, 표면이 답한 자리는 presenter 를 원점으로 한 {x:0,y:28} 이었다. 두 축을 그대로
  // 맞대면 판정은 좌표계 차이를 합성 결함으로 읽는다 — 이 사슬이 그 둘을 같은 축으로 세운다.
  it("judges the offscreen engine green from the numbers the run actually measured", () => {
    const windowLabel = "w-8ee125bf-a8ef-4069-8951-e74c958f5836";
    const viewIds = ["tab-m5bxed", "tab-7hleas"];
    const labels = viewIds.map((viewId) => `offscreen-${viewId}`);
    const slotX = [60, 613];
    const topology = (index) =>
      `window/${windowLabel}/view/${viewIds[index]}/content/${labels[index]}`;
    const settledAtUnixMs = 1_786_102_060_636;

    const observation = browserSurfaceObservation({
      nativeChildWebview: true,
      surface: "engine-offscreen",
      windowLabel,
      viewIds,
      labels,
      paneComposition: {
        matches: viewIds.map((viewId, index) => ({
          viewId,
          nativeFrame: { x: slotX[index], y: 121, w: 381, h: 549 },
          memberMatches: [{ label: labels[index], nativeCount: 1, ok: true }],
        })),
      },
      stats: {
        sampledAtUnixMs: settledAtUnixMs + 64,
        ids: viewIds.map((viewId, index) => ({ viewId, surfaceId: 5 + index })),
        surfaces: viewIds.map((viewId, index) => ({
          viewId,
          surfaceId: 5 + index,
          label: labels[index],
          topologyPath: topology(index),
          coordinateSpace: {
            logical: "css-px", origin: "presenter-local", referenceId: labels[index],
          },
          frame: { x: 0, y: 28, w: 381, h: 521 },
        })),
        engine: {
          ids: [5, 6],
          surfaces: viewIds.map((_viewId, index) => ({
            id: 5 + index,
            hidden: false,
            presentation: { x: 0, y: 28, w: 381, h: 521 },
            viewport: { matches: true },
            resize: { pending: false },
          })),
        },
      },
    });

    const verdict = judgeB03MachineEvidence(mapB03LiveEvidence({
      engine: "browser-chromium-offscreen",
      scaleFactor: 2,
      settledAtUnixMs,
      visibleViewIds: viewIds,
      uiTree: {
        nodes: viewIds.flatMap((viewId, index) => ["slot", "renderer"].map((kind) => ({
          nodeIdentity: `${kind}-${viewId}`,
          dataset: {
            compositionKind: kind, viewId, visible: "true", topologyPath: topology(index),
          },
          rect: { x: slotX[index], y: 149, w: 381, h: 521 },
        }))),
      },
      surfaceObservation: observation,
    }));

    expect(verdict.evidence).toEqual([
      "browser-chromium-offscreen/B03:visible=2"
        + ";slot+renderer+surface=1:1-physical-rounding"
        + ";surface-ledger=engine-surface-ledger",
    ]);
    expect(verdict.status).toBe("green");
  });

  it("records a clean wiring ledger on the green path", () => {
    const evidence = mapB03LiveEvidence(raw());
    expect(evidence.evidenceWiring).toEqual({
      source: "B03.live",
      unconsumed: [],
      unproduced: [],
      error: null,
    });
  });
});
