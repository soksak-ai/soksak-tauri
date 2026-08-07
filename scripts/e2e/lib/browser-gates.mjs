import {
  compositionInventoryVerdict,
  compositionObservationWindowVerdict,
  compositionTimelineVerdict,
  compositionTransactionVerdict,
  logicalRectToPhysical,
} from "../../../packages/dom-webview-compositor/src/index.ts";
import { layoutTransactionVerdict } from "./layout-transaction-verdict.mjs";
import { judgeB05MachineEvidence } from "./browser-gate-b05.mjs";
import { judgeB06MachineEvidence } from "./browser-gate-b06.mjs";
import { judgeB07MachineEvidence } from "./browser-gate-b07.mjs";
import { judgeB08MachineEvidence } from "./browser-gate-b08.mjs";
import { judgeB09MachineEvidence } from "./browser-gate-b09.mjs";
import { judgeB10MachineEvidence } from "./browser-gate-b10.mjs";
import { judgeB12MachineEvidence } from "./browser-gate-b12.mjs";
import {
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_FRAMEWORKS,
  BROWSER_ACCEPTANCE_PLATFORMS,
} from "./browser-gate-identity.mjs";
import {
  displayValue,
  engineSet,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireEvidenceEnvelope,
  requireExactKeys,
  requireUniqueViewId,
} from "./browser-machine-judge-support.mjs";

export {
  BROWSER_ACCEPTANCE_ENGINES,
  BROWSER_ACCEPTANCE_FRAMEWORKS,
  BROWSER_ACCEPTANCE_PLATFORMS,
};
export { judgeB05MachineEvidence };
export { judgeB06MachineEvidence };
export { judgeB07MachineEvidence };
export { judgeB08MachineEvidence };
export { judgeB09MachineEvidence };
export { judgeB10MachineEvidence };
export { judgeB12MachineEvidence };

export const MACHINE_GATE_STATUSES = Object.freeze([
  "not-applicable",
  "not-run",
  "blocked",
  "red",
  "green",
]);

export const VISUAL_REVIEW_STATUSES = Object.freeze([
  "not-applicable",
  "pending",
  "passed",
  "failed",
]);

export const B02_RETENTION_PHASES = Object.freeze([
  "initial",
  "flow-left",
  "flow-right",
  "hostile-window-resize",
  "pane-wider",
  "pane-restored",
]);

export const BROWSER_ACCEPTANCE_GATES = deepFreeze([
  {
    id: "B01",
    name: "initial-mount-address-page-identity",
    contract: "세 구현 모두 최초 mount에서 주소표시줄과 요청한 페이지 신원을 노출한다.",
  },
  {
    id: "B02",
    name: "korean-ime-state-retention",
    contract: "한글 IME가 beforeinput과 input을 발생시키며 전환과 resize 뒤에도 값을 보존한다.",
  },
  {
    id: "B03",
    name: "dom-live-surface-one-to-one",
    contract: "DOM slot과 live surface는 1:1이고 공유 topology와 frame은 rounding-only로 일치한다.",
  },
  {
    id: "B04",
    name: "flow-atomic-composition",
    contract: "FLOW에서 rail, pane, native surface는 하나의 원자적 이동으로 착지한다.",
  },
  {
    id: "B05",
    name: "continuous-visible-presentation",
    contract: "전환 중 flicker, black frame, 잔상, 착지 후 surface 소실은 모두 0이다.",
  },
  {
    id: "B06",
    name: "focus-lighting",
    contract: "active pane만 밝고 inactive pane만 감광되며 rail과 sidebar는 감광되지 않는다.",
  },
  {
    id: "B07",
    name: "pin-border-layout-invariance",
    contract: "PIN의 좌측 인접, 우측 인접, 분리 상태에서 border 계약과 레이아웃 불변성을 지킨다.",
  },
  {
    id: "B08",
    name: "pin-maximize-restore-station",
    contract: "PIN 양방향 maximize와 restore가 방향과 분할을 보존하고 station을 변경하지 않는다.",
  },
  {
    id: "B09",
    name: "chrome-over-native-layering",
    contract: "rail의 + 버튼, 우측 sidebar, modal은 native browser surface 위에 합성된다.",
  },
  {
    id: "B10",
    name: "hostile-window-resize",
    contract: "전체 창을 빠르게 축소·확대해도 presentation이 affine하게 추종하고 원래 기하로 복원된다.",
  },
  {
    id: "B11",
    name: "pane-resize-scroll-full-capture",
    contract: "pane resize 왕복, wheel 0→480→0, 명시한 탭의 full capture가 모두 같은 계약을 통과한다.",
  },
  {
    id: "B12",
    name: "traffic-light-composition",
    contract: "macOS traffic lights는 상하 중앙 및 hostile resize 정합을 유지한다. Tauri는 DOM reservation과 AppKit button/backing 3:3을, Electron은 공개 traffic-light position과 DOM reservation 정합을 증명한다.",
  },
]);

const frameworkSet = new Set(BROWSER_ACCEPTANCE_FRAMEWORKS);
const platformSet = new Set(BROWSER_ACCEPTANCE_PLATFORMS);
const gateSet = new Set(BROWSER_ACCEPTANCE_GATES.map(({ id }) => id));
const machineStatusSet = new Set(MACHINE_GATE_STATUSES);
const visualStatusSet = new Set(VISUAL_REVIEW_STATUSES);
const REPORT_SCHEMA_VERSION = 3;
const JUDGE_RECEIPT_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const B12_NOT_APPLICABLE_REASON = "B12 applies only to macOS traffic lights";

function gateIsApplicable(identity, gate) {
  return gate !== "B12" || identity.platform === "darwin";
}

function initialCell(identity, gate) {
  if (!gateIsApplicable(identity, gate)) {
    return {
      machine: {
        status: "not-applicable",
        evidence: [],
        reason: B12_NOT_APPLICABLE_REASON,
        judgeReceipt: null,
      },
      visualReview: {
        status: "not-applicable",
        artifacts: [],
        notes: B12_NOT_APPLICABLE_REASON,
      },
    };
  }
  return {
    machine: { status: "not-run", evidence: [], reason: null, judgeReceipt: null },
    visualReview: { status: "pending", artifacts: [], notes: null },
  };
}

function requireIdentityText(value, field) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a trimmed 1..256 character string`);
  }
  return value;
}

function normalizeReportIdentity(value) {
  if (!isRecord(value)) throw new TypeError("browser gate report identity is required");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "buildId,framework,platform,runId") {
    throw new TypeError("browser gate report identity must contain exactly framework, platform, buildId, runId");
  }
  if (!frameworkSet.has(value.framework)) {
    throw new TypeError(`unknown browser framework: ${value.framework}`);
  }
  if (!platformSet.has(value.platform)) {
    throw new TypeError(`unknown browser platform: ${value.platform}`);
  }
  return {
    framework: value.framework,
    platform: value.platform,
    buildId: requireIdentityText(value.buildId, "buildId"),
    runId: requireIdentityText(value.runId, "runId"),
  };
}

function requireEngine(engine) {
  if (!engineSet.has(engine)) throw new TypeError(`unknown browser engine: ${engine}`);
}

function requireGate(gate) {
  if (!gateSet.has(gate)) throw new TypeError(`unknown browser gate: ${gate}`);
}

function requireStringList(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) throw new TypeError(`${field} must not be empty`);
  return [...value];
}

function requireOptionalText(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be null or a non-empty string`);
  }
  return value;
}

