// Tauri 의 resize 관측면 — 코어 계약이 요구하는 사실을 이 프레임워크의 원천에서 모은다.
//
// 창 사건은 프레임워크 창 표면이, pane 세 평면은 pane presentation 상태가 답한다. 요청 크기는
// 여기 들어오지 않는다(ResizeProbeRequest 에 크기가 없다) — 관측이 요청을 베낄 통로가 없다.
import type {
  ResizeCompositionFacts,
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
import {
  combineTauriCompositionProbe,
  nextTauriCompositionProbeGeneration,
  type DirectResizeCompositionPlane,
  type PaneResizeCompositionPlane,
  type TitlebarCompositionProbe,
} from "./compositionProbe";

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

/**
 * 한 단계를 정착시키는 상한. 유한 resize 거래 **전체**의 예산은 판정면이 소유하므로
 * (B10 resizeElapsedMs) 단계 하나의 상한은 그보다 훨씬 작아야 한다. 넘겨도 지어낸 성공이
 * 되지 않는다 — 못 따라온 평면은 그 단계의 관측에 stale 한 frame 과 presented=false 로 남는다.
 */
const SETTLE_TIMEOUT_MS = 1_000;

export interface TauriResizeProbeDeps {
  windowLabel: () => string;
  scaleFactor: () => number;
  /** 이 창의 native resize 사건 세대. 구독은 호출자가 건다. */
  eventGeneration: () => number;
  /**
   * 한 거래를 정착시킨다 — 이 어댑터가 그 단계를 **완료로 세기 전에** 부른다.
   *
   * 이 프레임워크의 콘텐츠는 문서 밖 자식 renderer 에 산다. 창 크기가 바뀌면 native surface 는
   * AppKit resize epoch 에서 같이 옮겨지지만, 자식은 자기 ResizeObserver/`resize` 로만 그 사실을
   * 알게 되고 비전면 WKWebView 에서 그 사건은 미뤄진다. 그래서 정착을 부르지 않으면 renderer
   * 평면이 직전 거래를 그대로 든 채 이 단계가 완료로 세어진다.
   *
   * 정착이 실패해도 던지지 않는다. 못 닫힌 사실은 곧바로 이어지는 관측이 stale 한 frame 과
   * presented=false 로 답하므로, 이 자리에서 예외로 바꾸면 사실 대신 사고만 남는다.
   */
  settle: (timeoutMs: number) => Promise<void>;
  readComposition: () => Promise<{ matches: readonly PaneCompositionMatch[] }>;
  /**
   * 이 단계의 합성 판정을 지탱하는 두 평면.
   *
   * direct 는 DOM 홀과 스탠드얼론 AppKit 표면의 일대일이고, pane 은 PaneSurfaceHost frame 과
   * 그것을 만든 affine 계약의 대조다. 못 읽은 평면은 null 로 답한다 — 다른 평면의 값으로
   * 메우면 이 단계는 영원히 green 이다.
   */
  readDirect: () => Promise<DirectResizeCompositionPlane | null>;
  readPaneContract: () => Promise<PaneResizeCompositionPlane | null>;
  /** 이 표본을 찍은 시각. 시계도 관측면이 답하는 사실이라 이 어댑터가 든다. */
  now?: () => number;
}

const orNull = async <T>(read: () => Promise<T | null>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    // 못 물은 평면은 없는 평면으로 남는다. 여기서 예외로 바꾸면 같은 거래의 나머지 단계가
    // 통째로 사라지고, 지어내면 안 읽은 평면이 green 이 된다.
    return null;
  }
};

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
  let lastObservation: ResizeCompositionFacts | null = null;
  const generations = new TauriSurfaceGenerations();
  const now = deps.now ?? (() => Date.now());

  return async function observe(request: ResizeProbeRequest): Promise<ResizeCompositionObservation> {
    // baseline 은 아직 아무 크기도 요청되지 않은 자리라 정착시킬 거래가 없다. 단계는 반대로
    // 이 어댑터가 "완료된 단계 수"를 올리는 자리이므로, 세기 전에 그 거래를 닫는다.
    if (request.kind === "step") await deps.settle(SETTLE_TIMEOUT_MS);
    const composition = await deps.readComposition();
    // 판정 평면은 정착이 끝난 뒤 같은 표본에서 읽는다. 관측이 무엇을 바꾸지 않으므로 순서가
    // 다음 관측의 값을 만들지 않는다.
    const [direct, pane] = [
      await orNull(deps.readDirect),
      await orNull(deps.readPaneContract),
    ];
    // 이 표본은 titlebar 평면을 들지 않는다. 타이틀바 합성은 자기 관측면과 자기 게이트가
    // 따로 재는 사실이고, 여기서 그 평면을 안 실었다고 해서 이 판정이 그 사실을 통과시킨 것은
    // 아니다 — 키 자체가 없으므로 판정은 그 축을 세지 않는다.
    const declared = combineTauriCompositionProbe<
      DirectResizeCompositionPlane, PaneResizeCompositionPlane, TitlebarCompositionProbe
    >({
      generation: nextTauriCompositionProbeGeneration(),
      sampledAtUnixMs: now(),
      direct,
      pane,
    });
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
    return {
      ...observation,
      continuity: { countersBefore, countersAfter: { ...ledger } },
      composition: declared,
    };
  };
}
