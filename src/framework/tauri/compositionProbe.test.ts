import { describe, expect, it } from "vitest";
import { combineTauriCompositionProbe } from "./compositionProbe";

const direct = (bad = false) => ({
  verdict: {
    misplaced: bad ? [{ x: 1, y: 2, w: 3, h: 4 }] : [],
    stacked: [], missing: [], surfaces: bad ? 1 : 0, holes: 0,
  },
});
const pane = (matched = true) => ({
  matched,
  verdict: matched ? "green" as const : "red" as const,
});

describe("Tauri resize composition probe", () => {
  it("requires both direct-slot and pane-host ownership planes to be green", () => {
    expect(combineTauriCompositionProbe(direct(), pane()).verdict).toBe("green");
    expect(combineTauriCompositionProbe(direct(true), pane()).verdict).toBe("red");
    expect(combineTauriCompositionProbe(direct(), pane(false)).verdict).toBe("red");
  });

  it("preserves both public facts instead of flattening incompatible match schemas", () => {
    expect(combineTauriCompositionProbe(direct(), pane())).toMatchObject({
      direct: { verdict: { misplaced: [] } },
      pane: { matched: true },
    });
  });
});
