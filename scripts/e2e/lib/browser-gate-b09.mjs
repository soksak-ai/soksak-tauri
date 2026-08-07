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

/**
 * 그 자리를 target 이 소유했는가.
 *
 * ui.hit 이 답하는 owners 는 그 점의 **조상 경로**다(깊은 것부터, shadow 관통 —
 * catalogDom.declaredOwnerChain). 그래서 사슬이 target 을 담는다는 것과 최상위 요소가 target
 * 자신이거나 그 안이라는 것은 같은 말이고, 앞선 항목은 전부 target 의 자손이다.
 *
 * 이름 접두사로 읽지 않는다. 주소는 소유를 증명하지 못한다 — `sidebar/right/resizer` 는 이름만
 * 하위지 DOM 형제이고(사이드바 밖 자리가 GREEN 이 된다), 사이드바 안 플러그인 뷰가 선언한
 * `search-input` 은 진짜 자손인데 이름에 접두사가 없다(플러그인은 자기가 어느 자리에 붙었는지
 * 모르고, 알면 그게 강결합이다). 접두사 규칙은 양쪽으로 틀린다.
 */
function targetChromeIndex(stack, target) {
  return stack.findIndex((layer) => layer?.kind === "chrome" && layer?.owner === target);
}

function chromeOwners(stack) {
  return stack.filter((layer) => layer?.kind === "chrome").map((layer) => layer?.owner);
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
  if (first?.kind !== "chrome" || first?.surfaceId !== null) {
    failures.push(`${path}[0]=chrome-layer/${displayValue(first)}`);
  }
  if (first?.owner !== topmostOwner) {
    failures.push(
      `${path}[0].owner=topmostOwner/${displayValue(first?.owner)}/${displayValue(topmostOwner)}`,
    );
  }

  const targetIndex = targetChromeIndex(stack, target);
  if (targetIndex < 0) {
    failures.push(
      `${path}=owner-chain-contains-target/`
        + `${displayValue(chromeOwners(stack))}/${displayValue(target)}`,
    );
  } else {
    // target 위에 남는 것은 target 의 자손 chrome 뿐이다. native surface 가 끼면 그 자리는
    // 브라우저가 크롬을 덮은 것이므로 사슬이 target 을 담아도 계약 위반이다.
    for (let index = 0; index < targetIndex; index += 1) {
      if (stack[index]?.kind !== "chrome") {
        failures.push(
          `${path}[${index}].kind=chrome-above-target/${displayValue(stack[index]?.kind)}`,
        );
      }
    }
  }

  if (nativeSurface) {
    const nativeIndex = stack.findIndex((layer, index) => (
      index > 0
      && layer?.kind === "native-surface"
      && layer?.owner === nativeSurface.viewId
      && layer?.surfaceId === nativeSurface.surfaceId
    ));
    if (nativeIndex < 1 || (targetIndex >= 0 && nativeIndex < targetIndex)) {
      failures.push(
        `${path}.native-surface=matching-below-target-chrome/`
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
  // topmostOwner 는 stack[0].owner 와 같은 값이어야 하고(inspectStack), 그 자리의 소유는
  // 사슬 포함이 답한다 — 여기서 이름을 한 번 더 재지 않는다(한 사실 한 자리).
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
 *
 * "그 자리를 target 이 소유했는가"는 사슬 포함으로 읽는다(targetChromeIndex). target 이
 * 사슬에 있고, 그 위는 전부 chrome 이고, native surface 는 그 아래여야 GREEN 이다.
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
