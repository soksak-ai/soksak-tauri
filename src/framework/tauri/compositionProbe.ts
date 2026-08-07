import { moduleState } from "../../lib/moduleState";

export interface DirectCompositionProbe {
  verdict: {
    misplaced: readonly unknown[];
    stacked: readonly unknown[];
    missing: readonly unknown[];
    unowned: readonly unknown[];
  };
}

export interface PaneCompositionProbe {
  matched: boolean;
  verdict: "green" | "red";
}

/**
 * resize 한 단계가 싣는 direct 평면. 판정(verdict) 옆에 그 판정을 낸 표면 목록을 그대로 둔다 —
 * bounds 를 누가 쓰는지(autoresizing mask·레이어 재그리기 정책)는 목록에만 있는 사실이라,
 * 여기서 떨어뜨리면 어긋난 frame 의 소유 축을 아무도 못 읽는다.
 */
export interface DirectResizeCompositionPlane extends DirectCompositionProbe {
  surfaces: readonly unknown[];
}

/**
 * resize 한 단계가 싣는 pane 평면. 허용 오차와 대조 목록을 판정과 함께 둔다 — 어긋난 delta 를
 * 수치로 읽으려면 그 delta 를 잰 기준이 같은 자리에 있어야 한다.
 */
export interface PaneResizeCompositionPlane extends PaneCompositionProbe {
  tolerancePx: number;
  matches: readonly unknown[];
}

export interface TitlebarCompositionProbe {
  nativeSequence: number;
  verdict: "green" | "red";
  checks: {
    count: boolean;
    order: boolean;
    nonOverlap: boolean;
    containment: boolean;
    oneToOne: boolean;
    verticalCenter: boolean;
    backingMatch: boolean;
  };
}

export type TauriCompositionProbeIssue =
  | "invalid-generation"
  | "invalid-sample-time"
  | "direct-missing"
  | "direct-red"
  | "pane-missing"
  | "pane-red"
  | "titlebar-missing"
  | "titlebar-red";

export interface TauriCompositionProbeInput<
  Direct extends DirectCompositionProbe = DirectCompositionProbe,
  Pane extends PaneCompositionProbe = PaneCompositionProbe,
  Titlebar extends TitlebarCompositionProbe = TitlebarCompositionProbe,
> {
  /** One invocation of the post-resize observer. All included planes belong to this generation. */
  generation: number;
  sampledAtUnixMs: number;
  direct: Direct | null;
  pane: Pane | null;
  /** Absent outside the macOS AppKit boundary; present-null is a missing receipt and therefore RED. */
  titlebar?: Titlebar | null;
}

const generationState = moduleState("framework/tauri/resizeCompositionProbe#generation", () => ({
  value: 0,
}));

/** HMR-safe process-local generation for finite post-resize observations. */
export function nextTauriCompositionProbeGeneration(): number {
  if (!Number.isSafeInteger(generationState.value) || generationState.value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Tauri composition probe generation exhausted");
  }
  generationState.value += 1;
  return generationState.value;
}

/**
 * A resize sample is one ledger, not three unrelated best-effort diagnostics. The native resize
 * transaction has already committed when this observer is called; it reads every applicable Tauri
 * plane under one monotonically increasing generation. Missing facts stay in the receipt and make
 * it RED. The macOS-only titlebar key does not exist on platforms where its native command does not.
 */
export function combineTauriCompositionProbe<
  Direct extends DirectCompositionProbe,
  Pane extends PaneCompositionProbe,
  Titlebar extends TitlebarCompositionProbe,
>(input: TauriCompositionProbeInput<Direct, Pane, Titlebar>) {
  const issues: TauriCompositionProbeIssue[] = [];
  const generationValid = Number.isSafeInteger(input.generation) && input.generation > 0;
  const sampleTimeValid = Number.isSafeInteger(input.sampledAtUnixMs) && input.sampledAtUnixMs >= 0;
  if (!generationValid) issues.push("invalid-generation");
  if (!sampleTimeValid) issues.push("invalid-sample-time");

  const direct = input.direct;
  const directGreen = direct !== null
    && direct.verdict.misplaced.length === 0
    && direct.verdict.stacked.length === 0
    && direct.verdict.missing.length === 0
    && direct.verdict.unowned.length === 0;
  if (direct === null) issues.push("direct-missing");
  else if (!directGreen) issues.push("direct-red");

  const pane = input.pane;
  const paneGreen = pane !== null && pane.matched && pane.verdict === "green";
  if (pane === null) issues.push("pane-missing");
  else if (!paneGreen) issues.push("pane-red");

  const titlebarExpected = Object.prototype.hasOwnProperty.call(input, "titlebar");
  const titlebar = titlebarExpected ? input.titlebar ?? null : undefined;
  const titlebarGreen = titlebar !== null
    && titlebar !== undefined
    && Number.isSafeInteger(titlebar.nativeSequence)
    && titlebar.nativeSequence > 0
    && titlebar.verdict === "green"
    && Object.values(titlebar.checks).every((check) => check === true);
  if (titlebarExpected && titlebar === null) issues.push("titlebar-missing");
  else if (titlebarExpected && !titlebarGreen) issues.push("titlebar-red");

  const checks = {
    generation: generationValid && sampleTimeValid,
    direct: directGreen,
    pane: paneGreen,
    ...(titlebarExpected ? { titlebar: titlebarGreen } : {}),
  };
  return {
    schemaVersion: 1 as const,
    kind: "tauri-resize-composition-sample" as const,
    generation: input.generation,
    sampledAtUnixMs: input.sampledAtUnixMs,
    direct,
    pane,
    ...(titlebarExpected ? { titlebar } : {}),
    checks,
    issues,
    verdict: issues.length === 0 && Object.values(checks).every(Boolean)
      ? "green" as const
      : "red" as const,
  };
}
