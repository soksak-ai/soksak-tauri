// 창 resize 관측 봉투 — 한 축은 한 이름으로만 불린다.
//
// resize 는 두 사실이 만나는 자리다. **요청**(어떤 크기를 시켰나)과 **관측**(그래서 무엇이
// 됐나)이며, 이 둘은 절대 같은 값에서 나오면 안 된다. 요청 크기를 관측 자리에 베끼면 관측은
// 항상 성공하고 판정은 언제나 통과한다. 그래서 관측자에게는 요청 크기를 **주지 않는다**
// (ResizeProbeRequest 에는 size 가 없다). 요청면은 코어가 자기 요청에서 채우고, 창 기하는
// 코어가 중립 창 표면(FrameworkWindowHandle)에서 직접 잰다.
//
// 남은 관측면 — 사건 세대, 거래 세대, 보이는 뷰, 세 평면(slot/renderer/surface)의 frame,
// presentation 연속 — 은 프레임워크마다 재는 물건이 다르므로 각 어댑터가 채운다. 어댑터가
// 이 계약을 어기면 조용히 통과하지 않고 위반한 자리 이름이 봉투에 실린다.
import { currentWindow } from "../framework";
import { moduleState } from "./moduleState";

export interface PhysicalWindowSize {
  w: number;
  h: number;
}

/** 물리 픽셀 사각형. 논리(css-px)와 물리(device-px)는 서로 다른 축이라 섞어 싣지 않는다. */
export interface ResizeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 적대적 resize 한 단계의 의도. 호출자가 선언하고 관측이 대조한다 — 관측 기하에서 역산하면
 * 그 대조는 자기 자신과의 비교라 아무것도 걸러내지 못한다.
 */
export type ResizeTransactionPhase = "shrink" | "wide" | "tall" | "restore";

export const RESIZE_TRANSACTION_PHASES = [
  "shrink", "wide", "tall", "restore",
] as const satisfies readonly ResizeTransactionPhase[];

export type ResizeSequenceStep = PhysicalWindowSize & { phase?: ResizeTransactionPhase };

/** 유한 resize 거래가 관측면에 넘기는 요청. baseline 은 아직 아무 크기도 요청되지 않은 자리다. */
export type ResizeObservationRequest =
  | { readonly kind: "baseline" }
  | {
      readonly kind: "step";
      readonly step: number;
      readonly size: PhysicalWindowSize;
      readonly phase?: ResizeTransactionPhase;
    };

/** 관측자가 받는 것. 요청 크기는 없다 — 베낄 통로 자체를 두지 않는다. */
export type ResizeProbeRequest =
  | { readonly kind: "baseline" }
  | { readonly kind: "step"; readonly step: number };

export interface ResizeCompositionParticipant {
  /** 이 평면이 공개한 참여자 식별자. 거래 중 바뀌면 그 표면은 교체된 것이다. */
  id: string;
  viewId: string;
  topologyPath: string;
  visible: boolean;
  logicalFrame: ResizeRect;
  physicalFrame: ResizeRect;
}

export interface ResizePresentation {
  viewId: string;
  surfaceId: string;
  surfaceGeneration: number;
  /** 이 표면이 실제로 표시한 프레임 수. 거래마다 커져야 연속이다. */
  revision: number;
  live: boolean;
  visible: boolean;
  presented: boolean;
}

export interface ResizeContinuityCounters {
  replacements: number;
  gaps: number;
  disappearances: number;
  unpresented: number;
}

/** 어댑터가 답하는 관측면. windowGeometry 는 여기 없다 — 코어가 중립 창 표면에서 잰다. */
export interface ResizeCompositionObservation {
  eventGeneration: number;
  transactionGeneration: number;
  visibleViewIds: string[];
  slots: ResizeCompositionParticipant[];
  renderers: ResizeCompositionParticipant[];
  surfaces: ResizeCompositionParticipant[];
  presentations: ResizePresentation[];
  eventGenerationBefore: number;
  eventGenerationAfter: number;
  continuity: {
    countersBefore: ResizeContinuityCounters;
    countersAfter: ResizeContinuityCounters;
  };
}

export interface ResizeObservationSnapshot {
  windowGeometry: ResizeRect;
  eventGeneration: number;
  transactionGeneration: number;
  visibleViewIds: string[];
  slots: ResizeCompositionParticipant[];
  renderers: ResizeCompositionParticipant[];
  surfaces: ResizeCompositionParticipant[];
  presentations: ResizePresentation[];
}

