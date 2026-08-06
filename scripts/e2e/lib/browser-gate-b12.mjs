import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

export const TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX = 0.5;

const FRAMEWORKS = new Set(["tauri", "electron"]);
const ROLES = Object.freeze(["close", "minimize", "zoom"]);
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const SIZE_KEYS = Object.freeze(["w", "h"]);
const REQUIRED_HEIGHTS = Object.freeze([30, 60, 72]);
const SAMPLE_KEYS = Object.freeze([
  "stage",
  "presentationRevision",
  "presented",
  "requestedHeightCssPx",
  "dom",
  "viewportPhysical",
  "titlebarPhysical",
  "reservations",
  "buttons",
  "backings",
]);
const HELD_KEYS = Object.freeze(["baseline", "heights", "reset", "final"]);
const HOSTILE_KEYS = Object.freeze([
  "baselineOuterPhysical",
  "transactions",
  "restoredOuterPhysical",
  "settledRestore",
  "heldOuterPhysical",
  "heldRestore",
]);
const HOSTILE_TRANSACTION_KEYS = Object.freeze([
  "step", "requestedOuterPhysical", "probeGeneration", "titlebar",
]);
const HOSTILE_TITLEBAR_KEYS = Object.freeze([
  "presentationRevision",
  "viewportPhysical",
  "titlebarPhysical",
  "reservations",
  "buttons",
  "backings",
]);

function inspectRect(value, path, failures) {
  if (!requireExactKeys(value, RECT_KEYS, path, failures)) return null;
  let valid = true;
  for (const key of RECT_KEYS) {
    const number = value[key];
    if (!Number.isFinite(number) || ((key === "w" || key === "h") && number <= 0)) {
      failures.push(
        `${path}.${key}=finite${key === "w" || key === "h" ? ">0" : ""}/${displayValue(number)}`,
      );
      valid = false;
    }
  }
  return valid ? value : null;
}

function inspectSize(value, path, failures) {
  if (!requireExactKeys(value, SIZE_KEYS, path, failures)) return null;
  let valid = true;
  for (const key of SIZE_KEYS) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) {
      failures.push(`${path}.${key}=finite>0/${displayValue(value[key])}`);
      valid = false;
    }
  }
  return valid ? value : null;
}

function withinTolerance(delta) {
  return Number.isFinite(delta)
    && Math.abs(delta) <= TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX;
}

function centerY(rect) {
  return rect.y + rect.h / 2;
}

function right(rect) {
  return rect.x + rect.w;
}

function bottom(rect) {
  return rect.y + rect.h;
}

function contained(outer, inner) {
  return inner.x >= outer.x - TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX
    && inner.y >= outer.y - TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX
    && right(inner) <= right(outer) + TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX
    && bottom(inner) <= bottom(outer) + TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX;
}

function matchingRect(left, rightValue) {
  return RECT_KEYS.every((key) => withinTolerance(left[key] - rightValue[key]));
}

function sameList(left, rightValue) {
  return Array.isArray(left) && Array.isArray(rightValue)
    && left.length === rightValue.length
    && left.every((value, index) => value === rightValue[index]);
}

function inspectElements(value, path, failures) {
  if (!Array.isArray(value) || value.length !== ROLES.length) {
    failures.push(`${path}=exactly-${ROLES.length}/${displayValue(value?.length)}`);
    return null;
  }
  const byRole = new Map();
  value.forEach((element, index) => {
    const elementPath = `${path}[${index}]`;
    if (!requireExactKeys(element, ["role", "rect"], elementPath, failures)) return;
    const expectedRole = ROLES[index];
    if (element.role !== expectedRole) {
      failures.push(`${elementPath}.role=${expectedRole}/${displayValue(element.role)}`);
    }
    const rect = inspectRect(element.rect, `${elementPath}.rect`, failures);
    if (element.role === expectedRole && rect) byRole.set(expectedRole, rect);
  });
  return byRole.size === ROLES.length ? byRole : null;
}

