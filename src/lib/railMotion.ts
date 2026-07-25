/** 레일 복도가 출발 배치에서 도착 배치로 수축·확장되는 시간. DOM 곡선과 같은 단일 상수. */
export const RAIL_TRAVEL_MS = 340;

/** 레일 주행을 공유할 수 있는 패널 평면의 identity. split/merge로 선 집합이 바뀌면 새 평면이다. */
export function railGeometryScopeId(
  spaceId: string | undefined,
  cleanLines: readonly number[],
): string {
  return `${spaceId ?? ""}:${cleanLines.join(",")}`;
}