export interface ResizeObservation {
  phase: ResizeTransactionPhase | null;
  requestedWindowGeometry: ResizeRect | null;
  eventGenerationBefore: number;
  eventGenerationAfter: number;
  transactionGeneration: number;
  continuity: ResizeCompositionObservation["continuity"];
  snapshot: ResizeObservationSnapshot;
  /** 빈 배열만이 "계약대로"다. 어긴 자리는 그 자리 이름으로 실린다. */
  contractViolations: string[];
}

type AssertNever<T extends never> = T;

export const RESIZE_SNAPSHOT_KEYS = [
  "windowGeometry",
  "eventGeneration",
  "transactionGeneration",
  "visibleViewIds",
  "slots",
  "renderers",
  "surfaces",
  "presentations",
] as const satisfies readonly (keyof ResizeObservationSnapshot)[];
export type _SnapshotKeysComplete = AssertNever<
  Exclude<keyof ResizeObservationSnapshot, (typeof RESIZE_SNAPSHOT_KEYS)[number]>
>;

export const RESIZE_PARTICIPANT_KEYS = [
  "id", "viewId", "topologyPath", "visible", "logicalFrame", "physicalFrame",
] as const satisfies readonly (keyof ResizeCompositionParticipant)[];
export type _ParticipantKeysComplete = AssertNever<
  Exclude<keyof ResizeCompositionParticipant, (typeof RESIZE_PARTICIPANT_KEYS)[number]>
>;

export const RESIZE_PRESENTATION_KEYS = [
  "viewId", "surfaceId", "surfaceGeneration", "revision", "live", "visible", "presented",
] as const satisfies readonly (keyof ResizePresentation)[];
export type _PresentationKeysComplete = AssertNever<
  Exclude<keyof ResizePresentation, (typeof RESIZE_PRESENTATION_KEYS)[number]>
>;

export const RESIZE_COUNTER_KEYS = [
  "replacements", "gaps", "disappearances", "unpresented",
] as const satisfies readonly (keyof ResizeContinuityCounters)[];
export type _CounterKeysComplete = AssertNever<
  Exclude<keyof ResizeContinuityCounters, (typeof RESIZE_COUNTER_KEYS)[number]>
>;

export const RESIZE_OBSERVATION_KEYS = [
  "phase",
  "requestedWindowGeometry",
  "eventGenerationBefore",
  "eventGenerationAfter",
  "transactionGeneration",
  "continuity",
  "snapshot",
  "contractViolations",
] as const satisfies readonly (keyof ResizeObservation)[];
export type _ObservationKeysComplete = AssertNever<
  Exclude<keyof ResizeObservation, (typeof RESIZE_OBSERVATION_KEYS)[number]>
>;

const RESIZE_RECT_KEYS = ["x", "y", "w", "h"] as const satisfies readonly (keyof ResizeRect)[];

function displayValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkRect(value: unknown, path: string, violations: string[], integer = false): void {
  if (!isRecord(value)) {
    violations.push(`${path}=rect/${displayValue(value)}`);
    return;
  }
  for (const key of RESIZE_RECT_KEYS) {
    const number = value[key];
    const positive = key === "w" || key === "h";
    if (typeof number !== "number"
      || !Number.isFinite(number)
      || (integer && !Number.isInteger(number))
      || (positive && number <= 0)) {
      violations.push(
        `${path}.${key}=${integer ? "integer" : "finite"}${positive ? ">0" : ""}`
          + `/${displayValue(number)}`,
      );
    }
  }
}

function checkGeneration(value: unknown, path: string, violations: string[]): boolean {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    violations.push(`${path}=integer>=0/${displayValue(value)}`);
    return false;
  }
  return true;
}

