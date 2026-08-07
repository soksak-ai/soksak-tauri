// Tauri 가 resize 관측 봉투를 채우는 자리.
//
// 이 프레임워크의 콘텐츠는 문서 밖 OS 자식 뷰에 산다. 그래서 한 뷰의 세 평면은 **서로 다른
// 세 곳이 각자 잰 값**이다: 자리는 메인 문서가, 렌더러 루트는 자식 렌더러가, 표면은 AppKit
// 호스트가 잰다. 셋을 한 원천에서 뽑으면 어긋남은 영영 관측되지 않는다.
import {
  resizeTopologyPath,
  type ResizeCompositionFacts,
  type ResizeCompositionParticipant,
  type ResizeContinuityCounters,
  type ResizePresentation,
  type ResizeRect,
} from "../../lib/windowResizeProbe";

export interface TauriPaneMemberFact {
  label: string;
  topologyPath: string | null;
  /** 자식 렌더러가 스스로 잰 자기 루트 상자와 그 커밋 세대. */
  viewport: { w: number; h: number; revision: number } | null;
  /** 이 멤버의 native frame 이 이번 거래의 DOM frame 과 같은가. */
  ok: boolean;
}

export interface TauriPaneFact {
  /** AppKit 호스트 식별자 — 표면의 공개 신원. */
  nativeHostId: string;
  viewId: string | null;
  /** 메인 문서가 잰 pane 자리. */
  domFrame: ResizeRect | null;
  /** AppKit 이 잰 호스트 frame(CSS 좌표). */
  nativeFrame: ResizeRect | null;
  members: readonly TauriPaneMemberFact[];
}

export interface TauriResizeFacts {
  windowLabel: string;
  scaleFactor: number;
  eventGeneration: number;
  eventGenerationBefore: number;
  eventGenerationAfter: number;
  transactionGeneration: number;
  continuity: {
    countersBefore: ResizeContinuityCounters;
    countersAfter: ResizeContinuityCounters;
  };
  panes: readonly TauriPaneFact[];
  /** viewId 마다 이 어댑터가 목격한 표면 신원 세대. 신원이 바뀌면 그 표면은 교체된 것이다. */
  surfaceGenerationOf: (viewId: string, nativeHostId: string) => number;
}

