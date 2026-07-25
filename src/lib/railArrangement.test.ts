import { describe, expect, it } from "vitest";
import type { SplitTree } from "../state/splitTree";
import { leavesOf } from "../state/splitTree";
import { computeSplitLayout } from "./splitLayout";
import { isCleanRailStation } from "./railPlacement";
import {
  arrangementMoves,
  moveOffsetPx,
  solveArrangement,
  railMoveAcross,
  spanMoveAcross,
} from "./railArrangement";

type Panel = { id: string };
const leaf = (id: string): SplitTree<Panel> => ({ type: "leaf", value: { id } });
const order = (tree: SplitTree<Panel>): string[] =>
  leavesOf(tree).map((p) => p.id);

const HOST_W = 1000;
const RAIL_W = 246;

/** [a | b | c] 균등 3열. */
const threeColumns = (): SplitTree<Panel> => ({
  type: "split",
  id: "root",
  dir: "row",
  sizes: [1 / 3, 1 / 3, 1 / 3],
  children: [leaf("a"), leaf("b"), leaf("c")],
});

/** 상단 1 / 하단 2(반반) — 행별 세로선이 안 맞는 사용자 케이스. */
const oneOverTwo = (): SplitTree<Panel> => ({
  type: "split",
  id: "root",
  dir: "col",
  sizes: [0.5, 0.5],
  children: [
    leaf("top"),
    {
      type: "split",
      id: "bottom",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [leaf("bl"), leaf("br")],
    },
  ],
});

const solve = (
  layout: SplitTree<Panel>,
  focusId: string | null,
  extra: Partial<Parameters<typeof solveArrangement<Panel>>[0]> = {},
) =>
  solveArrangement<Panel>({
    layout,
    focusId,
    placement: { mode: "flow" },
    railOpen: true,
    ...extra,
  });

/** 논리 셀의 물리 left(px) — 소비자(GroupArea)의 배치 산식과 같은 합성. */
const leftPx = (
  arrangement: ReturnType<typeof solve>,
  id: string,
): number => {
  const cell = arrangement.cells.find((c) => c.id === id)!;
  const after = cell.rect.left >= arrangement.station - 1e-9;
  return (HOST_W * cell.rect.left) / 100 + (after ? RAIL_W : 0) - (RAIL_W * cell.rect.left) / 100;
};

