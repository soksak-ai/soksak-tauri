import { describe, expect, it } from "vitest";
import {
  railFlipOffsetPx,
  railGeometryScopeId,
  railPresentation,
} from "./railMotion";

describe("레일 표시 — 탭과 함께 이동하는 한 영속 DOM", () => {
  it("주행 중에도 레일 identity와 투영 host는 하나이며 목표 위치에 최종 배치된다", () => {
    expect(railPresentation(64, 20, true)).toEqual({
      key: "persistent-rail",
      station: 20,
      fromStation: 64,
      moving: true,
    });
  });

  it("착지 뒤에도 같은 identity를 보존한다", () => {
    expect(railPresentation(20, 20, false)).toEqual({
      key: "persistent-rail",
      station: 20,
      fromStation: 20,
      moving: false,
    });
  });

  it("최종 레이아웃에서 출발 위치를 재현하는 FLIP 오프셋은 레일 가용 폭 한 식으로 계산한다", () => {
    expect(railFlipOffsetPx(64, 20, 900, 160)).toBeCloseTo(325.6);
    expect(railFlipOffsetPx(20, 64, 900, 160)).toBeCloseTo(-325.6);
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
