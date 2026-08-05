// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createFiniteDomTraceSampler } from "./finiteDomTrace";

describe("finite DOM transition trace", () => {
  it("records exposed nodes and their CSS animation clocks on the recorder frame clock", () => {
    const rail = document.createElement("div");
    const pane = document.createElement("div");
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 20, width: 30, height: 40,
      left: 10, top: 20, right: 40, bottom: 60, toJSON: () => ({}),
    });
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      x: 50, y: 20, width: 100, height: 40,
      left: 50, top: 20, right: 150, bottom: 60, toJSON: () => ({}),
    });
    const effect = { getComputedTiming: () => ({ progress: 0.25 }) };
    Object.defineProperty(rail, "getAnimations", {
      value: () => [{ animationName: "rail-flip-x", startTime: 100, currentTime: 25, playState: "running", effect }],
    });
    Object.defineProperty(pane, "getAnimations", {
      value: () => [{ animationName: "rail-flip-x", startTime: 100, currentTime: 25, playState: "running", effect }],
    });
    const trace = createFiniteDomTraceSampler([
      { address: "rail/left", el: rail },
      { address: "layout/pane/a", el: pane },
    ]);

    trace.sample(0, 16);
    trace.sample(1, 32);
    const samples = trace.samples();

    expect(samples).toHaveLength(2);
    expect(samples[0].nodes).toEqual([
      expect.objectContaining({ address: "rail/left", connected: false, rect: { x: 10, y: 20, w: 30, h: 40 } }),
      expect.objectContaining({ address: "layout/pane/a", connected: false, rect: { x: 50, y: 20, w: 100, h: 40 } }),
    ]);
    expect(samples[0].nodes.map((node) => node.animations[0])).toEqual([
      expect.objectContaining({ name: "rail-flip-x", startTime: 100, currentTime: 25, progress: 0.25 }),
      expect.objectContaining({ name: "rail-flip-x", startTime: 100, currentTime: 25, progress: 0.25 }),
    ]);
    expect(samples.map((sample) => sample.captureFrame)).toEqual([0, 1]);
  });
});
