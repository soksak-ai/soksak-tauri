import { createStream, invoke } from "../framework";

export type WindowRecordRequest = {
  dir: string;
  frames: number;
  intervalMs: number;
  /** producer가 기록할 수 있는 전체 encoded PNG bytes 상한. 생략은 제한 없음. */
  maxBytes?: number;
  /** 각 네이티브 프레임 완료를 기다리는 유한 기한. */
  frameTimeoutMs?: number;
  /** 저장이 끝난 각 캡처 프레임의 0-based 번호. 캡처와 수치 관측의 공통 시계다. */
  onFrame?: (frame: number) => void;
};

export type WindowRecording = Promise<number> & { ready: Promise<void> };

export type WindowRecordingReport =
  | { status: "not-requested"; mode: "realtime" }
  | {
      status: "complete";
      mode: "realtime";
      dir: string;
      requestedFrames: number;
      frames: number;
    }
  | {
      status: "failed";
      mode: "realtime";
      dir: string;
      requestedFrames: number;
      frames: number;
      reason: string;
    };

export type WindowRecorder = (request: WindowRecordRequest) => WindowRecording;

export const WINDOW_RECORD_MAX_BYTES = 1_073_741_824;
export const WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS = 8_000;
export const WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS = 60_000;

export function validWindowRecordMaxBytes(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= WINDOW_RECORD_MAX_BYTES;
}

export function validWindowRecordFrameTimeoutMs(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS;
}

const recordingFailureReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * recorder의 시작·첫 저장·완료를 하나의 non-rejecting 상태 거래로 바꾼다.
 *
 * 픽셀 녹화는 제품 자극의 증거이지 자극 자체가 아니다. ready 실패 시 완료 Promise가 끝나지
 * 않아도 report를 즉시 닫되, 늦은 final rejection handler는 시작 시점에 이미 붙여 둔다.
 */
export function startWindowRecording(
  request: WindowRecordRequest,
  recorder: WindowRecorder = recordWindowFrames,
): { ready: Promise<boolean>; report: Promise<WindowRecordingReport> } {
  let savedFrames = 0;
  let frameObservationFailure: string | null = null;
  try {
    const onFrame = request.onFrame;
    const recording = recorder({
      ...request,
      onFrame: (frame) => {
        savedFrames += 1;
        if (!onFrame) return;
        try {
          onFrame(frame);
        } catch (error) {
          frameObservationFailure ??= recordingFailureReason(error);
        }
      },
    });
    // ready가 먼저 실패해 report가 일찍 끝나도 늦은 final rejection은 여기서 이미 소비된다.
    const completion = Promise.resolve(recording).then(
      (frames) => ({ ok: true as const, frames }),
      (error) => ({ ok: false as const, reason: recordingFailureReason(error) }),
    );
    // final handler를 먼저 붙인다. 잘못된 recorder의 ready getter 자체가 throw하더라도 final
    // rejection이 별도 unhandledrejection으로 새지 않는다.
    const ready = recording.ready as unknown;
    if (
      (typeof ready !== "object" && typeof ready !== "function")
      || ready === null
      || typeof (ready as PromiseLike<void>).then !== "function"
    ) {
      throw new Error("recorder.ready must be a Promise");
    }
    const readiness = Promise.resolve(ready as PromiseLike<void>).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, reason: recordingFailureReason(error) }),
    );
    const failed = (reason: string): WindowRecordingReport => ({
      status: "failed",
      mode: "realtime",
      dir: request.dir,
      requestedFrames: request.frames,
      frames: savedFrames,
      reason,
    });
    const report = readiness.then(async (ready): Promise<WindowRecordingReport> => {
      if (!ready.ok) return failed(ready.reason);
      const finished = await completion;
      if (!finished.ok) return failed(finished.reason);
      if (frameObservationFailure) return failed(frameObservationFailure);
      return {
        status: "complete",
        mode: "realtime",
        dir: request.dir,
        requestedFrames: request.frames,
        frames: finished.frames,
      };
    });
    return { ready: readiness.then((result) => result.ok), report };
  } catch (error) {
    const result: WindowRecordingReport = {
      status: "failed",
      mode: "realtime",
      dir: request.dir,
      requestedFrames: request.frames,
      frames: savedFrames,
      reason: recordingFailureReason(error),
    };
    return { ready: Promise.resolve(false), report: Promise.resolve(result) };
  }
}

/**
 * 프레임워크 중립 창 녹화 정책.
 *
 * 껍데기는 한 프레임의 픽셀만 제공한다. 프레임 수, 간격, 파일 이름은 공통 명령 계층이
 * 소유해야 Electron과 Tauri가 같은 자동화 계약을 답한다. 호출자가 정한 유한 횟수만 실행하며
 * 상태를 기다리거나 재시도하지 않는다.
 */
export function recordWindowFrames({
  dir,
  frames,
  intervalMs,
  maxBytes,
  frameTimeoutMs = WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
  onFrame,
}: WindowRecordRequest): WindowRecording {
  if (!validWindowRecordFrameTimeoutMs(frameTimeoutMs)) {
    throw new Error(
      `frameTimeoutMs must be between 1 and ${WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS}`,
    );
  }
  const frameEvents = createStream<number>();
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 완료 Promise만 소비하는 기존 호출에서도 별도 readiness 거절이 unhandled가 되지 않는다.
  // 같은 Promise 자체는 유지하므로 준비를 기다리는 호출자는 여전히 그 오류를 받는다.
  ready.catch(() => {});
  frameEvents.onmessage = (frame) => {
    onFrame?.(frame);
    if (!settled) {
      settled = true;
      resolveReady();
    }
  };
  const finished = invoke<number>("plugin:webview-capture|record", {
    dir,
    frames,
    intervalMs,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    frameTimeoutMs,
    onFrame: frameEvents,
  }).catch((error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    throw error;
  });
  // 일부 진단 명령은 recorder를 시작한 뒤 자극 시각까지 기다렸다가 final을 await한다. 그
  // 사이 producer가 먼저 실패해도 unhandledrejection이 되지 않도록 원본 final을 유지한 채
  // rejection 소비자만 즉시 붙인다.
  finished.catch(() => {});
  return Object.assign(finished, { ready });
}
