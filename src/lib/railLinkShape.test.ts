import { describe, expect, it } from "vitest";
import {
  insetClippedEdges,
  openOrthogonalPath,
  railLinkBoxes,
  railLinkPolygon,
  roundedOrthogonalPath,
  splitRightEdge,
} from "./railLinkShape";

describe("레일 결부 관계 도형", () => {
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

describe("오른쪽 변 분리(B안 — 바깥 변 점선)", () => {
  // 사각 다각형(시계): (0,0)→(10,0)→(10,8)→(0,8). 최우측 수직 변 = (10,0)-(10,8).
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 8 },
    { x: 0, y: 8 },
  ];

  it("최우측 수직 변과 나머지 열린 점열로 분리한다", () => {
    const split = splitRightEdge(square)!;
    expect(split.edge).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 8 },
    ]);
    // 열린 경로: 변의 끝점에서 시작해 반대편으로 돌아 변의 시작점에서 끝난다.
    expect(split.rest[0]).toEqual({ x: 10, y: 8 });
    expect(split.rest[split.rest.length - 1]).toEqual({ x: 10, y: 0 });
    expect(split.rest).toHaveLength(4);
  });

  it("열린 경로는 Z 로 닫지 않는다", () => {
    const split = splitRightEdge(square)!;
    const d = openOrthogonalPath(split.rest, 0);
    expect(d.startsWith("M")).toBe(true);
    expect(d.includes("Z")).toBe(false);
  });
});
