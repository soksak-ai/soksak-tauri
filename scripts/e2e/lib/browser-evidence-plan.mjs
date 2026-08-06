import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gates.mjs";
import { EVIDENCE_RUN_LIMIT_BYTES } from "./evidence-store.mjs";

export const RECORDING_BYTES_PER_FRAME = 512 * 1024;

const ACCEPTED_ENGINES = new Set(BROWSER_ACCEPTANCE_ENGINES);
const ACCEPTED_SCENARIOS = new Set(["flow", "pin", "resize", "overlay", "scroll"]);
const PIN_RECORDINGS = Object.freeze([
  ["pin-right-adjacent", 24],
  ["pin-detached", 24],
  ["pin-left-adjacent", 24],
]);
const RESIZE_RECORDINGS = Object.freeze([
  ["resize-window-fast", 64],
  ["resize-pane-wider", 48],
  ["resize-pane-restored", 48],
]);

function distinctDeclaredList(value, accepted, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label}은 비어 있지 않은 배열이어야 한다`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !accepted.has(item)) {
      throw new TypeError(`알 수 없는 ${label}: ${String(item)}`);
    }
    if (seen.has(item)) throw new TypeError(`중복 ${label}: ${item}`);
    seen.add(item);
    result.push(item);
  }
  return result;
}

function maxBytesForFrames(frames) {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 600) {
    throw new TypeError(`record frames는 1..600 safe integer여야 한다: ${frames}`);
  }
  return frames * RECORDING_BYTES_PER_FRAME;
}

function recording(engine, scenario, name, frames) {
  return Object.freeze({
    engine,
    scenario,
    name,
    frames,
    maxBytes: maxBytesForFrames(frames),
    relativePath: `${engine}/${name}/frames`,
  });
}

function recordingIdentity(engine, scenario, name) {
  if (typeof engine !== "string" || typeof scenario !== "string" || typeof name !== "string"
      || engine.length === 0 || scenario.length === 0 || name.length === 0) {
    throw new TypeError("recording identity는 비어 있지 않은 engine/scenario/name 문자열이어야 한다");
  }
  return JSON.stringify([engine, scenario, name]);
}

/**
 * 사전 계획과 실제 producer 호출 사이의 일대일 계약을 소유한다.
 * 계획 밖 녹화, 중복 녹화, 실행 종료 시 누락 녹화를 모두 같은 장부에서 거부한다.
 */
export function createBrowserRecordingEvidenceLedger(plan) {
  if (!plan || !Array.isArray(plan.recordings)) {
    throw new TypeError("browser recording evidence plan이 필요하다");
  }
  const declared = new Map();
  for (const item of plan.recordings) {
    const key = recordingIdentity(item?.engine, item?.scenario, item?.name);
    if (declared.has(key)) {
      throw new TypeError(`중복 recording 계획: ${item.engine}/${item.scenario}/${item.name}`);
    }
    declared.set(key, item);
  }
  const consumed = new Set();

  return Object.freeze({
    take(engine, scenario, name) {
      const key = recordingIdentity(engine, scenario, name);
      const item = declared.get(key);
      if (!item) throw new Error(`계획되지 않은 recording: ${engine}/${scenario}/${name}`);
      if (consumed.has(key)) throw new Error(`이미 소비한 recording: ${engine}/${scenario}/${name}`);
      consumed.add(key);
      return item;
    },
    assertComplete() {
      const pending = [...declared]
        .filter(([key]) => !consumed.has(key))
        .map(([, item]) => `${item.engine}/${item.scenario}/${item.name}`);
      if (pending.length) {
        throw new Error(`미소비 recording ${pending.length}개: ${pending.join(", ")}`);
      }
      return { planned: declared.size, consumed: consumed.size, pending };
    },
  });
}

/**
 * 실행 전에 선택된 모든 유한 녹화의 최악 용량을 확정한다.
 *
 * 일부 녹화를 뒤에서 조용히 생략하지 않는다. 선언 전체가 1GiB 실행 경계 안에 들지 않으면
 * 제품 자극을 시작하기 전에 계획 자체를 거부한다.
 */
export function planBrowserRecordingEvidence({ engines, scenarios, cycles } = {}) {
  const selectedEngines = distinctDeclaredList(engines, ACCEPTED_ENGINES, "engine");
  const selectedScenarios = distinctDeclaredList(scenarios, ACCEPTED_SCENARIOS, "scenario");
  if (!Number.isSafeInteger(cycles) || cycles < 0 || cycles > 20) {
    throw new TypeError(`cycles는 0..20 safe integer여야 한다: ${String(cycles)}`);
  }

  const recordings = [];
  for (const engine of selectedEngines) {
    if (selectedScenarios.includes("flow")) {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (let side = 0; side < 2; side += 1) {
          const sequence = cycle * 2 + side + 1;
          const name = `${String(sequence).padStart(2, "0")}-${side ? "right" : "left"}`;
          recordings.push(recording(engine, "flow", name, 48));
        }
      }
    }
    if (selectedScenarios.includes("pin")) {
      for (const [name, frames] of PIN_RECORDINGS) {
        recordings.push(recording(engine, "pin", name, frames));
      }
    }
    if (selectedScenarios.includes("resize")) {
      for (const [name, frames] of RESIZE_RECORDINGS) {
        recordings.push(recording(engine, "resize", name, frames));
      }
    }
  }

  const totalFrames = recordings.reduce((sum, item) => sum + item.frames, 0);
  const totalMaxBytes = recordings.reduce((sum, item) => sum + item.maxBytes, 0);
  if (totalMaxBytes > EVIDENCE_RUN_LIMIT_BYTES) {
    throw new Error(
      `browser recording evidence 계획이 1GiB 실행 한도를 초과한다: `
      + `${totalMaxBytes}/${EVIDENCE_RUN_LIMIT_BYTES} bytes`,
    );
  }
  return Object.freeze({
    recordings: Object.freeze(recordings),
    totalFrames,
    totalMaxBytes,
    runLimitBytes: EVIDENCE_RUN_LIMIT_BYTES,
  });
}
