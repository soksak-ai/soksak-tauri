/** DOM titlebar facts use CSS pixels with a top-left origin. */
export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** AppKit titlebar facts use points with a bottom-left origin. */
export type NativeRect = CssRect;

export type TrafficLightRole = "close" | "minimize" | "zoom";

export interface NativeTitlebarElement {
  role: TrafficLightRole;
  rect: NativeRect | null;
}

export interface TitlebarCompositionInput {
  /** DOM hole reserved for all three traffic-light buttons. */
  reservation: CssRect | null;
  /** Height of the AppKit coordinate space containing the native facts, in points. */
  nativeViewportHeight: number | null;
  buttons: readonly (NativeTitlebarElement | null)[] | null;
  backings: readonly (NativeTitlebarElement | null)[] | null;
  /** CSS px -> AppKit point scale used by whole-window zoom. */
  zoom: number | null;
  /** AppKit point -> physical pixel scale reported by the screen. */
  backingScale: number | null;
}

export const TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX = 0.5;

export type TitlebarCompositionIssue =
  | "missing-reservation"
  | "invalid-reservation"
  | "missing-native-viewport-height"
  | "invalid-native-viewport-height"
  | "missing-zoom"
  | "invalid-zoom"
  | "missing-backing-scale"
  | "invalid-backing-scale"
  | "button-count"
  | "backing-count"
  | "button-missing"
  | "backing-missing"
  | "invalid-button-rect"
  | "invalid-backing-rect"
  | "button-order"
  | "backing-order"
  | "button-overlap"
  | "backing-overlap"
  | "outside-reservation"
  | "vertical-center"
  | "backing-mismatch";

export interface TitlebarCompositionMeasurement {
  role: TrafficLightRole;
  buttonCss: CssRect | null;
  backingCss: CssRect | null;
  /** Signed button-center delta from the DOM reservation center. */
  centerDeltaPhysicalPx: number | null;
  /** Absolute button/backing deltas in physical pixels. */
  backingDeltaPhysicalPx: CssRect | null;
}

export interface TitlebarCompositionVerdict {
  coordinateContract: {
    dom: "CSS px, viewport top-left";
    native: "AppKit pt, viewport bottom-left";
    roundingTolerancePhysicalPx: typeof TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX;
    zoom: number | null;
    backingScale: number | null;
  };
  measurements: TitlebarCompositionMeasurement[];
  checks: {
    count: boolean;
    order: boolean;
    nonOverlap: boolean;
    containment: boolean;
    verticalCenter: boolean;
    backingMatch: boolean;
  };
  issues: TitlebarCompositionIssue[];
  verdict: "green" | "red";
}

const EXPECTED_ROLES: readonly TrafficLightRole[] = ["close", "minimize", "zoom"];

const finite = (value: number): boolean => Number.isFinite(value);
const positive = (value: number | null): value is number => value !== null && finite(value) && value > 0;
const validRect = (rect: CssRect | null): rect is CssRect => !!rect
  && finite(rect.x)
  && finite(rect.y)
  && finite(rect.w)
  && finite(rect.h)
  && rect.w > 0
  && rect.h > 0;

/**
 * AppKit bottom-left -> DOM top-left conversion. Invalid coordinate facts remain null;
 * callers must not silently replace them with a scale or height default.
 */
export function nativeBottomLeftRectToCssTopLeft(
  rect: NativeRect | null,
  nativeViewportHeight: number | null,
  zoom: number | null,
): CssRect | null {
  if (!validRect(rect) || !positive(nativeViewportHeight) || !positive(zoom)) return null;
  return {
    x: rect.x / zoom,
    y: (nativeViewportHeight - rect.y - rect.h) / zoom,
    w: rect.w / zoom,
    h: rect.h / zoom,
  };
}

/** The only geometry tolerance: at most one half of one physical backing pixel. */
export function isRoundingOnlyDelta(
  deltaCss: number,
  zoom: number | null,
  backingScale: number | null,
): boolean {
  return finite(deltaCss)
    && positive(zoom)
    && positive(backingScale)
    && Math.abs(deltaCss * zoom * backingScale) <= TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX;
}

