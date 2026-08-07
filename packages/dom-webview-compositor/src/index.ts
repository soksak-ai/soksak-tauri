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

/**
 * 선언된 궤적이 한 epoch에서 주장하는 frame. 관측을 이 값과 대조하는 쪽과 이 값으로
 * 픽스처를 짓는 쪽이 서로 다른 곡선을 쓰면 판정은 자기 자신을 검사하지 못한다.
 */
export function compositionTimelineFrameAt(
  timeline: Pick<
    CompositionTimeline,
    "startAtUnixMs" | "durationMs" | "timingFunction" | "from" | "to"
  >,
  sampledAtUnixMs: number,
): CompositionRect {
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

function physicalEdgeDelta(
  expected: CompositionRect,
  actual: CompositionRect,
  scaleFactor: number,
): CompositionRect {
  return {
    x: Math.abs(expected.x - actual.x) * scaleFactor,
    y: Math.abs(expected.y - actual.y) * scaleFactor,
    w: Math.abs((expected.x + expected.w) - (actual.x + actual.w)) * scaleFactor,
    h: Math.abs((expected.y + expected.h) - (actual.y + actual.h)) * scaleFactor,
  };
}

export interface CompositionObservationWindow {
  startAtUnixMs: number;
  endAtUnixMs: number;
}

export interface CompositionObservationSpan {
  /** 표본을 낸 관측 주체 이름. framework/engine 이름을 싣지 않는다. */
  producer: string;
  firstSampledAtUnixMs: number;
  lastSampledAtUnixMs: number;
}

/**
 * 한 거래를 함께 관측했다는 주장은 그 거래 구간과 겹치는 표본으로만 성립한다. `...UnixMs`라는
 * 같은 이름은 같은 epoch를 뜻하지 않으므로, 두 producer의 시각을 빼기 전에 각 관측 구간이
 * 거래 구간과 만나는지 먼저 판정한다. 판정은 tolerance가 아니라 교집합 유무이며, 겹치지 않는
 * 관측은 좌표 delta 대신 그 거리를 그대로 남긴다. 겹치는 구간의 길이는 요구하지 않는다.
 */
export function compositionObservationWindowVerdict(
  window: CompositionObservationWindow,
  producers: readonly CompositionObservationSpan[],
): { ok: boolean; errors: string[]; gapMs: Record<string, number> } {
  const errors: string[] = [];
  const gapMs: Record<string, number> = {};
  const startAtUnixMs = Number(window?.startAtUnixMs);
  const endAtUnixMs = Number(window?.endAtUnixMs);
  if (!Number.isFinite(startAtUnixMs) || !Number.isFinite(endAtUnixMs)
      || endAtUnixMs < startAtUnixMs) {
    errors.push(`window=${window?.startAtUnixMs}/${window?.endAtUnixMs}`);
    return { ok: false, errors, gapMs };
  }
  for (const span of producers ?? []) {
    const producer = span?.producer;
    if (typeof producer !== "string" || producer.length === 0) {
      errors.push("producer=non-empty");
      continue;
    }
    const first = Number(span?.firstSampledAtUnixMs);
    const last = Number(span?.lastSampledAtUnixMs);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
      errors.push(`${producer}:span=${span?.firstSampledAtUnixMs}/${span?.lastSampledAtUnixMs}`);
      continue;
    }
    const gap = last < startAtUnixMs
      ? startAtUnixMs - last
      : first > endAtUnixMs ? first - endAtUnixMs : 0;
    gapMs[producer] = gap;
    if (gap > 0) errors.push(`${producer}:window-gap=${gap}`);
  }
  return { ok: errors.length === 0, errors, gapMs };
}

