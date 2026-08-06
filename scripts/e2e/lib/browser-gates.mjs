export const BROWSER_ACCEPTANCE_ENGINES = Object.freeze([
  "browser",
  "browser-chromium",
  "browser-chromium-offscreen",
]);

export const MACHINE_GATE_STATUSES = Object.freeze([
  "not-run",
  "blocked",
  "red",
  "green",
]);

export const VISUAL_REVIEW_STATUSES = Object.freeze([
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
    contract: "traffic lights 3개와 hole/backing 3개가 1:1이고 상하 중앙 및 hostile resize 정합을 유지한다.",
  },
]);

const engineSet = new Set(BROWSER_ACCEPTANCE_ENGINES);
const gateSet = new Set(BROWSER_ACCEPTANCE_GATES.map(({ id }) => id));
const machineStatusSet = new Set(MACHINE_GATE_STATUSES);
const visualStatusSet = new Set(VISUAL_REVIEW_STATUSES);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function initialCell() {
  return {
    machine: { status: "not-run", evidence: [], reason: null },
    visualReview: { status: "pending", artifacts: [], notes: null },
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

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function displayValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function notRunVerdict() {
  return { status: "not-run", evidence: [], reason: null };
}

function finishMachineVerdict(gate, failures, greenEvidence) {
  if (failures.length > 0) {
    const unique = [...new Set(failures)];
    return {
      status: "red",
      evidence: unique.map((failure) => `${gate}:${failure}`),
      reason: `${gate} machine contract failed (${unique.length})`,
    };
  }
  return { status: "green", evidence: [greenEvidence], reason: null };
}

function requireEvidenceEnvelope(value, failures) {
  if (!isRecord(value)) {
    failures.push(`evidence=record/${displayValue(value)}`);
    return false;
  }
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) {
    failures.push(`tabs=non-empty/${displayValue(value.tabs)}`);
    return false;
  }
  return true;
}

function requireExactKeys(value, keys, path, failures) {
  if (!isRecord(value)) {
    failures.push(`${path}=record/${displayValue(value)}`);
    return false;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) failures.push(`${path}.${key}=not-machine-schema`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) failures.push(`${path}.${key}=missing`);
  }
  return true;
}

function requireUniqueViewId(tab, path, seen, failures) {
  if (!hasText(tab?.viewId)) {
    failures.push(`${path}.viewId=non-empty/${displayValue(tab?.viewId)}`);
    return null;
  }
  if (seen.has(tab.viewId)) failures.push(`${path}.viewId=unique/${displayValue(tab.viewId)}`);
  seen.add(tab.viewId);
  return tab.viewId;
}

/**
 * B01 machine evidence is deliberately DOM/API based. A screenshot may accompany the
 * report through visualReview, but it cannot substitute for any value checked here.
 */