const physical = (deltaCss: number, zoom: number, backingScale: number): number =>
  deltaCss * zoom * backingScale;

const centerY = (rect: CssRect): number => rect.y + rect.h / 2;
const right = (rect: CssRect): number => rect.x + rect.w;
const bottom = (rect: CssRect): number => rect.y + rect.h;

const hasOneOfEachRole = (items: readonly (NativeTitlebarElement | null)[] | null): boolean => {
  if (!items || items.length !== EXPECTED_ROLES.length || items.some((item) => !item)) return false;
  return EXPECTED_ROLES.every((role) => items.filter((item) => item?.role === role).length === 1);
};

const ordered = (
  items: readonly (NativeTitlebarElement | null)[] | null,
  rects: readonly (CssRect | null)[],
): boolean => {
  if (!items || items.length !== EXPECTED_ROLES.length || rects.some((rect) => !rect)) return false;
  return EXPECTED_ROLES.every((role, index) => items[index]?.role === role)
    && rects.slice(1).every((rect, index) => rect!.x > rects[index]!.x);
};

const disjoint = (
  rects: readonly (CssRect | null)[],
  zoom: number | null,
  backingScale: number | null,
): boolean => {
  if (rects.length !== EXPECTED_ROLES.length || rects.some((rect) => !rect)) return false;
  return rects.slice(1).every((rect, index) => {
    const overlapCss = right(rects[index]!) - rect!.x;
    return overlapCss <= 0 || isRoundingOnlyDelta(overlapCss, zoom, backingScale);
  });
};

const contained = (
  outer: CssRect,
  inner: CssRect,
  zoom: number,
  backingScale: number,
): boolean => {
  const overflows = [
    outer.x - inner.x,
    outer.y - inner.y,
    right(inner) - right(outer),
    bottom(inner) - bottom(outer),
  ];
  return overflows.every((overflow) =>
    overflow <= 0 || isRoundingOnlyDelta(overflow, zoom, backingScale));
};

const matchingRect = (
  a: CssRect,
  b: CssRect,
  zoom: number,
  backingScale: number,
): boolean => [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h]
  .every((delta) => isRoundingOnlyDelta(delta, zoom, backingScale));

/**
 * Pure verdict for the DOM reservation and the six native titlebar views. Every input fact is
 * mandatory. The verdict never guesses a scale, coordinate height, missing rect, or role.
 */
