const RECORDING_STATUSES = new Set(["not-requested", "complete", "failed"]);
const RECORDING_MODES = new Set(["realtime", "steps"]);

function optionalFrameCount(name, value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * 녹화 artifact는 사람이 화면을 판독하기 위한 증거다. 이 함수는 그 증거가 검토 가능한지
 * 보고할 뿐 제품 동작의 machine verdict를 만들지 않는다.
 */
export function reviewVisualRecording({
  recording,
  expectedFrames,
  artifacts = [],
  artifactReadError = null,
} = {}) {
  if (!recording || typeof recording !== "object" || !RECORDING_STATUSES.has(recording.status)) {
    throw new TypeError(`unknown recording status: ${String(recording?.status)}`);
  }
  if (recording.mode !== undefined && !RECORDING_MODES.has(recording.mode)) {
    throw new TypeError(`unknown recording mode: ${String(recording.mode)}`);
  }
  const expected = expectedFrames === undefined
    ? null
    : optionalFrameCount("expectedFrames", expectedFrames);
  if (expected === 0) throw new TypeError("expectedFrames must be greater than zero");
  const requested = optionalFrameCount("recording.requestedFrames", recording.requestedFrames);
  const reported = optionalFrameCount("recording.frames", recording.frames);
  if (!Array.isArray(artifacts) || artifacts.some(
    (artifact) => typeof artifact !== "string" || !/^.+\.png$/i.test(artifact),
  )) {
    throw new TypeError("artifacts must contain PNG paths only");
  }
  if (artifactReadError !== null && (typeof artifactReadError !== "string" || artifactReadError.length === 0)) {
    throw new TypeError("artifactReadError must be null or a non-empty string");
  }

  const failures = [];
  if (recording.status === "failed") {
    failures.push(`recording:${recording.reason || "unspecified failure"}`);
  }
  if (artifactReadError) failures.push(`artifacts:${artifactReadError}`);
  if (expected !== null && reported !== expected) {
    failures.push(`reported-frames:${reported ?? "absent"}/${expected}`);
  }
  if (expected !== null && artifacts.length !== expected) {
    failures.push(`artifact-frames:${artifacts.length}/${expected}`);
  }

  return {
    kind: "human-visual-evidence",
    automatedVerdict: false,
    status: recording.status === "not-requested"
      ? "not-requested"
      : failures.length > 0 ? "failed" : "pending",
    recordingStatus: recording.status,
    mode: recording.mode ?? null,
    expectedFrames: expected,
    requestedFrames: requested,
    reportedFrames: reported,
    artifactFrames: artifacts.length,
    artifacts: [...artifacts],
    failures,
  };
}

/** 녹화 계측 계약 오류 역시 제품 machine gate를 중단시키지 않고 시각 증거 실패로 보존한다. */
export function reviewVisualRecordingSafely(input = {}) {
  try {
    return reviewVisualRecording(input);
  } catch (error) {
    const expectedFrames = Number.isSafeInteger(input.expectedFrames) && input.expectedFrames > 0
      ? input.expectedFrames
      : null;
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts.filter((artifact) => typeof artifact === "string" && /^.+\.png$/i.test(artifact))
      : [];
    return {
      kind: "human-visual-evidence",
      automatedVerdict: false,
      status: "failed",
      recordingStatus: "invalid",
      mode: null,
      expectedFrames,
      requestedFrames: null,
      reportedFrames: null,
      artifactFrames: artifacts.length,
      artifacts: [...artifacts],
      failures: [`contract:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
