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
 * `ui.input.*`와 `window.resizeSequence`는 공개 소켓의 JSON-RPC 응답 봉투를 반환한다.
 * 제품 동작 결과를 보존하는 recording transaction이 그 봉투를 임의로 벗기면 호출자가
 * 받은 정확한 응답이라는 계약이 깨진다. 시각 검토 소비자가 공개 봉투의 유일한 결과 위치인
 * `data.recording`을 읽는다. 계약이 없으면 undefined를 그대로 반환해 safe reviewer가
 * 명시적인 visual-evidence failure를 만들게 한다(저장된 PNG로 성공을 꾸미지 않는다).
 */
export function recordingReportFromCommandResponse(response) {
  if (!response || typeof response !== "object" || response.ok !== true) return undefined;
  const data = response.data;
  if (!data || typeof data !== "object") return undefined;
  return data.recording;
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

/**
 * Starts the product stimulus inside the evidence artifact transaction, but exposes its ACK before
 * PNG completion. The caller closes numeric machine traces at the product transaction boundary,
 * then calls release(); only then does the visual recorder finish and the artifact store measure it.
 */
export function startRecordingEvidenceAction(options = {}) {
  if (typeof options.action !== "function") {
    throw new TypeError("recording evidence concurrent action callback이 필요하다");
  }
  let releaseBarrier;
  let released = false;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  let resolveAction;
  let rejectAction;
  let actionSettled = false;
  const actionResult = new Promise((resolve, reject) => {
    resolveAction = resolve;
    rejectAction = reject;
  });
  const outcome = runRecordingEvidenceAction({
    ...options,
    action: async (recordFields) => {
      try {
        const transaction = await options.action(recordFields);
        if (!transaction || typeof transaction !== "object" || typeof transaction.finish !== "function") {
          throw new TypeError("concurrent recording action must return { actionResult, finish }");
        }
        actionSettled = true;
        resolveAction(transaction.actionResult);
        await barrier;
        return await transaction.finish();
      } catch (error) {
        if (!actionSettled) {
          actionSettled = true;
          rejectAction(error);
        }
        throw error;
      }
    },
  });
  // Artifact preflight can fail before the callback and still routes through the fallback callback,
  // but a store-level failure must never leave the early product promise unhandled or pending.
  outcome.catch((error) => {
    if (actionSettled) return;
    actionSettled = true;
    rejectAction(error);
  });
  return {
    actionResult,
    release() {
      if (released) return;
      released = true;
      releaseBarrier();
    },
    outcome,
  };
}