export function judgeB01MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireEvidenceEnvelope(value, failures)) {
    return finishMachineVerdict("B01", failures, "B01:unreachable");
  }
  if (value.tabs.length !== 2) failures.push(`tabs.length=2/${value.tabs.length}`);
  const seen = new Set();
  value.tabs.forEach((tab, index) => {
    const path = `tabs[${index}]`;
    if (!isRecord(tab)) {
      failures.push(`${path}=record/${displayValue(tab)}`);
      return;
    }
    const viewId = requireUniqueViewId(tab, path, seen, failures);
    if (!hasText(tab.expectedUrl)) failures.push(`${path}.expectedUrl=non-empty/${displayValue(tab.expectedUrl)}`);
    if (tab.mounted !== true) failures.push(`${path}.mounted=true/${displayValue(tab.mounted)}`);

    if (!isRecord(tab.toolbarAddress)) {
      failures.push(`${path}.toolbarAddress=record/${displayValue(tab.toolbarAddress)}`);
    } else {
      if (tab.toolbarAddress.dataNode !== "urlbar") {
        failures.push(`${path}.toolbarAddress.dataNode=urlbar/${displayValue(tab.toolbarAddress.dataNode)}`);
      }
      if (tab.toolbarAddress.value !== tab.expectedUrl) {
        failures.push(`${path}.toolbarAddress.value=expectedUrl/${displayValue(tab.toolbarAddress.value)}`);
      }
    }

    if (!isRecord(tab.pageIdentity)) {
      failures.push(`${path}.pageIdentity=record/${displayValue(tab.pageIdentity)}`);
    } else {
      if (tab.pageIdentity.viewId !== viewId) {
        failures.push(`${path}.pageIdentity.viewId=${displayValue(viewId)}/${displayValue(tab.pageIdentity.viewId)}`);
      }
      if (tab.pageIdentity.url !== tab.expectedUrl) {
        failures.push(`${path}.pageIdentity.url=expectedUrl/${displayValue(tab.pageIdentity.url)}`);
      }
    }

    if (!isRecord(tab.commandReceipt)) {
      failures.push(`${path}.commandReceipt=record/${displayValue(tab.commandReceipt)}`);
    } else if (tab.commandReceipt.requestedViewId !== viewId
      || tab.commandReceipt.returnedViewId !== viewId) {
      failures.push(`${path}.commandReceipt.viewId=${displayValue(viewId)}/${displayValue({
        requested: tab.commandReceipt.requestedViewId,
        returned: tab.commandReceipt.returnedViewId,
      })}`);
    }
  });
  return finishMachineVerdict(
    "B01",
    failures,
    `${value.engine}/B01:tabs=${value.tabs.length};mounted+urlbar+page+explicit-view=exact`,
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

const B11_PAGE_KEYS = Object.freeze([
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

export function judgeBrowserMachineGateEvidence(gate, value) {
  if (gate === "B01") return judgeB01MachineEvidence(value);
  if (gate === "B02") return judgeB02MachineEvidence(value);
  if (gate === "B11") return judgeB11MachineEvidence(value);
  throw new TypeError("machine evidence judge is available for B01, B02, B11");
}

function requireReport(report) {
  if (!report || typeof report !== "object" || report.schemaVersion !== 1) {
    throw new TypeError("browser gate report schemaVersion must be 1");
  }
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
      if (!cell || !machineStatusSet.has(cell.machine?.status)) {
        throw new TypeError(`${engine}/${id} has an invalid machine status`);
      }
      requireStringList(cell.machine.evidence, `${engine}/${id}.machine.evidence`);
      requireOptionalText(cell.machine.reason, `${engine}/${id}.machine.reason`);
      if ((cell.machine.status === "green" || cell.machine.status === "red")
          && cell.machine.evidence.length === 0) {
        throw new TypeError(`${engine}/${id}.machine.evidence must not be empty`);
      }
      if (cell.machine.status === "blocked" && cell.machine.reason == null) {
        throw new TypeError(`${engine}/${id}.machine.reason is required for blocked`);
      }
      if (cell.machine.status === "not-run"
          && (cell.machine.evidence.length > 0 || cell.machine.reason != null)) {
        throw new TypeError(`${engine}/${id}.machine not-run cannot carry evidence or reason`);
      }
      if (!visualStatusSet.has(cell.visualReview?.status)) {
        throw new TypeError(`${engine}/${id} has an invalid visualReview status`);
      }
      requireStringList(cell.visualReview.artifacts, `${engine}/${id}.visualReview.artifacts`);
      requireOptionalText(cell.visualReview.notes, `${engine}/${id}.visualReview.notes`);
      if (cell.visualReview.status !== "pending" && cell.visualReview.artifacts.length === 0) {
        throw new TypeError(`${engine}/${id}.visualReview.artifacts must not be empty`);
      }
    }
  }
  return report;
}

function replaceCell(report, engine, gate, replace) {
  return deepFreeze({
    schemaVersion: 1,
    engines: Object.fromEntries(BROWSER_ACCEPTANCE_ENGINES.map((engineName) => [
      engineName,
      Object.fromEntries(BROWSER_ACCEPTANCE_GATES.map(({ id }) => [
        id,
        engineName === engine && id === gate ? replace(report.engines[engineName][id]) : report.engines[engineName][id],
      ])),
    ])),
  });
}

export function createBrowserGateReport() {
  return deepFreeze({
    schemaVersion: 1,
    engines: Object.fromEntries(BROWSER_ACCEPTANCE_ENGINES.map((engine) => [
      engine,
      Object.fromEntries(BROWSER_ACCEPTANCE_GATES.map(({ id }) => [id, initialCell()])),
    ])),
  });
}

export function setMachineGateStatus(report, {
  engine,
  gate,
  status,
  evidence = [],
  reason = null,
}) {
  requireReport(report);
  requireEngine(engine);
  requireGate(gate);
  if (!machineStatusSet.has(status)) throw new TypeError(`unknown machine gate status: ${status}`);
  const normalizedEvidence = requireStringList(evidence, "evidence", {
    nonEmpty: status === "green" || status === "red",
  });
  const normalizedReason = requireOptionalText(reason, "reason");
  if (status === "blocked" && normalizedReason == null) {
    throw new TypeError("reason is required for blocked");
  }
  if (status === "not-run" && (normalizedEvidence.length > 0 || normalizedReason != null)) {
    throw new TypeError("not-run cannot carry evidence or reason");
  }
  return replaceCell(report, engine, gate, (cell) => ({
    ...cell,
    machine: { status, evidence: normalizedEvidence, reason: normalizedReason },
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
  if (!visualStatusSet.has(status)) throw new TypeError(`unknown visualReview status: ${status}`);
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
  const counts = { "not-run": 0, blocked: 0, red: 0, green: 0 };
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    for (const { id } of BROWSER_ACCEPTANCE_GATES) counts[report.engines[engine][id].machine.status] += 1;
  }
  const status = counts.red > 0 ? "red"
    : counts.blocked > 0 ? "blocked"
      : counts["not-run"] > 0 ? "not-run"
        : "green";
  return { status, total: BROWSER_ACCEPTANCE_ENGINES.length * BROWSER_ACCEPTANCE_GATES.length, counts };
}

export function visualReviewSummary(report) {
  requireReport(report);
  const counts = { pending: 0, passed: 0, failed: 0 };
  for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
    for (const { id } of BROWSER_ACCEPTANCE_GATES) counts[report.engines[engine][id].visualReview.status] += 1;
  }
  const status = counts.failed > 0 ? "failed" : counts.pending > 0 ? "pending" : "passed";
  return { status, total: BROWSER_ACCEPTANCE_ENGINES.length * BROWSER_ACCEPTANCE_GATES.length, counts };
}

export function serializeBrowserGateReport(report) {
  requireReport(report);
  return `${JSON.stringify({
    schemaVersion: 1,
    catalog: BROWSER_ACCEPTANCE_GATES,
    engines: report.engines,
    summary: {
      machine: machineGateSummary(report),
      visualReview: visualReviewSummary(report),
    },
  }, null, 2)}\n`;
}
