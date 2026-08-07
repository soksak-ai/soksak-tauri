/**
 * 사람이 화면을 보고 남기는 판정. 정본 보고서의 `visualReview` 축을 소유한다.
 *
 * machine 판정은 실행이 끝나면 닫힌다. 시각 검토는 그 다음에, 사람이 캡처를 열어 본 뒤에야 선다.
 * 그래서 검토는 살아 있는 실행 안이 아니라 **저장된 정본 보고서 위에서** 이뤄져야 한다.
 * 그 자리가 없어서 `visualReview`는 36칸 전부 `pending`으로 남았고, "모든 UI gate의
 * visualReview가 passed"라는 최종 조건은 달성 가능한 경로 자체가 없었다.
 *
 * 자동으로 `passed`가 되는 길은 여기에 없다. 상태·본 artifact·메모는 전부 사람이 적어야 하고,
 * 적은 artifact가 실제로 있는지 확인한 뒤에만 기록된다. 못 본 것을 봤다고 적을 수 없어야 한다.
 */
import { serializeBrowserGateReport, setVisualReviewStatus } from "./browser-gates.mjs";

/** 사람이 남길 수 있는 판정. `pending`은 아직 안 본 것이고 `not-applicable`은 정체성이 정한다. */
export const HUMAN_VISUAL_REVIEW_STATUSES = Object.freeze(["passed", "failed"]);

/**
 * 직렬화된 정본을 다시 report 로 읽는다. `catalog`와 `summary`는 직렬화가 파생한 것이므로
 * 되읽을 때 버린다 — 두 번째 사본을 들고 다니면 곧 정본과 갈린다.
 */
export function parseBrowserGateReportText(text) {
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  if (!parsed || typeof parsed !== "object") {
    throw new TypeError("browser gate report는 객체여야 한다");
  }
  return {
    schemaVersion: parsed.schemaVersion,
    identity: parsed.identity,
    engines: parsed.engines,
  };
}

/**
 * 사람의 검토가 갖춰야 할 것. 하나라도 빠지면 기록하지 않는다.
 *
 * `artifactExists`를 인자로 요구하는 것이 요점이다. 확인자 없이 부를 수 있으면 언젠가 확인 없이
 * 불린다 — 그러면 "봤다"는 기록이 아무것도 증명하지 않는다.
 */
export function requireHumanVisualReview({ status, artifacts, notes, artifactExists } = {}) {
  if (!HUMAN_VISUAL_REVIEW_STATUSES.includes(status)) {
    throw new TypeError(
      `visualReview 판정은 사람이 passed 또는 failed로 적어야 한다 — 받은 것은 ${JSON.stringify(status)}. `
        + "자동으로 passed가 되는 경로는 없다",
    );
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0
      || artifacts.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError("검토한 artifact 경로를 하나 이상 적어라 — 무엇을 봤는지 없이는 기록하지 않는다");
  }
  if (typeof notes !== "string" || notes.trim() === "") {
    throw new TypeError("사람이 무엇을 확인했는지 메모(notes)를 적어라");
  }
  if (typeof artifactExists !== "function") {
    throw new TypeError("artifactExists 확인자가 없다 — 실재를 확인하지 않은 검토는 기록하지 않는다");
  }
  const missing = artifacts.filter((artifact) => !artifactExists(artifact));
  if (missing.length > 0) {
    throw new Error(`검토했다는 artifact가 없다: ${missing.join(", ")}`);
  }
  return { status, artifacts: [...artifacts], notes };
}

/**
 * 저장된 정본 보고서 텍스트에 사람의 판정 하나를 적어 되돌려준다. machine 축은 건드리지 않는다.
 * 같은 검토를 두 번 적으면 같은 정본이 나온다.
 */
export function applyVisualReview(reportText, {
  engine,
  gate,
  status,
  artifacts,
  notes,
  artifactExists,
}) {
  const verdict = requireHumanVisualReview({ status, artifacts, notes, artifactExists });
  const report = parseBrowserGateReportText(reportText);
  return serializeBrowserGateReport(setVisualReviewStatus(report, {
    engine,
    gate,
    status: verdict.status,
    artifacts: verdict.artifacts,
    notes: verdict.notes,
  }));
}

/** 아직 사람이 안 본 칸. 검토를 어디서 이어야 하는지 이것으로 읽는다. */
export function pendingVisualReviews(reportText) {
  const report = parseBrowserGateReportText(reportText);
  const pending = [];
  for (const [engine, gates] of Object.entries(report.engines ?? {})) {
    for (const [gate, cell] of Object.entries(gates ?? {})) {
      if (cell?.visualReview?.status === "pending") {
        pending.push({ engine, gate, machine: cell.machine?.status ?? null });
      }
    }
  }
  return pending;
}