function inspectInlineStyle(value, path, failures) {
  if (!requireExactKeys(value, ["height", "flexBasis"], path, failures)) return null;
  let valid = true;
  for (const key of ["height", "flexBasis"]) {
    if (typeof value[key] !== "string") {
      failures.push(`${path}.${key}=string/${displayValue(value[key])}`);
      valid = false;
    }
  }
  return valid ? { height: value.height, flexBasis: value.flexBasis } : null;
}

function inspectDom(value, path, failures) {
  if (!requireExactKeys(value, ["nodeIdentity", "inlineStyle"], path, failures)) return null;
  const identityValid = hasText(value.nodeIdentity);
  if (!identityValid) {
    failures.push(`${path}.nodeIdentity=non-empty/${displayValue(value.nodeIdentity)}`);
  }
  const inlineStyle = inspectInlineStyle(value.inlineStyle, `${path}.inlineStyle`, failures);
  return identityValid && inlineStyle
    ? { nodeIdentity: value.nodeIdentity, inlineStyle }
    : null;
}

function inspectPlaneAgainstTitlebar(plane, titlebar, path, failures) {
  if (!(plane && titlebar)) return;
  for (const role of ROLES) {
    const rect = plane.get(role);
    if (!rect) continue;
    const delta = centerY(rect) - centerY(titlebar);
    if (!withinTolerance(delta)) {
      failures.push(
        `${path}.${role}.centerY=titlebar±${TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX}/`
          + `${displayValue(delta)}`,
      );
    }
    if (!contained(titlebar, rect)) failures.push(`${path}.${role}=contained-by-titlebar`);
  }
}

function inspectMatchingPlanes(left, rightPlane, path, failures) {
  if (!(left && rightPlane)) return;
  for (const role of ROLES) {
    const leftRect = left.get(role);
    const rightRect = rightPlane.get(role);
    if (leftRect && rightRect && !matchingRect(leftRect, rightRect)) {
      failures.push(`${path}.${role}=rounding-only-physical-frame`);
    }
  }
}

function cssLength(value) {
  return `${value}px`;
}

function inspectSample(
  value,
  path,
  { expectedStage, framework, coordinateSpace },
  failures,
) {
  if (!requireExactKeys(value, SAMPLE_KEYS, path, failures)) return null;

  if (value.stage !== expectedStage) {
    failures.push(`${path}.stage=${expectedStage}/${displayValue(value.stage)}`);
  }
  const revisionValid = Number.isInteger(value.presentationRevision)
    && value.presentationRevision >= 1;
  if (!revisionValid) {
    failures.push(
      `${path}.presentationRevision=integer>=1/${displayValue(value.presentationRevision)}`,
    );
  }
  if (value.presented !== true) {
    failures.push(`${path}.presented=true/${displayValue(value.presented)}`);
  }

  const heightStage = expectedStage === "height";
  const requestedHeight = value.requestedHeightCssPx;
  const requestedValid = heightStage
    ? Number.isFinite(requestedHeight) && requestedHeight > 0
    : requestedHeight === null;
  if (!requestedValid) {
    failures.push(
      `${path}.requestedHeightCssPx=${heightStage ? "finite>0" : "null"}/`
        + `${displayValue(requestedHeight)}`,
    );
  }

  const dom = inspectDom(value.dom, `${path}.dom`, failures);
  const viewport = inspectSize(value.viewportPhysical, `${path}.viewportPhysical`, failures);
  const titlebar = inspectRect(value.titlebarPhysical, `${path}.titlebarPhysical`, failures);
  const reservations = inspectElements(value.reservations, `${path}.reservations`, failures);
  const buttons = inspectElements(value.buttons, `${path}.buttons`, failures);
  let backings = null;
  if (framework === "tauri") {
    backings = inspectElements(value.backings, `${path}.backings`, failures);
  } else if (framework === "electron" && value.backings !== null) {
    failures.push(`${path}.backings=null-for-electron/${displayValue(value.backings)}`);
  }

  inspectPlaneAgainstTitlebar(reservations, titlebar, `${path}.reservations`, failures);
  inspectPlaneAgainstTitlebar(buttons, titlebar, `${path}.buttons`, failures);
  if (framework === "tauri") {
    inspectPlaneAgainstTitlebar(backings, titlebar, `${path}.backings`, failures);
  }
  inspectMatchingPlanes(reservations, buttons, `${path}.reservationButton`, failures);
  if (framework === "tauri") {
    inspectMatchingPlanes(backings, buttons, `${path}.backingButton`, failures);
  }

  if (heightStage && requestedValid) {
    if (titlebar && !withinTolerance(
      titlebar.h - requestedHeight * coordinateSpace.scaleFactor,
    )) {
      failures.push(`${path}.titlebarPhysical.h=requestedHeight×scaleFactor`);
    }
    if (dom) {
      const expected = cssLength(requestedHeight);
      if (dom.inlineStyle.height !== expected) {
        failures.push(`${path}.dom.inlineStyle.height=${expected}/${displayValue(dom.inlineStyle.height)}`);
      }
      if (dom.inlineStyle.flexBasis !== expected) {
        failures.push(
          `${path}.dom.inlineStyle.flexBasis=${expected}/${displayValue(dom.inlineStyle.flexBasis)}`,
        );
      }
    }
  }

  return {
    stage: value.stage,
    presentationRevision: revisionValid ? value.presentationRevision : null,
    presented: value.presented === true,
    requestedHeightCssPx: requestedValid ? requestedHeight : null,
    dom,
    viewport,
    titlebar,
    planes: { reservations, buttons, backings },
  };
}

