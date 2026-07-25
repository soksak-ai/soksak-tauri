/** 레일 복도가 출발 배치에서 도착 배치로 수축·확장되는 시간. DOM 곡선과 같은 단일 상수. */
export const RAIL_TRAVEL_MS = 340;

export type RailPresentationLayer = {
  key: number;
  station: number;
  role: "source" | "target" | "resting";
  /** 표면(내용) 투영을 최신으로 커밋하는가. 닫히는 레일은 자기가 들고 있던 표면을 유지한다. */
  commitProjection: boolean;
  interactive: boolean;
};

/**
 * 레일은 이동 물체가 아니라 그리드가 열고 닫는 두 영역이다 — 빠질 자리와 생길 자리.
 *
 * 계약의 핵심은 key 다. 출발선 레이어는 **서 있던 인스턴스의 key** 를 그대로 쓴다(그래서 원래
 * 있던 것이 닫힌다). 도착선 레이어는 새 key 로 열리고, 위상이 끝나면 상주 세대가 그 key 로
 * 전진해 재마운트 없이 그것이 상주가 된다. 세대를 위상 시작에 전진시키면 두 레이어 다 새것이
 * 되고, 빠질 자리에 갓 만든 사이드바가 끼워져 그것이 닫힌다(사용자 실측 결함).
 *
 * 이어져야 하는 것은 표면이다 — 인스턴스가 둘이어도 접힘·스크롤·플러그인 뷰 상태가 레이어 밖에
 * 있으면 도착 레이어는 같은 표면으로 즉시 열린다. 레이어 안에 사는 상태는 곧 "새것으로 교체"다.
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

/** 레일 주행을 공유할 수 있는 패널 평면의 identity. split/merge로 선 집합이 바뀌면 새 평면이다. */
export function railGeometryScopeId(
  spaceId: string | undefined,
  cleanLines: readonly number[],
): string {
  return `${spaceId ?? ""}:${cleanLines.join(",")}`;
}

