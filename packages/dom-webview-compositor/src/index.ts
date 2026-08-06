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
  physical?: "device-px";
  scaleFactor: number;
}

/**
 * A frame is comparable only inside one declared origin and one concrete reference owner.
 * Unit/scale alone cannot distinguish a presenter-local rect from a window rect.
 */
export interface CompositionReferencedCoordinateSpace extends CompositionCoordinateSpace {
  origin: "presenter-local" | "window-absolute";
  referenceId: string;
}

export interface CompositionReferencedFrame {
  frame: CompositionRect;
  coordinateSpace: CompositionReferencedCoordinateSpace;
}

export interface CompositionObservedFrame {
  id: string;
  viewId: string;
  topologyPath: string;
  visible: true;
  logicalFrame: CompositionRect;
  physicalFrame: CompositionRect;
}

/**
 * 세 집합을 독립 열거해야 누락된 native surface를 matched pair에서 숨길 수 없다.
 * 각 adapter는 같은 시점의 공개 상태를 이 중립 inventory로 정규화한다.
 */
export interface CompositionInventory {
  coordinateSpace: CompositionCoordinateSpace & { physical: "device-px" };
  /** UI가 공개한 visible browser owner의 완전한 집합. */
  visibleViewIds: string[];
  slots: CompositionObservedFrame[];
  renderers: CompositionObservedFrame[];
  surfaces: CompositionObservedFrame[];
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

export interface CompositionTimelineSample {
  sequence: number;
  sampledAtUnixMs: number;
  frame: CompositionRect;
}

export interface CompositionTimeline {
  coordinateSpace: CompositionCoordinateSpace;
  startAtUnixMs: number;
  durationMs: number;
  timingFunction: readonly [number, number, number, number];
  from: CompositionRect;
  to: CompositionRect;
  slot: readonly CompositionTimelineSample[];
  renderer: readonly CompositionTimelineSample[];
  surface: readonly CompositionTimelineSample[];
}

export function rectDelta(a: CompositionRect, b: CompositionRect): CompositionRect {
  return {
    x: Math.abs(a.x - b.x),
    y: Math.abs(a.y - b.y),
    w: Math.abs(a.w - b.w),
    h: Math.abs(a.h - b.h),
  };
}

export function sameRect(a: CompositionRect, b: CompositionRect): boolean {
  return Object.values(rectDelta(a, b)).every((value) => value === 0);
}

function cubicBezierCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first
    + 3 * inverse * t * t * second
    + t * t * t;
}

function cubicBezierProgress(
  progress: number,
  [x1, y1, x2, y2]: readonly [number, number, number, number],
): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let low = 0;
  let high = 1;
  // CSS cubic-bezier의 x는 0..1 단조다. 고정 반복은 시간 tolerance가 아니라 동일 입력에
  // 동일한 곡선 좌표를 내는 수치 해석이며, 최종 판정은 device-pixel exact다.
  for (let index = 0; index < 48; index += 1) {
    const candidate = (low + high) / 2;
    if (cubicBezierCoordinate(candidate, x1, x2) < progress) low = candidate;
    else high = candidate;
  }
  return cubicBezierCoordinate((low + high) / 2, y1, y2);
}

function timelineFrameAt(timeline: CompositionTimeline, sampledAtUnixMs: number): CompositionRect {
  const linear = Math.max(0, Math.min(
    1,
    (sampledAtUnixMs - timeline.startAtUnixMs) / timeline.durationMs,
  ));
  const progress = cubicBezierProgress(linear, timeline.timingFunction);
  return {
    x: timeline.from.x + (timeline.to.x - timeline.from.x) * progress,
    y: timeline.from.y + (timeline.to.y - timeline.from.y) * progress,
    w: timeline.from.w + (timeline.to.w - timeline.from.w) * progress,
    h: timeline.from.h + (timeline.to.h - timeline.from.h) * progress,
  };
}

/**
 * 서로 다른 display cadence를 nearest-neighbour로 가짜 1:1 결합하지 않는다. 각 producer의
 * 실제 표시 epoch에서 같은 선언 궤적을 device-pixel exact로 따르는지 독립 판정하고, native
 * renderer/surface producer끼리는 동일 사건을 1:1로 대조한다.
 */
