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
      adapterBases: ["pane-host", "pane-host"],
    },
    lightingPlane: {
      presented: 1,
      parked: 0,
      unreadable: 0,
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

  // 값과 그 값을 낸 장부의 이름은 함께 온다 — 이름 없이 실린 alpha 는 측정이 아니라 선언이다.
  it("carries the ledger each adapter alpha came from", () => {
    expect(mapB06LiveEvidence(raw()).checkpoints[0].panes[0].adapterBasis).toBe("pane-host");

    const value = raw();
    delete value.checkpoints[0].lighting.adapterBases;
    const evidence = mapB06LiveEvidence(value);
    expect(evidence.checkpoints[0].panes[0].adapterBasis).toBeNull();
    expect(judgeB06MachineEvidence(evidence).status).toBe("red");
  });

  it("records a clean wiring ledger on both the envelope and every checkpoint", () => {
    const evidence = mapB06LiveEvidence(raw());
    expect(evidence.evidenceWiring).toEqual({
      source: "B06.live",
      unconsumed: [],
      unproduced: [],
      error: null,
    });
    expect(evidence.checkpoints.map((checkpoint) => checkpoint.evidenceWiring)).toEqual([
      { source: "B06.checkpoint[0]", unconsumed: [], unproduced: [], error: null },
      { source: "B06.checkpoint[1]", unconsumed: [], unproduced: [], error: null },
    ]);
  });

  it("names the harness-side rail rename on both sides instead of losing the exemption", () => {
    // 실제 사고 모양: 하니스가 checkpoint 에 railComposition 을 싣고 mapper 는 rail 을 찾았다.
    // 생산만 되고 소비되지 않은 이름과 소비만 되고 생산되지 않은 이름이 둘 다 조용했다.
    const value = raw();
    value.checkpoints[0].railComposition = value.checkpoints[0].rail;
    delete value.checkpoints[0].rail;
    const evidence = mapB06LiveEvidence(value);
    expect(evidence.checkpoints[0].evidenceWiring).toEqual({
      source: "B06.checkpoint[0]",
      unconsumed: ["railComposition"],
      unproduced: ["rail"],
      error: null,
    });
    const verdict = judgeB06MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      "B06:wiring.B06.checkpoint[0].railComposition=produced-not-consumed",
    );
    expect(verdict.evidence).toContain("B06:wiring.B06.checkpoint[0].rail=consumed-not-produced");
  });

  it("names a drifted envelope field on both sides", () => {
    const value = raw();
    value.phases = value.checkpoints;
    delete value.checkpoints;
    const evidence = mapB06LiveEvidence(value);
    expect(evidence.evidenceWiring).toEqual({
      source: "B06.live",
      unconsumed: ["phases"],
      unproduced: ["checkpoints"],
      error: null,
    });
    const verdict = judgeB06MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B06:wiring.B06.live.phases=produced-not-consumed");
    expect(verdict.evidence).toContain("B06:wiring.B06.live.checkpoints=consumed-not-produced");
  });

  it("names a checkpoint field that throws instead of killing the harness", () => {
    const value = raw();
    Object.defineProperty(value.checkpoints[0], "phase", {
      enumerable: true,
      get() {
        throw new TypeError("phase checkpoint read failed");
      },
    });
    let verdict;
    expect(() => {
      verdict = judgeB06MachineEvidence(mapB06LiveEvidence(value));
    }).not.toThrow();
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      'B06:wiring.B06.checkpoint[0]=mapper-threw/"TypeError: phase checkpoint read failed"',
    );
  });
});
