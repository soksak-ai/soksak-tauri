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
  "owner",
]);
const OWNER_KEYS = Object.freeze([
  "identity",
  "drawOwnerCount",
  "targetSequence",
  "appliedTargetSequence",
  "mutationSequence",
  "drawSequence",
  "applying",
  "lastApplyOk",
  "lastApplyError",
]);
const HOSTILE_OWNER_KEYS = Object.freeze(["identity", "drawOwnerCount"]);
const STARTUP_KEYS = Object.freeze([
  "platform",
  "generation",
  "headless",
  "creationCommitted",
  "rendererGreen",
  "presentationInFlight",
  "presented",
  "composition",
]);
const STARTUP_COMPOSITION_KEYS = Object.freeze(["kind", "nativeSequence"]);
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
  "owner",
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

function counter(value, path, minimum, failures) {
  if (Number.isSafeInteger(value) && value >= minimum) return value;
  failures.push(`${path}=integer>=${minimum}/${displayValue(value)}`);
  return null;
}

/**
 * Tauri의 유일한 paint owner 원장. `targetSequence`는 명시적 compose 거래 수,
 * `mutationSequence`는 실제로 버튼을 움직인 apply 수다. 둘의 차이가 AppKit이 스스로
 * 옮긴 것을 다시 앉힌 횟수이므로, 정지 구간에서 이 차이가 벌어지면 중간 회귀다.
 */
function inspectOwner(value, path, { framework, revision }, failures) {
  if (framework !== "tauri") {
    if (value !== null) failures.push(`${path}=null-for-electron/${displayValue(value)}`);
    return null;
  }
  if (!requireExactKeys(value, OWNER_KEYS, path, failures)) return null;
  if (!hasText(value.identity)) {
    failures.push(`${path}.identity=non-empty/${displayValue(value.identity)}`);
  }
  if (value.drawOwnerCount !== 1) {
    failures.push(`${path}.drawOwnerCount=1/${displayValue(value.drawOwnerCount)}`);
  }
  const targetSequence = counter(value.targetSequence, `${path}.targetSequence`, 1, failures);
  const appliedTargetSequence = counter(
    value.appliedTargetSequence,
    `${path}.appliedTargetSequence`,
    1,
    failures,
  );
  const mutationSequence = counter(value.mutationSequence, `${path}.mutationSequence`, 0, failures);
  const drawSequence = counter(value.drawSequence, `${path}.drawSequence`, 0, failures);
  if (targetSequence !== null && appliedTargetSequence !== null
      && appliedTargetSequence !== targetSequence) {
    failures.push(`${path}.appliedTargetSequence=targetSequence`);
  }
  if (revision != null && targetSequence !== null && targetSequence !== revision) {
    failures.push(`${path}.targetSequence=presentationRevision/${displayValue(targetSequence)}`);
  }
  if (value.applying !== false) failures.push(`${path}.applying=false/${displayValue(value.applying)}`);
  if (value.lastApplyOk !== true) {
    failures.push(`${path}.lastApplyOk=true/${displayValue(value.lastApplyOk)}`);
  }
  if (value.lastApplyError !== null) {
    failures.push(`${path}.lastApplyError=null/${displayValue(value.lastApplyError)}`);
  }
  return {
    identity: hasText(value.identity) ? value.identity : null,
    targetSequence,
    mutationSequence,
    drawSequence,
  };
}

function inspectHostileOwner(value, path, framework, failures) {
  if (framework !== "tauri") {
    if (value !== null) failures.push(`${path}=null-for-electron/${displayValue(value)}`);
    return null;
  }
  if (!requireExactKeys(value, HOSTILE_OWNER_KEYS, path, failures)) return null;
  if (!hasText(value.identity)) {
    failures.push(`${path}.identity=non-empty/${displayValue(value.identity)}`);
  }
  if (value.drawOwnerCount !== 1) {
    failures.push(`${path}.drawOwnerCount=1/${displayValue(value.drawOwnerCount)}`);
  }
  return { identity: hasText(value.identity) ? value.identity : null };
}

/** 창을 실제로 드러낸 시작 게이트 영수증. 어댑터의 boolean 하나가 아니라 각 사실을 읽는다. */
function inspectStartup(value, framework, failures) {
  if (!requireExactKeys(value, STARTUP_KEYS, "startup", failures)) return null;
  if (framework === "tauri" && value.platform !== "macos") {
    failures.push(`startup.platform=macos/${displayValue(value.platform)}`);
  }
  const generation = counter(value.generation, "startup.generation", 1, failures);
  for (const [key, expected] of [
    ["headless", false],
    ["creationCommitted", true],
    ["rendererGreen", true],
    ["presentationInFlight", false],
    ["presented", true],
  ]) {
    if (value[key] !== expected) {
      failures.push(`startup.${key}=${expected}/${displayValue(value[key])}`);
    }
  }
  if (!requireExactKeys(value.composition, STARTUP_COMPOSITION_KEYS, "startup.composition", failures)) {
    return { generation, nativeSequence: null };
  }
  if (framework === "tauri" && value.composition.kind !== "macos-titlebar") {
    failures.push(`startup.composition.kind=macos-titlebar/${displayValue(value.composition.kind)}`);
  }
  const nativeSequence = counter(
    value.composition.nativeSequence,
    "startup.composition.nativeSequence",
    1,
    failures,
  );
  return { generation, nativeSequence };
}

