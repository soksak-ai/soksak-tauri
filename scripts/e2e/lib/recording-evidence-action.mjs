import path from "node:path";
import { produceEvidenceArtifact } from "./evidence-store.mjs";

const NOT_STARTED = "not-started";
const RUNNING = "running";
const SUCCEEDED = "succeeded";
const FAILED = "failed";

function failureReason(error) {
  return error instanceof Error ? error.message : String(error);
}

function relativeArtifactIdentity(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = path.normalize(relativePath);
  if (normalized === "."
      || normalized === ".."
      || normalized.startsWith(`..${path.sep}`)
      || normalized.includes("\0")) {
    return null;
  }
  return normalized.split(path.sep).join("/");
}

function failedVisualEvidence(error, phase) {
  return {
    kind: "human-visual-evidence",
    automatedVerdict: false,
    status: "failed",
    phase,
    artifact: null,
    failures: [`artifact:${failureReason(error)}`],
  };
}

/**
 * 증거 저장 실패와 제품 동작 실패는 서로 다른 거래다. 녹화 저장소가 callback 전에
 * 거부되면 제품 동작을 녹화 옵션 없이 정확히 한 번 실행한다. callback 뒤 저장/계측이
 * 실패하면 이미 끝난 제품 동작을 반복하지 않고 그 결과와 시각 증거 실패를 함께 돌려준다.
 */
export async function runRecordingEvidenceAction({
  root,
  relativePath,
  maxBytes,
  keep = false,
  limits,
  action,
} = {}) {
  if (typeof action !== "function") {
    throw new TypeError("recording evidence product action callback이 필요하다");
  }

  let actionState = NOT_STARTED;
  let actionPromise = null;
  let actionResult;
  let actionError;
  let artifactCallbackStarted = false;

  const invokeActionOnce = (recordFields) => {
    if (actionPromise) return actionPromise;
    actionState = RUNNING;
    actionPromise = (async () => {
      try {
        actionResult = await action(Object.freeze(recordFields));
        actionState = SUCCEEDED;
        return actionResult;
      } catch (error) {
        actionError = error;
        actionState = FAILED;
        throw error;
      }
    })();
    return actionPromise;
  };

  let stored;
  try {
    stored = await produceEvidenceArtifact(
      root,
      relativePath,
      { kind: "directory", maxBytes, keep, limits },
      async ({ path: recordDir, maxBytes: recordMaxBytes }) => {
        artifactCallbackStarted = true;
        return invokeActionOnce({ recordDir, recordMaxBytes });
      },
    );
  } catch (artifactError) {
    if (actionState === NOT_STARTED) {
      try {
        await invokeActionOnce({});
      } catch {
        throw actionError;
      }
    } else if (actionState === RUNNING) {
      try {
        await actionPromise;
      } catch {
        throw actionError;
      }
    }
    if (actionState === FAILED) throw actionError;
    return {
      actionResult,
      visualEvidence: failedVisualEvidence(
        artifactError,
        artifactCallbackStarted ? "store" : "preflight",
      ),
    };
  }

  const identity = relativeArtifactIdentity(relativePath);
  if (!identity) {
    throw new Error("저장된 recording artifact의 상대 identity를 만들 수 없다");
  }
  return {
    actionResult,
    visualEvidence: {
      kind: "human-visual-evidence",
      automatedVerdict: false,
      status: "pending",
      phase: "stored",
      artifact: {
        relativePath: identity,
        kind: stored.kind,
        maxBytes: stored.maxBytes,
        bytes: stored.bytes,
      },
      failures: [],
    },
  };
}
