import { describe, expect, it } from "vitest";
import {
  cssRectToPhysical,
  judgeTitlebarComposition,
  type PhysicalRect,
  type TitlebarCompositionInput,
  type TitlebarElement,
  TRAFFIC_LIGHT_ROLES,
} from "./titlebarComposition";

const buttonRects = [
  { x: 24, y: 30, w: 28, h: 28 },
  { x: 64, y: 30, w: 28, h: 28 },
  { x: 104, y: 30, w: 28, h: 28 },
] as const;

const elements = (rects: readonly PhysicalRect[]): TitlebarElement[] => rects.map((rect, index) => ({
  role: TRAFFIC_LIGHT_ROLES[index]!,
  rect,
}));

const validInput = (): TitlebarCompositionInput => ({
  titlebar: { x: 0, y: 0, w: 1_600, h: 88 },
  reservations: elements(buttonRects),
  buttons: elements(buttonRects),
  declaredButtons: elements(buttonRects),
  backings: elements(buttonRects),
});

describe("Tauri titlebar 3:3:3 composition verdict", () => {
  it("projects DOM CSS rectangles into the shared physical-pixel coordinate space", () => {
    expect(cssRectToPhysical({ x: 12, y: 15, w: 14, h: 14 }, 2)).toEqual({
      x: 24, y: 30, w: 28, h: 28,
    });
    expect(cssRectToPhysical({ x: 0, y: 0, w: 14, h: 14 }, 0)).toBeNull();
  });

  it("accepts exactly three role-addressed DOM slots, AppKit buttons and owned backings", () => {
    const result = judgeTitlebarComposition(validInput());

    expect(result.verdict).toBe("green");
    expect(result.coordinateContract).toEqual({
      shared: "physical px, viewport top-left",
      domSource: "getBoundingClientRect × cssToPhysicalScale",
      nativeSource: "AppKit view rect converted to contentView backing coordinates",
      roundingTolerancePhysicalPx: 0.5,
    });
    expect(result.checks).toEqual({
      count: true,
      order: true,
      nonOverlap: true,
      containment: true,
      oneToOne: true,
      declaredTarget: true,
      verticalCenter: true,
      backingMatch: true,
    });
    expect(result.issues).toEqual([]);
    expect(result.measurements.map(({ role }) => role)).toEqual(TRAFFIC_LIGHT_ROLES);
    expect(result.measurements.map(({ centerDeltaPhysicalPx }) => centerDeltaPhysicalPx)).toEqual([
      { reservation: 0, button: 0, declaredButton: 0, backing: 0 },
      { reservation: 0, button: 0, declaredButton: 0, backing: 0 },
      { reservation: 0, button: 0, declaredButton: 0, backing: 0 },
    ]);
  });

  it("uses a physical half-pixel as the sole geometry tolerance", () => {
    const boundary = validInput();
    boundary.reservations = elements([
      { ...buttonRects[0], x: buttonRects[0].x + 0.5 },
      buttonRects[1],
      buttonRects[2],
    ]);
    expect(judgeTitlebarComposition(boundary).verdict).toBe("green");

    const outside = validInput();
    outside.reservations = elements([
      { ...buttonRects[0], x: buttonRects[0].x + 0.501 },
      buttonRects[1],
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(outside);
    expect(result.verdict).toBe("red");
    expect(result.checks.oneToOne).toBe(false);
    expect(result.issues).toContain("reservation-button-mismatch");
  });

  it.each([
    ["titlebar", { titlebar: null }, "missing-titlebar"],
    ["reservations", { reservations: null }, "reservation-count"],
    ["reservation item", { reservations: [null, ...elements(buttonRects).slice(1)] }, "reservation-count"],
    ["buttons", { buttons: null }, "button-count"],
    ["button item", { buttons: [null, ...elements(buttonRects).slice(1)] }, "button-count"],
    ["declared buttons", { declaredButtons: null }, "declared-button-count"],
    ["declared button item", { declaredButtons: [null, ...elements(buttonRects).slice(1)] }, "declared-button-count"],
    ["backings", { backings: null }, "backing-count"],
    ["backing item", { backings: [null, ...elements(buttonRects).slice(1)] }, "backing-count"],
  ])("makes a missing %s fact RED", (_label, replacement, issue) => {
    const result = judgeTitlebarComposition({ ...validInput(), ...replacement });
    expect(result.verdict).toBe("red");
    expect(result.issues).toContain(issue);
  });

  it("rejects counts other than one close/minimize/zoom fact on every side", () => {
    const input = validInput();
    input.reservations = input.reservations!.slice(0, 2);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.count).toBe(false);
    expect(result.issues).toContain("reservation-count");
  });

  it("rejects native role order changes", () => {
    const input = validInput();
    input.buttons = [input.buttons![1], input.buttons![0], input.buttons![2]];
    const result = judgeTitlebarComposition(input);
    expect(result.checks.order).toBe(false);
    expect(result.issues).toContain("button-order");
  });

  it("rejects overlapping role slots", () => {
    const input = validInput();
    input.reservations = elements([
      buttonRects[0],
      { ...buttonRects[1], x: 50 },
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.nonOverlap).toBe(false);
    expect(result.issues).toContain("reservation-overlap");
  });

  it("rejects any DOM or AppKit rect outside the rendered titlebar", () => {
    const input = validInput();
    input.backings = elements([
      buttonRects[0],
      buttonRects[1],
      { ...buttonRects[2], x: 1_590 },
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.containment).toBe(false);
    expect(result.issues).toContain("outside-titlebar");
  });

  it("rejects vertical-center drift even when all three layers remain 1:1", () => {
    const shifted = buttonRects.map((rect) => ({ ...rect, y: rect.y + 0.501 }));
    const input = validInput();
    input.reservations = elements(shifted);
    input.buttons = elements(shifted);
    input.declaredButtons = elements(shifted);
    input.backings = elements(shifted);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.oneToOne).toBe(true);
    expect(result.checks.backingMatch).toBe(true);
    expect(result.checks.verticalCenter).toBe(false);
    expect(result.issues).toContain("vertical-center");
  });

  it("rejects simultaneous DOM reservation and live-button drift from the immutable native target", () => {
    const shifted = buttonRects.map((rect) => ({ ...rect, x: rect.x + 0.501 }));
    const input = validInput();
    input.reservations = elements(shifted);
    input.buttons = elements(shifted);
    input.backings = elements(shifted);

    const result = judgeTitlebarComposition(input);

    expect(result.checks.oneToOne).toBe(true);
    expect(result.checks.backingMatch).toBe(true);
    expect(result.checks.declaredTarget).toBe(false);
    expect(result.issues).toContain("declared-button-mismatch");
    expect(result.verdict).toBe("red");
  });

  it("rejects a DOM slot that does not match its AppKit button", () => {
    const input = validInput();
    input.reservations = elements([
      { ...buttonRects[0], w: buttonRects[0].w + 1 },
      buttonRects[1],
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.oneToOne).toBe(false);
    expect(result.issues).toContain("reservation-button-mismatch");
  });

  it("rejects an owned backing that does not match its AppKit button", () => {
    const input = validInput();
    input.backings = elements([
      { ...buttonRects[0], h: buttonRects[0].h + 1 },
      buttonRects[1],
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.checks.backingMatch).toBe(false);
    expect(result.issues).toContain("backing-mismatch");
  });

  it("rejects invalid numeric facts rather than inventing coordinates", () => {
    const input = validInput();
    input.buttons = elements([
      { ...buttonRects[0], x: Number.NaN },
      buttonRects[1],
      buttonRects[2],
    ]);
    const result = judgeTitlebarComposition(input);
    expect(result.verdict).toBe("red");
    expect(result.issues).toContain("invalid-button-rect");
  });
});
