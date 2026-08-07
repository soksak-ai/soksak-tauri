import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

const TARGETS = Object.freeze([
  "rail/add",
  "sidebar/right",
  "modal/project-new",
]);
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const POINT_KEYS = Object.freeze(["x", "y"]);
const SAMPLE_KEYS = Object.freeze([
  "target",
  "relation",
  "chromeRect",
  "chromeControl",
  "nativeSurface",
  "hit",
]);
const TARGET_RELATIONS = Object.freeze({
  "rail/add": "global-layer-order",
  "sidebar/right": "point-overlap",
  "modal/project-new": "point-overlap",
});
/** modal 만 자기 평면 번호로 chrome 평면 위에 있음을 증명한다(NATIVE-SURFACES §4). */
const TARGET_MIN_PLANE_Z = Object.freeze({ "modal/project-new": 300 });
const NATIVE_SURFACE_KEYS = Object.freeze([
  "viewId",
  "surfaceId",
  "topologyPath",
  "chromeAboveHost",
  "live",
  "visible",
  "presented",
  "rect",
]);
const CHROME_CONTROL_KEYS = Object.freeze(["reachable", "planeZ"]);
const HIT_KEYS = Object.freeze(["point", "topmostOwner", "stack"]);
const STACK_LAYER_KEYS = Object.freeze(["kind", "owner", "surfaceId"]);

/** 응답이 답하는 최상위 소유자는 target 자신이거나 그 하위 주소다 — 잎을 target 으로 눕히지 않는다. */
function ownedByTarget(owner, target) {
  return owner === target || (typeof owner === "string" && owner.startsWith(`${target}/`));
}