export const B01_TAB_KEYS = Object.freeze([
  "viewId",
  "expectedUrl",
  "mounted",
  "navigations",
]);
export const B01_NAVIGATION_KEYS = Object.freeze([
  "url",
  "expectedTitle",
  "expectedBodyIncludes",
  "requestedViewId",
  "returnedViewId",
  "toolbarAddress",
  "pageIdentity",
  "observation",
]);
const B01_TOOLBAR_KEYS = Object.freeze(["dataNode", "value"]);
const B01_PAGE_IDENTITY_KEYS = Object.freeze(["url", "title", "bodyText"]);
const B01_MINIMUM_NAVIGATIONS = 2;

function b01IdentitySignature(navigation) {
  return displayValue([
    navigation?.pageIdentity?.url ?? null,
    navigation?.pageIdentity?.title ?? null,
    navigation?.pageIdentity?.bodyText ?? null,
  ]);
}

function b01Navigations(tab) {
  return Array.isArray(tab?.navigations) ? tab.navigations : [];
}

/** 한 값이 증거 전체에서 몇 번 나오는지 센다. 1 은 그 view 만이 답할 수 있는 사실을 뜻한다. */
function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function inspectB01Navigation(navigation, path, viewId, failures) {
  if (!requireExactKeys(navigation, B01_NAVIGATION_KEYS, path, failures)) return;
  if (!hasText(navigation.url)) {
    failures.push(`${path}.url=non-empty/${displayValue(navigation.url)}`);
  }
  if (!hasText(navigation.expectedTitle)) {
    failures.push(`${path}.expectedTitle=non-empty/${displayValue(navigation.expectedTitle)}`);
  }
  if (!hasText(navigation.expectedBodyIncludes)) {
    failures.push(`${path}.expectedBodyIncludes=non-empty/${displayValue(navigation.expectedBodyIncludes)}`);
  }
  if (navigation.requestedViewId !== viewId || navigation.returnedViewId !== viewId) {
    failures.push(`${path}.viewId=${displayValue(viewId)}/${displayValue({
      requested: navigation.requestedViewId,
      returned: navigation.returnedViewId,
    })}`);
  }

  if (requireExactKeys(navigation.toolbarAddress, B01_TOOLBAR_KEYS, `${path}.toolbarAddress`, failures)) {
    if (navigation.toolbarAddress.dataNode !== "urlbar") {
      failures.push(`${path}.toolbarAddress.dataNode=urlbar/${displayValue(navigation.toolbarAddress.dataNode)}`);
    }
    // 주소표시줄은 이 항해의 주소를 답해야 한다. 최초 문서에 멈춘 주소창은 여기서 이름으로 남는다.
    if (navigation.toolbarAddress.value !== navigation.url) {
      failures.push(`${path}.toolbarAddress.value=${displayValue(navigation.url)}/${displayValue(navigation.toolbarAddress.value)}`);
    }
  }

  if (requireExactKeys(navigation.pageIdentity, B01_PAGE_IDENTITY_KEYS, `${path}.pageIdentity`, failures)) {
    if (navigation.pageIdentity.url !== navigation.url) {
      failures.push(`${path}.pageIdentity.url=${displayValue(navigation.url)}/${displayValue(navigation.pageIdentity.url)}`);
    }
    if (navigation.pageIdentity.title !== navigation.expectedTitle) {
      failures.push(`${path}.pageIdentity.title=${displayValue(navigation.expectedTitle)}/${displayValue(navigation.pageIdentity.title)}`);
    }
    const bodyText = navigation.pageIdentity.bodyText;
    if (!hasText(bodyText)) {
      failures.push(`${path}.pageIdentity.bodyText=non-empty/${displayValue(bodyText)}`);
    } else if (hasText(navigation.expectedBodyIncludes)
        && !bodyText.includes(navigation.expectedBodyIncludes)) {
      failures.push(`${path}.pageIdentity.bodyText=includes(${displayValue(navigation.expectedBodyIncludes)})/${displayValue(bodyText)}`);
    }
  }

  if (requireExactKeys(navigation.observation, ["error"], `${path}.observation`, failures)
      && navigation.observation.error !== null) {
    failures.push(`${path}.observation.error=null/${displayValue(navigation.observation.error)}`);
  }
}

/**
 * B01 machine evidence is deliberately DOM/API based. A screenshot may accompany the
 * report through visualReview, but it cannot substitute for any value checked here.
 *
 * 한 번만 관측한 신원은 주소표시줄이 그 항해를 따라왔다는 사실을 담지 못한다. 그래서 탭마다
 * 실제 항해를 최소 두 번 요구하고, 매 항해에서 주소표시줄·문서 제목·본문을 함께 읽는다.
 * 우리가 물은 view 의 신원이라는 증명은 view 마다 다른 문서를 세워 그 신원이 증거 전체에서
 * 정확히 한 번만 나오는지로 한다 — 다른 view 의 답을 받아 오면 같은 값이 두 번 나온다.
 */
export function judgeB01MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "tabs"], "evidence", failures)) {
    return finishMachineVerdict("B01", failures, "B01:unreachable");
  }
  if (!requireEvidenceEnvelope(value, failures)) {
    return finishMachineVerdict("B01", failures, "B01:unreachable");
  }
  if (value.tabs.length !== 2) failures.push(`tabs.length=2/${value.tabs.length}`);

  const titleCounts = countBy(value.tabs.flatMap((tab) => b01Navigations(tab)
    .map((navigation) => displayValue(navigation?.pageIdentity?.title ?? null))));
  const bodyCounts = countBy(value.tabs.flatMap((tab) => b01Navigations(tab)
    .map((navigation) => displayValue(navigation?.pageIdentity?.bodyText ?? null))));

  const seen = new Set();
  value.tabs.forEach((tab, index) => {
    const path = `tabs[${index}]`;
    if (!requireExactKeys(tab, B01_TAB_KEYS, path, failures)) return;
    const viewId = requireUniqueViewId(tab, path, seen, failures);
    if (!hasText(tab.expectedUrl)) failures.push(`${path}.expectedUrl=non-empty/${displayValue(tab.expectedUrl)}`);
    if (tab.mounted !== true) failures.push(`${path}.mounted=true/${displayValue(tab.mounted)}`);

    if (!Array.isArray(tab.navigations) || tab.navigations.length < B01_MINIMUM_NAVIGATIONS) {
      failures.push(`${path}.navigations=at-least-${B01_MINIMUM_NAVIGATIONS}/${displayValue(tab.navigations?.length)}`);
      return;
    }
    tab.navigations.forEach((navigation, step) => {
      inspectB01Navigation(navigation, `${path}.navigations[${step}]`, viewId, failures);
    });

    // 마지막 항해는 뒤 게이트가 딛고 서는 문서다. 여기서 갈리면 뒤 판정 전부가 다른 문서를 잰다.
    const last = tab.navigations.at(-1);
    if (last?.url !== tab.expectedUrl) {
      failures.push(`${path}.navigations.last.url=${displayValue(tab.expectedUrl)}/${displayValue(last?.url)}`);
    }
    const distinctIdentities = new Set(tab.navigations.map(b01IdentitySignature)).size;
    if (distinctIdentities < B01_MINIMUM_NAVIGATIONS) {
      failures.push(`${path}.navigations.identity=at-least-${B01_MINIMUM_NAVIGATIONS}-distinct/${distinctIdentities}`);
    }
    const viewUnique = tab.navigations.some((navigation) => {
      const title = displayValue(navigation?.pageIdentity?.title ?? null);
      const bodyText = displayValue(navigation?.pageIdentity?.bodyText ?? null);
      return hasText(navigation?.pageIdentity?.title)
        && hasText(navigation?.pageIdentity?.bodyText)
        && titleCounts.get(title) === 1
        && bodyCounts.get(bodyText) === 1;
    });
    if (!viewUnique) failures.push(`${path}.pageIdentity=view-unique-missing`);
  });
  return finishMachineVerdict(
    "B01",
    failures,
    `${value.engine}/B01:tabs=${value.tabs.length};navigations=${value.tabs.map((tab) => b01Navigations(tab).length).join(",")};mounted+urlbar+title+body+explicit-view=exact`,
  );
}

