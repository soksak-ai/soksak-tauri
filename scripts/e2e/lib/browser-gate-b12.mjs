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
const SAMPLE_KEYS = Object.freeze([
  "stage",
  "presentationRevision",
  "presented",
  "requestedHeightCssPx",
  "dom",
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
  for (const plane of ["reservations", "buttons", ...(framework === "tauri" ? ["backings"] : [])]) {
    inspectMatchingPlanes(
      baseline.planes[plane],
      restored.planes[plane],
      `${path}.${plane}`,
      failures,
    );
  }
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
    ["engine", "coordinateSpace", "baseline", "heights", "reset", "final"],
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
  if (!Array.isArray(value.heights) || value.heights.length < 2) {
    failures.push(`heights=at-least-2/${displayValue(value.heights?.length)}`);
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
  const final = inspectSample(
    value.final,
    "final",
    { ...context, expectedStage: "final" },
    failures,
  );

  const requestedHeights = heights.map((sample) => sample.requestedHeightCssPx);
  if (requestedHeights.some((height) => height === null)
      || new Set(requestedHeights).size !== requestedHeights.length) {
    failures.push(`heights.requestedHeightCssPx=unique/${displayValue(requestedHeights)}`);
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

  return finishMachineVerdict(
    "B12",
    failures,
    `${value.engine}/B12:${framework};baseline+height>=2+reset+final=presented;`
      + `center<=${TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX}px;dom-identity+inline-style=restored`,
  );
}
