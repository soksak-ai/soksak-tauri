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
  role: "traveling" | "resting";
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
    traveling: presentation.station !== targetStation,
  };
}

/**
 * 레일은 내용째 한 몸으로 활주하는 단일 표상이다 — pane 과 같은 FLIP 문법(최종 배치 +
 * translate 되감기, 같은 곡선·시간). 이전의 두-영역 여닫기(도착 레일 즉시 배치 + 출발
 * 내용 유지)는 도착 프레임이 위상 내내 비어 있다가 종료에 내용이 순간이동해 채워지는
 * 이질감의 원인이었다(실측: 프레임 궤적 — 브라우저·pane 전부 동조 후 유일한 비동조 요소).
 * key 는 generation 으로 안정 — 주행/정착 전환에 재마운트가 없어 투영 인스턴스가 보존된다.
 */
export function railPresentationLayers(
  presentation: RailPresentation,
  targetStation: number,
  traveling: boolean,
): RailPresentationLayer[] {
  return [
    {
      key: presentation.generation,
      station: targetStation,
      role: traveling ? "traveling" : "resting",
      commitProjection: true,
      interactive: !traveling,
    },
  ];
}
