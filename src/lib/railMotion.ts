/** FLOW에서 pane 복도가 출발 배치에서 도착 배치로 수축·확장되는 시간. */
export const RAIL_TRAVEL_MS = 340;

/** 레일 주행을 공유할 수 있는 패널 평면의 identity. split/merge로 선 집합이 바뀌면 새 평면이다. */
export function railGeometryScopeId(
  spaceId: string | undefined,
  cleanLines: readonly number[],
): string {
  return `${spaceId ?? ""}:${cleanLines.join(",")}`;
}

export type RailPresentation = {
  generation: number;
  station: number;
  /** station이 유효한 패널 평면의 identity(space + 깨끗한 세로선 집합). */
  scopeId?: string;
};

export type RailPresentationLayer = {
  key: number;
  station: number;
  role: "source" | "target" | "resting";
  commitProjection: boolean;
  interactive: boolean;
};

/**
 * 최대화는 기존 split 위의 이동이 아니라 [rail|feature] 단일 평면으로의 원자적 전환이다.
 * 이전 내부 station을 FULL_RECT에 적용하면 rail이 패널을 관통하므로 출발 기하를 소비하지 않는다.
 */
export function railTravelGeometry(
  presentation: RailPresentation,
  targetStation: number,
  exclusive: boolean,
  scopeId?: string,
): { fromStation: number; traveling: boolean; rebase?: boolean } {
  if (
    scopeId !== undefined &&
    presentation.scopeId !== undefined &&
    presentation.scopeId !== scopeId
  ) {
    return { fromStation: targetStation, traveling: false, rebase: true };
  }
  if (exclusive) return { fromStation: targetStation, traveling: false };
  return {
    fromStation: presentation.station,
    // 동등 위치는 이동이 아니다 — station 은 재계산되는 float(cleanLines 위치)라 미세 오차가
    // `!==` 를 참으로 만들어 유령 주행(레일 rect 픽셀 동일인데 전역 이동 위상 개시)을 열었다
    // (실사고: 같은 그룹 내 탭 전환마다 모든 브라우저가 동결 펄스). 0.5 미만 = 무이동.
    traveling: Math.abs(presentation.station - targetStation) >= 0.5,
  };
}

/**
 * 레일은 이동 물체가 아니라 그리드가 열고 닫는 두 영역이다. 전환 중 도착 레일은
 * 최종선에 즉시 놓여 확장되는 복도로 드러나고, 출발 레일은 기존 내용을 유지한 채
 * 수축하는 pane에 가려진다. 종료 뒤에는 도착 레이어 하나만 남는다.
 */
export function railPresentationLayers(
  presentation: RailPresentation,
  targetStation: number,
  traveling: boolean,
): RailPresentationLayer[] {
  if (!traveling) {
    return [
      {
        key: presentation.generation,
        station: targetStation,
        role: "resting",
        commitProjection: true,
        interactive: true,
      },
    ];
  }
  return [
    {
      key: presentation.generation,
      station: presentation.station,
      role: "source",
      commitProjection: false,
      interactive: false,
    },
    {
      key: presentation.generation + 1,
      station: targetStation,
      role: "target",
      commitProjection: true,
      interactive: true,
    },
  ];
}
