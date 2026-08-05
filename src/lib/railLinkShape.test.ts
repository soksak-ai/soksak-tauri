import { describe, expect, it } from "vitest";
import {
  classifyRailRelation,
  insetClippedEdges,
  railLinkBoxes,
  railLinkPolygon,
  roundedOrthogonalPath,
  splitRightEdgeRounded,
} from "./railLinkShape";

describe("레일 결부 관계 도형", () => {
  it("실제 rect로 왼쪽·오른쪽 인접과 비인접을 한 기준으로 분류한다", () => {
    expect(classifyRailRelation(50, { left: 0, top: 0, width: 50, height: 100 })).toBe("left");
    expect(classifyRailRelation(50, { left: 50, top: 0, width: 25, height: 100 })).toBe("right");
    expect(classifyRailRelation(0, { left: 50, top: 0, width: 50, height: 100 })).toBe("detached");
  });
  it("고정폭 레일과 바로 오른쪽 상단 패널을 하나의 L자 합집합으로 만든다", () => {
    const boxes = railLinkBoxes(
      1200,
      800,
      300,
      50,
      { left: 50, top: 0, width: 25, height: 50 },
    );
    expect(boxes).toEqual({
      rail: { x: 450, y: 0, width: 300, height: 800 },
      panel: { x: 750, y: 0, width: 225, height: 400 },
    });
    expect(railLinkPolygon(boxes!.rail, boxes!.panel)).toEqual([
      { x: 450, y: 0 },
      { x: 975, y: 0 },
      { x: 975, y: 400 },
      { x: 750, y: 400 },
      { x: 750, y: 800 },
      { x: 450, y: 800 },
    ]);
  });

  it("중간 높이 패널도 위·아래 다른 패널을 덮지 않는 돌출부만 만든다", () => {
    const polygon = railLinkPolygon(
      { x: 100, y: 0, width: 240, height: 900 },
      { x: 340, y: 225, width: 300, height: 450 },
    );
    expect(polygon).toEqual([
      { x: 100, y: 0 }, { x: 340, y: 0 }, { x: 340, y: 225 },
      { x: 640, y: 225 }, { x: 640, y: 675 }, { x: 340, y: 675 },
      { x: 340, y: 900 }, { x: 100, y: 900 },
    ]);
  });

  it("레일과 패널 사이에 다른 영역이 있으면 거짓 연결 표면을 만들지 않는다", () => {
    expect(railLinkPolygon(
      { x: 0, y: 0, width: 240, height: 900 },
      { x: 500, y: 0, width: 300, height: 450 },
    )).toBeNull();
  });

  it("radius 0은 직각 경로, 양수는 Q 곡선 경로이며 입력을 변이하지 않는다", () => {
    const points = [
      { x: 0, y: 0 }, { x: 100, y: 0 },
      { x: 100, y: 50 }, { x: 0, y: 50 },
    ];
    const before = structuredClone(points);
    expect(roundedOrthogonalPath(points, 0)).toBe("M 0 0 L 100 0 L 100 50 L 0 50 Z");
    expect(roundedOrthogonalPath(points, 10)).toContain("Q 100 0 100 10");
    expect(points).toEqual(before);
  });

  it("외곽 clip 경계의 stroke만 선 두께 절반 안쪽으로 옮기고 내부 그리드선은 유지한다", () => {
    expect(insetClippedEdges([
      { x: 300, y: 0 }, { x: 1200, y: 0 },
      { x: 1200, y: 800 }, { x: 300, y: 800 },
    ], 1200, 800, 0.75)).toEqual([
      { x: 300, y: 0.75 }, { x: 1199.25, y: 0.75 },
      { x: 1199.25, y: 799.25 }, { x: 300, y: 799.25 },
    ]);
  });
});

describe("오른쪽 변 분리(B안 — 바깥 변 점선, 라운드 보존)", () => {
  // 실측 결함: 분리 렌더가 코너 아크를 버려 오른쪽 두 모서리가 직각이 됐다("원래처럼
  // 라운드되어야지"). 계약: 코너 아크는 실선 경로가 소유하고, 점선은 두 아크 사이의
  // 직선 구간만이다 — 외곽 형태는 분리 전과 동일해야 한다.
  const squareR = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 8 },
    { x: 0, y: 8 },
  ];

  it("splitRightEdgeRounded: 점선=아크 사이 직선, 실선=아크 포함 열린 경로", () => {
    const split = splitRightEdgeRounded(squareR, 2)!;
    expect(split.edge).toEqual([
      { x: 10, y: 2 },
      { x: 10, y: 6 },
    ]);
    expect(split.solid.startsWith("M 10 6 Q 10 8")).toBe(true); // B 코너 아크로 시작
    expect(split.solid.endsWith("Q 10 0 10 2")).toBe(true); // A 코너 아크로 끝
    expect(split.solid.includes("Z")).toBe(false);
  });

  // 사각 다각형(시계): (0,0)→(10,0)→(10,8)→(0,8). 최우측 수직 변 = (10,0)-(10,8).


});

/** **기준 폭은 호스트가 답한다.** 판 영역은 호스트에서 레일만 뺀 나머지다 — 레일은 호스트
 *  *안*에 선다. 호스트 밖에 선 것(밀기 사이드바)은 여기서 뺄 것이 아니다: 그것이 서면
 *  호스트 자체가 이미 그만큼 좁다.
 *
 *  재입법(2026-08-02): 옛 기준은 "오른쪽 밀기 폭도 뺀다"였고 이 자리에 그 검사가 있었다.
 *  틀렸다 — 실측으로 밀기 모드에서 그린 보더가 결합 판보다 정확히 사이드바 폭만큼 짧았다
 *  (창 1017 vs 1336, 호스트 폭 1204 vs 오버레이 모드 1529). 뺄 것을 하나 더 두면 그 값은
 *  언젠가 두 번 세어진다. 인자를 없앴으므로 이제 틀릴 자리가 없다. */
describe("판 영역 — 기준은 호스트다", () => {
  it("호스트에서 레일만 뺀 나머지가 판 영역이다", () => {
    const b = railLinkBoxes(1000, 500, 100, 0, { left: 0, top: 0, width: 100, height: 100 });
    expect(b?.panel.width).toBe(900);
  });

  it("전 폭 상자의 오른쪽 끝은 호스트의 오른쪽 끝이다 — 모자라면 보더가 판을 못 감싼다", () => {
    const b = railLinkBoxes(1000, 500, 100, 0, { left: 0, top: 0, width: 100, height: 100 });
    expect((b?.panel.x ?? 0) + (b?.panel.width ?? 0)).toBe(1000);
  });
});