function inspectCoordinateSpace(value, failures) {
  if (!requireExactKeys(
    value,
    ["logical", "physical", "scaleFactor"],
    "coordinateSpace",
    failures,
  )) return null;
  let valid = true;
  if (value.logical !== "css-px") {
    failures.push(`coordinateSpace.logical=css-px/${displayValue(value.logical)}`);
    valid = false;
  }
  if (value.physical !== "device-px") {
    failures.push(`coordinateSpace.physical=device-px/${displayValue(value.physical)}`);
    valid = false;
  }
  if (!(Number.isFinite(value.scaleFactor) && value.scaleFactor > 0)) {
    failures.push(
      `coordinateSpace.scaleFactor=finite>0/${displayValue(value.scaleFactor)}`,
    );
    valid = false;
  }
  return valid ? value : null;
}

function sameInlineStyle(left, rightValue) {
  return left?.height === rightValue?.height
    && left?.flexBasis === rightValue?.flexBasis;
}

function compareRestoredSample(baseline, restored, path, framework, failures) {
  if (!(baseline && restored)) return;
  if (baseline.dom && restored.dom) {
    if (restored.dom.nodeIdentity !== baseline.dom.nodeIdentity) {
      failures.push(`${path}.dom.nodeIdentity=baseline`);
    }
    if (!sameInlineStyle(restored.dom.inlineStyle, baseline.dom.inlineStyle)) {
      failures.push(`${path}.dom.inlineStyle=exact-baseline`);
    }
  }
  if (baseline.titlebar && restored.titlebar
      && !matchingRect(baseline.titlebar, restored.titlebar)) {
    failures.push(`${path}.titlebarPhysical=baseline`);
  }
  if (baseline.viewport && restored.viewport
      && (baseline.viewport.w !== restored.viewport.w || baseline.viewport.h !== restored.viewport.h)) {
    failures.push(`${path}.viewportPhysical=baseline`);
  }
  for (const plane of ["reservations", "buttons", ...(framework === "tauri" ? ["backings"] : [])]) {
    inspectMatchingPlanes(
      baseline.planes[plane],
      restored.planes[plane],
      `${path}.${plane}`,
      failures,
    );
  }
}