export function compositionTimelineVerdict(timeline: CompositionTimeline) {
  const errors: string[] = [];
  const scaleFactor = Number(timeline.coordinateSpace?.scaleFactor);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) errors.push(`scaleFactor=${scaleFactor}`);
  if (!Number.isFinite(timeline.startAtUnixMs)) errors.push(`startAtUnixMs=${timeline.startAtUnixMs}`);
  if (!Number.isFinite(timeline.durationMs) || timeline.durationMs <= 0) {
    errors.push(`durationMs=${timeline.durationMs}`);
  }
  if (timeline.timingFunction.length !== 4
      || timeline.timingFunction.some((value) => !Number.isFinite(value))) {
    errors.push(`timingFunction=${timeline.timingFunction.join(",")}`);
  }
  if (errors.length) return { ok: false, errors };

  const endAtUnixMs = timeline.startAtUnixMs + timeline.durationMs;
  const inspect = (name: "slot" | "renderer" | "surface") => {
    const samples = timeline[name];
    if (samples.length < 3) {
      errors.push(`${name}:samples=${samples.length}/3`);
      return;
    }
    for (const [index, sample] of samples.entries()) {
      if (sample.sequence !== index) errors.push(`${name}[${index}]:sequence=${sample.sequence}/${index}`);
      if (!Number.isFinite(sample.sampledAtUnixMs)
          || (index > 0 && sample.sampledAtUnixMs <= samples[index - 1].sampledAtUnixMs)) {
        errors.push(`${name}[${index}]:sampledAtUnixMs=${sample.sampledAtUnixMs}`);
        continue;
      }
      const expected = logicalRectToPhysical(
        timelineFrameAt(timeline, sample.sampledAtUnixMs),
        scaleFactor,
      );
      const actual = logicalRectToPhysical(sample.frame, scaleFactor);
      if (!sameRect(expected, actual)) {
        errors.push(`${name}[${index}]=${JSON.stringify(rectDelta(expected, actual))}`);
      }
    }
    if (samples[0].sampledAtUnixMs > timeline.startAtUnixMs) {
      errors.push(`${name}:start-coverage=${samples[0].sampledAtUnixMs}/${timeline.startAtUnixMs}`);
    }
    if (samples.at(-1)!.sampledAtUnixMs < endAtUnixMs) {
      errors.push(`${name}:end-coverage=${samples.at(-1)!.sampledAtUnixMs}/${endAtUnixMs}`);
    }
    if (!samples.some(({ sampledAtUnixMs }) => (
      sampledAtUnixMs > timeline.startAtUnixMs && sampledAtUnixMs < endAtUnixMs
    ))) errors.push(`${name}:intermediate=0`);
    const gaps = samples.slice(1).map((sample, index) => (
      sample.sampledAtUnixMs - samples[index].sampledAtUnixMs
    )).sort((left, right) => left - right);
    const cadence = gaps[Math.floor(gaps.length / 2)];
    if (gaps.at(-1)! > cadence * 1.75) {
      errors.push(`${name}:display-gap=${gaps.at(-1)}/${cadence}`);
    }
  };
  inspect("slot");
  inspect("renderer");
  inspect("surface");

  if (timeline.renderer.length !== timeline.surface.length) {
    errors.push(`native-pairs=${timeline.renderer.length}/${timeline.surface.length}`);
  } else {
    for (const [index, renderer] of timeline.renderer.entries()) {
      const surface = timeline.surface[index];
      if (renderer.sampledAtUnixMs !== surface.sampledAtUnixMs) {
        errors.push(`native-pair[${index}]:epoch=${renderer.sampledAtUnixMs}/${surface.sampledAtUnixMs}`);
      }
      const rendererFrame = logicalRectToPhysical(renderer.frame, scaleFactor);
      const surfaceFrame = logicalRectToPhysical(surface.frame, scaleFactor);
      if (!sameRect(rendererFrame, surfaceFrame)) {
        errors.push(`native-pair[${index}]:frame=${JSON.stringify(rectDelta(rendererFrame, surfaceFrame))}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Compare frames only after their adapters have projected them into the same declared space.
 * The verdict permits nearest-device-pixel edge rounding and no arbitrary tolerance.
 */
export function compositionFrameComparisonVerdict({
  expected,
  actual,
}: {
  expected: CompositionReferencedFrame;
  actual: CompositionReferencedFrame;
}) {
  const errors: string[] = [];
  const expectedSpace = expected?.coordinateSpace;
  const actualSpace = actual?.coordinateSpace;
  if (expectedSpace?.logical !== "css-px" || actualSpace?.logical !== "css-px") {
    errors.push(`coordinate-logical=${expectedSpace?.logical}/${actualSpace?.logical}`);
  }
  if (expectedSpace?.origin !== actualSpace?.origin) {
    errors.push(`coordinate-origin=${expectedSpace?.origin}/${actualSpace?.origin}`);
  }
  if (expectedSpace?.referenceId !== actualSpace?.referenceId) {
    errors.push(`coordinate-reference=${expectedSpace?.referenceId}/${actualSpace?.referenceId}`);
  }
  const expectedScale = Number(expectedSpace?.scaleFactor);
  const actualScale = Number(actualSpace?.scaleFactor);
  if (!Number.isFinite(expectedScale) || expectedScale <= 0
      || !Number.isFinite(actualScale) || actualScale <= 0
      || expectedScale !== actualScale) {
    errors.push(`coordinate-scale=${expectedSpace?.scaleFactor}/${actualSpace?.scaleFactor}`);
  }
  if (!validLogicalRect(expected?.frame)) errors.push("expected-frame=finite-positive");
  if (!validLogicalRect(actual?.frame)) errors.push("actual-frame=finite-positive");
  if (errors.length > 0) return { ok: false, errors, delta: null };

  const expectedPhysical = logicalRectToPhysical(expected.frame, expectedScale);
  const actualPhysical = logicalRectToPhysical(actual.frame, actualScale);
  const delta = rectDelta(expectedPhysical, actualPhysical);
  if (!sameRect(expectedPhysical, actualPhysical)) {
    errors.push(`frame=${displayRect(expectedPhysical)}/${displayRect(actualPhysical)}`);
  }
  return { ok: errors.length === 0, errors, delta };
}

/**
 * 논리 rect의 네 모서리를 가장 가까운 물리 픽셀에 한 번만 반올림한다.
 * 폭/높이를 따로 반올림하지 않아 인접 rect가 같은 물리 경계를 공유한다.
 */
export function logicalRectToPhysical(frame: CompositionRect, scaleFactor: number): CompositionRect {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new RangeError(`scaleFactor must be finite and positive: ${scaleFactor}`);
  }
  const left = Math.round(frame.x * scaleFactor);
  const top = Math.round(frame.y * scaleFactor);
  const right = Math.round((frame.x + frame.w) * scaleFactor);
  const bottom = Math.round((frame.y + frame.h) * scaleFactor);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function validLogicalRect(value: unknown): value is CompositionRect {
  const rect = value as CompositionRect | undefined;
  return rect != null
    && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
    && rect.w > 0
    && rect.h > 0;
}

function validPhysicalRect(value: unknown): value is CompositionRect {
  const rect = value as CompositionRect | undefined;
  return validLogicalRect(rect)
    && [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
}

function displayRect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function observedFrames(
  kind: "slot" | "renderer" | "surface",
  values: unknown,
  scaleFactor: number,
  errors: string[],
): Map<string, CompositionObservedFrame> {
  const byView = new Map<string, CompositionObservedFrame>();
  const ids = new Set<string>();
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${kind}s=non-empty`);
    return byView;
  }
  for (const [index, raw] of values.entries()) {
    const value = raw as CompositionObservedFrame | undefined;
    const at = `${kind}s[${index}]`;
    if (value == null || typeof value !== "object") {
      errors.push(`${at}=record`);
      continue;
    }
    if (typeof value.id !== "string" || value.id.length === 0 || ids.has(value.id)) {
      errors.push(`${at}.id=unique-non-empty`);
    } else {
      ids.add(value.id);
    }
    if (typeof value.viewId !== "string" || value.viewId.length === 0 || byView.has(value.viewId)) {
      errors.push(`${at}.viewId=unique-non-empty`);
    } else {
      byView.set(value.viewId, value);
    }
    if (typeof value.topologyPath !== "string" || value.topologyPath.length === 0) {
      errors.push(`${at}.topologyPath=non-empty`);
    }
    if (value.visible !== true) errors.push(`${at}.visible=true`);
    if (!validLogicalRect(value.logicalFrame)) {
      errors.push(`${at}.logicalFrame=finite-positive`);
    }
    if (!validPhysicalRect(value.physicalFrame)) {
      errors.push(`${at}.physicalFrame=integer-positive`);
    }
    if (validLogicalRect(value.logicalFrame) && validPhysicalRect(value.physicalFrame)) {
      const rounded = logicalRectToPhysical(value.logicalFrame, scaleFactor);
      if (!sameRect(rounded, value.physicalFrame)) {
        errors.push(`${at}:physical-rounding=${displayRect(rounded)}/${displayRect(value.physicalFrame)}`);
      }
    }
  }
  return byView;
}

/** 독립적으로 열거한 visible slot·renderer·surface의 1:1 소유권과 양 좌표계를 판정한다. */
export function compositionInventoryVerdict(inventory: CompositionInventory) {
  const errors: string[] = [];
  const coordinateSpace = inventory?.coordinateSpace;
  const scaleFactor = Number(coordinateSpace?.scaleFactor);
  if (coordinateSpace?.logical !== "css-px") errors.push(`logical=${coordinateSpace?.logical}/css-px`);
  if (coordinateSpace?.physical !== "device-px") errors.push(`physical=${coordinateSpace?.physical}/device-px`);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    errors.push(`scaleFactor=${coordinateSpace?.scaleFactor}`);
    return { ok: false, errors, matched: 0, scaleFactor };
  }

  const slots = observedFrames("slot", inventory?.slots, scaleFactor, errors);
  const renderers = observedFrames("renderer", inventory?.renderers, scaleFactor, errors);
  const surfaces = observedFrames("surface", inventory?.surfaces, scaleFactor, errors);
  const visibleViewIds = Array.isArray(inventory?.visibleViewIds)
    ? inventory.visibleViewIds
    : [];
  if (visibleViewIds.length === 0
      || visibleViewIds.some((viewId) => typeof viewId !== "string" || viewId.length === 0)
      || new Set(visibleViewIds).size !== visibleViewIds.length) {
    errors.push("visibleViewIds=unique-non-empty");
  }
  const visibleOwners = [...visibleViewIds].sort();
  const slotOwners = [...slots.keys()].sort();
  const rendererOwners = [...renderers.keys()].sort();
  const surfaceOwners = [...surfaces.keys()].sort();
  if (visibleOwners.join("\u0000") !== slotOwners.join("\u0000")
      || slotOwners.join("\u0000") !== rendererOwners.join("\u0000")
      || slotOwners.join("\u0000") !== surfaceOwners.join("\u0000")) {
    errors.push(`visible-owners=${visibleOwners.join(",")}/${slotOwners.join(",")}/${rendererOwners.join(",")}/${surfaceOwners.join(",")}`);
  }

  let matched = 0;
  for (const viewId of slotOwners) {
    const slot = slots.get(viewId);
    const renderer = renderers.get(viewId);
    const surface = surfaces.get(viewId);
    if (!slot || !renderer || !surface) continue;
    matched += 1;
    const topologies = [slot.topologyPath, renderer.topologyPath, surface.topologyPath];
    if (new Set(topologies).size !== 1) {
      errors.push(`${viewId}:topology=${topologies.join("/")}`);
    }
    if (!sameRect(slot.physicalFrame, renderer.physicalFrame)) {
      errors.push(`${viewId}:renderer-frame=${displayRect(slot.physicalFrame)}/${displayRect(renderer.physicalFrame)}`);
    }
    if (!sameRect(slot.physicalFrame, surface.physicalFrame)) {
      errors.push(`${viewId}:surface-frame=${displayRect(slot.physicalFrame)}/${displayRect(surface.physicalFrame)}`);
    }
  }
  return { ok: errors.length === 0, errors, matched, scaleFactor };
}

