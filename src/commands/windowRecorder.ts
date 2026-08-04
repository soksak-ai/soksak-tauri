import { createStream, invoke } from "../framework";

export type WindowRecordRequest = {
  dir: string;
  frames: number;
  intervalMs: number;
};

export type WindowRecording = Promise<number> & { ready: Promise<void> };

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
}: WindowRecordRequest): WindowRecording {
  const onReady = createStream<number>();
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
  onReady.onmessage = () => {
    if (settled) return;
    settled = true;
    resolveReady();
  };
  const finished = invoke<number>("plugin:webview-capture|record", {
    dir,
    frames,
    intervalMs,
    onReady,
  }).catch((error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    throw error;
  });
  return Object.assign(finished, { ready });
}
