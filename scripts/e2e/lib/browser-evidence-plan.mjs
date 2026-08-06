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
