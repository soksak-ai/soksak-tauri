/** FLOW에서 pane 복도가 출발 배치에서 도착 배치로 수축·확장되는 시간. */
export const RAIL_TRAVEL_MS = 340;

export type RailPresentation = {
  generation: number;
  station: number;
};

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