/** Every retained sample is an event-ledger observation, never a pixel observation. */
export function judgeB02MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireEvidenceEnvelope(value, failures)) {
    return finishMachineVerdict("B02", failures, "B02:unreachable");
  }
  if (value.tabs.length !== 2) failures.push(`tabs.length=2/${value.tabs.length}`);
  const seen = new Set();
  const expectedTexts = new Set();
  value.tabs.forEach((tab, index) => {
    const path = `tabs[${index}]`;
    if (!isRecord(tab)) {
      failures.push(`${path}=record/${displayValue(tab)}`);
      return;
    }
    requireUniqueViewId(tab, path, seen, failures);
    if (!hasText(tab.expectedText) || !/[\u3131-\uD79D]/u.test(tab.expectedText)) {
      failures.push(`${path}.expectedText=hangul/${displayValue(tab.expectedText)}`);
    } else if (expectedTexts.has(tab.expectedText)) {
      failures.push(`${path}.expectedText=unique/${displayValue(tab.expectedText)}`);
    } else {
      expectedTexts.add(tab.expectedText);
    }
    if (!isRecord(tab.phases)) {
      failures.push(`${path}.phases=record/${displayValue(tab.phases)}`);
      return;
    }
    const initial = tab.phases.initial;
    if (!isRecord(initial) || initial.active !== true) {
      failures.push(`${path}.phases.initial.active=true/${displayValue(initial?.active)}`);
    }
    const initialBeforeInput = initial?.ledger?.beforeInput;
    const initialInputEvents = initial?.ledger?.inputEvents;
    if (!Number.isInteger(initialBeforeInput) || initialBeforeInput < 1) {
      failures.push(`${path}.phases.initial.ledger.beforeInput=integer>=1/${displayValue(initial?.ledger?.beforeInput)}`);
    }
    if (!Number.isInteger(initialInputEvents) || initialInputEvents < 1) {
      failures.push(`${path}.phases.initial.ledger.inputEvents=integer>=1/${displayValue(initial?.ledger?.inputEvents)}`);
    }

    for (const phase of B02_RETENTION_PHASES) {
      const sample = tab.phases[phase];
      const phasePath = `${path}.phases.${phase}`;
      if (!isRecord(sample)) {
        failures.push(`${phasePath}=record/${displayValue(sample)}`);
        continue;
      }
      if (sample.value !== tab.expectedText) {
        failures.push(`${phasePath}.value=expectedText/${displayValue(sample.value)}`);
      }
      if (!isRecord(sample.ledger)) {
        failures.push(`${phasePath}.ledger=record/${displayValue(sample.ledger)}`);
        continue;
      }
      const beforeInput = sample.ledger.beforeInput;
      const inputEvents = sample.ledger.inputEvents;
      if (!Number.isInteger(beforeInput) || beforeInput < initialBeforeInput) {
        failures.push(`${phasePath}.ledger.beforeInput>=initial/${displayValue(sample.ledger.beforeInput)}`);
      }
      if (!Number.isInteger(inputEvents) || inputEvents < initialInputEvents) {
        failures.push(`${phasePath}.ledger.inputEvents>=initial/${displayValue(sample.ledger.inputEvents)}`);
      }
      if (!Array.isArray(sample.ledger.values) || sample.ledger.values.length === 0
        || sample.ledger.values.at(-1) !== tab.expectedText) {
        failures.push(`${phasePath}.ledger.values.last=expectedText/${displayValue(sample.ledger.values?.at?.(-1))}`);
      }
    }
  });
  return finishMachineVerdict(
    "B02",
    failures,
    `${value.engine}/B02:tabs=${value.tabs.length};phases=${B02_RETENTION_PHASES.length};IME-ledger=retained`,
  );
}

const B03_EVIDENCE_KEYS = Object.freeze([
  "engine",
  "coordinateSpace",
  "visibleViewIds",
  "slots",
  "renderers",
  "surfaces",
]);
const B03_PARTICIPANT_KEYS = Object.freeze([
  "id",
  "viewId",
  "topologyPath",
  "visible",
  "logicalFrame",
  "physicalFrame",
]);
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);

function inspectB03Participants(values, kind, failures) {
  if (!Array.isArray(values) || values.length === 0) {
    failures.push(`${kind}s=non-empty/${displayValue(values)}`);
    return;
  }
  values.forEach((participant, index) => {
    const path = `${kind}s[${index}]`;
    if (!requireExactKeys(participant, B03_PARTICIPANT_KEYS, path, failures)) return;
    requireExactKeys(participant.logicalFrame, RECT_KEYS, `${path}.logicalFrame`, failures);
    requireExactKeys(participant.physicalFrame, RECT_KEYS, `${path}.physicalFrame`, failures);
  });
}

/**
 * B03은 independently enumerated inventory만 받는다. paired 결과만 받으면 producer가
 * 누락 surface를 숨길 수 있으므로 visible owner ledger와 세 집합을 따로 요구한다.
 */
export function judgeB03MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, B03_EVIDENCE_KEYS, "evidence", failures)) {
    return finishMachineVerdict("B03", failures, "B03:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (requireExactKeys(value.coordinateSpace, [
    "logical", "physical", "scaleFactor",
  ], "coordinateSpace", failures)) {
    if (value.coordinateSpace.logical !== "css-px") {
      failures.push(`coordinateSpace.logical=css-px/${displayValue(value.coordinateSpace.logical)}`);
    }
    if (value.coordinateSpace.physical !== "device-px") {
      failures.push(`coordinateSpace.physical=device-px/${displayValue(value.coordinateSpace.physical)}`);
    }
  }
  if (!Array.isArray(value.visibleViewIds)
      || value.visibleViewIds.length === 0
      || value.visibleViewIds.some((viewId) => !hasText(viewId))) {
    failures.push(`visibleViewIds=non-empty-strings/${displayValue(value.visibleViewIds)}`);
  }
  inspectB03Participants(value.slots, "slot", failures);
  inspectB03Participants(value.renderers, "renderer", failures);
  inspectB03Participants(value.surfaces, "surface", failures);

  const inventoryVerdict = compositionInventoryVerdict(value);
  failures.push(...inventoryVerdict.errors.map((error) => `inventory:${error}`));
  return finishMachineVerdict(
    "B03",
    failures,
    `${value.engine}/B03:visible=${inventoryVerdict.matched};slot+renderer+surface=1:1-rounding-only`,
  );
}

