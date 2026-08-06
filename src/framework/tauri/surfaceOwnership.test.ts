import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTauriSurfaceOwnershipForTest,
  claimDirectSurface,
  claimPaneSurface,
  onTauriSurfaceOwnershipChanged,
  releaseDirectSurface,
  releasePaneSurface,
  tauriSurfaceOwner,
  tauriSurfaceOwnershipFacts,
} from "./surfaceOwnership";

describe("Tauri surface geometry ownership ledger", () => {
  beforeEach(__resetTauriSurfaceOwnershipForTest);

  it("open/close lifecycle declares and removes a direct owner", () => {
    claimDirectSurface("b-1");
    expect(tauriSurfaceOwner("b-1")).toBe("direct");
    releaseDirectSurface("b-1");
    expect(tauriSurfaceOwner("b-1")).toBeNull();
  });

  it("PaneSurfaceHost claim wins and release returns ownership to a still-open direct surface", () => {
    claimPaneSurface("b-1", "pane-1");
    claimDirectSurface("b-1");
    expect(tauriSurfaceOwner("b-1")).toBe("pane");
    expect(tauriSurfaceOwnershipFacts()).toEqual([
      { label: "b-1", owner: "pane", pane: "pane-1" },
    ]);
    releasePaneSurface("b-1", "pane-1");
    expect(tauriSurfaceOwner("b-1")).toBe("direct");
  });

  it("wrong pane cannot release another PaneSurfaceHost claim and idempotent writes stay silent", () => {
    const listener = vi.fn();
    onTauriSurfaceOwnershipChanged(listener);
    claimPaneSurface("b-1", "pane-1");
    claimPaneSurface("b-1", "pane-1");
    releasePaneSurface("b-1", "pane-other");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tauriSurfaceOwner("b-1")).toBe("pane");
  });
});