/** 한 sample에서 공개 slot, plugin renderer, native surface가 반올림 외 차이 없이 같은지 판정한다. */
export function compositionSampleVerdict(sample: CompositionSample) {
  const errors: string[] = [];
  if (!Number.isFinite(sample.coordinateSpace.scaleFactor) || sample.coordinateSpace.scaleFactor <= 0) {
    errors.push(`scaleFactor=${sample.coordinateSpace.scaleFactor}`);
    return {
      ok: false,
      rounding: "nearest-device-pixel-edges",
      rendererDelta: rectDelta(sample.slot.frame, sample.renderer.frame),
      surfaceDelta: rectDelta(sample.slot.frame, sample.surface.frame),
      errors,
    };
  }
  const slotPhysical = logicalRectToPhysical(sample.slot.frame, sample.coordinateSpace.scaleFactor);
  const rendererPhysical = logicalRectToPhysical(sample.renderer.frame, sample.coordinateSpace.scaleFactor);
  const surfacePhysical = logicalRectToPhysical(sample.surface.frame, sample.coordinateSpace.scaleFactor);
  const rendererDelta = rectDelta(slotPhysical, rendererPhysical);
  const surfaceDelta = rectDelta(slotPhysical, surfacePhysical);
  if (!sameRect(slotPhysical, rendererPhysical)) {
    errors.push(`renderer=${JSON.stringify(rendererDelta)}`);
  }
  if (!sameRect(slotPhysical, surfacePhysical)) {
    errors.push(`surface=${JSON.stringify(surfaceDelta)}`);
  }
  return { ok: errors.length === 0, rounding: "nearest-device-pixel-edges", rendererDelta, surfaceDelta, errors };
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
  { motionMode }: { motionMode: CompositionMotionMode },
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
    for (const error of compositionSampleVerdict(sample).errors) {
      errors.push(`s${index}:${error}`);
    }
  }
  const committed = samples[samples.length - 1]?.phase === "committed";
  if (!committed) errors.push("commit-missing");
  if (motionMode === "snap") {
    const distinct = samples.reduce<CompositionRect[]>((frames, sample) => (
      frames.some((frame) => sameRect(
        frame,
        logicalRectToPhysical(sample.slot.frame, sample.coordinateSpace.scaleFactor),
      ))
        ? frames
        : [...frames, logicalRectToPhysical(sample.slot.frame, sample.coordinateSpace.scaleFactor)]
    ), []);
    if (distinct.length > 2) errors.push(`snap-intermediate-frames=${distinct.length}`);
  }
  return { ok: errors.length === 0, errors, samples: samples.length, committed, motionMode };
}
