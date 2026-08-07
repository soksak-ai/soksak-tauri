// Tauri 의 resize 관측면 — 코어 계약이 요구하는 사실을 이 프레임워크의 원천에서 모은다.
//
// 창 사건은 프레임워크 창 표면이, pane 세 평면은 pane presentation 상태가 답한다. 요청 크기는
// 여기 들어오지 않는다(ResizeProbeRequest 에 크기가 없다) — 관측이 요청을 베낄 통로가 없다.
import type {
  ResizeCompositionObservation,
  ResizeContinuityCounters,
  ResizeProbeRequest,
  ResizeRect,
} from "../../lib/windowResizeProbe";
import {
  TauriSurfaceGenerations,
  countTauriResizeContinuity,
  tauriResizeObservation,
  type TauriPaneFact,
} from "./resizeObservation";

interface PaneCompositionMatch {
  pane: string;
  viewId: string | null;
  domFrame: ResizeRect | null;
  nativeFrame: ResizeRect | null;
  memberMatches: readonly {
    label: string;
    topologyPath: string | null;
    viewport: { w: number; h: number; revision: number } | null;
    ok: boolean;
  }[];
}

export interface TauriResizeProbeDeps {
  windowLabel: () => string;
  scaleFactor: () => number;
  /** 이 창의 native resize 사건 세대. 구독은 호출자가 건다. */
  eventGeneration: () => number;
  readComposition: () => Promise<{ matches: readonly PaneCompositionMatch[] }>;
}

const paneFacts = (matches: readonly PaneCompositionMatch[]): TauriPaneFact[] =>
  matches.map((match) => ({
    nativeHostId: match.pane,
    viewId: match.viewId,
    domFrame: match.domFrame,
    nativeFrame: match.nativeFrame,
    members: match.memberMatches.map((member) => ({
      label: member.label,
      topologyPath: member.topologyPath,
      viewport: member.viewport,
      ok: member.ok,
    })),
  }));

/**
 * 한 창의 Tauri 관측면. 거래 세대는 이 어댑터가 목격한 완료된 단계 수이고, 끊김 원장은
 * 직전 관측과 대조해 누적한다 — 다음 프레임이 멀쩡하다고 끊겼던 사실이 사라지지 않는다.
 */
export function createTauriResizeProbe(deps: TauriResizeProbeDeps) {
  let transactionGeneration = 0;
  let eventsAtLastObservation = 0;
  let ledger: ResizeContinuityCounters = {
    replacements: 0, gaps: 0, disappearances: 0, unpresented: 0,
  };
  let lastObservation: ResizeCompositionObservation | null = null;
  const generations = new TauriSurfaceGenerations();

  return async function observe(request: ResizeProbeRequest): Promise<ResizeCompositionObservation> {
    const composition = await deps.readComposition();
    const eventGeneration = deps.eventGeneration();
    const eventGenerationBefore = request.kind === "step" ? eventsAtLastObservation : eventGeneration;
    if (request.kind === "step") transactionGeneration += 1;
    const countersBefore = { ...ledger };
    const observation = tauriResizeObservation({
      windowLabel: deps.windowLabel(),
      scaleFactor: deps.scaleFactor(),
      eventGeneration,
      eventGenerationBefore,
      eventGenerationAfter: eventGeneration,
      transactionGeneration,
      continuity: { countersBefore, countersAfter: countersBefore },
      panes: paneFacts(composition.matches),
      surfaceGenerationOf: (viewId, nativeHostId) => generations.of(viewId, nativeHostId),
    });
    ledger = countTauriResizeContinuity(lastObservation, observation, ledger);
    lastObservation = observation;
    eventsAtLastObservation = eventGeneration;
    return { ...observation, continuity: { countersBefore, countersAfter: { ...ledger } } };
  };
}
