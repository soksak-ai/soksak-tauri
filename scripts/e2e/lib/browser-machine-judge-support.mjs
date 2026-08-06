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

export function finishMachineVerdict(gate, failures, greenEvidence) {
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

export function requireEvidenceEnvelope(value, failures) {
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

export function requireExactKeys(value, keys, path, failures) {
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

export function requireUniqueViewId(tab, path, seen, failures) {
  if (!hasText(tab?.viewId)) {
    failures.push(`${path}.viewId=non-empty/${displayValue(tab?.viewId)}`);
    return null;
  }
  if (seen.has(tab.viewId)) failures.push(`${path}.viewId=unique/${displayValue(tab.viewId)}`);
  seen.add(tab.viewId);
  return tab.viewId;
}
