import {
  startWindowRecording,
  validWindowRecordMaxBytes,
  type WindowRecordRequest,
  type WindowRecorder,
  type WindowRecordingReport,
} from "./windowRecorder";

export interface PhysicalWindowSize {
  w: number;
  h: number;
}

/**
 * 관측면에 넘기는 요청. baseline은 아직 어떤 크기도 요청되지 않은 순간이므로 크기를 싣지
 * 않는다 — 요청값이 관측값 자리에 복사될 통로 자체를 두지 않는다.
 */
export type ResizeObservationRequest =
  | { readonly kind: "baseline" }
  | { readonly kind: "step"; readonly step: number; readonly size: PhysicalWindowSize };

/**
 * 첫 크기를 요청하기 전의 관측 자리. 안 물어본 것(not-observed)·물었는데 답이 없는 것
 * (unavailable)·관측한 것(observed)은 서로 다른 사실이므로 한 null로 뭉치지 않는다.
 */
export type ResizeBaselineReport =
  | { status: "not-observed" }
  | { status: "unavailable"; reason: string }
  | { status: "observed"; observation: unknown };

export type WindowResizeRecording = Pick<
  WindowRecordRequest,
  "dir" | "frames" | "intervalMs" | "maxBytes"
>;

export type WindowResizeRecordingResult = WindowRecordingReport;

interface ResizeSequenceRequest {
  sizes: PhysicalWindowSize[];
  intervalMs: number;
  record?: WindowResizeRecording;
  setSize: (w: number, h: number) => Promise<void>;
  recordFrames: WindowRecorder;
  observe?: (request: ResizeObservationRequest) => Promise<unknown> | unknown;
}

const MAX_STEPS = 120;

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

async function observeBaseline(
  observe: ResizeSequenceRequest["observe"],
): Promise<ResizeBaselineReport> {
  if (!observe) return { status: "not-observed" };
  try {
    return { status: "observed", observation: await observe({ kind: "baseline" }) };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateRecording(record: WindowResizeRecording): void {
  if (typeof record.dir !== "string" || record.dir.trim().length === 0) {
    throw new Error("record.dir must not be empty");
  }
  if (!Number.isSafeInteger(record.frames) || record.frames < 1 || record.frames > 600) {
    throw new Error("record.frames must be a safe integer between 1 and 600");
  }
  if (!Number.isFinite(record.intervalMs) || record.intervalMs < 0 || record.intervalMs > 1_000) {
    throw new Error("record.intervalMs must be between 0 and 1000");
  }
  if (record.maxBytes !== undefined && !validWindowRecordMaxBytes(record.maxBytes)) {
    throw new Error("record.maxBytes must be a valid window recording byte budget");
  }
}

/**
 * 유한한 native window resize 거래.
 *
 * 녹화가 준비되면 첫 기준 프레임 뒤에 물리 크기를 입력 순서 그대로 적용한다. 녹화는 사람이
 * 전이를 검토하기 위한 별도 증거이므로 시작·준비·완료 실패가 resize 거래를 취소하지 않는다.
 * 상태를 폴링하거나 재시도하지 않으며, 호출자가 명시한 cadence만 사용한다.
 *
 * 첫 크기를 적용하기 전에 각 단계와 같은 관측면으로 baseline을 한 번 읽는다. 변화는 이전
 * 상태 없이 판정할 수 없고, 그 이전 상태는 요청 크기에서 역산할 수 없다.
 *
 * 아직 정착한 native 거래가 없어 관측면이 baseline을 거절할 수 있다. 그 거절은 이 유한
 * 거래의 결과가 아니라 거래 이전의 사실이므로 사유를 그대로 실어 답하고 resize를 취소하지
 * 않는다. 단계 관측 실패는 반대로 거래 자체의 증거가 없다는 뜻이라 그대로 드러낸다.
 */
export async function runWindowResizeSequence({
  sizes,
  intervalMs,
  record,
  setSize,
  recordFrames,
  observe,
}: ResizeSequenceRequest): Promise<{
  steps: number;
  recording: WindowResizeRecordingResult;
  resizeElapsedMs: number;
  elapsedMs: number;
  final: PhysicalWindowSize;
  baseline: ResizeBaselineReport;
  samples: { step: number; size: PhysicalWindowSize; observation: unknown }[];
}> {
  if (!Array.isArray(sizes) || sizes.length === 0) throw new Error("sizes must not be empty");
  if (sizes.length > MAX_STEPS) throw new Error(`sizes supports at most ${MAX_STEPS} steps`);
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 1_000) {
    throw new Error("intervalMs must be between 0 and 1000");
  }
  for (const size of sizes) {
    if (!Number.isFinite(size?.w) || !Number.isFinite(size?.h) || size.w <= 0 || size.h <= 0) {
      throw new Error(`invalid physical window size: ${JSON.stringify(size)}`);
    }
  }
  if (record) validateRecording(record);

  const startedAt = performance.now();
  const recording = record
    ? startWindowRecording(record, recordFrames)
    : null;
  // 성공한 readiness만 baseline 순서를 보장한다. 실패는 이미 녹화 상태로 닫혔으므로 native
  // resize를 그대로 진행한다.
  await (recording?.ready ?? Promise.resolve(false));

  // 첫 크기를 요청하기 전의 관측. resize 시간 예산 밖이어야 stall 판정이 resize만 잰다.
  const baseline = await observeBaseline(observe);

  const resizeStartedAt = performance.now();
  const samples: { step: number; size: PhysicalWindowSize; observation: unknown }[] = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    await setSize(size.w, size.h);
    if (observe) {
      samples.push({
        step: index,
        size,
        observation: await observe({ kind: "step", step: index, size }),
      });
    }
    if (index + 1 < sizes.length) await delay(intervalMs);
  }
  const resizeElapsedMs = Math.round(performance.now() - resizeStartedAt);

  const recordingResult: WindowResizeRecordingResult = recording
    ? await recording.report
    : { status: "not-requested", mode: "realtime" };

  return {
    steps: sizes.length,
    recording: recordingResult,
    resizeElapsedMs,
    elapsedMs: Math.round(performance.now() - startedAt),
    final: sizes[sizes.length - 1],
    baseline,
    samples,
  };
}