function compareHeldSample(applied, held, path, framework, failures) {
  if (!(applied && held)) return;
  if (held.presentationRevision !== applied.presentationRevision) {
    failures.push(`${path}.presentationRevision=applied`);
  }
  if (held.requestedHeightCssPx !== applied.requestedHeightCssPx) {
    failures.push(`${path}.requestedHeightCssPx=applied`);
  }
  if (applied.dom && held.dom) {
    if (held.dom.nodeIdentity !== applied.dom.nodeIdentity) {
      failures.push(`${path}.dom.nodeIdentity=applied`);
    }
    if (!sameInlineStyle(held.dom.inlineStyle, applied.dom.inlineStyle)) {
      failures.push(`${path}.dom.inlineStyle=exact-applied`);
    }
  }
  if (applied.titlebar && held.titlebar && !matchingRect(applied.titlebar, held.titlebar)) {
    failures.push(`${path}.titlebarPhysical=applied`);
  }
  if (applied.viewport && held.viewport
      && (applied.viewport.w !== held.viewport.w || applied.viewport.h !== held.viewport.h)) {
    failures.push(`${path}.viewportPhysical=applied`);
  }
  for (const plane of ["reservations", "buttons", ...(framework === "tauri" ? ["backings"] : [])]) {
    inspectMatchingPlanes(
      applied.planes[plane],
      held.planes[plane],
      `${path}.${plane}`,
      failures,
    );
  }
}

function inspectHostileTitlebar(value, path, framework, failures) {
  if (!requireExactKeys(value, HOSTILE_TITLEBAR_KEYS, path, failures)) return null;
  const revision = Number.isInteger(value.presentationRevision) && value.presentationRevision >= 1
    ? value.presentationRevision
    : null;
  if (revision === null) {
    failures.push(`${path}.presentationRevision=integer>=1/${displayValue(value.presentationRevision)}`);
  }
  const viewport = inspectSize(value.viewportPhysical, `${path}.viewportPhysical`, failures);
  const titlebar = inspectRect(value.titlebarPhysical, `${path}.titlebarPhysical`, failures);
  const reservations = inspectElements(value.reservations, `${path}.reservations`, failures);
  const buttons = inspectElements(value.buttons, `${path}.buttons`, failures);
  let backings = null;
  if (framework === "tauri") {
    backings = inspectElements(value.backings, `${path}.backings`, failures);
  } else if (value.backings !== null) {
    failures.push(`${path}.backings=null-for-electron/${displayValue(value.backings)}`);
  }
  inspectPlaneAgainstTitlebar(reservations, titlebar, `${path}.reservations`, failures);
  inspectPlaneAgainstTitlebar(buttons, titlebar, `${path}.buttons`, failures);
  inspectMatchingPlanes(reservations, buttons, `${path}.reservationButton`, failures);
  if (framework === "tauri") {
    inspectPlaneAgainstTitlebar(backings, titlebar, `${path}.backings`, failures);
    inspectMatchingPlanes(backings, buttons, `${path}.backingButton`, failures);
  }
  return { revision, viewport, titlebar, planes: { reservations, buttons, backings } };
}

function sameSize(left, rightValue) {
  return !!left && !!rightValue && left.w === rightValue.w && left.h === rightValue.h;
}

