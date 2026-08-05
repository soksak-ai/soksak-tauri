/**
 * 문서 밖 가시 표면의 공개 DOM 배치 거래.
 *
 * 코어는 표면 제공자나 프레임워크 이름을 알지 않는다. 프레임워크 조합 host가 이동 대상인
 * `data-content-view-body` 슬롯에 이 사건을 보내면, 그 슬롯을 소유한 제공자가 거래를 claim한다.
 * claim한 제공자는 목표 DOM 커밋 뒤 받은 정수 rect를 자기 표면에 적용하고 ACK가 끝날 때까지
 * Promise를 닫지 않는다. 제공자가 없으면 순수 DOM 슬롯이며 기존 CSS glide가 정답이다.
 */
export const EXTERNAL_SURFACE_TRANSITION_EVENT =
  "soksak:external-surface-layout-transition" as const;

export interface ExternalSurfaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExternalSurfaceTransitionParticipant {
  /** 진행 가능한 공유 시계가 없을 때 목표 rect를 애니메이션 없이 적용하고 ACK한다. */
  snap(rect: ExternalSurfaceRect): Promise<void>;
  /** 목표 model frame을 공통 epoch에 시작하도록 DOM 커밋 전에 무장한다. */
  prepare(rect: ExternalSurfaceRect, timing: ExternalSurfaceTransitionTiming): Promise<void>;
  /** 목표 DOM이 커밋된 뒤 외부 표면의 frame을 적용하고 실제 적용 ACK까지 기다린다. */
  commit(rect: ExternalSurfaceRect): Promise<void>;
  /** 목표가 폐기되면 준비 잠금을 해제한다. 외부 frame을 임의 위치로 움직이지 않는다. */
  cancel(): void;
}

export interface ExternalSurfaceTransitionTiming {
  startAtUnixMs: number;
  durationMs: number;
}

export interface ExternalSurfaceTransitionDetail {
  /** 공개 layout view identity. 엔진 label이나 플러그인 이름이 아니다. */
  viewId: string;
  /** 한 슬롯의 소유자는 하나다. 두 번째 claim은 계약 위반으로 거절된다. */
  claim(participant: ExternalSurfaceTransitionParticipant): void;
}
