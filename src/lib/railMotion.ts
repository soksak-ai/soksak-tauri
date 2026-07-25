/** 레일 복도가 출발 배치에서 도착 배치로 수축·확장되는 시간. DOM 곡선과 같은 단일 상수. */
export const RAIL_TRAVEL_MS = 340;

/** 레일 주행을 공유할 수 있는 패널 평면의 identity. split/merge로 선 집합이 바뀌면 새 평면이다. */
export function railGeometryScopeId(
  spaceId: string | undefined,
  cleanLines: readonly number[],
): string {
  return `${spaceId ?? ""}:${cleanLines.join(",")}`;
}

export type RailPresentationLayer = {
  key: number;
  station: number;
  role: "source" | "target" | "resting";
  commitProjection: boolean;
  interactive: boolean;
};

/**
 * 레일은 이동 물체가 아니라 그리드가 열고 닫는 두 영역이다. 전환 중 도착 레일은
 * 최종선에 즉시 놓여 확장되는 복도로 드러나고, 출발 레일은 기존 내용을 유지한 채
 * 수축하는 pane에 가려진다. 종료 뒤에는 도착 레이어 하나만 남는다.
 */
export function railPresentationLayers(
  generation: number,
  fromStation: number,
  targetStation: number,
  traveling: boolean,
): RailPresentationLayer[] {
  if (!traveling) {
    return [
      {
        key: generation,
        station: targetStation,
        role: "resting",
        commitProjection: true,
        interactive: true,
      },
    ];
  }
  return [
    {
      key: generation,
      station: fromStation,
      role: "source",
      commitProjection: false,
      interactive: false,
    },
    {
      key: generation + 1,
      station: targetStation,
      role: "target",
      commitProjection: true,
      interactive: true,
    },
  ];
}
