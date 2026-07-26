// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RailGridSurface } from "./RailGridSurface";

describe("RailGridSurface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
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
});
