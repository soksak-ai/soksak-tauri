// Electron 의 resize 합성 판정 — 이 프레임워크가 스스로 낼 수 있는 사실만으로 판정한다.
//
// 이 프레임워크의 콘텐츠는 문서 안에 산다. 그래서 AppKit 표면 목록도, 그것을 만든 affine
// 계약도 없다 — 대신 한 뷰마다 자리(slot)·렌더러가 놓은 요소·guest 가 스스로 답한 viewport·
// 표시 영수증 넷이 있고, 이 넷이 한 사각형을 가리키고 표시가 증명됐을 때만 이 단계의 합성이
// 성립한다. 없는 평면을 흉내 내지 않고, 못 읽은 평면은 이름으로 남긴다.
import type { ElectronObservedTarget } from "./resizeObservation";

/** 자리와 요소가 같은 사각형인지 볼 때 허용하는 논리 픽셀 오차. 반올림만 허용한다. */
export const ELECTRON_COMPOSITION_TOLERANCE_PX = 1;

export interface ElectronCompositionProbeInput {
  /** 이 관측 한 번의 세대. 표본을 서로 구분하는 유일한 축이다. */
  generation: number;
  sampledAtUnixMs: number;
  targets: readonly ElectronObservedTarget[];
}

const offBy = (a: number, b: number) => Math.abs(a - b) > ELECTRON_COMPOSITION_TOLERANCE_PX;

/**
 * 한 뷰가 이 단계에서 어긴 자리의 이름. 빈 배열만이 "이 뷰의 네 평면이 한 사각형"이라는 뜻이다.
 * 없는 평면(자리 없음·guest 무응답·영수증 없음)과 어긋난 평면을 서로 다른 이름으로 부른다 —
 * 못 읽은 것과 틀린 것은 같은 사실이 아니다.
 */
function targetIssues(target: ElectronObservedTarget): string[] {
  const issues: string[] = [];
  const at = target.label.trim().length > 0 ? target.label : "unlabeled";
  if (!target.slotRect) {
    issues.push(`slot-missing:${at}`);
  } else if (offBy(target.slotRect.x, target.elementRect.x)
    || offBy(target.slotRect.y, target.elementRect.y)
    || offBy(target.slotRect.width, target.elementRect.width)
    || offBy(target.slotRect.height, target.elementRect.height)) {
    issues.push(`slot-surface-mismatch:${at}`);
  }
  if (!target.guestViewport) {
    issues.push(`guest-missing:${at}`);
  } else if (offBy(target.guestViewport.innerWidth, target.elementRect.width)
    || offBy(target.guestViewport.innerHeight, target.elementRect.height)) {
    issues.push(`guest-surface-mismatch:${at}`);
  }
  if (!target.presentation) issues.push(`presentation-missing:${at}`);
  else if (!target.presentation.presented) issues.push(`unpresented:${at}`);
  return issues;
}

/**
 * 한 resize 단계의 Electron 합성 표본. 세 진단을 따로 내지 않고 한 세대의 한 원장으로 낸다 —
 * 빠진 사실은 원장에 남아 이 표본을 red 로 만든다.
 */
export function combineElectronCompositionProbe(input: ElectronCompositionProbeInput) {
  const issues: string[] = [];
  const generationValid = Number.isSafeInteger(input.generation) && input.generation > 0;
  const sampleTimeValid = Number.isSafeInteger(input.sampledAtUnixMs) && input.sampledAtUnixMs >= 0;
  if (!generationValid) issues.push("invalid-generation");
  if (!sampleTimeValid) issues.push("invalid-sample-time");

  const visible = input.targets.filter((target) => target.visible);
  // 보이는 표면이 하나도 없으면 판정할 합성이 없다. 그것을 green 으로 답하면 표면이 통째로
  // 사라진 프레임이 합격이 된다.
  if (visible.length === 0) issues.push("surfaces-missing");
  const surfaces = visible.map((target) => {
    const targetFailures = targetIssues(target);
    issues.push(...targetFailures);
    return {
      label: target.label,
      viewId: target.viewId,
      slotRect: target.slotRect,
      elementRect: target.elementRect,
      guestViewport: target.guestViewport,
      presentation: target.presentation,
      issues: targetFailures,
      ok: targetFailures.length === 0,
    };
  });

  const checks = {
    generation: generationValid && sampleTimeValid,
    surfaces: visible.length > 0 && surfaces.every((surface) => surface.ok),
  };
  return {
    schemaVersion: 1 as const,
    kind: "electron-resize-composition-sample" as const,
    generation: input.generation,
    sampledAtUnixMs: input.sampledAtUnixMs,
    tolerancePx: ELECTRON_COMPOSITION_TOLERANCE_PX,
    surfaces,
    checks,
    issues,
    verdict: issues.length === 0 && Object.values(checks).every(Boolean)
      ? "green" as const
      : "red" as const,
  };
}
