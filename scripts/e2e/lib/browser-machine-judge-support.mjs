import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";

export const engineSet = new Set(BROWSER_ACCEPTANCE_ENGINES);

export function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function displayValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function notRunVerdict() {
  return { status: "not-run", evidence: [], reason: null };
}

/** 잰 어긋남은 red, 못 잰 축은 blocked, 둘 다 없으면 green.
 *
 * 관측자가 표본을 못 낸 것을 실패로 적으면 없는 사실을 만든 것이고, 그 판정은 관측 환경에 따라
 * green/red 를 오간다. 잰 어긋남이 함께 있으면 red 가 이긴다 — 실측한 위반이 못 잼에 가려지면
 * 안 된다. */
export function finishMachineVerdict(gate, failures, greenEvidence, unmeasured = []) {
  if (failures.length > 0) {
    const unique = [...new Set(failures)];
    return {
      status: "red",
      evidence: unique.map((failure) => `${gate}:${failure}`),
      reason: `${gate} machine contract failed (${unique.length})`,
    };
  }
  if (unmeasured.length > 0) {
    const names = [...new Set(unmeasured)].join(",");
    return {
      status: "blocked",
      evidence: [],
      reason: `${gate} could not be measured: ${names}`,
    };
  }
  return { status: "green", evidence: [greenEvidence], reason: null };
}

/**
 * 봉투가 자기 배선 장부를 싣는 예약 키. 어느 게이트의 닫힌 스키마에도 이 이름을 적지 않는다 —
 * 스키마 대조는 이 키를 건너뛰고, 대신 장부 내용을 실패 이름으로 펼친다.
 */
export const EVIDENCE_WIRING_KEY = "evidenceWiring";

const WIRING_KEYS = Object.freeze(["source", "unconsumed", "unproduced", "error"]);
const WIRING_DIRECTIONS = Object.freeze([
  ["unconsumed", "produced-not-consumed"],
  ["unproduced", "consumed-not-produced"],
]);

function wiringNames(value) {
  if (!Array.isArray(value)) return null;
  return value.every((item) => hasText(item)) ? value : null;
}

/**
 * 배선 장부를 실패 이름으로 펼친다.
 *
 * 생산자가 넣었는데 아무도 안 읽은 필드와 소비자가 읽었는데 아무도 안 넣은 필드는 같은 무게로
 * 실패다. 한쪽만 =null 로 새고 다른 쪽은 침묵하는 비대칭을 남기지 않는다. 장부가 아예 없으면
 * 그 봉투는 배선을 재지 않은 것이므로 아무 실패도 만들지 않는다 — 비어 있는 장부와 없는 장부는
 * 서로 다른 사실이다.
 */
export function reportEvidenceWiring(value, path, failures) {
  if (value === undefined) return false;
  const at = `${path}.${EVIDENCE_WIRING_KEY}`;
  if (!isRecord(value)) {
    failures.push(`${at}=record/${displayValue(value)}`);
    return true;
  }
  for (const key of Object.keys(value)) {
    if (!WIRING_KEYS.includes(key)) failures.push(`${at}.${key}=not-wiring-schema`);
  }
  const source = hasText(value.source) ? value.source : null;
  if (source === null) failures.push(`${at}.source=non-empty/${displayValue(value.source)}`);
  const owner = source ?? at;
  for (const [field, verdict] of WIRING_DIRECTIONS) {
    const names = wiringNames(value[field]);
    if (names === null) {
      failures.push(`${at}.${field}=names/${displayValue(value[field])}`);
      continue;
    }
    for (const name of names) failures.push(`wiring.${owner}.${name}=${verdict}`);
  }
  if (value.error != null) {
    if (hasText(value.error)) failures.push(`wiring.${owner}=mapper-threw/${displayValue(value.error)}`);
    else failures.push(`${at}.error=null-or-text/${displayValue(value.error)}`);
  }
  return true;
}

export function requireEvidenceEnvelope(value, failures) {
  if (!isRecord(value)) {
    failures.push(`evidence=record/${displayValue(value)}`);
    return false;
  }
  reportEvidenceWiring(value[EVIDENCE_WIRING_KEY], "evidence", failures);
  if (!engineSet.has(value.engine)) failures.push(`engine=known/${displayValue(value.engine)}`);
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) {
    failures.push(`tabs=non-empty/${displayValue(value.tabs)}`);
    return false;
  }
  return true;
}

export function requireExactKeys(value, keys, path, failures) {
  if (!isRecord(value)) {
    failures.push(`${path}=record/${displayValue(value)}`);
    return false;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (key === EVIDENCE_WIRING_KEY) continue;
    if (!expected.has(key)) failures.push(`${path}.${key}=not-machine-schema`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) failures.push(`${path}.${key}=missing`);
  }
  reportEvidenceWiring(value[EVIDENCE_WIRING_KEY], path, failures);
  return true;
}

function wiringError(value) {
  if (value == null) return null;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * checkpoint 한 장을 읽으면서 읽은 키를 센다. 봉인 시점에 checkpoint 자신의 키 집합과 맞대,
 * requireExactKeys 가 봉투에 대해 하는 양방향 대조를 봉투가 만들어지기 전 source 에 대해 한다.
 */
export function readCheckpoint(source, label) {
  if (!hasText(label)) throw new TypeError("checkpoint label must be non-empty text");
  const record = isRecord(source) ? source : null;
  const consumed = new Set();
  return {
    label,
    take(key) {
      consumed.add(key);
      return record === null ? undefined : record[key];
    },
    seal(error = null) {
      const produced = record === null ? [] : Object.keys(record);
      return {
        source: label,
        unconsumed: produced.filter((key) => !consumed.has(key)),
        unproduced: [...consumed].filter((key) => record === null || !Object.hasOwn(record, key)),
        error: wiringError(error)
          ?? (record === null ? `checkpoint is not a record: ${displayValue(source)}` : null),
      };
    },
  };
}

/**
 * mapper 를 배선 장부와 함께 돌린다.
 *
 * mapper 가 던져도 하니스를 죽이지 않는다. 던졌다는 사실은 장부에 실려 judge 가 RED 로 판정하고
 * 보고서에 이름으로 남는다. 봉투가 아닌 값을 돌려주는 것도 같은 자리에서 이름으로 거절한다.
 */
export function mapWithWiring(source, label, build) {
  const checkpoint = readCheckpoint(source, label);
  let mapped;
  let error = null;
  try {
    mapped = build(checkpoint);
  } catch (cause) {
    error = cause;
  }
  if (error === null && !isRecord(mapped)) {
    error = new TypeError(`mapper returned ${displayValue(mapped)}`);
  }
  const envelope = isRecord(mapped) ? { ...mapped } : {};
  envelope[EVIDENCE_WIRING_KEY] = checkpoint.seal(error);
  return envelope;
}

export function requireUniqueViewId(tab, path, seen, failures) {
  if (!hasText(tab?.viewId)) {
    failures.push(`${path}.viewId=non-empty/${displayValue(tab?.viewId)}`);
    return null;
  }
  if (seen.has(tab.viewId)) failures.push(`${path}.viewId=unique/${displayValue(tab.viewId)}`);
  seen.add(tab.viewId);
  return tab.viewId;
}
