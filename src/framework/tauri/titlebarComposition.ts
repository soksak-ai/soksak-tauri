/** Tauri titlebar composition is compared only after both sides are projected into this space. */
export interface PhysicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TrafficLightRole = "close" | "minimize" | "zoom";

export interface TitlebarElement {
  role: TrafficLightRole;
  rect: PhysicalRect | null;
  hidden?: boolean;
}

export interface TitlebarCompositionInput {
  /** The rendered DOM titlebar, projected to physical pixels with a viewport top-left origin. */
  titlebar: PhysicalRect | null;
  /** Three real DOM reservation elements, one per traffic-light role. */
  reservations: readonly (TitlebarElement | null)[] | null;
  /** Three AppKit standardWindowButton rects in the same physical coordinate space. */
  buttons: readonly (TitlebarElement | null)[] | null;
  /** Immutable native target derived from the committed DOM titlebar and configured X origins. */
  declaredButtons: readonly (TitlebarElement | null)[] | null;
  /** Three owned AppKit backing rects in the same physical coordinate space. */
  backings: readonly (TitlebarElement | null)[] | null;
}

export const TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX = 0.5;

export type TitlebarCompositionIssue =
  | "missing-titlebar"
  | "invalid-titlebar"
  | "reservation-count"
  | "button-count"
  | "declared-button-count"
  | "backing-count"
  | "reservation-missing"
  | "button-missing"
  | "declared-button-missing"
  | "backing-missing"
  | "invalid-reservation-rect"
  | "invalid-button-rect"
  | "invalid-declared-button-rect"
  | "invalid-backing-rect"
  | "reservation-order"
  | "button-order"
  | "declared-button-order"
  | "backing-order"
  | "reservation-overlap"
  | "button-overlap"
  | "declared-button-overlap"
  | "backing-overlap"
  | "outside-titlebar"
  | "vertical-center"
  | "reservation-button-mismatch"
  | "declared-button-mismatch"
  | "backing-mismatch";

export interface TitlebarCompositionMeasurement {
  role: TrafficLightRole;
  reservationPhysical: PhysicalRect | null;
  buttonPhysical: PhysicalRect | null;
  declaredButtonPhysical: PhysicalRect | null;
  backingPhysical: PhysicalRect | null;
  /** Signed center deltas from the DOM titlebar center, already in physical pixels. */
  centerDeltaPhysicalPx: {
    reservation: number | null;
    button: number | null;
    declaredButton: number | null;
    backing: number | null;
  };
  /** Absolute rect deltas, already in physical pixels. */
  reservationButtonDeltaPhysicalPx: PhysicalRect | null;
  declaredButtonDeltaPhysicalPx: PhysicalRect | null;
  backingButtonDeltaPhysicalPx: PhysicalRect | null;
}

export interface TitlebarCompositionVerdict {
  coordinateContract: {
    shared: "physical px, viewport top-left";
    domSource: "getBoundingClientRect × cssToPhysicalScale";
    nativeSource: "AppKit view rect converted to contentView backing coordinates";
    roundingTolerancePhysicalPx: typeof TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX;
  };
  measurements: TitlebarCompositionMeasurement[];
  checks: {
    count: boolean;
    order: boolean;
    nonOverlap: boolean;
    containment: boolean;
    oneToOne: boolean;
    declaredTarget: boolean;
    verticalCenter: boolean;
    backingMatch: boolean;
  };
  issues: TitlebarCompositionIssue[];
  verdict: "green" | "red";
}

export const TRAFFIC_LIGHT_ROLES: readonly TrafficLightRole[] = Object.freeze([
  "close",
  "minimize",
  "zoom",
]);

const finite = (value: number): boolean => Number.isFinite(value);
const validRect = (rect: PhysicalRect | null): rect is PhysicalRect => !!rect
  && finite(rect.x)
  && finite(rect.y)
  && finite(rect.w)
  && finite(rect.h)
  && rect.w > 0
  && rect.h > 0;

/** The only geometry tolerance: at most one half of one physical backing pixel. */
export function isRoundingOnlyPhysicalDelta(deltaPhysicalPx: number): boolean {
  return finite(deltaPhysicalPx)
    && Math.abs(deltaPhysicalPx) <= TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX;
}

export function cssRectToPhysical(rect: PhysicalRect, cssToPhysicalScale: number): PhysicalRect | null {
  if (!validRect(rect) || !finite(cssToPhysicalScale) || cssToPhysicalScale <= 0) return null;
  return {
    x: rect.x * cssToPhysicalScale,
    y: rect.y * cssToPhysicalScale,
    w: rect.w * cssToPhysicalScale,
    h: rect.h * cssToPhysicalScale,
  };
}

const centerY = (rect: PhysicalRect): number => rect.y + rect.h / 2;
const right = (rect: PhysicalRect): number => rect.x + rect.w;
const bottom = (rect: PhysicalRect): number => rect.y + rect.h;

const exactRoles = (items: readonly (TitlebarElement | null)[] | null): boolean => {
  if (!items || items.length !== TRAFFIC_LIGHT_ROLES.length || items.some((item) => !item)) return false;
  return TRAFFIC_LIGHT_ROLES.every((role) => items.filter((item) => item?.role === role).length === 1);
};

