// 급격한 창 resize 한 거래의 단계 관측을 두 부류로 가른다.
//
// 측정 불가 — 단계 원장 자체가 없다(명령이 답하지 않았다, 단계 수가 안 맞는다, 관측 자리가
// 비었다). 없는 사실을 red 로 적으면 보고서가 관측하지 않은 것을 관측했다고 말하므로 이때만
// 실행을 멈춘다.
//
// 계약 위반 — 관측면이 스스로 판정을 선언했고 그것이 green 이 아니다. 이것은 수치로 남아야
// 하는 사실이라 던지지 않고 게이트 증거로 싣는다. 던지면 같은 엔진의 뒤 게이트가 blocked 로
// 닫혀 위반한 수치가 어느 보고서에도 이름으로 남지 않는다.
//
// 어느 평면을 읽을지는 프레임워크 이름이 아니라 관측면이 실은 선언(kind·verdict)이 정한다.
import { tauriSurfaceResizePolicyVerdict } from "./tauri-surface-resize-policy.mjs";

const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function display(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** delta 를 축마다 수치로 편다. 없는 값은 없다고 적는다 — 0 으로 채우지 않는다. */
function deltaText(delta) {
  if (!isRecord(delta)) return `delta=${display(delta)}`;
  return `delta:${RECT_KEYS.map((key) => `${key}=${display(delta[key])}`).join(",")}`;
}

function offContract(delta, tolerancePx) {
  if (!isRecord(delta)) return true;
  return RECT_KEYS.some((key) => {
    const value = delta[key];
    if (!Number.isFinite(value)) return true;
    return tolerancePx === null ? value !== 0 : Math.abs(value) > tolerancePx;
  });
}

function directFacts(direct, prefix) {
  const facts = [];
  if (direct === null || direct === undefined) return [`${prefix}:direct=${display(direct)}`];
  if (!isRecord(direct)) return [`${prefix}:direct=record/${display(direct)}`];
  const verdict = direct.verdict;
  if (!isRecord(verdict)) return [`${prefix}:direct.verdict=record/${display(verdict)}`];
  for (const plane of ["misplaced", "stacked", "missing", "unowned"]) {
    const value = verdict[plane];
    if (!Array.isArray(value)) {
      facts.push(`${prefix}:direct.${plane}=array/${display(value)}`);
      continue;
    }
    if (value.length > 0) facts.push(`${prefix}:direct.${plane}=0/${value.length}`);
  }
  return facts;
}

function paneFacts(pane, prefix) {
  if (pane === null || pane === undefined) return [`${prefix}:pane=${display(pane)}`];
  if (!isRecord(pane)) return [`${prefix}:pane=record/${display(pane)}`];
  const tolerancePx = Number.isFinite(pane.tolerancePx) ? Number(pane.tolerancePx) : null;
  const facts = [];
  if (tolerancePx === null) facts.push(`${prefix}:pane.tolerancePx=declared/${display(pane.tolerancePx)}`);
  if (!Array.isArray(pane.matches)) {
    facts.push(`${prefix}:pane.matches=array/${display(pane.matches)}`);
    return facts;
  }
  for (const match of pane.matches) {
    if (!isRecord(match)) {
      facts.push(`${prefix}:pane.match=record/${display(match)}`);
      continue;
    }
    if (match.ok === true) continue;
    const paneId = hasText(match.pane) ? match.pane : display(match.pane);
    if (offContract(match.delta, tolerancePx)) {
      facts.push(`${prefix}:pane[${paneId}].${deltaText(match.delta)}`);
    }
    const members = Array.isArray(match.members) ? match.members : null;
    if (members === null) {
      facts.push(`${prefix}:pane[${paneId}].members=array/${display(match.members)}`);
      continue;
    }
    if (members.length === 0) facts.push(`${prefix}:pane[${paneId}].members=non-empty/0`);
    for (const member of members) {
      if (!isRecord(member)) {
        facts.push(`${prefix}:pane[${paneId}].member=record/${display(member)}`);
        continue;
      }
      if (member.ok === true) continue;
      const label = hasText(member.label) ? member.label : display(member.label);
      facts.push(`${prefix}:pane[${paneId}].member[${label}].${deltaText(member.delta)}`);
    }
  }
  return facts;
}

/**
 * 어긋난 frame 의 소유 축. mask 가 부모 상속이 아니면 그 member 는 애초에 부모 거래를 따르지
 * 않는다(선언 결함). mask 가 맞는데도 어긋났다면 마지막으로 frame 을 쓴 자리가 현재 세대가
 * 아니다(쓰기 결함). 이 축은 red 를 선언한 단계에만 붙인다 — 새 합격/불합격 축을 만들지 않는다.
 */
function boundsOwnerFacts(direct, prefix) {
  if (!isRecord(direct) || !Array.isArray(direct.surfaces)) return [];
  const verdict = tauriSurfaceResizePolicyVerdict(direct.surfaces);
  if (verdict.ok) return [];
  return verdict.errors.map((error) => `${prefix}:bounds-owner:${error}`);
}

function stepFacts(sample, index, observer) {
  const prefix = `s${index}`;
  const observation = isRecord(sample) ? sample.observation : null;
  if (!isRecord(observation)) {
    return {
      sequence: index,
      acknowledged: null,
      violations: [`${prefix}:observation=record/${display(observation)}`],
    };
  }
  const violations = [];
  const kind = hasText(observation.kind) ? observation.kind : null;
  if (kind === null) violations.push(`${prefix}:kind=declared/${display(observation.kind)}`);
  else if (observer !== null && kind !== observer) {
    violations.push(`${prefix}:kind=${observer}/${kind}`);
  }
  const verdict = observation.verdict;
  const acknowledged = verdict === "green" ? true : verdict === "red" ? false : null;
  if (acknowledged === null) violations.push(`${prefix}:verdict=declared/${display(verdict)}`);
  if (acknowledged === false) {
    violations.push(`${prefix}:verdict=green/red`);
    const issues = Array.isArray(observation.issues) ? observation.issues : null;
    if (issues === null) violations.push(`${prefix}:issues=array/${display(observation.issues)}`);
    else for (const issue of issues) violations.push(`${prefix}:issue=${hasText(issue) ? issue : display(issue)}`);
    if (Object.hasOwn(observation, "direct")) violations.push(...directFacts(observation.direct, prefix));
    if (Object.hasOwn(observation, "pane")) violations.push(...paneFacts(observation.pane, prefix));
    violations.push(...boundsOwnerFacts(observation.direct, prefix));
  }
  return { sequence: index, acknowledged, violations };
}

/**
 * 관측면이 각 단계에서 스스로 선언한 합성 판정. 요청 크기나 하니스의 기대는 들어오지 않는다 —
 * 같은 봉투의 관측에서만 파생한다.
 */
export function hostileResizeCompositionPlane(resizeSequence) {
  const samples = Array.isArray(resizeSequence?.samples) ? resizeSequence.samples : null;
  if (samples === null) return { observer: null, steps: null };
  const observer = samples
    .map((sample) => (isRecord(sample?.observation) && hasText(sample.observation.kind)
      ? sample.observation.kind
      : null))
    .find((kind) => kind !== null) ?? null;
  return {
    observer,
    steps: samples.map((sample, index) => stepFacts(sample, index, observer)),
  };
}

/**
 * 측정 자체가 성립하지 않은 사유만 돌려준다. 비어 있지 않으면 이 거래는 판정할 것이 없다.
 * 관측면이 답했는데 내용이 계약 위반인 것은 여기 들어오지 않는다.
 */
export function hostileResizeObservationGaps({ requestedSteps, resizeSequence } = {}) {
  if (!isRecord(resizeSequence)) return [`resizeSequence=record/${display(resizeSequence)}`];
  const samples = resizeSequence.samples;
  if (!Array.isArray(samples)) return [`samples=array/${display(samples)}`];
  const gaps = [];
  if (!Number.isInteger(requestedSteps) || requestedSteps < 1) {
    gaps.push(`requestedSteps=integer>=1/${display(requestedSteps)}`);
  } else {
    if (Number(resizeSequence.steps) !== requestedSteps) {
      gaps.push(`steps=${requestedSteps}/${display(resizeSequence.steps)}`);
    }
    if (samples.length !== requestedSteps) {
      gaps.push(`samples.length=${requestedSteps}/${samples.length}`);
    }
  }
  samples.forEach((sample, index) => {
    if (!isRecord(sample)) {
      gaps.push(`s${index}=record/${display(sample)}`);
      return;
    }
    if (sample.step !== index) gaps.push(`s${index}.step=${index}/${display(sample.step)}`);
    if (!isRecord(sample.observation)) {
      gaps.push(`s${index}.observation=record/${display(sample.observation)}`);
    }
  });
  return gaps;
}