function inspectRect(value, path, failures) {
  if (!requireExactKeys(value, RECT_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of ["x", "y"]) {
    if (!Number.isFinite(value[key])) {
      failures.push(`${path}.${key}=finite/${displayValue(value[key])}`);
      valid = false;
    }
  }
  for (const key of ["w", "h"]) {
    if (!(Number.isFinite(value[key]) && value[key] > 0)) {
      failures.push(`${path}.${key}=finite>0/${displayValue(value[key])}`);
      valid = false;
    }
  }
  return valid;
}

function inspectPoint(value, path, failures) {
  if (!requireExactKeys(value, POINT_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of POINT_KEYS) {
    if (!Number.isFinite(value[key])) {
      failures.push(`${path}.${key}=finite/${displayValue(value[key])}`);
      valid = false;
    }
  }
  return valid;
}

function overlapRect(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return {
    x: left,
    y: top,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
}

function pointInside(point, rect) {
  return point.x >= rect.x
    && point.x < rect.x + rect.w
    && point.y >= rect.y
    && point.y < rect.y + rect.h;
}

function inspectNativeSurface(value, path, failures) {
  if (!requireExactKeys(value, NATIVE_SURFACE_KEYS, path, failures)) return null;
  if (!hasText(value.viewId)) {
    failures.push(`${path}.viewId=non-empty/${displayValue(value.viewId)}`);
  }
  if (!hasText(value.surfaceId)) {
    failures.push(`${path}.surfaceId=non-empty/${displayValue(value.surfaceId)}`);
  }
  if (!hasText(value.topologyPath)) {
    failures.push(`${path}.topologyPath=non-empty/${displayValue(value.topologyPath)}`);
  }
  // 실측 형제 순서. 선언이나 class 이름 추측은 증거가 아니다(NATIVE-SURFACES §4) — 이 사실이
  // 영수증에 실리지 않으면 "chrome 이 위"는 하니스가 적어 넣은 문장일 뿐이다.
  if (value.chromeAboveHost !== true) {
    failures.push(`${path}.chromeAboveHost=true/${displayValue(value.chromeAboveHost)}`);
  }
  for (const field of ["live", "visible", "presented"]) {
    if (value[field] !== true) {
      failures.push(`${path}.${field}=true/${displayValue(value[field])}`);
    }
  }
  const rectValid = inspectRect(value.rect, `${path}.rect`, failures);
  return rectValid && hasText(value.viewId) && hasText(value.surfaceId) ? value : null;
}

function inspectStack(stack, target, topmostOwner, nativeSurface, path, failures) {
  if (!Array.isArray(stack) || stack.length < 2) {
    failures.push(`${path}=at-least-2/${displayValue(stack?.length)}`);
    return;
  }

  stack.forEach((layer, index) => {
    const layerPath = `${path}[${index}]`;
    if (!requireExactKeys(layer, STACK_LAYER_KEYS, layerPath, failures)) return;
    if (layer.kind !== "chrome" && layer.kind !== "native-surface") {
      failures.push(`${layerPath}.kind=chrome|native-surface/${displayValue(layer.kind)}`);
    }
    if (!hasText(layer.owner)) {
      failures.push(`${layerPath}.owner=non-empty/${displayValue(layer.owner)}`);
    }
    if (layer.kind === "chrome" && layer.surfaceId !== null) {
      failures.push(`${layerPath}.surfaceId=null-for-chrome/${displayValue(layer.surfaceId)}`);
    }
    if (layer.kind === "native-surface" && !hasText(layer.surfaceId)) {
      failures.push(`${layerPath}.surfaceId=non-empty/${displayValue(layer.surfaceId)}`);
    }
  });

  const first = stack[0];
  if (first?.kind !== "chrome" || !ownedByTarget(first?.owner, target) || first?.surfaceId !== null) {
    failures.push(`${path}[0]=target-chrome/${displayValue(first)}`);
  }
  if (first?.owner !== topmostOwner) {
    failures.push(
      `${path}[0].owner=topmostOwner/${displayValue(first?.owner)}/${displayValue(topmostOwner)}`,
    );
  }

  if (nativeSurface) {
    const nativeIndex = stack.findIndex((layer, index) => (
      index > 0
      && layer?.kind === "native-surface"
      && layer?.owner === nativeSurface.viewId
      && layer?.surfaceId === nativeSurface.surfaceId
    ));
    if (nativeIndex < 1) {
      failures.push(
        `${path}.native-surface=matching-below-chrome/`
          + `${displayValue({ viewId: nativeSurface.viewId, surfaceId: nativeSurface.surfaceId })}`,
      );
    }
  }
}

/**
 * chrome 조작면 사실. 도달 불가는 "브라우저 위 크롬"이 성립하지 않았다는 뜻이고, 평면 번호는
 * modal 이 크롬 평면 위에 있다는 증거다. 둘 다 생산자가 던져 지우지 말고 값으로 실어야 한다.
 */
function inspectChromeControl(value, target, path, failures) {
  if (!requireExactKeys(value, CHROME_CONTROL_KEYS, path, failures)) return;
  if (value.reachable !== true) {
    failures.push(`${path}.reachable=true/${displayValue(value.reachable)}`);
  }
  const minimum = TARGET_MIN_PLANE_Z[target];
  if (minimum !== undefined
      && !(Number.isFinite(value.planeZ) && value.planeZ >= minimum)) {
    failures.push(`${path}.planeZ=>=${minimum}/${displayValue(value.planeZ)}`);
  }
}

function inspectSample(value, index, seenTargets, failures) {
  const path = `samples[${index}]`;
  if (!requireExactKeys(value, SAMPLE_KEYS, path, failures)) return;

  const target = value.target;
  if (!TARGETS.includes(target) || seenTargets.has(target)) {
    failures.push(`${path}.target=unique-known/${displayValue(target)}`);
  } else {
    seenTargets.add(target);
  }
  const expectedRelation = TARGET_RELATIONS[target];
  if (value.relation !== expectedRelation) {
    failures.push(`${path}.relation=${displayValue(expectedRelation)}/${displayValue(value.relation)}`);
  }

  const chromeRectValid = inspectRect(value.chromeRect, `${path}.chromeRect`, failures);
  inspectChromeControl(value.chromeControl, target, `${path}.chromeControl`, failures);
  const nativeSurface = inspectNativeSurface(
    value.nativeSurface,
    `${path}.nativeSurface`,
    failures,
  );

  const hit = value.hit;
  if (!requireExactKeys(hit, HIT_KEYS, `${path}.hit`, failures)) return;
  const pointValid = inspectPoint(hit.point, `${path}.hit.point`, failures);
  if (!ownedByTarget(hit.topmostOwner, target)) {
    failures.push(
      `${path}.hit.topmostOwner=target/`
        + `${displayValue(hit.topmostOwner)}/${displayValue(target)}`,
    );
  }
  inspectStack(
    hit.stack,
    target,
    hit.topmostOwner,
    nativeSurface,
    `${path}.hit.stack`,
    failures,
  );

  if (chromeRectValid && nativeSurface && value.relation === "point-overlap") {
    const overlap = overlapRect(value.chromeRect, nativeSurface.rect);
    if (!(overlap.w > 0 && overlap.h > 0)) {
      failures.push(`${path}.overlap=positive-area/${displayValue(overlap)}`);
    } else if (pointValid && !pointInside(hit.point, overlap)) {
      failures.push(
        `${path}.hit.point=inside-overlap/`
          + `${displayValue(hit.point)}/${displayValue(overlap)}`,
      );
    }
  } else if (chromeRectValid && pointValid && value.relation === "global-layer-order"
      && !pointInside(hit.point, value.chromeRect)) {
    failures.push(
      `${path}.hit.point=inside-chrome/`
        + `${displayValue(hit.point)}/${displayValue(value.chromeRect)}`,
    );
  }
}

/**
 * 픽셀이 아니라 공개 rect·hit owner·layer stack으로 chrome/native 합성을 판정한다.
 * nativeSurface는 공개 surface 영수증 그대로이며, 선언된 `topologyPath`를 가진 소유자만
 * chrome 아래 layer로 인정한다. rect만 있는 익명 surface는 RED다.
 */
export function judgeB09MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "samples"], "evidence", failures)) {
    return finishMachineVerdict("B09", failures, "B09:unreachable");
  }
  if (!engineSet.has(value.engine)) {
    failures.push(`engine=known/${displayValue(value.engine)}`);
  }
  if (!Array.isArray(value.samples) || value.samples.length !== TARGETS.length) {
    failures.push(`samples=exactly-${TARGETS.length}/${displayValue(value.samples?.length)}`);
  } else {
    const seenTargets = new Set();
    value.samples.forEach((sample, index) => (
      inspectSample(sample, index, seenTargets, failures)
    ));
    for (const target of TARGETS) {
      if (!seenTargets.has(target)) failures.push(`target=${target}=missing`);
    }
  }
  return finishMachineVerdict(
    "B09",
    failures,
    `${value.engine}/B09:rail-add=global-chrome-above-native;`
      + "right-sidebar+modal=overlap-hit-topmost;native=declared-topology",
  );
}
