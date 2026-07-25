import { describe, expect, it } from "vitest";
import {
  normalizeRailPlacement,
  DEFAULT_RAIL_PLACEMENT,
  cleanRailLines,
  effectiveRailStation,
  isCleanRailStation,
  projectRailRect,
  projectRailCssTransition,
  railLeftPx,
  railStationFromLeftPx,
  snapRailStation,
  unprojectRailX,
  type RailCell,
} from "./railPlacement";

const cell = (
  id: string,
  left: number,
  width: number,
  top = 0,
  height = 100,
): RailCell => ({ id, rect: { left, top, width, height } });

const twoColumns = [cell("a", 0, 50), cell("b", 50, 50)];
const crossed = [
  cell("a", 0, 50, 0, 50),
  cell("b", 50, 50, 0, 50),
  cell("c", 0, 100, 50, 50),
];
const nested = [
  cell("a", 0, 33, 0, 50),
  cell("b", 33, 33, 0, 50),
  cell("c", 66, 34, 0, 50),
  cell("d", 0, 66, 50, 50),
  cell("e", 66, 34, 50, 50),
];

describe("left rail clean-line contract", () => {
  it("keeps only full-height vertical lines and always includes both edges", () => {
    expect(cleanRailLines(twoColumns.map((item) => item.rect))).toEqual([
      0, 50, 100,
    ]);
    expect(cleanRailLines(crossed.map((item) => item.rect))).toEqual([0, 100]);
    expect(cleanRailLines(nested.map((item) => item.rect))).toEqual([0, 66, 100]);
  });

  it("deduplicates aligned recursive boundaries within floating-point epsilon", () => {
    const lines = cleanRailLines([
      { left: 0, top: 0, width: 33.333333, height: 50 },
      { left: 33.333334, top: 0, width: 66.666666, height: 50 },
      { left: 0, top: 50, width: 33.333332, height: 50 },
      { left: 33.333333, top: 50, width: 66.666667, height: 50 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBeCloseTo(33.333333, 5);
  });

  it("이주 폐지 — 포커스는 위치의 입력이 아니다(같은 pin, 다른 포커스, 같은 답)", () => {
    const pin = { mode: "pin" as const, station: 50 };
    expect(effectiveRailStation(twoColumns, "b", pin)).toBe(50);
    expect(effectiveRailStation(twoColumns, "a", pin)).toBe(50);
  });

  it("PIN snaps to a valid line, with an exact tie resolved toward the front", () => {
    expect(snapRailStation([0, 66, 100], 40)).toBe(66);
    expect(snapRailStation([0, 100], 50)).toBe(0);
    expect(
      effectiveRailStation(nested, "c", { mode: "pin", station: 40 }),
    ).toBe(66);
    // 기본값은 글로벌 정박(station 0) — 포커스가 b 여도 앞선으로 남는다(이주 폐지).
    expect(
      effectiveRailStation(twoColumns, "b", DEFAULT_RAIL_PLACEMENT),
    ).toBe(0);
  });

  it("distinguishes an exact committed PIN from a drag preview that may snap", () => {
    const lines = cleanRailLines(nested.map((item) => item.rect));
    expect(isCleanRailStation(lines, 66)).toBe(true);
    expect(isCleanRailStation(lines, 40)).toBe(false);
    expect(snapRailStation(lines, 40)).toBe(66);
  });
});

describe("real-space rail insertion", () => {
  it("projects a FLOW handoff from the source rect instead of crossing the target rect", () => {
    const source = { left: 50, top: 0, width: 100 / 3, height: 50 };
    const target = { left: 100 / 3, top: 0, width: 100 / 3, height: 50 };

    expect(() => projectRailCssTransition(source, 50, target, 100 / 3))
      .not.toThrow();
    expect(projectRailCssTransition(source, 50, target, 100 / 3)).toMatchObject({
      source: { left: 50 },
      target: { left: 100 / 3 },
    });
  });

  it("reserves a fixed pixel gap without changing vertical geometry", () => {
    const left = projectRailRect(twoColumns[0].rect, 50, 1_000, 200);
    const right = projectRailRect(twoColumns[1].rect, 50, 1_000, 200);
    expect(left).toEqual({ left: 0, top: 0, width: 400, height: 100 });
    expect(right).toEqual({ left: 600, top: 0, width: 400, height: 100 });
    expect(railLeftPx(1_000, 200, 50)).toBe(400);
  });

  it("supports the leading and trailing clean lines with the same fixed width", () => {
    const full = { left: 0, top: 0, width: 100, height: 100 };
    expect(projectRailRect(full, 0, 1_000, 200)).toEqual({
      left: 200,
      top: 0,
      width: 800,
      height: 100,
    });
    expect(projectRailRect(full, 100, 1_000, 200)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 100,
    });
  });

  it("rejects pointer coordinates inside the rail and inverses both panel sides", () => {
    expect(unprojectRailX(200, 1_000, 200, 50)).toBe(200);
    expect(unprojectRailX(500, 1_000, 200, 50)).toBeNull();
    expect(unprojectRailX(800, 1_000, 200, 50)).toBe(600);
  });

  it("maps a dragged fixed-width rail left edge back to its logical station", () => {
    expect(railStationFromLeftPx(400, 1_000, 200)).toBe(50);
    expect(railStationFromLeftPx(-20, 1_000, 200)).toBe(0);
    expect(railStationFromLeftPx(900, 1_000, 200)).toBe(100);
  });

  it("fails closed if a caller tries to insert a rail through a panel", () => {
    expect(() =>
      projectRailRect({ left: 0, top: 0, width: 100, height: 100 }, 50, 1_000, 200),
    ).toThrow(/crosses/i);
  });
});

describe("레일 정박 단일 계약 — 이주(flow) 폐지", () => {
  const cells = [
    { id: "a", rect: { left: 0, top: 0, width: 30, height: 100 } },
    { id: "b", rect: { left: 30, top: 0, width: 70, height: 100 } },
  ];
  it("포커스는 위치의 입력이 아니다 — 어떤 focusId 에서도 같은 선", () => {
    const pin = { mode: "pin" as const, station: 30 };
    expect(effectiveRailStation(cells, "a", pin)).toBe(
      effectiveRailStation(cells, "b", pin),
    );
  });
  it("레거시 flow 저장값은 정박으로 정규화된다", () => {
    expect(normalizeRailPlacement(DEFAULT_RAIL_PLACEMENT)).toEqual(DEFAULT_RAIL_PLACEMENT);
    expect(normalizeRailPlacement(undefined)).toEqual(DEFAULT_RAIL_PLACEMENT);
    expect(normalizeRailPlacement({ mode: "pin", station: 42 })).toEqual({
      mode: "pin",
      station: 42,
    });
  });
});

