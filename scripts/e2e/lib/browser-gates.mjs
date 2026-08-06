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