export function judgeTitlebarComposition(input: TitlebarCompositionInput): TitlebarCompositionVerdict {
  const issues: TitlebarCompositionIssue[] = [];
  const addIssue = (issue: TitlebarCompositionIssue) => {
    if (!issues.includes(issue)) issues.push(issue);
  };

  if (input.reservation === null) addIssue("missing-reservation");
  else if (!validRect(input.reservation)) addIssue("invalid-reservation");
  if (input.nativeViewportHeight === null) addIssue("missing-native-viewport-height");
  else if (!positive(input.nativeViewportHeight)) addIssue("invalid-native-viewport-height");
  if (input.zoom === null) addIssue("missing-zoom");
  else if (!positive(input.zoom)) addIssue("invalid-zoom");
  if (input.backingScale === null) addIssue("missing-backing-scale");
  else if (!positive(input.backingScale)) addIssue("invalid-backing-scale");

  const buttonCount = hasOneOfEachRole(input.buttons);
  const backingCount = hasOneOfEachRole(input.backings);
  if (!buttonCount) addIssue("button-count");
  if (!backingCount) addIssue("backing-count");
  if (input.buttons?.some((button) => button === null || button.rect === null)) addIssue("button-missing");
  if (input.backings?.some((backing) => backing === null || backing.rect === null)) addIssue("backing-missing");
  if (input.buttons?.some((button) => button?.rect !== null && !validRect(button?.rect ?? null))) {
    addIssue("invalid-button-rect");
  }
  if (input.backings?.some((backing) => backing?.rect !== null && !validRect(backing?.rect ?? null))) {
    addIssue("invalid-backing-rect");
  }

  const buttonCss = EXPECTED_ROLES.map((_, index) =>
    nativeBottomLeftRectToCssTopLeft(
      input.buttons?.[index]?.rect ?? null,
      input.nativeViewportHeight,
      input.zoom,
    ));
  const backingCss = EXPECTED_ROLES.map((_, index) =>
    nativeBottomLeftRectToCssTopLeft(
      input.backings?.[index]?.rect ?? null,
      input.nativeViewportHeight,
      input.zoom,
    ));

  const count = buttonCount && backingCount;
  const buttonOrder = ordered(input.buttons, buttonCss);
  const backingOrder = ordered(input.backings, backingCss);
  const order = buttonOrder && backingOrder;
  if (buttonCount && !buttonOrder) addIssue("button-order");
  if (backingCount && !backingOrder) addIssue("backing-order");

  const buttonsDisjoint = disjoint(buttonCss, input.zoom, input.backingScale);
  const backingsDisjoint = disjoint(backingCss, input.zoom, input.backingScale);
  const nonOverlap = buttonsDisjoint && backingsDisjoint;
  if (buttonCss.every(validRect) && !buttonsDisjoint) addIssue("button-overlap");
  if (backingCss.every(validRect) && !backingsDisjoint) addIssue("backing-overlap");

  const validGeometryBase = validRect(input.reservation)
    && positive(input.zoom)
    && positive(input.backingScale);
  const allRects = [...buttonCss, ...backingCss];
  const containment = validGeometryBase
    && allRects.length === 6
    && allRects.every((rect) => !!rect && contained(input.reservation!, rect, input.zoom!, input.backingScale!));
  if (validGeometryBase && allRects.every(validRect) && !containment) addIssue("outside-reservation");

  const verticalCenter = validGeometryBase
    && allRects.length === 6
    && allRects.every((rect) => !!rect && isRoundingOnlyDelta(
      centerY(rect) - centerY(input.reservation!),
      input.zoom,
      input.backingScale,
    ));
  if (validGeometryBase && allRects.every(validRect) && !verticalCenter) addIssue("vertical-center");

  const backingMatch = validGeometryBase
    && EXPECTED_ROLES.every((role, index) => {
      const button = buttonCss[index];
      const backing = backingCss[index];
      return input.buttons?.[index]?.role === role
        && input.backings?.[index]?.role === role
        && !!button
        && !!backing
        && matchingRect(button, backing, input.zoom!, input.backingScale!);
    });
  if (validGeometryBase && buttonCss.every(validRect) && backingCss.every(validRect) && !backingMatch) {
    addIssue("backing-mismatch");
  }

  const measurements = EXPECTED_ROLES.map<TitlebarCompositionMeasurement>((role, index) => {
    const button = buttonCss[index] ?? null;
    const backing = backingCss[index] ?? null;
    return {
      role,
      buttonCss: button,
      backingCss: backing,
      centerDeltaPhysicalPx: validGeometryBase && button
        ? physical(centerY(button) - centerY(input.reservation!), input.zoom!, input.backingScale!)
        : null,
      backingDeltaPhysicalPx: validGeometryBase && button && backing
        ? {
            x: Math.abs(physical(button.x - backing.x, input.zoom!, input.backingScale!)),
            y: Math.abs(physical(button.y - backing.y, input.zoom!, input.backingScale!)),
            w: Math.abs(physical(button.w - backing.w, input.zoom!, input.backingScale!)),
            h: Math.abs(physical(button.h - backing.h, input.zoom!, input.backingScale!)),
          }
        : null,
    };
  });

  const checks = { count, order, nonOverlap, containment, verticalCenter, backingMatch };
  const verdict = issues.length === 0 && Object.values(checks).every(Boolean) ? "green" : "red";
  return {
    coordinateContract: {
      dom: "CSS px, viewport top-left",
      native: "AppKit pt, viewport bottom-left",
      roundingTolerancePhysicalPx: TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX,
      zoom: input.zoom,
      backingScale: input.backingScale,
    },
    measurements,
    checks,
    issues,
    verdict,
  };
}