describe("배치 해결기 — station 은 그리드와 포커스의 함수다", () => {
  it("균등 3열에서 포커스별 station 은 그 패널의 왼쪽 클린 라인이다", () => {
    expect(solve(threeColumns(), "a").station).toBeCloseTo(0, 6);
    expect(solve(threeColumns(), "b").station).toBeCloseTo(100 / 3, 6);
    expect(solve(threeColumns(), "c").station).toBeCloseTo(200 / 3, 6);
    expect(solve(threeColumns(), "b").swapped).toBe(false);
  });

  it("PIN 은 포커스를 입력으로 쓰지 않는다 — 어떤 포커스에서도 같은 선", () => {
    const pinned = { placement: { mode: "pin" as const, station: 31 } };
    const atA = solve(threeColumns(), "a", pinned);
    const atC = solve(threeColumns(), "c", pinned);
    expect(atA.station).toBeCloseTo(100 / 3, 6); // 가장 가까운 클린 라인으로 snap
    expect(atC.station).toBe(atA.station);
    expect(atC.swapped).toBe(false);
  });

  it("미해소 포커스는 0 으로 붕괴하지 않고 현 위치를 유지한다", () => {
    const held = solve(threeColumns(), "ghost", { fallbackStation: 200 / 3 });
    expect(held.station).toBeCloseTo(200 / 3, 6);
    expect(held.swapped).toBe(false);
  });

  it("사이드바가 닫혀 있으면 붙을 레일이 없다 — 스위칭하지 않는다", () => {
    const closed = solve(oneOverTwo(), "br", { railOpen: false });
    expect(closed.swapped).toBe(false);
    expect(order(closed.displayLayout)).toEqual(["top", "bl", "br"]);
  });

  it("최대화는 [레일 | 기능] 단일 평면이다 — 밑 분할을 소비하지 않는다", () => {
    const max = solve(oneOverTwo(), "br", { maximizedId: "br" });
    expect(max.cells).toEqual([
      { id: "br", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(max.station).toBe(0);
    expect(max.swapped).toBe(false);
  });
});

describe("배치 해결기 — 행 불일치 예외(스위칭 + 점선 근거)", () => {
  it("상단 1 / 하단 2 에서 하단 뒷쪽 포커스는 앞으로 스위칭하고 만들어진 인접을 보고한다", () => {
    const canonical = oneOverTwo();
    const frozen = structuredClone(canonical);
    const to = solve(canonical, "br");

    expect(order(to.displayLayout)).toEqual(["top", "br", "bl"]);
    expect(to.swapped).toBe(true); // 점선 봉합의 단일 근거(자연 인접은 무표시)
    const cells = computeSplitLayout(to.displayLayout).cells;
    const focused = cells.find((c) => c.value.id === "br")!;
    expect(isCleanRailStation(to.cleanLines, focused.rect.left)).toBe(true);
    expect(canonical).toEqual(frozen); // 정본 트리는 변이하지 않는다
  });

  it("이미 클린한 포커스는 배열을 건드리지 않는다(정체성 보존)", () => {
    const canonical = oneOverTwo();
    const at = solve(canonical, "top");
    expect(at.displayLayout).toBe(canonical);
    expect(at.swapped).toBe(false);
  });

  it("멀리 있는 포커스도 가까운 왼쪽 형제 하나와만 교환한다 — 전역 재배열 금지", () => {
    // 위 [terminal | playbox | astryxTop], 아래 [about(1/3) | astryxBottom(2/3)].
    const reported: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [1 / 3, 1 / 3, 1 / 3],
          children: [leaf("terminal"), leaf("playbox"), leaf("astryxTop")],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [1 / 3, 2 / 3],
          children: [leaf("about"), leaf("astryxBottom")],
        },
      ],
    };
    const to = solve(reported, "astryxTop");
    expect(order(to.displayLayout)).toEqual([
      "terminal",
      "astryxTop",
      "playbox",
      "about",
      "astryxBottom",
    ]);
    expect(to.station).toBeCloseTo(100 / 3, 5); // 스테이션 무이동
    expect(to.cells.find((c) => c.id === "terminal")!.rect.left).toBeCloseTo(0, 5);
  });

  it("폭이 다른 형제는 sizes 를 함께 교환한다 — 각 패널의 폭이 보존된다", () => {
    const uneven: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [leaf("t1"), leaf("t2")],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [1 / 3, 2 / 3],
          children: [leaf("about"), leaf("astryx")],
        },
      ],
    };
    const to = solve(uneven, "astryx");
    expect(order(to.displayLayout)).toEqual(["t1", "t2", "astryx", "about"]);
    const cells = to.cells;
    expect(cells.find((c) => c.id === "astryx")!.rect.width).toBeCloseTo(200 / 3, 5);
    expect(cells.find((c) => c.id === "about")!.rect.width).toBeCloseTo(100 / 3, 5);
  });

  it("교환 후보가 없으면 원본 배열 + 앞쪽 클린 라인이다", () => {
    // 상단 wide / 하단 [r | col(p, q)]. q 는 row 의 직접 leaf 자식이 아니라 col 안에 있어
    // 교환 상대가 없다. 막힌 포커스는 억지로 배열을 흔들지 않고 앞(왼쪽) 클린 라인에 선다.
    const blocked: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        leaf("wide"),
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            leaf("r"),
            {
              type: "split",
              id: "nest",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [leaf("p"), leaf("q")],
            },
          ],
        },
      ],
    };
    const to = solve(blocked, "q");
    expect(to.displayLayout).toBe(blocked); // 배열 불변(정체성)
    expect(to.swapped).toBe(false);
    expect(to.station).toBe(0); // q 의 왼쪽 50 은 wide 가 가로질러 더럽다 → 앞 선
  });
});