function checkParticipants(value: unknown, path: string, violations: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${path}=non-empty-array/${displayValue(value)}`);
    return;
  }
  const ids = new Set<unknown>();
  const viewIds = new Set<unknown>();
  value.forEach((participant, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(participant)) {
      violations.push(`${at}=record/${displayValue(participant)}`);
      return;
    }
    const extra = Object.keys(participant)
      .filter((key) => !(RESIZE_PARTICIPANT_KEYS as readonly string[]).includes(key));
    if (extra.length > 0) violations.push(`${at}=exact-keys/${displayValue(extra)}`);
    if (typeof participant.id !== "string" || participant.id.length === 0 || ids.has(participant.id)) {
      violations.push(`${at}.id=unique-non-empty/${displayValue(participant.id)}`);
    } else ids.add(participant.id);
    if (typeof participant.viewId !== "string"
      || participant.viewId.length === 0
      || viewIds.has(participant.viewId)) {
      violations.push(`${at}.viewId=unique-non-empty/${displayValue(participant.viewId)}`);
    } else viewIds.add(participant.viewId);
    if (typeof participant.topologyPath !== "string" || participant.topologyPath.length === 0) {
      violations.push(`${at}.topologyPath=non-empty/${displayValue(participant.topologyPath)}`);
    }
    if (participant.visible !== true) {
      violations.push(`${at}.visible=true/${displayValue(participant.visible)}`);
    }
    checkRect(participant.logicalFrame, `${at}.logicalFrame`, violations);
    checkRect(participant.physicalFrame, `${at}.physicalFrame`, violations, true);
  });
}

function checkPresentations(value: unknown, path: string, violations: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${path}=non-empty-array/${displayValue(value)}`);
    return;
  }
  const viewIds = new Set<unknown>();
  value.forEach((presentation, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(presentation)) {
      violations.push(`${at}=record/${displayValue(presentation)}`);
      return;
    }
    const extra = Object.keys(presentation)
      .filter((key) => !(RESIZE_PRESENTATION_KEYS as readonly string[]).includes(key));
    if (extra.length > 0) violations.push(`${at}=exact-keys/${displayValue(extra)}`);
    if (typeof presentation.viewId !== "string"
      || presentation.viewId.length === 0
      || viewIds.has(presentation.viewId)) {
      violations.push(`${at}.viewId=unique-non-empty/${displayValue(presentation.viewId)}`);
    } else viewIds.add(presentation.viewId);
    if (typeof presentation.surfaceId !== "string" || presentation.surfaceId.length === 0) {
      violations.push(`${at}.surfaceId=non-empty/${displayValue(presentation.surfaceId)}`);
    }
    for (const key of ["surfaceGeneration", "revision"] as const) {
      const number = presentation[key];
      if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
        violations.push(`${at}.${key}=integer>=1/${displayValue(number)}`);
      }
    }
    for (const key of ["live", "visible", "presented"] as const) {
      if (presentation[key] !== true) {
        violations.push(`${at}.${key}=true/${displayValue(presentation[key])}`);
      }
    }
  });
}

function checkCounters(value: unknown, path: string, violations: string[]): void {
  if (!isRecord(value)) {
    violations.push(`${path}=record/${displayValue(value)}`);
    return;
  }
  for (const key of RESIZE_COUNTER_KEYS) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
      violations.push(`${path}.${key}=integer>=0/${displayValue(number)}`);
    }
  }
}

/**
 * 어댑터가 답한 관측면을 계약과 대조한다. 반환은 **어긴 자리의 이름**이며, 빈 배열만이
 * 계약을 지켰다는 뜻이다. 같은 축을 다른 이름으로 부르면(transaction·generation) 그 축이
 * 비어 있다는 사실이 축 이름으로 드러난다.
 */
export function resizeCompositionViolations(
  value: unknown,
  { transaction = true }: { transaction?: boolean } = {},
): string[] {
  const violations: string[] = [];
  if (!isRecord(value)) {
    violations.push(`observation=record/${displayValue(value)}`);
    return violations;
  }
  checkGeneration(value.eventGeneration, "eventGeneration", violations);
  checkGeneration(value.transactionGeneration, "transactionGeneration", violations);
  const beforeValid = checkGeneration(
    value.eventGenerationBefore,
    "eventGenerationBefore",
    violations,
  );
  const afterValid = checkGeneration(
    value.eventGenerationAfter,
    "eventGenerationAfter",
    violations,
  );
  // 거래를 관측한 단계는 창 사건이 반드시 하나 이상 지나갔어야 한다. baseline 은 아직 아무
  // 거래도 없던 자리라 같은 세대에 머무는 것이 사실이다 — 이 둘을 한 기준으로 재면 둘 중
  // 하나는 거짓말이 된다.
  if (beforeValid && afterValid) {
    const before = value.eventGenerationBefore as number;
    const after = value.eventGenerationAfter as number;
    if (transaction ? !(after > before) : after < before) {
      violations.push(
        `eventGenerationAfter=${transaction ? ">" : ">="}eventGenerationBefore`
          + `/${displayValue(before)}/${displayValue(after)}`,
      );
    }
  }
  const visibleViewIds = value.visibleViewIds;
  if (!Array.isArray(visibleViewIds)
    || visibleViewIds.length === 0
    || visibleViewIds.some((viewId) => typeof viewId !== "string" || viewId.length === 0)
    || new Set(visibleViewIds).size !== visibleViewIds.length) {
    violations.push(`visibleViewIds=unique-non-empty-strings/${displayValue(visibleViewIds)}`);
  }
  checkParticipants(value.slots, "slots", violations);
  checkParticipants(value.renderers, "renderers", violations);
  checkParticipants(value.surfaces, "surfaces", violations);
  checkPresentations(value.presentations, "presentations", violations);
  if (!isRecord(value.continuity)) {
    violations.push(`continuity=record/${displayValue(value.continuity)}`);
  } else {
    checkCounters(value.continuity.countersBefore, "continuity.countersBefore", violations);
    checkCounters(value.continuity.countersAfter, "continuity.countersAfter", violations);
  }
  return violations;
}

