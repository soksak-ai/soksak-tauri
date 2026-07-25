import { describe, expect, it } from "vitest";
import { railGeometryScopeId, railPresentationLayers } from "./railMotion";

describe("레일 영역 인계 — 빠질 자리와 생길 자리", () => {
  it("출발선 레이어는 서 있던 key 를 그대로 쓴다(원래 있던 것이 닫힌다), 도착선만 새 key", () => {
    expect(railPresentationLayers(7, 64, 20, true)).toEqual([
      {
        key: 7, // = 정차 중 상주 key. 여기가 새 key 면 빠질 자리에 새 사이드바가 끼워진다.
        station: 64,
        role: "source",
        commitProjection: false,
        interactive: false,
      },
      {
        key: 8,
        station: 20,
        role: "target",
        commitProjection: true,
        interactive: true,
      },
    ]);
  });

  it("착지 뒤 상주 세대는 도착 key 다 — 재마운트 없이 그것이 상주가 된다", () => {
    expect(railPresentationLayers(8, 20, 20, false)).toEqual([
      {
        key: 8,
        station: 20,
        role: "resting",
        commitProjection: true,
        interactive: true,
      },
    ]);
  });
});

describe("평면 identity", () => {
  it("서로 다른 space 의 레일 선은 같은 좌표계가 아니다", () => {
    expect(railGeometryScopeId("c38", [0, 50, 100])).not.toBe(
      railGeometryScopeId("c39", [0, 50, 100]),
    );
  });

  it("같은 space 도 split/merge 로 깨끗한 선 집합이 바뀌면 새 좌표계다", () => {
    expect(railGeometryScopeId("c1", [0, 50, 100])).not.toBe(
      railGeometryScopeId("c1", [0, 100 / 3, 200 / 3, 100]),
    );
  });
});
