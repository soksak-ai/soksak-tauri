// @vitest-environment node

import { describe, expect, it } from "vitest";
import { tauriSurfaceResizePolicyVerdict } from "./tauri-surface-resize-policy.mjs";

const surface = (overrides = {}) => ({
  label: "surface-a",
  pane: "pane-a",
  autoresizingMask: 18,
  layerContentsRedrawPolicy: 2,
  layerContentsPlacement: 11,
  ...overrides,
});

describe("Tauri surface resize ownership policy", () => {
  it("requires grouped members to inherit width and height in the parent AppKit epoch", () => {
    expect(tauriSurfaceResizePolicyVerdict([surface()])).toEqual({ ok: true, errors: [] });
    expect(tauriSurfaceResizePolicyVerdict([surface({ autoresizingMask: 0 })])).toMatchObject({
      ok: false,
      errors: ["surface-a:autoresizing=0/18(grouped:pane-a)"],
    });
  });

  it("requires standalone surfaces to keep explicit bounds ownership", () => {
    expect(tauriSurfaceResizePolicyVerdict([surface({ pane: null, autoresizingMask: 0 })]))
      .toEqual({ ok: true, errors: [] });
    expect(tauriSurfaceResizePolicyVerdict([surface({ pane: null, autoresizingMask: 18 })]))
      .toMatchObject({ ok: false, errors: ["surface-a:autoresizing=18/0(standalone)"] });
  });

  it("makes missing ownership or native policy telemetry RED", () => {
    const result = tauriSurfaceResizePolicyVerdict([
      surface({ pane: undefined }),
      surface({ label: "surface-b", layerContentsRedrawPolicy: null }),
      surface({ label: "surface-c", layerContentsPlacement: null }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "surface-a:pane=missing",
      "surface-b:redraw=null/2",
      "surface-c:placement=null/11",
    ]);
  });

  it("rejects an empty native surface measurement", () => {
    expect(tauriSurfaceResizePolicyVerdict([])).toEqual({
      ok: false,
      errors: ["surface:none"],
    });
  });
});