function physicalFrameOf(frame: ResizeRect, scaleFactor: number): ResizeRect {
  const left = Math.round(frame.x * scaleFactor);
  const top = Math.round(frame.y * scaleFactor);
  const right = Math.round((frame.x + frame.w) * scaleFactor);
  const bottom = Math.round((frame.y + frame.h) * scaleFactor);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function participant(
  id: string,
  viewId: string,
  topologyPath: string,
  frame: ResizeRect,
  scaleFactor: number,
): ResizeCompositionParticipant {
  return {
    id,
    viewId,
    topologyPath,
    visible: true,
    logicalFrame: frame,
    physicalFrame: physicalFrameOf(frame, scaleFactor),
  };
}

/**
 * 관측한 사실만으로 봉투의 관측면을 채운다.
 *
 * 자기 신원(viewId)이 없는 native 호스트는 어느 뷰의 평면도 아니므로 빠진다 — 프레임워크
 * label 로 신원을 추측하지 않는다. 못 잰 평면은 다른 평면의 값으로 메우지 않는다.
 *
 * [임시] presentation revision 은 자식 렌더러가 커밋한 슬롯 세대다. Tauri 에는 아직 이
 * 샘플에 실린 display-link 영수증이 없다. 제거 조건: pane presentation trace(arm/close)를
 * 단계마다 읽어 실제 표시 프레임 세대를 싣는 순간 이 대체를 걷는다. 검증: 그때 이 파일의
 * 테스트가 trace 세대를 요구하도록 바뀐다.
 */
export function tauriResizeObservation(facts: TauriResizeFacts): ResizeCompositionFacts {
  const visibleViewIds: string[] = [];
  const slots: ResizeCompositionParticipant[] = [];
  const renderers: ResizeCompositionParticipant[] = [];
  const surfaces: ResizeCompositionParticipant[] = [];
  const presentations: ResizePresentation[] = [];

  for (const pane of facts.panes) {
    const viewId = pane.viewId;
    if (!viewId) continue;
    visibleViewIds.push(viewId);
    const member = pane.members[0] ?? null;
    const topologyPath = member?.topologyPath ?? resizeTopologyPath(facts.windowLabel, viewId);
    if (pane.domFrame) {
      slots.push(participant(
        `slot/${pane.nativeHostId}`, viewId, topologyPath, pane.domFrame, facts.scaleFactor,
      ));
    }
    // 렌더러 평면은 자식이 스스로 잰 자기 루트다. pane 자리에서 크기를 베끼면 자식이 따라오지
    // 못한 프레임이 그대로 GREEN 이 된다.
    if (pane.domFrame && member?.viewport) {
      renderers.push(participant(
        `renderer/${pane.nativeHostId}`,
        viewId,
        topologyPath,
        { x: pane.domFrame.x, y: pane.domFrame.y, w: member.viewport.w, h: member.viewport.h },
        facts.scaleFactor,
      ));
    }
    if (pane.nativeFrame) {
      surfaces.push(participant(
        `surface/${pane.nativeHostId}`, viewId, topologyPath, pane.nativeFrame, facts.scaleFactor,
      ));
    }
    presentations.push({
      viewId,
      surfaceId: `surface/${pane.nativeHostId}`,
      surfaceGeneration: facts.surfaceGenerationOf(viewId, pane.nativeHostId),
      revision: member?.viewport?.revision ?? 0,
      live: pane.nativeFrame !== null,
      visible: true,
      presented: member?.ok === true,
    });
  }

  return {
    eventGeneration: facts.eventGeneration,
    transactionGeneration: facts.transactionGeneration,
    visibleViewIds,
    slots,
    renderers,
    surfaces,
    presentations,
    eventGenerationBefore: facts.eventGenerationBefore,
    eventGenerationAfter: facts.eventGenerationAfter,
    continuity: facts.continuity,
  };
}

/** viewId 가 다른 native 호스트로 옮겨 간 횟수 — 표면 교체를 이름 없이 세지 않는다. */
export class TauriSurfaceGenerations {
  private readonly seen = new Map<string, { nativeHostId: string; generation: number }>();

  of(viewId: string, nativeHostId: string): number {
    const previous = this.seen.get(viewId);
    if (!previous) {
      this.seen.set(viewId, { nativeHostId, generation: 1 });
      return 1;
    }
    if (previous.nativeHostId === nativeHostId) return previous.generation;
    const next = { nativeHostId, generation: previous.generation + 1 };
    this.seen.set(viewId, next);
    return next.generation;
  }
}

/**
 * 거래를 사이에 두고 소유·표면·표시가 끊겼는지 센다. 누적 원장이라 한 번 끊긴 사실은 다음
 * 관측에서도 남는다.
 */
export function countTauriResizeContinuity(
  before: ResizeCompositionFacts | null,
  after: ResizeCompositionFacts,
  ledger: ResizeContinuityCounters,
): ResizeContinuityCounters {
  let { replacements, gaps, disappearances, unpresented } = ledger;
  const afterByView = new Map(after.presentations.map((entry) => [entry.viewId, entry]));
  for (const entry of before?.presentations ?? []) {
    const next = afterByView.get(entry.viewId);
    if (!next) {
      disappearances += 1;
      continue;
    }
    if (next.surfaceId !== entry.surfaceId || next.surfaceGeneration !== entry.surfaceGeneration) {
      replacements += 1;
    }
    if (next.revision <= entry.revision) gaps += 1;
  }
  if (before) {
    for (const entry of afterByView.values()) {
      if (!entry.presented) unpresented += 1;
    }
  }
  return { replacements, gaps, disappearances, unpresented };
}