const B04_DIRECTIONS = Object.freeze(["to-left", "to-right"]);
const B04_TRANSITION_KEYS = Object.freeze([
  "direction",
  "targetViewId",
  "motionMode",
  "journal",
  "samples",
  "timeline",
]);
const B04_SAMPLE_KEYS = Object.freeze([
  "transactionId",
  "sequence",
  "phase",
  "sampledAtUnixMs",
  "rail",
  "pane",
  "slot",
  "renderer",
  "surface",
]);
const B04_PARTICIPANT_KEYS = Object.freeze([
  "id",
  "ownerViewId",
  "connected",
  "frame",
]);
export const B04_JOURNAL_ENTRY_KEYS = Object.freeze([
  "transactionId",
  "sequence",
  "phase",
  "mode",
  "startAtUnixMs",
  "durationMs",
  "preparedAtUnixMs",
  "domCommittedAtUnixMs",
  "closedAtUnixMs",
  "moves",
]);
const B04_TIMELINE_KEYS = Object.freeze([
  "startAtUnixMs",
  "durationMs",
  "timingFunction",
  "from",
  "to",
  "slot",
  "renderer",
  "surface",
]);
const B04_TIMELINE_SAMPLE_KEYS = Object.freeze(["sequence", "sampledAtUnixMs", "frame"]);

function inspectFiniteRect(rect, path, failures) {
  if (!requireExactKeys(rect, RECT_KEYS, path, failures)) return false;
  let valid = true;
  for (const key of RECT_KEYS) {
    if (!Number.isFinite(rect[key]) || ((key === "w" || key === "h") && rect[key] <= 0)) {
      failures.push(`${path}.${key}=finite${key === "w" || key === "h" ? ">0" : ""}/${displayValue(rect[key])}`);
      valid = false;
    }
  }
  return valid;
}

function inspectB04Participant(participant, path, targetViewId, failures) {
  if (!requireExactKeys(participant, B04_PARTICIPANT_KEYS, path, failures)) return false;
  let valid = true;
  if (!hasText(participant.id)) {
    failures.push(`${path}.id=non-empty/${displayValue(participant.id)}`);
    valid = false;
  }
  if (participant.ownerViewId !== targetViewId) {
    failures.push(`${path}.ownerViewId=${displayValue(targetViewId)}/${displayValue(participant.ownerViewId)}`);
    valid = false;
  }
  if (participant.connected !== true) {
    failures.push(`${path}.connected=true/${displayValue(participant.connected)}`);
    valid = false;
  }
  return inspectFiniteRect(participant.frame, `${path}.frame`, failures) && valid;
}

function b04PhysicalFrame(participant, scaleFactor) {
  return logicalRectToPhysical(participant.frame, scaleFactor);
}

function b04RelativeSlotSignature(sample, scaleFactor) {
  const pane = b04PhysicalFrame(sample.pane, scaleFactor);
  const slot = b04PhysicalFrame(sample.slot, scaleFactor);
  return [slot.x - pane.x, slot.y - pane.y, slot.w, slot.h, pane.w, pane.h].join("/");
}

function distinctB04Frames(samples, participant, scaleFactor) {
  return new Set(samples.map((sample) => {
    const frame = b04PhysicalFrame(sample[participant], scaleFactor);
    return `${frame.x}/${frame.y}/${frame.w}/${frame.h}`;
  })).size;
}

