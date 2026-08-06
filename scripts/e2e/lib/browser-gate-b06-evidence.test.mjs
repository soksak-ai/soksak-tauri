// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB06MachineEvidence } from "./browser-gate-b06.mjs";
import { mapB06LiveEvidence } from "./browser-gate-b06-evidence.mjs";

const exempt = (node) => ({ node, exempt: true, styleDim: 0, coveredByPlane: false });

function checkpoint(activeIndex) {
  const paneIds = ["left", "right"];
  return {
    phase: activeIndex === 0 ? "active-left" : "active-right",
    activePaneId: paneIds[activeIndex],
    paneIds,
    lighting: {
      dims: activeIndex === 0 ? [0, 0.7] : [0.7, 0],
      levels: activeIndex === 0 ? ["clear", "dimmed"] : ["dimmed", "clear"],
      adapterAlphas: [1, 1],
    },
    lightingPlane: {
      count: 1,
      baseAmount: 0.7,
      aperturePaneId: paneIds[activeIndex],
      apertureCount: 1,
    },
    rail: exempt("rail"),
    sidebar: exempt("sidebar"),
  };
}

function raw() {
  return { engine: "browser", checkpoints: [checkpoint(0), checkpoint(1)] };
}

describe("B06 live evidence mapper", () => {
  it("closes pane style, adapter alpha, plane aperture, and exempt-node facts", () => {
    expect(judgeB06MachineEvidence(mapB06LiveEvidence(raw())).status).toBe("green");
  });

  it("does not treat an unreported adapter alpha as neutral", () => {
    const value = raw();
    delete value.checkpoints[0].lighting.adapterAlphas;
    const evidence = mapB06LiveEvidence(value);
    expect(evidence.checkpoints[0].panes[0].adapterAlpha).toBeNull();
    expect(judgeB06MachineEvidence(evidence).status).toBe("red");
  });
});