describe("이동량 — 해가 지시한 패널만, 폭은 절대 변하지 않는다", () => {
  it("레일이 가로지른 패널만 railW 만큼 평행이동한다", () => {
    const from = solve(threeColumns(), "a");
    const to = solve(threeColumns(), "b");
    const moves = arrangementMoves(from, to);

    expect(moves.map((m) => m.id)).toEqual(["a"]); // b·c 는 이동 없음
    const [a] = moves;
    expect(a.dLeftPct).toBeCloseTo(0, 9); // 배열은 그대로 — 삽입 지점만 바뀐다
    expect(moveOffsetPx(a, HOST_W, RAIL_W)).toBeCloseTo(RAIL_W, 6);

    // 폭 불변(네이티브 리사이즈 0) — 모든 셀의 폭이 위상 전후 동일하다.
    for (const cell of to.cells) {
      const before = from.cells.find((c) => c.id === cell.id)!;
      expect(cell.rect.width).toBeCloseTo(before.rect.width, 9);
      expect(cell.rect.height).toBeCloseTo(before.rect.height, 9);
    }
  });

  it("합성 오프셋은 두 배치의 물리 left 차이와 정확히 같다(스위칭+주행 동시에도)", () => {
    const canonical = oneOverTwo();
    const from = solve(canonical, "top");
    const to = solve(canonical, "br");
    const moves = arrangementMoves(from, to);

    // br 은 스위칭으로 배열이 바뀌고 station 도 재계산된다 — 두 축이 한 위상에 겹친다.
    const br = moves.find((m) => m.id === "br")!;
    expect(moveOffsetPx(br, HOST_W, RAIL_W)).toBeCloseTo(
      leftPx(from, "br") - leftPx(to, "br"),
      6,
    );
    const bl = moves.find((m) => m.id === "bl")!;
    expect(moveOffsetPx(bl, HOST_W, RAIL_W)).toBeCloseTo(
      leftPx(from, "bl") - leftPx(to, "bl"),
      6,
    );
    // 참여하지 않은 패널은 목록에 없다(FLIP 은 실제 이동 요소에만).
    expect(moves.some((m) => m.id === "top")).toBe(false);
  });

  it("같은 배치는 이동이 아니고, 리사이즈가 남긴 float 오차도 이동이 아니다", () => {
    const from = solve(threeColumns(), "b");
    expect(arrangementMoves(from, solve(threeColumns(), "b"))).toEqual([]);

    // 균등화가 남긴 미세 float 차 — station 도 셀 left 도 소수점 끝자리만 다르다.
    // 이것을 이동으로 세면 탭 전환마다 유령 주행 위상이 열린다(실사고).
    const drifted: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "row",
      sizes: [0.333333, 0.333334, 0.333333],
      children: [leaf("a"), leaf("b"), leaf("c")],
    };
    expect(arrangementMoves(from, solve(drifted, "b"))).toEqual([]);
  });
});

describe("레일 자신의 이동량 — 인스턴스는 하나고 그 하나가 복도를 탄다", () => {
  it("레일 이동량 = 두 스테이션의 left 차이(자기 폭 항 포함)", () => {
    // 레일은 calc(s% - railW*s/100) 에 앉는다. 두 스테이션의 그 값 차이가 이동량이다 —
    // 표상을 둘(출발·도착) 두면 도착 쪽이 새로 마운트돼 열려 있던 사이드바가 버려진다.
    const leftPx = (s: number) => (HOST_W * s) / 100 - (RAIL_W * s) / 100;
    for (const [from, to] of [[0, 100], [100, 0], [50, 0], [0, 50], [50, 50]]) {
      expect(moveOffsetPx(railMoveAcross(from, to), HOST_W, RAIL_W)).toBeCloseTo(
        leftPx(from) - leftPx(to),
        6,
      );
    }
  });

  it("정차(같은 스테이션)는 이동량 0 — 유령 주행 금지", () => {
    expect(moveOffsetPx(railMoveAcross(37.5, 37.5), HOST_W, RAIL_W)).toBe(0);
  });
});

describe("장식 span 이동량 — 복도는 패널과 같은 곡선으로 움직여야 한다", () => {
  it("레일이 가로지른 디바이더는 railW 만큼, 지나치지 않은 것은 0", () => {
    // 디바이더는 패널이 아니라 복도의 일부다 — 배열 교환에 참여하지 않으므로 이동량의
    // 유일한 원천은 삽입 지점 변화다. 이것이 0 이면 셀은 활강하는데 디바이더만 t0 에
    // 도착지로 순간이동해 위상 내내 화면이 찢긴다.
    const at50 = { left: 50, top: 0, width: 0, height: 100 };
    const crossed = spanMoveAcross(at50, 0, 100);
    expect(moveOffsetPx(crossed, HOST_W, RAIL_W)).toBeCloseTo(RAIL_W, 6);
    const untouched = spanMoveAcross(at50, 50, 50);
    expect(moveOffsetPx(untouched, HOST_W, RAIL_W)).toBeCloseTo(0, 6);
  });

  it("레일을 관통하게 된 가로 span 은 시작 오프셋을 갖는다(폭 변화는 translate 밖)", () => {
    // 전 폭 col 디바이더: station 0 에서는 레일 오른쪽에서 시작하고, station 50 에서는 레일을
    // 관통해 0 부터 gap 까지 이어진다 — 왼쪽 끝이 railW 만큼 이동한다. 같은 전환에서 span 의
    // '길이'도 변하는데 그것은 translate 로 표현할 수 없다(선 길이라 시각 영향 미미) — 알려진
    // 한계로 남긴다.
    const wide = { left: 0, top: 50, width: 100, height: 0 };
    expect(moveOffsetPx(spanMoveAcross(wide, 0, 50), HOST_W, RAIL_W)).toBeCloseTo(RAIL_W, 6);
  });
});