/** 창 기하가 그대로인 구간에서는 compose 거래 수보다 mutation이 더 늘 수 없다. */
function compareCompositionLedger(from, to, path, { still }, failures) {
  const left = from?.owner;
  const right = to?.owner;
  if (!(left && right)) return;
  if (left.identity && right.identity && left.identity !== right.identity) {
    failures.push(`${path}.owner.identity=one-paint-owner`);
  }
  const delta = (key) => (left[key] === null || right[key] === null ? null : right[key] - left[key]);
  for (const key of ["targetSequence", "mutationSequence", "drawSequence"]) {
    const value = delta(key);
    if (value !== null && value < 0) failures.push(`${path}.owner.${key}=>=previous`);
  }
  const target = delta("targetSequence");
  const mutation = delta("mutationSequence");
  if (still && target !== null && mutation !== null && mutation > target) {
    failures.push(`${path}.owner.mutationSequence=<=composed-transactions/${displayValue(mutation)}`);
  }
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

function inspectTitlebarAgainstViewport(titlebar, viewport, path, failures) {
  if (!(titlebar && viewport)) return;
  if (!withinTolerance(titlebar.x)) failures.push(`${path}.x=viewport-left`);
  if (!withinTolerance(titlebar.y)) failures.push(`${path}.y=viewport-top`);
  if (!withinTolerance(titlebar.w - viewport.w)) failures.push(`${path}.w=viewport-width`);
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

  inspectTitlebarAgainstViewport(titlebar, viewport, `${path}.titlebarPhysical`, failures);
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

  const ownerLedger = inspectOwner(
    value.owner,
    `${path}.owner`,
    { framework, revision: revisionValid ? value.presentationRevision : null },
    failures,
  );

  return {
    stage: value.stage,
    presentationRevision: revisionValid ? value.presentationRevision : null,
    presented: value.presented === true,
    requestedHeightCssPx: requestedValid ? requestedHeight : null,
    dom,
    viewport,
    titlebar,
    planes: { reservations, buttons, backings },
    owner: ownerLedger,
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
  compareCompositionLedger(applied, held, path, { still: true }, failures);
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
  inspectTitlebarAgainstViewport(titlebar, viewport, `${path}.titlebarPhysical`, failures);
  inspectPlaneAgainstTitlebar(reservations, titlebar, `${path}.reservations`, failures);
  inspectPlaneAgainstTitlebar(buttons, titlebar, `${path}.buttons`, failures);
  inspectMatchingPlanes(reservations, buttons, `${path}.reservationButton`, failures);
  if (framework === "tauri") {
    inspectPlaneAgainstTitlebar(backings, titlebar, `${path}.backings`, failures);
    inspectMatchingPlanes(backings, buttons, `${path}.backingButton`, failures);
  }
  const ownerLedger = inspectHostileOwner(value.owner, `${path}.owner`, framework, failures);
  return {
    revision,
    viewport,
    titlebar,
    planes: { reservations, buttons, backings },
    owner: ownerLedger,
  };
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
      if (baseline?.owner?.identity && titlebar?.owner?.identity
          && titlebar.owner.identity !== baseline.owner.identity) {
        failures.push(`${path}.titlebar.owner.identity=one-paint-owner`);
      }
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
      if (baseline?.titlebar && titlebar?.titlebar
          && !withinTolerance(titlebar.titlebar.h - baseline.titlebar.h)) {
        failures.push(`${path}.titlebar.titlebarPhysical.h=baseline`);
      }
      for (const plane of ["reservations", "buttons", ...(context.framework === "tauri" ? ["backings"] : [])]) {
        inspectMatchingPlanes(
          baseline?.planes?.[plane],
          titlebar?.planes?.[plane],
          `${path}.titlebar.${plane}=baseline`,
          failures,
        );
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
    [
      "engine", "coordinateSpace", "startup", "cold", "baseline", "heights", "reset",
      "hostileResize", "final", "held",
    ],
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
  const startup = inspectStartup(value.startup, framework, failures);
  const cold = inspectSample(
    value.cold,
    "cold",
    { ...context, expectedStage: "cold" },
    failures,
  );
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

  const ordered = [cold, baseline, ...heights, reset, final].filter(Boolean);
  if (cold?.dom) {
    ordered.forEach((sample, index) => {
      if (sample.dom && sample.dom.nodeIdentity !== cold.dom.nodeIdentity) {
        failures.push(`stages[${index}].dom.nodeIdentity=cold`);
      }
    });
  }
  for (let index = 1; index < ordered.length; index += 1) {
    compareCompositionLedger(
      ordered[index - 1],
      ordered[index],
      `stages[${index}]`,
      { still: false },
      failures,
    );
  }

  // 재시작 직후 정렬(cold)과 로딩 완료 후 정렬(baseline)은 각각 측정하며, 그 사이에는
  // 명시적 mutation이 없다. 두 표본이 다르면 최종 화면만 보고 GREEN이라 할 수 없다.
  if (startup?.nativeSequence != null && cold?.presentationRevision != null
      && !(cold.presentationRevision >= startup.nativeSequence)) {
    failures.push("cold.presentationRevision=>=startup-presented-composition");
  }
  if (cold?.presentationRevision != null && baseline?.presentationRevision != null
      && !(baseline.presentationRevision >= cold.presentationRevision)) {
    failures.push("baseline.presentationRevision=>=cold");
  }
  compareRestoredSample(cold, baseline, "baseline-vs-cold", framework, failures);
  compareCompositionLedger(cold, baseline, "baseline-vs-cold", { still: true }, failures);

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
    `${value.engine}/B12:${framework};startup-receipt+cold+baseline+height>=2+reset+final`
      + `=presented+held;height=30,60,72;hostile-resize>=12+exact-restore;`
      + `center<=${TITLEBAR_CENTER_TOLERANCE_PHYSICAL_PX}px;dom-identity+inline-style=restored;`
      + `one-paint-owner;still-span-mutations<=composed-transactions`,
  );
}
