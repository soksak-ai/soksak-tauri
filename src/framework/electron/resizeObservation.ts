// Electron 이 resize 관측 봉투를 채우는 자리.
//
// 이 프레임워크의 콘텐츠는 문서 안에 살기 때문에 세 평면이 모두 이 문서에서 잰다:
// 자리(`[data-content-view-body]`), 렌더러가 놓은 콘텐츠 요소, 그리고 그 안의 guest viewport.
// 셋이 같은 사각형이어야 한다는 판정은 코어 계약이 하고, 여기서는 **각 평면을 따로** 답한다 —
// 한 평면의 값을 다른 평면에 베끼면 어긋남은 영영 관측되지 않는다.
import {
  resizeTopologyPath,
  type ResizeCompositionObservation,
  type ResizeCompositionParticipant,
  type ResizeContinuityCounters,
  type ResizePresentation,
  type ResizeRect,
} from "../../lib/windowResizeProbe";

export interface ObservedLogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElectronObservedTarget {
  /** 콘텐츠 뷰 label — 이 문서가 선언한 이름. */
  label: string;
  /** label 문법 소유자가 답한 공개 뷰 식별자. */
  viewId: string;
  visible: boolean;
  /** 선언된 자리. 없으면 이 뷰는 자리 없이 떠 있다. */
  slotRect: ObservedLogicalRect | null;
  /** 렌더러가 실제로 놓은 콘텐츠 요소. */
  elementRect: ObservedLogicalRect;
  /** guest 문서가 스스로 답한 viewport. 못 물었으면 null 이다. */
  guestViewport: { innerWidth: number; innerHeight: number } | null;
  /** 이 거래에서 실제 표시된 프레임의 영수증. 없으면 표시를 증명하지 못했다는 뜻이다. */
  presentation: {
    revision: number;
    surfaceGeneration: number;
    presented: boolean;
  } | null;
}

export interface ElectronResizeFacts {
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
  targets: readonly ElectronObservedTarget[];
}

/** 논리 사각형의 네 모서리를 물리 픽셀에 한 번만 반올림한다(폭·높이를 따로 반올림하지 않는다). */
export function physicalFrameOf(frame: ResizeRect, scaleFactor: number): ResizeRect {
  const left = Math.round(frame.x * scaleFactor);
  const top = Math.round(frame.y * scaleFactor);
  const right = Math.round((frame.x + frame.w) * scaleFactor);
  const bottom = Math.round((frame.y + frame.h) * scaleFactor);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const rectOf = (value: ObservedLogicalRect): ResizeRect => ({
  x: value.x, y: value.y, w: value.width, h: value.height,
});

function participant(
  kind: "slot" | "renderer" | "surface",
  target: ElectronObservedTarget,
  frame: ResizeRect,
  windowLabel: string,
  scaleFactor: number,
): ResizeCompositionParticipant {
  return {
    id: `${kind}/${target.label}`,
    viewId: target.viewId,
    topologyPath: resizeTopologyPath(windowLabel, target.viewId),
    visible: target.visible,
    logicalFrame: frame,
    physicalFrame: physicalFrameOf(frame, scaleFactor),
  };
}

/**
 * 관측한 사실만으로 봉투의 관측면을 채운다.
 *
 * 자리를 못 찾았거나 guest 가 자기 viewport 를 답하지 않은 뷰는 그 평면에서 **빠진다**.
 * 비어 있는 자리를 다른 평면의 값으로 메우면 계약은 통과하고 화면은 어긋난 채로 남는다.
 * 빠진 사실은 계약 판정이 그 평면 이름으로 부른다.
 */
export function electronResizeObservation(facts: ElectronResizeFacts): ResizeCompositionObservation {
  const visible = facts.targets.filter((target) => target.visible);
  const slots: ResizeCompositionParticipant[] = [];
  const renderers: ResizeCompositionParticipant[] = [];
  const surfaces: ResizeCompositionParticipant[] = [];
  const presentations: ResizePresentation[] = [];

  for (const target of visible) {
    if (target.slotRect) {
      slots.push(participant("slot", target, rectOf(target.slotRect), facts.windowLabel, facts.scaleFactor));
    }
    renderers.push(
      participant("renderer", target, rectOf(target.elementRect), facts.windowLabel, facts.scaleFactor),
    );
    if (target.guestViewport) {
      // 표면은 guest 가 스스로 답한 크기다. 요소 상자에서 크기를 베끼면 guest 가 따라오지
      // 못한 프레임이 그대로 GREEN 이 된다.
      surfaces.push(participant("surface", target, {
        x: target.elementRect.x,
        y: target.elementRect.y,
        w: target.guestViewport.innerWidth,
        h: target.guestViewport.innerHeight,
      }, facts.windowLabel, facts.scaleFactor));
    }
    presentations.push({
      viewId: target.viewId,
      surfaceId: `surface/${target.label}`,
      surfaceGeneration: target.presentation?.surfaceGeneration ?? 0,
      revision: target.presentation?.revision ?? 0,
      live: target.presentation !== null,
      visible: target.visible,
      presented: target.presentation?.presented ?? false,
    });
  }

  return {
    eventGeneration: facts.eventGeneration,
    transactionGeneration: facts.transactionGeneration,
    visibleViewIds: visible.map((target) => target.viewId),
    slots,
    renderers,
    surfaces,
    presentations,
    eventGenerationBefore: facts.eventGenerationBefore,
    eventGenerationAfter: facts.eventGenerationAfter,
    continuity: facts.continuity,
  };
}

/**
 * 거래를 사이에 두고 소유·표면·표시가 끊겼는지 센다. 누적 원장이라 한 번 끊긴 사실은 다음
 * 관측에서도 남는다 — 다음 프레임이 멀쩡하다고 끊겼던 사실이 없어지지 않는다.
 */
export function countResizeContinuity(
  before: readonly ElectronObservedTarget[],
  after: readonly ElectronObservedTarget[],
  ledger: ResizeContinuityCounters,
): ResizeContinuityCounters {
  const beforeVisible = before.filter((target) => target.visible);
  const afterByView = new Map(after.filter((target) => target.visible).map((t) => [t.viewId, t]));
  let { replacements, gaps, disappearances, unpresented } = ledger;
  for (const target of beforeVisible) {
    const next = afterByView.get(target.viewId);
    if (!next) {
      disappearances += 1;
      continue;
    }
    if (target.presentation && next.presentation
      && next.presentation.surfaceGeneration !== target.presentation.surfaceGeneration) {
      replacements += 1;
    }
    if (target.presentation && next.presentation
      && next.presentation.revision <= target.presentation.revision) {
      gaps += 1;
    }
  }
  for (const target of afterByView.values()) {
    if (!target.presentation?.presented) unpresented += 1;
  }
  return { replacements, gaps, disappearances, unpresented };
}
