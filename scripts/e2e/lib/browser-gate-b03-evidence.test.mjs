// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB03MachineEvidence } from "./browser-gates.mjs";
import { mapB03LiveEvidence } from "./browser-gate-b03-evidence.mjs";

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
    visibleViewIds: viewIds,
    uiTree: { nodes },
    surfaceReceipts: viewIds.map((viewId, index) => ({
      viewId,
      surfaceId: `surface-${viewId}`,
      topologyPath: `workspace/pane/${viewId}/browser`,
      live: true,
      visible: true,
      rect: rect(50 + index * 340),
    })),
  };
}

describe("B03 live evidence mapper", () => {
  it("independent owner ledger, exposed slot/renderer nodes, and live surfaces form the closed schema", () => {
    expect(judgeB03MachineEvidence(mapB03LiveEvidence(raw())).status).toBe("green");
  });

  it("does not invent a missing native topology identity", () => {
    const value = raw();
    delete value.surfaceReceipts[0].topologyPath;
    const evidence = mapB03LiveEvidence(value);
    expect(evidence.surfaces[0].topologyPath).toBeNull();
    expect(judgeB03MachineEvidence(evidence).status).toBe("red");
  });
});
