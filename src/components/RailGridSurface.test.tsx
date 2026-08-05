// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailGridSurface } from "./RailGridSurface";

describe("RailGridSurface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  });

  it("keeps the rail inside the panel grid and below the content tabs", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <div className="content">
          <div className="space-tabs" data-testid="tabs" />
          <RailGridSurface
            railPlane={<div className="left-rail-plane" data-testid="rail" />}
          >
            <div className="space-plane" data-testid="grid" />
          </RailGridSurface>
        </div>,
      );
    });

    const tabs = host.querySelector<HTMLElement>("[data-testid=tabs]")!;
    const rail = host.querySelector<HTMLElement>("[data-testid=rail]")!;
    const grid = host.querySelector<HTMLElement>("[data-testid=grid]")!;
    expect(rail.parentElement).toBe(grid.parentElement);
    expect(rail.parentElement?.classList.contains("space-body")).toBe(true);
    expect(tabs.contains(rail)).toBe(false);

    act(() => root.unmount());
  });

  it("retimes pane and persistent rail animations from one transaction epoch", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const paneAnimation = { animationName: "rail-flip-x", startTime: null };
    const railAnimation = { animationName: "rail-flip-x", startTime: null };
    const getAnimations = vi.fn(() => [paneAnimation, railAnimation]);
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    act(() => {
      root.render(
        <RailGridSurface
          traveling
          startAtUnixMs={1_100}
          railPlane={<div className="sidebar flip-move" />}
        >
          <div className="pane flip-move" />
        </RailGridSurface>,
      );
    });

    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(paneAnimation.startTime).toEqual(expect.any(Number));
    expect(railAnimation.startTime).toBe(paneAnimation.startTime);
    act(() => root.unmount());
  });
});
