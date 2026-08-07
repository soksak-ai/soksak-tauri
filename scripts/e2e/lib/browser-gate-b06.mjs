import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  notRunVerdict,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";
import { ADAPTER_ALPHA_BASES } from "./browser-gate-b06-adapter.mjs";

const EPSILON = 0.001;
const ADAPTER_BASES = new Set(ADAPTER_ALPHA_BASES);
const PANE_KEYS = Object.freeze([
  "paneId",
  "active",
  "level",
  "styleDim",
  "adapterAlpha",
  "adapterBasis",
]);
// 단일 평면은 **화면에 선 것**을 센다. 파킹된 공간의 평면은 DOM 에 남지만 픽셀을 칠하지
// 않으므로 이중 감광이 될 수 없다(browser-gate-b06-collect.mjs 의 근거 참조). 그 사실을 안 세되
// 장부에는 남기고, 가시성을 못 읽은 평면은 셋 중 어느 쪽도 아니다 — 못 읽음은 0 이 아니다.
const PLANE_KEYS = Object.freeze([
  "presented",
  "parked",
  "unreadable",
  "baseAmount",
  "aperturePaneId",
  "apertureCount",
]);
const EXEMPT_KEYS = Object.freeze(["node", "exempt", "styleDim", "coveredByPlane"]);

function finiteUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function near(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= EPSILON;
}

function inspectPane(pane, path, activePaneId, seen, failures) {
  if (!requireExactKeys(pane, PANE_KEYS, path, failures)) return;
  if (!hasText(pane.paneId) || seen.has(pane.paneId)) {
    failures.push(`${path}.paneId=unique-non-empty/${displayValue(pane.paneId)}`);
  } else {
    seen.add(pane.paneId);
  }
  if (typeof pane.active !== "boolean") {
    failures.push(`${path}.active=boolean/${displayValue(pane.active)}`);
  }
  if (!hasText(pane.level)) failures.push(`${path}.level=non-empty/${displayValue(pane.level)}`);
  if (!finiteUnit(pane.styleDim)) {
    failures.push(`${path}.styleDim=0..1/${displayValue(pane.styleDim)}`);
  }
  // 값보다 먼저 근거를 묻는다 — 어느 장부에서 왔는지 말하지 못하는 1 은 측정이 아니다.
  if (!ADAPTER_BASES.has(pane.adapterBasis)) {
    failures.push(`${path}.adapterBasis=known/${displayValue(pane.adapterBasis)}`);
  }
  if (!finiteUnit(pane.adapterAlpha)) {
    failures.push(`${path}.adapterAlpha=0..1/${displayValue(pane.adapterAlpha)}`);
  } else if (!near(pane.adapterAlpha, 1)) {
    failures.push(`${path}.adapterAlpha=1-no-duplicate-lighting/${displayValue(pane.adapterAlpha)}`);
  }
  if (pane.active === true) {
    if (pane.paneId !== activePaneId) {
      failures.push(`${path}.paneId=activePaneId/${displayValue(pane.paneId)}/${displayValue(activePaneId)}`);
    }
    if (pane.level !== "clear") failures.push(`${path}.level=clear/${displayValue(pane.level)}`);
    if (!near(pane.styleDim, 0)) failures.push(`${path}.styleDim=0/${displayValue(pane.styleDim)}`);
  } else if (pane.active === false) {
    if (pane.paneId === activePaneId) failures.push(`${path}.active=true-for-activePaneId`);
    if (pane.level === "clear") failures.push(`${path}.level=dimmed/${displayValue(pane.level)}`);
    if (!(pane.styleDim > EPSILON && pane.styleDim < 1)) {
      failures.push(`${path}.styleDim=0<dim<1/${displayValue(pane.styleDim)}`);
    }
  }
}

function inspectLightingPlane(value, activePaneId, path, failures) {
  if (!requireExactKeys(value, PLANE_KEYS, path, failures)) return null;
  if (value.presented !== 1) failures.push(`${path}.presented=1/${displayValue(value.presented)}`);
  if (!(Number.isInteger(value.parked) && value.parked >= 0)) {
    failures.push(`${path}.parked=0..n/${displayValue(value.parked)}`);
  }
  if (value.unreadable !== 0) {
    failures.push(`${path}.unreadable=0/${displayValue(value.unreadable)}`);
  }
  if (!(Number.isFinite(value.baseAmount) && value.baseAmount > 0 && value.baseAmount < 1)) {
    failures.push(`${path}.baseAmount=0<amount<1/${displayValue(value.baseAmount)}`);
  }
  if (value.apertureCount !== 1) {
    failures.push(`${path}.apertureCount=1/${displayValue(value.apertureCount)}`);
  }
  if (value.aperturePaneId !== activePaneId) {
    failures.push(
      `${path}.aperturePaneId=activePaneId/${displayValue(value.aperturePaneId)}/${displayValue(activePaneId)}`,
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
        ["phase", "activePaneId", "panes", "lightingPlane", "rail", "sidebar"],
        path,
        failures,
      )) return;
      if (!hasText(checkpoint.phase) || phases.has(checkpoint.phase)) {
        failures.push(`${path}.phase=unique-non-empty/${displayValue(checkpoint.phase)}`);
      } else {
        phases.add(checkpoint.phase);
      }
      if (!hasText(checkpoint.activePaneId)) {
        failures.push(`${path}.activePaneId=non-empty/${displayValue(checkpoint.activePaneId)}`);
      } else {
        activated.add(checkpoint.activePaneId);
      }
      const baseAmount = inspectLightingPlane(
        checkpoint.lightingPlane,
        checkpoint.activePaneId,
        `${path}.lightingPlane`,
        failures,
      );
      if (!Array.isArray(checkpoint.panes) || checkpoint.panes.length < 2) {
        failures.push(`${path}.panes=at-least-2/${displayValue(checkpoint.panes?.length)}`);
      } else {
        const seen = new Set();
        checkpoint.panes.forEach((pane, paneIndex) => (
          inspectPane(pane, `${path}.panes[${paneIndex}]`, checkpoint.activePaneId, seen, failures)
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
    for (const activePaneId of activated) {
      if (ownerSet && !ownerSet.includes(activePaneId)) {
        failures.push(`activePaneId=known-owner/${displayValue(activePaneId)}`);
      }
    }
  }
  return finishMachineVerdict(
    "B06",
    failures,
    `${value.engine}/B06:one-presented-plane;all-panes-active-once;`
      + "adapter-alpha=1-from-named-ledger;rail+sidebar=uncovered-in-paint-order",
  );
}
