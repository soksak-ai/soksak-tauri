import { motionPlaybackRate, motionScale } from "./motionDebug";

/** 레일 복도가 출발 배치에서 도착 배치로 수축·확장되는 시간. DOM 곡선과 같은 단일 상수. */
export const RAIL_TRAVEL_MS = 340;

/**
 * 이 위상이 화면에서 실제로 걸리는 시간 — 기대값이다. 예약에 이 값을 넣지 마라.
 *
 * 시계는 하나뿐이다: 문서 타임라인. CSS 애니메이션도 위상 착지 예약(scheduleMotion)도 거기
 * 얹히므로 배수·정지가 예외 없이 같이 걸린다. 호출자가 여기에 배수를 또 곱하면 이중이 된다 —
 * 화면만 제곱으로 늦고 착지가 먼저 와서 이동 도중에 위상이 닫힌다(실사고).
 * 이 함수는 그 짝을 검사하는 쪽(테스트·진단)이 읽는 기대 벽시계다.
 */
export function railTravelMs(): number {
  return RAIL_TRAVEL_MS * motionScale();
}

/**
 * CSS 선언으로 나가는 길이 — 항상 맨 상수다.
 *
 * 관측 배수를 여는 축은 playbackRate 하나이고 그것이 이 선언을 이미 늘린다. 주입처가 여기에
 * 배수를 또 곱하면 화면은 제곱만큼 늦는데 위상 타이머는 한 번만 곱해 짝이 깨진다. 그래서
 * 주입처는 상수를 직접 쓰지 않고 이 함수를 쓴다 — 짝 검사(railTravelWallMs)가 이 축을 본다.
 */
export function railTravelDeclaredMs(): number {
  return RAIL_TRAVEL_MS;
}

/** 선언 길이에 재생 속도를 걸었을 때 화면이 실제로 쓰는 시간. 위상 타이머와 같아야 한다. */
export function railTravelWallMs(): number {
  return railTravelDeclaredMs() / motionPlaybackRate();
}

export type RailPresentation = {
  key: "persistent-rail";
  station: number;
  fromStation: number;
  moving: boolean;
};

/**
 * 레일은 탭 배열과 같은 DOM 평면을 달리는 하나의 영속 요소다.
 * source/target 복제본은 목표 투영 host를 새로 마운트하여 전이 중 빈 레일을 만들고, 플러그인
 * 인스턴스도 둘로 갈라 놓는다. 최종 위치를 먼저 배치하고 같은 identity를 FLIP으로 되감는다.
 */
export function railPresentation(
  fromStation: number,
  targetStation: number,
  traveling: boolean,
): RailPresentation {
  return {
    key: "persistent-rail",
    station: targetStation,
    fromStation: traveling ? fromStation : targetStation,
    moving: traveling && fromStation !== targetStation,
  };
}

/** 목표 레이아웃에서 출발 레일 위치를 재현하는 유일한 FLIP 이동량. */
export function railFlipOffsetPx(
  fromStation: number,
  targetStation: number,
  planeWidthPx: number,
  railWidthPx: number,
): number {
  const available = Math.max(0, planeWidthPx - railWidthPx);
  return ((fromStation - targetStation) / 100) * available;
}

/** 레일 주행을 공유할 수 있는 패널 평면의 identity. split/merge로 선 집합이 바뀌면 새 평면이다. */
export function railGeometryScopeId(
  spaceId: string | undefined,
  cleanLines: readonly number[],
): string {
  return `${spaceId ?? ""}:${cleanLines.join(",")}`;
}
