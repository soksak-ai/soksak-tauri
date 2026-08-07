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
 * 상태 없이 판정할 수 없고, 그 이전 상태는 요청 크기에서 역산할 수 없다. 관측면이 없는
 * 프레임워크는 baseline도 null이며, 이 null은 사실 없음을 그대로 뜻한다.
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
  baseline: unknown;
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
  const baseline = observe ? await observe({ kind: "baseline" }) : null;

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