function inspectB04Transition(transition, index, coordinateSpace, failures) {
  const path = `transitions[${index}]`;
  if (!requireExactKeys(transition, B04_TRANSITION_KEYS, path, failures)) return;
  if (!B04_DIRECTIONS.includes(transition.direction)) {
    failures.push(`${path}.direction=known/${displayValue(transition.direction)}`);
  }
  if (!hasText(transition.targetViewId)) {
    failures.push(`${path}.targetViewId=non-empty/${displayValue(transition.targetViewId)}`);
  }
  if (transition.motionMode !== "snap" && transition.motionMode !== "glide") {
    failures.push(`${path}.motionMode=snap|glide/${displayValue(transition.motionMode)}`);
  }

  let journalVerdict = { ok: false, errors: ["journal=invalid"], transaction: null };
  if (requireExactKeys(transition.journal, ["afterSequence", "entries"], `${path}.journal`, failures)) {
    if (!Number.isInteger(transition.journal.afterSequence) || transition.journal.afterSequence < 0) {
      failures.push(`${path}.journal.afterSequence=integer>=0/${displayValue(transition.journal.afterSequence)}`);
    }
    if (!Array.isArray(transition.journal.entries)) {
      failures.push(`${path}.journal.entries=array/${displayValue(transition.journal.entries)}`);
    } else {
      transition.journal.entries.forEach((entry, entryIndex) => {
        const entryPath = `${path}.journal.entries[${entryIndex}]`;
        if (!requireExactKeys(entry, B04_JOURNAL_ENTRY_KEYS, entryPath, failures)) return;
        if (!Array.isArray(entry.moves)) {
          failures.push(`${entryPath}.moves=array/${displayValue(entry.moves)}`);
        } else {
          entry.moves.forEach((move, moveIndex) => {
            requireExactKeys(move, ["viewId", "dx"], `${entryPath}.moves[${moveIndex}]`, failures);
          });
        }
      });
    }
    journalVerdict = layoutTransactionVerdict(transition.journal.entries, {
      afterSequence: transition.journal.afterSequence,
      expectedMode: transition.motionMode,
      candidateViewIds: [transition.targetViewId],
    });
    failures.push(...journalVerdict.errors.map((error) => `${path}.journal:${error}`));
  }

  if (!Array.isArray(transition.samples) || transition.samples.length < 2) {
    failures.push(`${path}.samples=at-least-2/${displayValue(transition.samples?.length)}`);
    return;
  }
  let traceStructurallyValid = true;
  transition.samples.forEach((sample, sampleIndex) => {
    const samplePath = `${path}.samples[${sampleIndex}]`;
    if (!requireExactKeys(sample, B04_SAMPLE_KEYS, samplePath, failures)) {
      traceStructurallyValid = false;
      return;
    }
    for (const participant of ["rail", "pane", "slot", "renderer", "surface"]) {
      if (!inspectB04Participant(
        sample[participant], `${samplePath}.${participant}`, transition.targetViewId, failures,
      )) traceStructurallyValid = false;
    }
    if (!Number.isInteger(sample.sequence) || sample.sequence !== sampleIndex) {
      failures.push(`${samplePath}.sequence=${sampleIndex}/${displayValue(sample.sequence)}`);
    }
    if (!Number.isFinite(sample.sampledAtUnixMs)) {
      failures.push(`${samplePath}.sampledAtUnixMs=finite/${displayValue(sample.sampledAtUnixMs)}`);
    }
    if (sampleIndex > 0
        && !(sample.sampledAtUnixMs > transition.samples[sampleIndex - 1]?.sampledAtUnixMs)) {
      failures.push(`${samplePath}.sampledAtUnixMs=monotonic/${displayValue(sample.sampledAtUnixMs)}`);
    }
  });
  if (!traceStructurallyValid) return;

  const first = transition.samples[0];
  const last = transition.samples.at(-1);
  if (first.phase !== "prepared") failures.push(`${path}.samples[0].phase=prepared/${displayValue(first.phase)}`);
  const journalTransactionId = journalVerdict.transaction?.transactionId;
  for (const [sampleIndex, sample] of transition.samples.entries()) {
    if (sample.transactionId !== journalTransactionId) {
      failures.push(`${path}.samples[${sampleIndex}].transactionId=${displayValue(journalTransactionId)}/${displayValue(sample.transactionId)}`);
    }
    for (const participant of ["rail", "pane", "slot", "renderer", "surface"]) {
      if (sample[participant]?.id !== first[participant]?.id) {
        failures.push(`${path}.samples[${sampleIndex}].${participant}.id=stable/${displayValue(sample[participant]?.id)}`);
      }
    }
  }

  // 좌표를 대조하기 전에 표본이 그 거래를 실제로 관측했는지 본다. `...UnixMs`라는 같은
  // 이름은 같은 epoch를 뜻하지 않으므로, 거래 장부가 소유한 구간과 겹치지 않는 표본은
  // 좌표가 맞아도 같은 거래의 증거가 아니다. glide는 선언한 표시 구간을, snap은
  // prepared~closed를 그 거래의 관측 구간으로 쓴다.
  const transaction = journalVerdict.transaction;
  const glideWindow = Number.isFinite(transaction?.startAtUnixMs)
    && Number.isFinite(transaction?.durationMs);
  const windowStartAtUnixMs = glideWindow
    ? transaction.startAtUnixMs
    : transaction?.preparedAtUnixMs;
  const windowEndAtUnixMs = glideWindow
    ? transaction.startAtUnixMs + transaction.durationMs
    : transaction?.closedAtUnixMs;
  const sampleTimes = transition.samples
    .map((sample) => Number(sample.sampledAtUnixMs))
    .filter((value) => Number.isFinite(value));
  // 장부 epoch 자체의 유한성은 layout 거래 판정이 소유한다. 여기서 다시 세지 않는다.
  if (Number.isFinite(windowStartAtUnixMs) && Number.isFinite(windowEndAtUnixMs)
      && sampleTimes.length > 0) {
    const observation = compositionObservationWindowVerdict(
      { startAtUnixMs: windowStartAtUnixMs, endAtUnixMs: windowEndAtUnixMs },
      [{
        producer: "presentation",
        firstSampledAtUnixMs: Math.min(...sampleTimes),
        lastSampledAtUnixMs: Math.max(...sampleTimes),
      }],
    );
    failures.push(...observation.errors.map((error) => `${path}.samples:${error}`));
  }

  const scaleFactor = Number(coordinateSpace?.scaleFactor);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;
  const composition = compositionTransactionVerdict(transition.samples.map((sample) => ({
    transactionId: sample.transactionId,
    sequence: sample.sequence,
    phase: sample.phase,
    sampledAtUnixMs: sample.sampledAtUnixMs,
    coordinateSpace,
    slot: { id: sample.slot.id, frame: sample.slot.frame },
    renderer: { id: sample.renderer.id, frame: sample.renderer.frame },
    surface: { id: sample.surface.id, frame: sample.surface.frame },
  })), { motionMode: transition.motionMode });
  failures.push(...composition.errors.map((error) => `${path}.composition:${error}`));

  if (transition.motionMode === "glide") {
    if (!requireExactKeys(transition.timeline, B04_TIMELINE_KEYS, `${path}.timeline`, failures)) {
      return;
    }
    for (const participant of ["slot", "renderer", "surface"]) {
      const timelineSamples = transition.timeline[participant];
      if (!Array.isArray(timelineSamples)) {
        failures.push(`${path}.timeline.${participant}=array/${displayValue(timelineSamples)}`);
        continue;
      }
      timelineSamples.forEach((sample, sampleIndex) => {
        const samplePath = `${path}.timeline.${participant}[${sampleIndex}]`;
        if (!requireExactKeys(sample, B04_TIMELINE_SAMPLE_KEYS, samplePath, failures)) return;
        inspectFiniteRect(sample.frame, `${samplePath}.frame`, failures);
      });
    }
    inspectFiniteRect(transition.timeline.from, `${path}.timeline.from`, failures);
    inspectFiniteRect(transition.timeline.to, `${path}.timeline.to`, failures);
    const timelineVerdict = compositionTimelineVerdict({
      ...transition.timeline,
      coordinateSpace,
    });
    failures.push(...timelineVerdict.errors.map((error) => `${path}.timeline:${error}`));
  } else if (transition.timeline !== null) {
    failures.push(`${path}.timeline=null/${displayValue(transition.timeline)}`);
  }

  const firstRelative = b04RelativeSlotSignature(first, scaleFactor);
  transition.samples.forEach((sample, sampleIndex) => {
    const relative = b04RelativeSlotSignature(sample, scaleFactor);
    if (relative !== firstRelative) {
      failures.push(`${path}.samples[${sampleIndex}].pane-slot-relative=${firstRelative}/${relative}`);
    }
  });
  if (transition.motionMode === "snap") {
    for (const participant of ["rail", "pane"]) {
      const distinct = distinctB04Frames(transition.samples, participant, scaleFactor);
      if (distinct > 2) failures.push(`${path}.${participant}.snap-distinct=${distinct}/2`);
    }
  }
  const move = journalVerdict.transaction?.moves?.find(({ viewId }) => viewId === transition.targetViewId);
  if (move && first?.pane?.frame && last?.pane?.frame) {
    const observedDx = first.pane.frame.x - last.pane.frame.x;
    if (Math.abs(Number(move.dx) - observedDx) > 1e-6) {
      failures.push(`${path}.pane-dx=${displayValue(move.dx)}/${displayValue(observedDx)}`);
    }
    if (Math.abs(observedDx) < 0.5) failures.push(`${path}.pane-dx=non-zero/${displayValue(observedDx)}`);
  }
}

/** FLOW는 화면 녹화가 아니라 공개 거래 장부와 같은 tick의 유한 DOM/surface trace로 판정한다. */
export function judgeB04MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "coordinateSpace", "transitions"], "evidence", failures)) {
    return finishMachineVerdict("B04", failures, "B04:unreachable");
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (requireExactKeys(value.coordinateSpace, ["logical", "scaleFactor"], "coordinateSpace", failures)) {
    if (value.coordinateSpace.logical !== "css-px") {
      failures.push(`coordinateSpace.logical=css-px/${displayValue(value.coordinateSpace.logical)}`);
    }
    if (!Number.isFinite(value.coordinateSpace.scaleFactor) || value.coordinateSpace.scaleFactor <= 0) {
      failures.push(`coordinateSpace.scaleFactor=finite>0/${displayValue(value.coordinateSpace.scaleFactor)}`);
    }
  }
  if (!Array.isArray(value.transitions) || value.transitions.length < 2) {
    failures.push(`transitions=at-least-2/${displayValue(value.transitions?.length)}`);
  } else {
    value.transitions.forEach((transition, index) => {
      inspectB04Transition(transition, index, value.coordinateSpace, failures);
    });
    const directions = new Set(value.transitions.map((transition) => transition?.direction));
    for (const direction of B04_DIRECTIONS) {
      if (!directions.has(direction)) failures.push(`direction=${direction}=missing`);
    }
  }
  return finishMachineVerdict(
    "B04",
    failures,
    `${value.engine}/B04:directions=2;layout-transaction+finite-composition-trace=atomic`,
  );
}