/**
 * 요청면(코어)과 관측면(어댑터)을 한 봉투로 합친다.
 *
 * requestedWindowGeometry 는 요청 크기를 **관측한 창 원점**에 얹은 요청이고,
 * snapshot.windowGeometry 는 그 요청과 무관하게 잰 값이다. 둘이 다르면 그 차이가 결과다 —
 * 여기서 하나를 다른 하나로 채우면 resize 는 영원히 성공한다.
 */
export function composeResizeObservation({
  request,
  windowGeometry,
  observed,
}: {
  request: ResizeObservationRequest;
  windowGeometry: ResizeRect;
  observed: ResizeCompositionObservation;
}): ResizeObservation {
  const violations = resizeCompositionViolations(observed, { transaction: request.kind === "step" });
  checkRect(windowGeometry, "snapshot.windowGeometry", violations);
  if (request.kind === "step" && request.phase !== undefined
    && !(RESIZE_TRANSACTION_PHASES as readonly string[]).includes(request.phase)) {
    violations.push(`phase=known/${displayValue(request.phase)}`);
  }
  const source = observed as Partial<ResizeCompositionObservation>;
  return {
    phase: request.kind === "step" ? request.phase ?? null : null,
    requestedWindowGeometry: request.kind === "step"
      ? { x: windowGeometry.x, y: windowGeometry.y, w: request.size.w, h: request.size.h }
      : null,
    eventGenerationBefore: source.eventGenerationBefore as number,
    eventGenerationAfter: source.eventGenerationAfter as number,
    transactionGeneration: source.transactionGeneration as number,
    continuity: source.continuity as ResizeCompositionObservation["continuity"],
    snapshot: {
      windowGeometry,
      eventGeneration: source.eventGeneration as number,
      transactionGeneration: source.transactionGeneration as number,
      visibleViewIds: source.visibleViewIds as string[],
      slots: source.slots as ResizeCompositionParticipant[],
      renderers: source.renderers as ResizeCompositionParticipant[],
      surfaces: source.surfaces as ResizeCompositionParticipant[],
      presentations: source.presentations as ResizePresentation[],
    },
    contractViolations: violations,
  };
}

export type WindowResizeProbe = (
  request: ResizeProbeRequest,
) => Promise<ResizeCompositionObservation> | ResizeCompositionObservation;

const state = moduleState("lib/windowResizeProbe", () => ({ probe: null as WindowResizeProbe | null }));

/** 활성 프레임워크가 창 resize 직후 공개해야 하는 수치 사실을 연결한다. */
export function registerWindowResizeProbe(probe: WindowResizeProbe | null): void {
  state.probe = probe;
}

/** 창 물리 기하 — 프레임워크 이름이 아니라 중립 창 표면에 묻는다. */
async function observedWindowGeometry(): Promise<ResizeRect> {
  const win = currentWindow();
  const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  return { x: position.x, y: position.y, w: size.width, h: size.height };
}

/** probe 가 없는 프레임워크는 관측하지 않았다고 답한다 — 빈 사실을 지어내지 않는다. */
export async function sampleWindowResizeProbe(
  request: ResizeObservationRequest,
): Promise<ResizeObservation | null> {
  const probe = state.probe;
  if (!probe) return null;
  const observed = await probe(
    request.kind === "step" ? { kind: "step", step: request.step } : { kind: "baseline" },
  );
  return composeResizeObservation({
    request,
    windowGeometry: await observedWindowGeometry(),
    observed,
  });
}