const ordered = (items: readonly (TitlebarElement | null)[] | null): boolean => {
  if (!items || items.length !== TRAFFIC_LIGHT_ROLES.length) return false;
  return TRAFFIC_LIGHT_ROLES.every((role, index) => items[index]?.role === role)
    && items.slice(1).every((item, index) => {
      const previous = items[index]?.rect ?? null;
      return validRect(previous) && validRect(item?.rect ?? null) && item!.rect!.x > previous.x;
    });
};

const rects = (items: readonly (TitlebarElement | null)[] | null): (PhysicalRect | null)[] =>
  TRAFFIC_LIGHT_ROLES.map((role) => {
    const matches = items?.filter((item) => item?.role === role) ?? [];
    return matches.length === 1 ? matches[0]?.rect ?? null : null;
  });

const disjoint = (values: readonly (PhysicalRect | null)[]): boolean => {
  if (values.length !== TRAFFIC_LIGHT_ROLES.length || values.some((rect) => !validRect(rect))) return false;
  return values.slice(1).every((rect, index) => {
    const overlap = right(values[index]!) - rect!.x;
    return overlap <= 0 || isRoundingOnlyPhysicalDelta(overlap);
  });
};

const contained = (outer: PhysicalRect, inner: PhysicalRect): boolean => [
  outer.x - inner.x,
  outer.y - inner.y,
  right(inner) - right(outer),
  bottom(inner) - bottom(outer),
].every((overflow) => overflow <= 0 || isRoundingOnlyPhysicalDelta(overflow));

const matchingRect = (a: PhysicalRect, b: PhysicalRect): boolean =>
  [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h]
    .every(isRoundingOnlyPhysicalDelta);

const rectDelta = (a: PhysicalRect, b: PhysicalRect): PhysicalRect => ({
  x: Math.abs(a.x - b.x),
  y: Math.abs(a.y - b.y),
  w: Math.abs(a.w - b.w),
  h: Math.abs(a.h - b.h),
});

const missingRect = (items: readonly (TitlebarElement | null)[] | null): boolean =>
  !!items?.some((item) => item === null || item.rect === null);

const invalidPresentRect = (items: readonly (TitlebarElement | null)[] | null): boolean =>
  !!items?.some((item) => item?.rect !== null && !validRect(item?.rect ?? null));

/**
 * Pure 3:3:3 verdict. DOM reservations, AppKit buttons and owned AppKit backings must already be
 * expressed in physical viewport pixels. Missing facts remain RED; no scale, rect or role is guessed.
 */