// B11이 요구하는 페이지 축의 정본. probe와 mapper는 이 목록에서 파생한다 —
// 손으로 다시 나열하면 반드시 하나가 빠진다.
export const B11_PAGE_KEYS = Object.freeze([
  "scrollX",
  "scrollY",
  "viewportWidth",
  "viewportHeight",
  "documentWidth",
  "documentHeight",
]);

function inspectB11Page(page, path, failures) {
  if (!requireExactKeys(page, B11_PAGE_KEYS, path, failures)) return;
  for (const field of B11_PAGE_KEYS) {
    const value = page[field];
    const positive = !field.startsWith("scroll");
    if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
      failures.push(`${path}.${field}=${positive ? "finite>0" : "finite>=0"}/${displayValue(value)}`);
    }
  }
}

/**
 * B11 accepts only structured page/receipt numbers. Strict keys keep PNG-derived
 * markers, decoded image dimensions and human visual verdicts out of machine input.
 */
export function judgeB11MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "tabs"], "evidence", failures)) {
    return finishMachineVerdict("B11", failures, "B11:unreachable");
  }
  if (!requireEvidenceEnvelope(value, failures)) {
    return finishMachineVerdict("B11", failures, "B11:unreachable");
  }
  if (value.tabs.length !== 2) failures.push(`tabs.length=2/${value.tabs.length}`);
  const seen = new Set();
  value.tabs.forEach((tab, index) => {
    const path = `tabs[${index}]`;
    if (!requireExactKeys(tab, ["viewId", "wheel", "capture"], path, failures)) return;
    const viewId = requireUniqueViewId(tab, path, seen, failures);

    if (requireExactKeys(tab.wheel, ["positions"], `${path}.wheel`, failures)) {
      const positions = tab.wheel.positions;
      if (!Array.isArray(positions) || positions.length !== 3
        || positions[0] !== 0 || positions[1] !== 480 || positions[2] !== 0) {
        failures.push(`${path}.wheel.positions=0,480,0/${displayValue(positions)}`);
      }
    }

    if (!requireExactKeys(tab.capture, ["before", "receipt", "after"], `${path}.capture`, failures)) return;
    inspectB11Page(tab.capture.before, `${path}.capture.before`, failures);
    inspectB11Page(tab.capture.after, `${path}.capture.after`, failures);
    if (isRecord(tab.capture.before) && isRecord(tab.capture.after)) {
      for (const field of B11_PAGE_KEYS) {
        if (tab.capture.before[field] !== tab.capture.after[field]) {
          failures.push(`${path}.capture.${field}=preserved/${displayValue({
            before: tab.capture.before[field],
            after: tab.capture.after[field],
          })}`);
        }
      }
      if (tab.capture.before.scrollY !== 0) {
        failures.push(`${path}.capture.before.scrollY=0/${displayValue(tab.capture.before.scrollY)}`);
      }
    }

    const receiptPath = `${path}.capture.receipt`;
    const receipt = tab.capture.receipt;
    if (!requireExactKeys(receipt, [
      "requestedViewId",
      "returnedViewId",
      "requestedPath",
      "returnedPath",
      "reportedBytes",
      "fileBytes",
      "width",
      "docHeight",
    ], receiptPath, failures)) return;
    if (receipt.requestedViewId !== viewId || receipt.returnedViewId !== viewId) {
      failures.push(`${receiptPath}.viewId=${displayValue(viewId)}/${displayValue({
        requested: receipt.requestedViewId,
        returned: receipt.returnedViewId,
      })}`);
    }
    if (!hasText(receipt.requestedPath) || receipt.returnedPath !== receipt.requestedPath) {
      failures.push(`${receiptPath}.path=exact/${displayValue({
        requested: receipt.requestedPath,
        returned: receipt.returnedPath,
      })}`);
    }
    for (const field of ["reportedBytes", "fileBytes", "width", "docHeight"]) {
      if (!Number.isInteger(receipt[field]) || receipt[field] <= 0) {
        failures.push(`${receiptPath}.${field}=integer>0/${displayValue(receipt[field])}`);
      }
    }
    if (receipt.reportedBytes !== receipt.fileBytes) {
      failures.push(`${receiptPath}.bytes=exact/${displayValue({
        reported: receipt.reportedBytes,
        file: receipt.fileBytes,
      })}`);
    }
    if (isRecord(tab.capture.before)) {
      if (receipt.width !== tab.capture.before.documentWidth) {
        failures.push(`${receiptPath}.width=documentWidth/${displayValue({
          receipt: receipt.width,
          document: tab.capture.before.documentWidth,
        })}`);
      }
      if (receipt.docHeight !== tab.capture.before.documentHeight) {
        failures.push(`${receiptPath}.docHeight=documentHeight/${displayValue({
          receipt: receipt.docHeight,
          document: tab.capture.before.documentHeight,
        })}`);
      }
      if (!(tab.capture.before.documentHeight > tab.capture.before.viewportHeight + 960)) {
        failures.push(`${path}.capture.document=scrollable/${displayValue({
          documentHeight: tab.capture.before.documentHeight,
          viewportHeight: tab.capture.before.viewportHeight,
        })}`);
      }
    }
  });
  return finishMachineVerdict(
    "B11",
    failures,
    `${value.engine}/B11:tabs=2;wheel=0,480,0;explicit-full-capture+page-state=exact`,
  );
}

const machineEvidenceJudges = new Map([
  ["B01", { judgeId: "B01-machine-v2", judge: judgeB01MachineEvidence }],
  ["B02", { judgeId: "B02-machine-v1", judge: judgeB02MachineEvidence }],
  ["B03", { judgeId: "B03-machine-v1", judge: judgeB03MachineEvidence }],
  ["B04", { judgeId: "B04-machine-v1", judge: judgeB04MachineEvidence }],
  ["B05", { judgeId: "B05-machine-v1", judge: judgeB05MachineEvidence }],
  ["B06", { judgeId: "B06-machine-v1", judge: judgeB06MachineEvidence }],
  ["B07", { judgeId: "B07-machine-v1", judge: judgeB07MachineEvidence }],
  ["B08", { judgeId: "B08-machine-v1", judge: judgeB08MachineEvidence }],
  ["B09", { judgeId: "B09-machine-v1", judge: judgeB09MachineEvidence }],
  ["B10", { judgeId: "B10-machine-v1", judge: judgeB10MachineEvidence }],
  ["B11", { judgeId: "B11-machine-v1", judge: judgeB11MachineEvidence }],
  ["B12", { judgeId: "B12-machine-v1", judge: judgeB12MachineEvidence }],
]);

function mismatchedEngineVerdict(gate, expected, actual) {
  return {
    status: "red",
    evidence: [`${gate}:engine=${displayValue(expected)}/${displayValue(actual)}`],
    reason: `${gate} machine evidence belongs to a different engine`,
  };
}

