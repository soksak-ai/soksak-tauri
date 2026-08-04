export interface PhysicalWindowSize {
  w: number;
  h: number;
}

export interface WindowResizeRecording {
  dir: string;
  frames: number;
  intervalMs: number;
}

interface ResizeSequenceRequest {
  sizes: PhysicalWindowSize[];
  intervalMs: number;
  record?: WindowResizeRecording;
  setSize: (w: number, h: number) => Promise<void>;
  recordFrames: (request: WindowResizeRecording) => Promise<number>;
}

const MAX_STEPS = 120;

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * 유한한 native window resize 거래.
 *
 * 녹화를 먼저 연 뒤 물리 크기를 입력 순서 그대로 적용한다. 상태를 기다리거나 재시도하지
 * 않으며, 호출자가 명시한 cadence만 사용한다. 이 순서가 있어야 자동화가 resize 도중의 blank,
 * stale frame, 응답 정지를 재현하면서도 다음 실행에서 같은 자극을 만들 수 있다.
 */
export async function runWindowResizeSequence({
  sizes,
  intervalMs,
  record,
  setSize,
  recordFrames,
}: ResizeSequenceRequest): Promise<{
  steps: number;
  frames: number;
  resizeElapsedMs: number;
  elapsedMs: number;
  final: PhysicalWindowSize;
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

  const startedAt = performance.now();
  const recording = record ? recordFrames(record) : Promise.resolve(0);
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    await setSize(size.w, size.h);
    if (index + 1 < sizes.length) await delay(intervalMs);
  }
  const resizeElapsedMs = Math.round(performance.now() - startedAt);
  const frames = await recording;
  return {
    steps: sizes.length,
    frames,
    resizeElapsedMs,
    elapsedMs: Math.round(performance.now() - startedAt),
    final: sizes[sizes.length - 1],
  };
}