function inspectHostileResize(value, baseline, context, failures) {
  if (!requireExactKeys(value, HOSTILE_KEYS, "hostileResize", failures)) return null;
  const baselineOuter = inspectSize(
    value.baselineOuterPhysical,
    "hostileResize.baselineOuterPhysical",
    failures,
  );
  const restoredOuter = inspectSize(
    value.restoredOuterPhysical,
    "hostileResize.restoredOuterPhysical",
    failures,
  );
  const heldOuter = inspectSize(
    value.heldOuterPhysical,
    "hostileResize.heldOuterPhysical",
    failures,
  );
  if (baselineOuter && restoredOuter && !sameSize(baselineOuter, restoredOuter)) {
    failures.push("hostileResize.restoredOuterPhysical=baseline");
  }
  if (baselineOuter && heldOuter && !sameSize(baselineOuter, heldOuter)) {
    failures.push("hostileResize.heldOuterPhysical=baseline");
  }

  const transactions = [];
  if (!Array.isArray(value.transactions) || value.transactions.length < 12) {
    failures.push(`hostileResize.transactions=at-least-12/${displayValue(value.transactions?.length)}`);
  } else {
    let previousGeneration = 0;
    value.transactions.forEach((transaction, index) => {
      const path = `hostileResize.transactions[${index}]`;
      if (!requireExactKeys(transaction, HOSTILE_TRANSACTION_KEYS, path, failures)) return;
      if (transaction.step !== index) {
        failures.push(`${path}.step=${index}/${displayValue(transaction.step)}`);
      }
      const requested = inspectSize(
        transaction.requestedOuterPhysical,
        `${path}.requestedOuterPhysical`,
        failures,
      );
      const generation = Number.isSafeInteger(transaction.probeGeneration)
        && transaction.probeGeneration > previousGeneration
        ? transaction.probeGeneration
        : null;
      if (generation === null) {
        failures.push(`${path}.probeGeneration=>${previousGeneration}/${displayValue(transaction.probeGeneration)}`);
      } else {
        previousGeneration = generation;
      }
      const titlebar = inspectHostileTitlebar(
        transaction.titlebar,
        `${path}.titlebar`,
        context.framework,
        failures,
      );
      if (baselineOuter && baseline?.viewport && requested && titlebar?.viewport) {
        const expected = {
          w: baseline.viewport.w + requested.w - baselineOuter.w,
          h: baseline.viewport.h + requested.h - baselineOuter.h,
        };
        if (!withinTolerance(titlebar.viewport.w - expected.w)) {
          failures.push(`${path}.titlebar.viewportPhysical.w=baseline+outer-delta`);
        }
        if (!withinTolerance(titlebar.viewport.h - expected.h)) {
          failures.push(`${path}.titlebar.viewportPhysical.h=baseline+outer-delta`);
        }
      }
      transactions.push({ requested, generation, titlebar });
    });
  }
  const requestedSizes = transactions.map(({ requested }) => requested).filter(Boolean);
  if (baselineOuter && requestedSizes.length > 0
      && !sameSize(requestedSizes.at(-1), baselineOuter)) {
    failures.push("hostileResize.transactions.last.requestedOuterPhysical=baseline");
  }
  const widthDirections = new Set();
  const heightDirections = new Set();
  requestedSizes.slice(1).forEach((size, index) => {
    widthDirections.add(Math.sign(size.w - requestedSizes[index].w));
    heightDirections.add(Math.sign(size.h - requestedSizes[index].h));
  });
  if (!(widthDirections.has(-1) && widthDirections.has(1))) {
    failures.push("hostileResize.transactions.width=bidirectional");
  }
  if (!(heightDirections.has(-1) && heightDirections.has(1))) {
    failures.push("hostileResize.transactions.height=bidirectional");
  }

  const settled = inspectSample(
    value.settledRestore,
    "hostileResize.settledRestore",
    { ...context, expectedStage: "resize-restored" },
    failures,
  );
  const held = inspectSample(
    value.heldRestore,
    "hostileResize.heldRestore",
    { ...context, expectedStage: "resize-restored" },
    failures,
  );
  compareRestoredSample(baseline, settled, "hostileResize.settledRestore", context.framework, failures);
  compareRestoredSample(baseline, held, "hostileResize.heldRestore", context.framework, failures);
  compareHeldSample(settled, held, "hostileResize.heldRestore", context.framework, failures);
  return { baselineOuter, restoredOuter, heldOuter, transactions, settled, held };
}

/**
 * macOS titlebar의 raw DOM/native rect와 명시적 presentation 원장만 판정한다.
 * 이미지, adapter 자체 verdict, 지연 시간은 machine evidence가 아니다.
 */
