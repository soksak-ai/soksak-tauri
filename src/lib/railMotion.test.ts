import { describe, expect, it } from "vitest";
import {
  railGeometryScopeId,
  railPresentationLayers,
  railTravelGeometry,
} from "./railMotion";

describe("FLOW 레일 영역 인계", () => {
  it("도착 레일은 처음부터 최종선에 있고 출발 레일은 pane 수축이 끝날 때까지 남는다", () => {
    expect(
      railPresentationLayers(
        { generation: 7, station: 64 },
        20,
        true,
      ),
    ).toEqual([
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
    expect(
      railPresentationLayers(
        { generation: 8, station: 20 },
        20,
        false,
      ),
    ).toEqual([
      {
        key: 8,
        station: 20,
        role: "resting",
        commitProjection: true,
        interactive: true,
      },
    ]);
  });

  it("최대화 평면은 이전 내부 station을 참조하지 않고 0선에서 원자적으로 시작한다", () => {
    expect(
      railTravelGeometry({ generation: 8, station: 33.333 }, 0, true),
    ).toEqual({ fromStation: 0, traveling: false });
  });

  it("서로 다른 space의 레일 선은 같은 좌표계가 아니므로 이어서 주행하지 않는다", () => {
    const sourceScope = railGeometryScopeId("c38", [0, 50, 100]);
    const targetScope = railGeometryScopeId("c39", [0, 100 / 3, 200 / 3, 100]);
    expect(
      railTravelGeometry(
        { generation: 8, station: 50, scopeId: sourceScope },
        0,
        false,
        targetScope,
      ),
    ).toEqual({ fromStation: 0, traveling: false, rebase: true });
  });

  it("같은 space도 split/merge로 깨끗한 선 집합이 바뀌면 새 좌표계로 rebase한다", () => {
    const before = railGeometryScopeId("c1", [0, 50, 100]);
    const after = railGeometryScopeId("c1", [0, 100 / 3, 200 / 3, 100]);
    expect(
      railTravelGeometry(
        { generation: 2, station: 50, scopeId: before },
        100 / 3,
        false,
        after,
      ),
    ).toEqual({ fromStation: 100 / 3, traveling: false, rebase: true });
  });
});
