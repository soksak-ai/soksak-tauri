import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

const EPSILON = 0.001;
const PANE_KEYS = Object.freeze([
  "viewId",
  "active",
  "level",
  "styleDim",
  "adapterAlpha",
]);
const PLANE_KEYS = Object.freeze([
  "count",
  "baseAmount",
  "apertureViewId",
  "apertureCount",
]);
const EXEMPT_KEYS = Object.freeze(["node", "exempt", "styleDim", "coveredByPlane"]);

function finiteUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function near(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= EPSILON;
}

function inspectPane(pane, path, activeViewId, seen, failures) {
  if (!requireExactKeys(pane, PANE_KEYS, path, failures)) return;
  if (!hasText(pane.viewId) || seen.has(pane.viewId)) {
    failures.push(`${path}.viewId=unique-non-empty/${displayValue(pane.viewId)}`);
  } else {
    seen.add(pane.viewId);
  }
  if (typeof pane.active !== "boolean") {
    failures.push(`${path}.active=boolean/${displayValue(pane.active)}`);
  }
  if (!hasText(pane.level)) failures.push(`${path}.level=non-empty/${displayValue(pane.level)}`);
  if (!finiteUnit(pane.styleDim)) {
    failures.push(`${path}.styleDim=0..1/${displayValue(pane.styleDim)}`);
  }
  if (!finiteUnit(pane.adapterAlpha)) {
    failures.push(`${path}.adapterAlpha=0..1/${displayValue(pane.adapterAlpha)}`);
  } else if (!near(pane.adapterAlpha, 1)) {
    failures.push(`${path}.adapterAlpha=1-no-duplicate-lighting/${displayValue(pane.adapterAlpha)}`);
  }
  if (pane.active === true) {
    if (pane.viewId !== activeViewId) {
      failures.push(`${path}.viewId=activeViewId/${displayValue(pane.viewId)}/${displayValue(activeViewId)}`);
    }
    if (pane.level !== "clear") failures.push(`${path}.level=clear/${displayValue(pane.level)}`);
    if (!near(pane.styleDim, 0)) failures.push(`${path}.styleDim=0/${displayValue(pane.styleDim)}`);
  } else if (pane.active === false) {
    if (pane.viewId === activeViewId) failures.push(`${path}.active=true-for-activeViewId`);
    if (pane.level === "clear") failures.push(`${path}.level=dimmed/${displayValue(pane.level)}`);
    if (!(pane.styleDim > EPSILON && pane.styleDim < 1)) {
      failures.push(`${path}.styleDim=0<dim<1/${displayValue(pane.styleDim)}`);
    }
  }
}

function inspectLightingPlane(value, activeViewId, path, failures) {
  if (!requireExactKeys(value, PLANE_KEYS, path, failures)) return null;
  if (value.count !== 1) failures.push(`${path}.count=1/${displayValue(value.count)}`);
  if (!(Number.isFinite(value.baseAmount) && value.baseAmount > 0 && value.baseAmount < 1)) {
    failures.push(`${path}.baseAmount=0<amount<1/${displayValue(value.baseAmount)}`);
  }
  if (value.apertureCount !== 1) {
    failures.push(`${path}.apertureCount=1/${displayValue(value.apertureCount)}`);
  }
  if (value.apertureViewId !== activeViewId) {
    failures.push(
      `${path}.apertureViewId=activeViewId/${displayValue(value.apertureViewId)}/${displayValue(activeViewId)}`,
    );
  }
  return value.baseAmount;
}

function inspectExempt(value, expectedNode, path, failures) {
  if (!requireExactKeys(value, EXEMPT_KEYS, path, failures)) return;
  if (value.node !== expectedNode) failures.push(`${path}.node=${expectedNode}/${displayValue(value.node)}`);
  if (value.exempt !== true) failures.push(`${path}.exempt=true/${displayValue(value.exempt)}`);
  if (!near(value.styleDim, 0)) failures.push(`${path}.styleDim=0/${displayValue(value.styleDim)}`);
  if (value.coveredByPlane !== false) {
    failures.push(`${path}.coveredByPlane=false/${displayValue(value.coveredByPlane)}`);
  }
}

/** 픽셀 밝기가 아니라 단일 공개 lighting plane과 adapter 비개입을 판정하는 B06 순수 judge. */
export function judgeB06MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "checkpoints"], "evidence", failures)) {
    return finishMachineVerdict("B06", failures, "B06:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length < 2) {
    failures.push(`checkpoints=at-least-2/${displayValue(value.checkpoints?.length)}`);
  } else {
    const phases = new Set();
    const activated = new Set();
    let ownerSet = null;
    value.checkpoints.forEach((checkpoint, index) => {
      const path = `checkpoints[${index}]`;
      if (!requireExactKeys(
        checkpoint,
        ["phase", "activeViewId", "panes", "lightingPlane", "rail", "sidebar"],
        path,
        failures,
      )) return;
      if (!hasText(checkpoint.phase) || phases.has(checkpoint.phase)) {
        failures.push(`${path}.phase=unique-non-empty/${displayValue(checkpoint.phase)}`);
      } else {
        phases.add(checkpoint.phase);
      }
      if (!hasText(checkpoint.activeViewId)) {
        failures.push(`${path}.activeViewId=non-empty/${displayValue(checkpoint.activeViewId)}`);
      } else {
        activated.add(checkpoint.activeViewId);
      }
      const baseAmount = inspectLightingPlane(
        checkpoint.lightingPlane,
        checkpoint.activeViewId,
        `${path}.lightingPlane`,
        failures,
      );
      if (!Array.isArray(checkpoint.panes) || checkpoint.panes.length < 2) {
        failures.push(`${path}.panes=at-least-2/${displayValue(checkpoint.panes?.length)}`);
      } else {
        const seen = new Set();
        checkpoint.panes.forEach((pane, paneIndex) => (
          inspectPane(pane, `${path}.panes[${paneIndex}]`, checkpoint.activeViewId, seen, failures)
        ));
        const activeCount = checkpoint.panes.filter((pane) => pane?.active === true).length;
        if (activeCount !== 1) failures.push(`${path}.panes.active-count=1/${activeCount}`);
        if (Number.isFinite(baseAmount)) {
          checkpoint.panes.forEach((pane, paneIndex) => {
            if (pane?.active === false && !near(pane.styleDim, baseAmount)) {
              failures.push(
                `${path}.panes[${paneIndex}].styleDim=lightingPlane.baseAmount/`
                  + `${displayValue(pane.styleDim)}/${displayValue(baseAmount)}`,
              );
            }
          });
        }
        const owners = [...seen].sort();
        if (ownerSet === null) ownerSet = owners;
        else if (owners.join("\u0000") !== ownerSet.join("\u0000")) {
          failures.push(`${path}.panes.owners=stable/${ownerSet.join(",")}/${owners.join(",")}`);
        }
      }
      inspectExempt(checkpoint.rail, "rail", `${path}.rail`, failures);
      inspectExempt(checkpoint.sidebar, "sidebar", `${path}.sidebar`, failures);
    });
    if (ownerSet && activated.size !== ownerSet.length) {
      failures.push(`activated-owners=all/${ownerSet.join(",")}/${[...activated].sort().join(",")}`);
    }
    for (const activeViewId of activated) {
      if (ownerSet && !ownerSet.includes(activeViewId)) {
        failures.push(`activeViewId=known-owner/${displayValue(activeViewId)}`);
      }
    }
  }
  return finishMachineVerdict(
    "B06",
    failures,
    `${value.engine}/B06:single-plane;all-panes-active-once;adapter-alpha=1;rail+sidebar=uncovered`,
  );
}
