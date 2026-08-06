import { describe, expect, it } from "vitest";
import {
  judgeTitlebarComposition,
  nativeBottomLeftRectToCssTopLeft,
  type CssRect,
  type NativeTitlebarElement,
  type TitlebarCompositionInput,
  type TrafficLightRole,
} from "./titlebarComposition";

const roles: readonly TrafficLightRole[] = ["close", "minimize", "zoom"];

const cssToNative = (rect: CssRect, nativeViewportHeight: number, zoom: number): CssRect => ({
  x: rect.x * zoom,
  y: nativeViewportHeight - (rect.y + rect.h) * zoom,
  w: rect.w * zoom,
  h: rect.h * zoom,
});

const elements = (
  rects: readonly CssRect[],
  nativeViewportHeight = 120,
  zoom = 2,
): NativeTitlebarElement[] => rects.map((rect, index) => ({
  role: roles[index]!,
  rect: cssToNative(rect, nativeViewportHeight, zoom),
}));

const buttonRects = [
  { x: 12, y: 12, w: 14, h: 14 },
  { x: 32, y: 12, w: 14, h: 14 },
  { x: 52, y: 12, w: 14, h: 14 },
] as const;

const validInput = (): TitlebarCompositionInput => ({
  reservation: { x: 8, y: 8, w: 62, h: 22 },
  nativeViewportHeight: 120,
  buttons: elements(buttonRects),
  backings: elements(buttonRects),
  zoom: 2,
  backingScale: 2,
});

describe("Tauri titlebar composition verdict", () => {
  it("converts native bottom-left AppKit points to CSS top-left coordinates", () => {
    expect(nativeBottomLeftRectToCssTopLeft(
      { x: 24, y: 68, w: 28, h: 28 },
      120,
      2,
    )).toEqual({ x: 12, y: 12, w: 14, h: 14 });
  });

  it("accepts exactly three ordered, disjoint, contained, centered buttons with matching backings", () => {
    const result = judgeTitlebarComposition(validInput());

    expect(result.verdict).toBe("green");
    expect(result.checks).toEqual({
      count: true,
      order: true,
      nonOverlap: true,
      containment: true,
      verticalCenter: true,
      backingMatch: true,
    });
    expect(result.issues).toEqual([]);
    expect(result.measurements.map((fact) => fact.buttonCss)).toEqual(buttonRects);
    expect(result.measurements.map((fact) => fact.centerDeltaPhysicalPx)).toEqual([0, 0, 0]);
  });

  it("uses a physical half-pixel as the sole geometry tolerance", () => {
    const atBoundary = validInput();
    atBoundary.backings = elements([
      { ...buttonRects[0], x: buttonRects[0].x + 0.125 },
      buttonRects[1],
      buttonRects[2],
    ]);
    expect(judgeTitlebarComposition(atBoundary).verdict).toBe("green");

    const outsideBoundary = validInput();
    outsideBoundary.backings = elements([
      { ...buttonRects[0], x: buttonRects[0].x + 0.126 },
      buttonRects[1],
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(outsideBoundary);
    expect(result.verdict).toBe("red");
    expect(result.checks.backingMatch).toBe(false);
    expect(result.issues).toContain("backing-mismatch");
  });

  it.each([
    ["reservation", { reservation: null }],
    ["native viewport height", { nativeViewportHeight: null }],
    ["buttons", { buttons: null }],
    ["button item", { buttons: [null, ...elements(buttonRects).slice(1)] }],
    ["backings", { backings: null }],
    ["backing item", { backings: [null, ...elements(buttonRects).slice(1)] }],
    ["zoom", { zoom: null }],
    ["backing scale", { backingScale: null }],
  ])("makes a missing %s fact RED", (_label, replacement) => {
    const result = judgeTitlebarComposition({ ...validInput(), ...replacement });
    expect(result.verdict).toBe("red");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects counts other than one close/minimize/zoom button and backing", () => {
    const input = validInput();
    input.buttons = input.buttons!.slice(0, 2);
    const result = judgeTitlebarComposition(input);
    expect(result.verdict).toBe("red");
    expect(result.checks.count).toBe(false);
    expect(result.issues).toContain("button-count");
  });

  it("rejects native role or geometric order changes", () => {
    const input = validInput();
    input.buttons = [input.buttons![1], input.buttons![0], input.buttons![2]];
    const result = judgeTitlebarComposition(input);
    expect(result.checks.order).toBe(false);
    expect(result.issues).toContain("button-order");
  });

  it("rejects overlapping buttons", () => {
    const input = validInput();
    input.buttons = elements([
      buttonRects[0],
      { ...buttonRects[1], x: 24 },
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.nonOverlap).toBe(false);
    expect(result.issues).toContain("button-overlap");
  });

  it("rejects a button or backing outside the DOM reservation", () => {
    const input = validInput();
    input.buttons = elements([
      buttonRects[0],
      buttonRects[1],
      { ...buttonRects[2], x: 57 },
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.containment).toBe(false);
    expect(result.issues).toContain("outside-reservation");
  });

  it("rejects vertical-center drift even while the button remains contained", () => {
    const input = validInput();
    input.buttons = elements([
      { ...buttonRects[0], y: buttonRects[0].y + 0.126 },
      buttonRects[1],
      buttonRects[2],
    ]);
    input.backings = input.buttons;
    const result = judgeTitlebarComposition(input);
    expect(result.checks.verticalCenter).toBe(false);
    expect(result.issues).toContain("vertical-center");
  });

  it("rejects invalid numeric facts instead of inventing defaults", () => {
    const result = judgeTitlebarComposition({ ...validInput(), backingScale: 0 });
    expect(result.verdict).toBe("red");
    expect(result.issues).toContain("invalid-backing-scale");
  });
});