export function judgeTitlebarComposition(input: TitlebarCompositionInput): TitlebarCompositionVerdict {
  const issues: TitlebarCompositionIssue[] = [];
  const addIssue = (issue: TitlebarCompositionIssue) => {
    if (!issues.includes(issue)) issues.push(issue);
  };

  if (input.titlebar === null) addIssue("missing-titlebar");
  else if (!validRect(input.titlebar)) addIssue("invalid-titlebar");

  const reservationCount = exactRoles(input.reservations);
  const buttonCount = exactRoles(input.buttons);
  const declaredButtonCount = exactRoles(input.declaredButtons);
  const backingCount = exactRoles(input.backings);
  if (!reservationCount) addIssue("reservation-count");
  if (!buttonCount) addIssue("button-count");
  if (!declaredButtonCount) addIssue("declared-button-count");
  if (!backingCount) addIssue("backing-count");
  if (missingRect(input.reservations)) addIssue("reservation-missing");
  if (missingRect(input.buttons)) addIssue("button-missing");
  if (missingRect(input.declaredButtons)) addIssue("declared-button-missing");
  if (missingRect(input.backings)) addIssue("backing-missing");
  if (invalidPresentRect(input.reservations)) addIssue("invalid-reservation-rect");
  if (invalidPresentRect(input.buttons)) addIssue("invalid-button-rect");
  if (invalidPresentRect(input.declaredButtons)) addIssue("invalid-declared-button-rect");
  if (invalidPresentRect(input.backings)) addIssue("invalid-backing-rect");

  const reservationRects = rects(input.reservations);
  const buttonRects = rects(input.buttons);
  const declaredButtonRects = rects(input.declaredButtons);
  const backingRects = rects(input.backings);

  const reservationOrder = ordered(input.reservations);
  const buttonOrder = ordered(input.buttons);
  const declaredButtonOrder = ordered(input.declaredButtons);
  const backingOrder = ordered(input.backings);
  const order = reservationOrder && buttonOrder && declaredButtonOrder && backingOrder;
  if (reservationCount && !reservationOrder) addIssue("reservation-order");
  if (buttonCount && !buttonOrder) addIssue("button-order");
  if (declaredButtonCount && !declaredButtonOrder) addIssue("declared-button-order");
  if (backingCount && !backingOrder) addIssue("backing-order");

  const reservationsDisjoint = disjoint(reservationRects);
  const buttonsDisjoint = disjoint(buttonRects);
  const declaredButtonsDisjoint = disjoint(declaredButtonRects);
  const backingsDisjoint = disjoint(backingRects);
  const nonOverlap = reservationsDisjoint && buttonsDisjoint
    && declaredButtonsDisjoint && backingsDisjoint;
  if (reservationRects.every(validRect) && !reservationsDisjoint) addIssue("reservation-overlap");
  if (buttonRects.every(validRect) && !buttonsDisjoint) addIssue("button-overlap");
  if (declaredButtonRects.every(validRect) && !declaredButtonsDisjoint) {
    addIssue("declared-button-overlap");
  }
  if (backingRects.every(validRect) && !backingsDisjoint) addIssue("backing-overlap");

  const allRects = [...reservationRects, ...buttonRects, ...declaredButtonRects, ...backingRects];
  const containment = validRect(input.titlebar)
    && allRects.length === TRAFFIC_LIGHT_ROLES.length * 4
    && allRects.every((rect) => validRect(rect) && contained(input.titlebar!, rect));
  if (validRect(input.titlebar) && allRects.every(validRect) && !containment) {
    addIssue("outside-titlebar");
  }

  const oneToOne = reservationCount && buttonCount
    && TRAFFIC_LIGHT_ROLES.every((_, index) => {
      const reservation = reservationRects[index];
      const button = buttonRects[index];
      return validRect(reservation) && validRect(button) && matchingRect(reservation, button);
    });
  if (reservationRects.every(validRect) && buttonRects.every(validRect) && !oneToOne) {
    addIssue("reservation-button-mismatch");
  }

  const declaredTarget = buttonCount && declaredButtonCount
    && TRAFFIC_LIGHT_ROLES.every((_, index) => {
      const button = buttonRects[index];
      const declared = declaredButtonRects[index];
      return validRect(button) && validRect(declared) && matchingRect(button, declared);
    });
  if (buttonRects.every(validRect) && declaredButtonRects.every(validRect) && !declaredTarget) {
    addIssue("declared-button-mismatch");
  }

  const verticalCenter = validRect(input.titlebar)
    && allRects.length === TRAFFIC_LIGHT_ROLES.length * 4
    && allRects.every((rect) => validRect(rect)
      && isRoundingOnlyPhysicalDelta(centerY(rect) - centerY(input.titlebar!)));
  if (validRect(input.titlebar) && allRects.every(validRect) && !verticalCenter) {
    addIssue("vertical-center");
  }

  const backingMatch = buttonCount && backingCount
    && TRAFFIC_LIGHT_ROLES.every((_, index) => {
      const button = buttonRects[index];
      const backing = backingRects[index];
      return validRect(button) && validRect(backing) && matchingRect(button, backing);
    });
  if (buttonRects.every(validRect) && backingRects.every(validRect) && !backingMatch) {
    addIssue("backing-mismatch");
  }

  const measurements = TRAFFIC_LIGHT_ROLES.map<TitlebarCompositionMeasurement>((role, index) => {
    const reservation = reservationRects[index] ?? null;
    const button = buttonRects[index] ?? null;
    const declaredButton = declaredButtonRects[index] ?? null;
    const backing = backingRects[index] ?? null;
    const titlebarCenter = validRect(input.titlebar) ? centerY(input.titlebar) : null;
    return {
      role,
      reservationPhysical: reservation,
      buttonPhysical: button,
      declaredButtonPhysical: declaredButton,
      backingPhysical: backing,
      centerDeltaPhysicalPx: {
        reservation: titlebarCenter !== null && validRect(reservation)
          ? centerY(reservation) - titlebarCenter : null,
        button: titlebarCenter !== null && validRect(button)
          ? centerY(button) - titlebarCenter : null,
        declaredButton: titlebarCenter !== null && validRect(declaredButton)
          ? centerY(declaredButton) - titlebarCenter : null,
        backing: titlebarCenter !== null && validRect(backing)
          ? centerY(backing) - titlebarCenter : null,
      },
      reservationButtonDeltaPhysicalPx: validRect(reservation) && validRect(button)
        ? rectDelta(reservation, button) : null,
      declaredButtonDeltaPhysicalPx: validRect(declaredButton) && validRect(button)
        ? rectDelta(declaredButton, button) : null,
      backingButtonDeltaPhysicalPx: validRect(backing) && validRect(button)
        ? rectDelta(backing, button) : null,
    };
  });

  const checks = {
    count: reservationCount && buttonCount && declaredButtonCount && backingCount,
    order,
    nonOverlap,
    containment,
    oneToOne,
    declaredTarget,
    verticalCenter,
    backingMatch,
  };
  return {
    coordinateContract: {
      shared: "physical px, viewport top-left",
      domSource: "getBoundingClientRect × cssToPhysicalScale",
      nativeSource: "AppKit view rect converted to contentView backing coordinates",
      roundingTolerancePhysicalPx: TITLEBAR_ROUNDING_TOLERANCE_PHYSICAL_PX,
    },
    measurements,
    checks,
    issues,
    verdict: issues.length === 0 && Object.values(checks).every(Boolean) ? "green" : "red",
  };
}