function observationSpan(
  producer: string,
  samples: readonly CompositionTimelineSample[],
): CompositionObservationSpan | null {
  const times = (Array.isArray(samples) ? samples : [])
    .map((sample) => Number(sample?.sampledAtUnixMs))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) return null;
  return {
    producer,
    // 순서는 sample 판정이 따로 요구한다. 구간은 관측 집합의 사실이므로 최소/최대로 읽는다.
    firstSampledAtUnixMs: Math.min(...times),
    lastSampledAtUnixMs: Math.max(...times),
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
  // 좌표 delta보다 먼저 관측 구간을 본다. 거래 밖에서 관측한 producer의 좌표 오차는 궤적이
  // 아니라 epoch 차이를 재는 값이 되어, 실제 결함을 다른 이름으로 덮는다.
  const observation = compositionObservationWindowVerdict(
    { startAtUnixMs: timeline.startAtUnixMs, endAtUnixMs },
    (["slot", "renderer", "surface"] as const)
      .map((name) => observationSpan(name, timeline[name]))
      .filter((span): span is CompositionObservationSpan => span !== null),
  );
  errors.push(...observation.errors);
  // 관측자의 생존은 판정의 입력이 아니다. presentation-frame 표본은 rAF 가 내고, WebKit 은
  // 가려지거나 포커스 없는 창에서 rAF 를 멈춘다 — 그것은 관측의 한계이지 DOM 이 안 움직였다는
  // 증거가 아니다. 표본이 없는 producer 를 실패로 적으면 다른 창이 위에 있느냐가 green/red 를
  // 가른다. 잰 값과 못 잼은 다른 답이므로 다른 자리에 적는다.
  const unmeasured: string[] = [];
  const inspect = (name: "slot" | "renderer" | "surface") => {
    if (observation.gapMs[name] > 0) return;
    const samples = timeline[name];
    if (samples.length < 3) {
      unmeasured.push(name);
      return;
    }
    for (const [index, sample] of samples.entries()) {
      if (sample.sequence !== index) errors.push(`${name}[${index}]:sequence=${sample.sequence}/${index}`);
      if (!Number.isFinite(sample.sampledAtUnixMs)
          || (index > 0 && sample.sampledAtUnixMs <= samples[index - 1].sampledAtUnixMs)) {
        errors.push(`${name}[${index}]:sampledAtUnixMs=${sample.sampledAtUnixMs}`);
        continue;
      }
      const expected = compositionTimelineFrameAt(timeline, sample.sampledAtUnixMs);
      const delta = physicalEdgeDelta(expected, sample.frame, scaleFactor);
      // 두 독립 compositor가 같은 연속 좌표를 각각 nearest device pixel로 양자화한다.
      // 0.5 physical px는 임의 tolerance가 아니라 반올림 자체가 만들 수 있는 최대 오차다.
      if (Object.values(delta).some((value) => value > 0.5 + Number.EPSILON)) {
        errors.push(`${name}[${index}]=${JSON.stringify(delta)}`);
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
    // 구멍은 프레임 단위로 센다. 고정 비율 문턱은 프레임 하나가 통째로 빠지는 값보다 아래라
    // "늦은 프레임"과 "빠진 프레임"을 못 가르고, 그 경계에서 지터가 판정을 갈랐다.
    //
    // 규칙은 새로 세우지 않는다 — native 표시 원장이 쓰는 것과 같다(presentation_trace.rs):
    // 직전 표시 시각 + 주기/2 를 넘으면 그 초과분을 주기로 나눠 반올림한 수가 빠진 프레임 수다.
    // 기준 주기는 그 판이 실어 보낸 refreshIntervalMs 이며, 고정값으로 나누면 가변 주사율에서
    // 정상 프레임이 건너뜀으로 둔갑한다.
    // 기준 주기는 이 열 자신의 것이다. 열마다 주기가 다르므로(DOM 60Hz, native 120Hz) 한 값으로
    // 세 열을 재면 정상 프레임이 건너뜀으로 둔갑한다. 그 판이 주기를 실어 보냈으면 그것을 쓰고,
    // 없으면 이 열 간격의 중앙값을 쓴다 — 중앙값은 구멍 하나에 끌려가지 않는다.
    const deltas = samples.slice(1)
      .map((sample, index) => sample.sampledAtUnixMs - samples[index].sampledAtUnixMs)
      .sort((left, right) => left - right);
    const declared = Number(timeline.refreshIntervalMs);
    const interval = Number.isFinite(declared) && declared > 0
      ? declared
      : deltas[Math.floor(deltas.length / 2)];
    const skipped = samples.slice(1).reduce((total, sample, index) => {
      const previous = samples[index].sampledAtUnixMs;
      const delta = sample.sampledAtUnixMs - previous;
      if (delta <= interval * 1.5) return total;
      return total + Math.max(1, Math.round(delta / interval) - 1);
    }, 0);
    if (skipped > 0) {
      errors.push(`${name}:skipped-display-epochs=${skipped}`);
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
  return { ok: errors.length === 0 && unmeasured.length === 0, errors, unmeasured };
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