export function judgeB12MachineEvidence(value, identity = null) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(
    value,
    ["engine", "coordinateSpace", "baseline", "heights", "reset", "hostileResize", "final", "held"],
    "evidence",
    failures,
  )) return finishMachineVerdict("B12", failures, "B12:unreachable");

  if (!engineSet.has(value.engine)) {
    failures.push(`engine=known/${displayValue(value.engine)}`);
  }
  const framework = identity?.framework;
  if (!FRAMEWORKS.has(framework)) {
    failures.push(`framework=tauri|electron/${displayValue(framework)}`);
  }
  if (framework === "electron") {
    failures.push("electron-native-button-position-adapter=missing");
  }
  const coordinateSpace = inspectCoordinateSpace(value.coordinateSpace, failures);
  const context = {
    framework,
    coordinateSpace: coordinateSpace ?? { scaleFactor: Number.NaN },
  };
  const baseline = inspectSample(
    value.baseline,
    "baseline",
    { ...context, expectedStage: "baseline" },
    failures,
  );

  const heights = [];
  if (!Array.isArray(value.heights) || value.heights.length !== REQUIRED_HEIGHTS.length) {
    failures.push(`heights=exactly-30,60,72/${displayValue(value.heights?.length)}`);
  } else {
    value.heights.forEach((height, index) => {
      const inspected = inspectSample(
        height,
        `heights[${index}]`,
        { ...context, expectedStage: "height" },
        failures,
      );
      if (inspected) heights.push(inspected);
    });
  }
  const reset = inspectSample(
    value.reset,
    "reset",
    { ...context, expectedStage: "reset" },
    failures,
  );
  inspectHostileResize(value.hostileResize, baseline, context, failures);
  const final = inspectSample(
    value.final,
    "final",
    { ...context, expectedStage: "final" },
    failures,
  );

  let heldBaseline = null;
  const heldHeights = [];
  let heldReset = null;
  let heldFinal = null;
  if (requireExactKeys(value.held, HELD_KEYS, "held", failures)) {
    heldBaseline = inspectSample(
      value.held.baseline,
      "held.baseline",
      { ...context, expectedStage: "baseline" },
      failures,
    );
    const heightCount = Array.isArray(value.heights) ? value.heights.length : -1;
    if (!Array.isArray(value.held.heights) || value.held.heights.length !== heightCount) {
      failures.push(`held.heights=heights.length/${displayValue(value.held.heights?.length)}`);
    } else {
      value.held.heights.forEach((height, index) => {
        const inspected = inspectSample(
          height,
          `held.heights[${index}]`,
          { ...context, expectedStage: "height" },
          failures,
        );
        if (inspected) heldHeights.push(inspected);
      });
    }
    heldReset = inspectSample(
      value.held.reset,
      "held.reset",
      { ...context, expectedStage: "reset" },
      failures,
    );
    heldFinal = inspectSample(
      value.held.final,
      "held.final",
      { ...context, expectedStage: "final" },
      failures,
    );
  }

  const requestedHeights = heights.map((sample) => sample.requestedHeightCssPx);
  if (!sameList(requestedHeights, REQUIRED_HEIGHTS)) {
    failures.push(`heights.requestedHeightCssPx=30,60,72/${displayValue(requestedHeights)}`);
  }

  const ordered = [baseline, ...heights, reset, final].filter(Boolean);
  if (baseline?.dom) {
    ordered.forEach((sample, index) => {
      if (sample.dom && sample.dom.nodeIdentity !== baseline.dom.nodeIdentity) {
        failures.push(`stages[${index}].dom.nodeIdentity=baseline`);
      }
    });
  }
  let previousRevision = baseline?.presentationRevision ?? null;
  for (const [index, height] of heights.entries()) {
    if (previousRevision !== null && height.presentationRevision !== null
        && !(height.presentationRevision > previousRevision)) {
      failures.push(`heights[${index}].presentationRevision=>previous`);
    }
    if (height.presentationRevision !== null) previousRevision = height.presentationRevision;
  }
  if (previousRevision !== null && reset?.presentationRevision != null
      && !(reset.presentationRevision > previousRevision)) {
    failures.push("reset.presentationRevision=>last-height");
  }
  if (reset?.presentationRevision != null && final?.presentationRevision != null
      && final.presentationRevision < reset.presentationRevision) {
    failures.push("final.presentationRevision>=reset");
  }

  compareRestoredSample(baseline, reset, "reset", framework, failures);
  compareRestoredSample(baseline, final, "final", framework, failures);
  compareHeldSample(baseline, heldBaseline, "held.baseline", framework, failures);
  heights.forEach((height, index) => {
    compareHeldSample(height, heldHeights[index], `held.heights[${index}]`, framework, failures);
  });
  compareHeldSample(reset, heldReset, "held.reset", framework, failures);
  compareHeldSample(final, heldFinal, "held.final", framework, failures);

  return finishMachineVerdict(
    "B12",
    failures,
    `${value.engine}/B12:${framework};baseline+height>=2+reset+final=presented+held;`
      + `height=30,60,72;hostile-resize>=12+exact-restore;`
      + `center<=${TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX}px;dom-identity+inline-style=restored`,
  );
}
