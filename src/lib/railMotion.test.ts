import { describe, expect, it } from "vitest";
import { railGeometryScopeId, railPresentationLayers } from "./railMotion";

describe("레일 영역 인계", () => {
  it("도착 레일은 처음부터 최종선에 있고 출발 레일은 pane 수축이 끝날 때까지 남는다", () => {
    expect(railPresentationLayers(7, 64, 20, true)).toEqual([
      {
        key: 7,
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

  it("수축이 끝나면 도착 레일 하나만 남긴다", () => {
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