function copyMachineEvidence(value) {
  if (value == null) return null;
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`machine evidence must be JSON data: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (encoded == null) throw new TypeError("machine evidence must be JSON data");
  return JSON.parse(encoded);
}

function judgeMachineEvidence(entry, gate, engine, evidence, identity) {
  return evidence != null && evidence?.engine !== engine
    ? mismatchedEngineVerdict(gate, engine, evidence?.engine)
    : entry.judge(evidence, identity);
}

export function judgeBrowserMachineGateEvidence(request) {
  if (!isRecord(request)) throw new TypeError("machine judge request must be a record");
  const allowedKeys = new Set(["framework", "platform", "buildId", "runId", "engine", "gate", "evidence"]);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("machine judge request accepts only framework, platform, buildId, runId, engine, gate, evidence");
  }
  const identity = normalizeReportIdentity({
    framework: request.framework,
    platform: request.platform,
    buildId: request.buildId,
    runId: request.runId,
  });
  requireEngine(request.engine);
  requireGate(request.gate);
  const entry = machineEvidenceJudges.get(request.gate);
  if (!entry) throw new TypeError(`machine evidence judge is unavailable for ${request.gate}`);

  const machineEvidence = copyMachineEvidence(request.evidence);
  const verdict = judgeMachineEvidence(
    entry,
    request.gate,
    request.engine,
    machineEvidence,
    identity,
  );
  const receipt = deepFreeze({
    schemaVersion: JUDGE_RECEIPT_SCHEMA_VERSION,
    kind: "browser-machine-judge-receipt",
    judgeId: entry.judgeId,
    ...identity,
    engine: request.engine,
    gate: request.gate,
    machineEvidence,
    status: verdict.status,
    evidence: [...verdict.evidence],
    reason: verdict.reason,
  });
  return receipt;
}

function requireMatchingJudgeReceipt(receipt, report, engine, gate) {
  if (!isRecord(receipt)) throw new TypeError("green requires a judgeReceipt record");
  const receiptKeys = Object.keys(receipt).sort().join(",");
  if (receiptKeys !== [
    "buildId",
    "engine",
    "evidence",
    "framework",
    "gate",
    "judgeId",
    "kind",
    "machineEvidence",
    "platform",
    "reason",
    "runId",
    "schemaVersion",
    "status",
  ].sort().join(",")) {
    throw new TypeError("judgeReceipt has an invalid schema");
  }
  if (receipt.schemaVersion !== JUDGE_RECEIPT_SCHEMA_VERSION
      || receipt.kind !== "browser-machine-judge-receipt") {
    throw new TypeError("judgeReceipt has an invalid schema");
  }
  for (const field of ["framework", "platform", "buildId", "runId"]) {
    if (receipt[field] !== report.identity[field]) {
      throw new TypeError(`judgeReceipt ${field} does not match report identity`);
    }
  }
  if (receipt.engine !== engine) throw new TypeError("judgeReceipt engine does not match target engine");
  if (receipt.gate !== gate) throw new TypeError("judgeReceipt gate does not match target gate");
  const entry = machineEvidenceJudges.get(gate);
  if (!entry || receipt.judgeId !== entry.judgeId) {
    throw new TypeError("judgeReceipt judgeId does not match the gate judge");
  }
  const verdict = judgeMachineEvidence(
    entry,
    gate,
    engine,
    receipt.machineEvidence,
    report.identity,
  );
  const receiptEvidence = requireStringList(receipt.evidence, "judgeReceipt.evidence");
  const receiptReason = requireOptionalText(receipt.reason, "judgeReceipt.reason");
  if (receipt.status !== verdict.status
      || receiptReason !== verdict.reason
      || receiptEvidence.length !== verdict.evidence.length
      || receiptEvidence.some((item, index) => item !== verdict.evidence[index])) {
    throw new TypeError("judgeReceipt verdict does not match machine evidence");
  }
  return receipt;
}

function requireReport(report) {
  if (!report || typeof report !== "object" || report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new TypeError(`browser gate report schemaVersion must be ${REPORT_SCHEMA_VERSION}`);
  }
  const identity = normalizeReportIdentity(report.identity);
  if (!report.engines || Object.keys(report.engines).length !== BROWSER_ACCEPTANCE_ENGINES.length) {
    throw new TypeError("browser gate report must contain exactly three engines");
  }
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    const gates = report.engines[engine];
    if (!gates || Object.keys(gates).length !== BROWSER_ACCEPTANCE_GATES.length) {
      throw new TypeError(`${engine} must contain exactly twelve gates`);
    }
    for (const { id } of BROWSER_ACCEPTANCE_GATES) {
      const cell = gates[id];
      const applicable = gateIsApplicable(identity, id);
      if (!cell || !machineStatusSet.has(cell.machine?.status)) {
        throw new TypeError(`${engine}/${id} has an invalid machine status`);
      }
      if (Object.keys(cell.machine).sort().join(",") !== "evidence,judgeReceipt,reason,status") {
        throw new TypeError(`${engine}/${id}.machine has an invalid schema`);
      }
      requireStringList(cell.machine.evidence, `${engine}/${id}.machine.evidence`);
      requireOptionalText(cell.machine.reason, `${engine}/${id}.machine.reason`);
      const receipt = cell.machine.judgeReceipt;
      if (!applicable) {
        if (cell.machine.status !== "not-applicable"
            || cell.machine.evidence.length !== 0
            || cell.machine.reason !== B12_NOT_APPLICABLE_REASON
            || receipt !== null) {
          throw new TypeError(`${engine}/${id}.machine must preserve static not-applicable status`);
        }
      } else if (cell.machine.status === "not-applicable") {
        throw new TypeError(`${engine}/${id}.machine is applicable for this report identity`);
      }
      if (applicable && cell.machine.status === "green" && receipt == null) {
        throw new TypeError(`${engine}/${id}.machine green requires judgeReceipt`);
      }
      if (receipt != null) {
        requireMatchingJudgeReceipt(receipt, { identity }, engine, id);
        if (receipt.status !== cell.machine.status) {
          throw new TypeError(`${engine}/${id}.machine status does not match judgeReceipt`);
        }
        if (receipt.reason !== cell.machine.reason
            || receipt.evidence.length !== cell.machine.evidence.length
            || receipt.evidence.some((item, index) => item !== cell.machine.evidence[index])) {
          throw new TypeError(`${engine}/${id}.machine verdict does not match judgeReceipt`);
        }
      }
      if (applicable && (cell.machine.status === "green" || cell.machine.status === "red")
          && cell.machine.evidence.length === 0) {
        throw new TypeError(`${engine}/${id}.machine.evidence must not be empty`);
      }
      if (applicable && cell.machine.status === "blocked" && cell.machine.reason == null) {
        throw new TypeError(`${engine}/${id}.machine.reason is required for blocked`);
      }
      if (applicable && cell.machine.status === "not-run"
          && (cell.machine.evidence.length > 0 || cell.machine.reason != null)) {
        throw new TypeError(`${engine}/${id}.machine not-run cannot carry evidence or reason`);
      }
      if (!visualStatusSet.has(cell.visualReview?.status)) {
        throw new TypeError(`${engine}/${id} has an invalid visualReview status`);
      }
      if (Object.keys(cell.visualReview).sort().join(",") !== "artifacts,notes,status") {
        throw new TypeError(`${engine}/${id}.visualReview has an invalid schema`);
      }
      requireStringList(cell.visualReview.artifacts, `${engine}/${id}.visualReview.artifacts`);
      requireOptionalText(cell.visualReview.notes, `${engine}/${id}.visualReview.notes`);
      if (!applicable) {
        if (cell.visualReview.status !== "not-applicable"
            || cell.visualReview.artifacts.length !== 0
            || cell.visualReview.notes !== B12_NOT_APPLICABLE_REASON) {
          throw new TypeError(`${engine}/${id}.visualReview must preserve static not-applicable status`);
        }
      } else if (cell.visualReview.status === "not-applicable") {
        throw new TypeError(`${engine}/${id}.visualReview is applicable for this report identity`);
      }
      if (applicable && cell.visualReview.status !== "pending" && cell.visualReview.artifacts.length === 0) {
        throw new TypeError(`${engine}/${id}.visualReview.artifacts must not be empty`);
      }
    }
  }
  return report;
}

function replaceCell(report, engine, gate, replace) {
  return deepFreeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    identity: report.identity,
    engines: Object.fromEntries(BROWSER_ACCEPTANCE_ENGINES.map((engineName) => [
      engineName,
      Object.fromEntries(BROWSER_ACCEPTANCE_GATES.map(({ id }) => [
        id,
        engineName === engine && id === gate ? replace(report.engines[engineName][id]) : report.engines[engineName][id],
      ])),
    ])),
  });
}

export function createBrowserGateReport(identity) {
  const normalizedIdentity = normalizeReportIdentity(identity);
  return deepFreeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    identity: normalizedIdentity,
    engines: Object.fromEntries(BROWSER_ACCEPTANCE_ENGINES.map((engine) => [
      engine,
      Object.fromEntries(BROWSER_ACCEPTANCE_GATES.map(({ id }) => [
        id,
        initialCell(normalizedIdentity, id),
      ])),
    ])),
  });
}

export function setMachineGateStatus(report, update) {
  requireReport(report);
  if (!isRecord(update)) throw new TypeError("machine gate update must be a record");
  const receiptUpdate = Object.hasOwn(update, "judgeReceipt");
  const allowedUpdateKeys = new Set(receiptUpdate
    ? ["engine", "gate", "judgeReceipt"]
    : ["engine", "gate", "status", "evidence", "reason"]);
  if (Object.keys(update).some((key) => !allowedUpdateKeys.has(key))) {
    throw new TypeError(receiptUpdate
      ? "judge receipt update accepts only engine, gate, judgeReceipt"
      : "machine status update accepts only engine, gate, status, evidence, reason");
  }
  const { engine, gate } = update;
  requireEngine(engine);
  requireGate(gate);
  if (!gateIsApplicable(report.identity, gate)) {
    throw new TypeError(`${engine}/${gate} is not applicable for this report identity`);
  }
  if (receiptUpdate) {
    if (Object.hasOwn(update, "status") || Object.hasOwn(update, "evidence") || Object.hasOwn(update, "reason")) {
      throw new TypeError("judgeReceipt supplies status, evidence, and reason");
    }
    const receipt = requireMatchingJudgeReceipt(update.judgeReceipt, report, engine, gate);
    const storedReceipt = {
      schemaVersion: receipt.schemaVersion,
      kind: receipt.kind,
      judgeId: receipt.judgeId,
      framework: receipt.framework,
      platform: receipt.platform,
      buildId: receipt.buildId,
      runId: receipt.runId,
      engine: receipt.engine,
      gate: receipt.gate,
      machineEvidence: copyMachineEvidence(receipt.machineEvidence),
      status: receipt.status,
      evidence: [...receipt.evidence],
      reason: receipt.reason,
    };
    return replaceCell(report, engine, gate, (cell) => ({
      ...cell,
      machine: {
        status: receipt.status,
        evidence: [...receipt.evidence],
        reason: receipt.reason,
        judgeReceipt: storedReceipt,
      },
    }));
  }

  const status = update.status;
  if (!machineStatusSet.has(status)) throw new TypeError(`unknown machine gate status: ${status}`);
  if (status === "not-applicable") {
    throw new TypeError("not-applicable is derived from report identity");
  }
  if (status === "green") throw new TypeError("green requires a matching judgeReceipt");
  const normalizedEvidence = requireStringList(update.evidence ?? [], "evidence", {
    nonEmpty: status === "red",
  });
  const normalizedReason = requireOptionalText(update.reason ?? null, "reason");
  if (status === "blocked" && normalizedReason == null) {
    throw new TypeError("reason is required for blocked");
  }
  if (status === "not-run" && (normalizedEvidence.length > 0 || normalizedReason != null)) {
    throw new TypeError("not-run cannot carry evidence or reason");
  }
  return replaceCell(report, engine, gate, (cell) => ({
    ...cell,
    machine: {
      status,
      evidence: normalizedEvidence,
      reason: normalizedReason,
      judgeReceipt: null,
    },
  }));
}

export function setVisualReviewStatus(report, {
  engine,
  gate,
  status,
  artifacts = [],
  notes = null,
}) {
  requireReport(report);
  requireEngine(engine);
  requireGate(gate);
  if (!gateIsApplicable(report.identity, gate)) {
    throw new TypeError(`${engine}/${gate} is not applicable for this report identity`);
  }
  if (!visualStatusSet.has(status)) throw new TypeError(`unknown visualReview status: ${status}`);
  if (status === "not-applicable") {
    throw new TypeError("not-applicable is derived from report identity");
  }
  const normalizedArtifacts = requireStringList(artifacts, "artifacts", {
    nonEmpty: status !== "pending",
  });
  const normalizedNotes = requireOptionalText(notes, "notes");
  return replaceCell(report, engine, gate, (cell) => ({
    ...cell,
    visualReview: { status, artifacts: normalizedArtifacts, notes: normalizedNotes },
  }));
}

export function machineGateSummary(report) {
  requireReport(report);
  const counts = { "not-applicable": 0, "not-run": 0, blocked: 0, red: 0, green: 0 };
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    for (const { id } of BROWSER_ACCEPTANCE_GATES) counts[report.engines[engine][id].machine.status] += 1;
  }
  const status = counts.red > 0 ? "red"
    : counts.blocked > 0 ? "blocked"
      : counts["not-run"] > 0 ? "not-run"
        : "green";
  const total = BROWSER_ACCEPTANCE_ENGINES.length * BROWSER_ACCEPTANCE_GATES.length;
  return { status, total, required: total - counts["not-applicable"], counts };
}

export function visualReviewSummary(report) {
  requireReport(report);
  const counts = { "not-applicable": 0, pending: 0, passed: 0, failed: 0 };
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    for (const { id } of BROWSER_ACCEPTANCE_GATES) counts[report.engines[engine][id].visualReview.status] += 1;
  }
  const status = counts.failed > 0 ? "failed" : counts.pending > 0 ? "pending" : "passed";
  const total = BROWSER_ACCEPTANCE_ENGINES.length * BROWSER_ACCEPTANCE_GATES.length;
  return { status, total, required: total - counts["not-applicable"], counts };
}

export function serializeBrowserGateReport(report) {
  requireReport(report);
  return `${JSON.stringify({
    schemaVersion: REPORT_SCHEMA_VERSION,
    identity: report.identity,
    catalog: BROWSER_ACCEPTANCE_GATES,
    engines: report.engines,
    summary: {
      machine: machineGateSummary(report),
      visualReview: visualReviewSummary(report),
    },
  }, null, 2)}\n`;
}
