/** Framework/engine 이름을 포함하지 않는 DOM slot ↔ native surface 공통 계약. */
export interface CompositionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompositionCoordinateSpace {
  /** DOM과 adapter 명령이 교환하는 논리 단위. */
  logical: "css-px";
  /** 화면 캡처와 실제 backing pixel의 배율. */
  scaleFactor: number;
}

export interface CompositionParticipantFrame {
  id: string;
  frame: CompositionRect;
}

export interface CompositionSample {
  transactionId: string;
  /** 거래 내 event 순서. adapter는 상태 변경 직후에만 증가시킨다. */
  sequence: number;
  phase: "prepared" | "presenting" | "committed" | "cancelled";
  sampledAtUnixMs: number;
  coordinateSpace: CompositionCoordinateSpace;
  slot: CompositionParticipantFrame;
  renderer: CompositionParticipantFrame;
  surface: CompositionParticipantFrame;
}

export type CompositionMotionMode = "glide" | "snap";

export function rectDelta(a: CompositionRect, b: CompositionRect): CompositionRect {
  return {
    x: Math.abs(a.x - b.x),
    y: Math.abs(a.y - b.y),
    w: Math.abs(a.w - b.w),
    h: Math.abs(a.h - b.h),
  };
}

export function sameRect(a: CompositionRect, b: CompositionRect, tolerancePx = 1): boolean {
  return Object.values(rectDelta(a, b)).every((value) => value <= tolerancePx);
}

/** 한 sample에서 공개 slot, plugin renderer, native surface가 반올림 외 차이 없이 같은지 판정한다. */
export function compositionSampleVerdict(sample: CompositionSample, tolerancePx = 1) {
  const rendererDelta = rectDelta(sample.slot.frame, sample.renderer.frame);
  const surfaceDelta = rectDelta(sample.slot.frame, sample.surface.frame);
  const errors: string[] = [];
  if (!Number.isFinite(sample.coordinateSpace.scaleFactor) || sample.coordinateSpace.scaleFactor <= 0) {
    errors.push(`scaleFactor=${sample.coordinateSpace.scaleFactor}`);
  }
  if (!sameRect(sample.slot.frame, sample.renderer.frame, tolerancePx)) {
    errors.push(`renderer=${JSON.stringify(rendererDelta)}`);
  }
  if (!sameRect(sample.slot.frame, sample.surface.frame, tolerancePx)) {
    errors.push(`surface=${JSON.stringify(surfaceDelta)}`);
  }
  return { ok: errors.length === 0, tolerancePx, rendererDelta, surfaceDelta, errors };
}

/** 공유 진행 시계가 없으면 glide를 시도하지 않는다. OS adapter는 실제 시계 사실만 전달한다. */
export function motionModeForClocks(sharedPresentationClock: boolean): CompositionMotionMode {
  return sharedPresentationClock ? "glide" : "snap";
}

/**
 * 녹화/스크린샷을 읽지 않는 자동 판정. adapter가 상태를 바꾼 사건만 순서대로
 * 남긴 유한 거래를 검사한다. 화면 깨짐은 별도 녹화로 사람이 검증한다.
 */
export function compositionTransactionVerdict(
  samples: readonly CompositionSample[],
  { motionMode, tolerancePx = 1 }: { motionMode: CompositionMotionMode; tolerancePx?: number },
) {
  const errors: string[] = [];
  if (samples.length < 2) errors.push(`samples=${samples.length}/2`);
  const transactionIds = [...new Set(samples.map((sample) => sample.transactionId))];
  if (transactionIds.length !== 1) errors.push(`transaction-ids=${transactionIds.join("/")}`);
  const identities = samples[0]
    ? [samples[0].slot.id, samples[0].renderer.id, samples[0].surface.id]
    : [];
  for (const [index, sample] of samples.entries()) {
    if (sample.sequence !== index) errors.push(`s${index}:sequence=${sample.sequence}/${index}`);
    if (identities.length && (
      sample.slot.id !== identities[0]
      || sample.renderer.id !== identities[1]
      || sample.surface.id !== identities[2]
    )) errors.push(`s${index}:participant-identity-changed`);
    for (const error of compositionSampleVerdict(sample, tolerancePx).errors) {
      errors.push(`s${index}:${error}`);
    }
  }
  const committed = samples[samples.length - 1]?.phase === "committed";
  if (!committed) errors.push("commit-missing");
  if (motionMode === "snap") {
    const distinct = samples.reduce<CompositionRect[]>((frames, sample) => (
      frames.some((frame) => sameRect(frame, sample.slot.frame, tolerancePx))
        ? frames
        : [...frames, sample.slot.frame]
    ), []);
    if (distinct.length > 2) errors.push(`snap-intermediate-frames=${distinct.length}`);
  }
  return { ok: errors.length === 0, errors, samples: samples.length, committed, motionMode };
}
