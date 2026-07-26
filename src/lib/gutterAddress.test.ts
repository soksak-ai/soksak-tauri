// 골 주소 해소 게이트 — 내부 노드를 부르지 않고도 모든 이음선이 지목된다는 정리(IDENTITY §4)를
// 트리 위에서 실제로 확인한다.
//
// 지키는 규칙 네 가지:
//   ① 전수성 — 트리의 골 개수와 해소된 정본 주소 개수가 같다(빠지는 이음선이 있으면 그 골은
//      부를 말이 없어지고, 부를 말이 없는 조작면은 없는 것과 같다).
//   ② 유일성 — 정본 주소는 골마다 하나다(둘이면 응답이 골 하나를 두 이름으로 말한다).
//   ③ 왕복 — 정본 주소를 내부 좌표로 되돌리면 출발한 그 골이다.
//   ④ 별칭 — left|top 은 앞쪽 이음선으로 풀리고, 정본형으로 되돌아온다.
//
// 픽스처는 세 모양이다: 평평한 row, 같은 축 중첩(정리의 "마지막 자식으로 내려간다"), 수직 중첩
// (정리의 "아무 자식" — 정본이 문서순 첫 자식으로 좁히는 지점).
import { describe, expect, it } from "vitest";
import type { SplitTree } from "../state/splitTree";
import {
  canonicalGutter,
  canonicalSide,
  gutterAddress,
  gutterOwnerOf,
  resolveGutter,
} from "./gutterAddress";

type Cell = { id: string };
const leaf = (id: string): SplitTree<Cell> => ({ type: "leaf", value: { id } });
const split = (
  id: string,
  dir: "row" | "col",
  children: SplitTree<Cell>[],
): SplitTree<Cell> => ({
  type: "split",
  id,
  dir,
  sizes: children.map(() => 1 / children.length),
  children,
});
const idOf = (c: Cell) => c.id;

/** 트리의 모든 골을 내부 좌표로 긁는다 — 기대값의 분모(①). */
function allGutters(node: SplitTree<Cell>): { splitId: string; index: number }[] {
  if (node.type === "leaf") return [];
  const own = node.children.slice(0, -1).map((_, i) => ({ splitId: node.id, index: i }));
  return [...own, ...node.children.flatMap(allGutters)];
}

// row 세 칸: a | b | c → 골 둘(a.right, b.right)
const flatRow = split("s0", "row", [leaf("pan-a"), leaf("pan-b"), leaf("pan-c")]);

// 같은 축 중첩: (a | (b | c)) | d — 안쪽도 row 다.
const sameAxis = split("s0", "row", [
  leaf("pan-a"),
  split("s1", "row", [leaf("pan-b"), leaf("pan-c")]),
  leaf("pan-d"),
]);

// 수직 중첩: (b 위 c) | d — row 의 첫 자식이 col 이라 b·c 둘 다 오른쪽 면에 닿는다.
const perpendicular = split("s0", "row", [
  split("s1", "col", [leaf("pan-b"), leaf("pan-c")]),
  leaf("pan-d"),
]);

describe("① 전수성·② 유일성 — 모든 골이 정확히 한 정본 주소를 갖는다", () => {
  for (const [name, tree] of [
    ["평평한 row", flatRow],
    ["같은 축 중첩", sameAxis],
    ["수직 중첩", perpendicular],
  ] as const) {
    it(`${name}: 골 수 = 정본 주소 수, 중복 0`, () => {
      const gutters = allGutters(tree);
      const owners = gutters.map((g) => gutterOwnerOf(tree, g.splitId, g.index, idOf));
      expect(owners.every((o) => o !== null)).toBe(true);
      const addrs = owners.map((o) => gutterAddress(o!.pane, o!.side));
      expect(addrs.length).toBe(gutters.length);
      expect(new Set(addrs).size).toBe(addrs.length);
    });
  }

  it("평평한 row 의 정본은 왼쪽 칸의 right 다", () => {
    expect(gutterOwnerOf(flatRow, "s0", 0, idOf)).toEqual({ pane: "pan-a", side: "right" });
    expect(gutterOwnerOf(flatRow, "s0", 1, idOf)).toEqual({ pane: "pan-b", side: "right" });
  });

  it("col 분할의 정본은 위쪽 칸의 bottom 이다", () => {
    const t = split("s0", "col", [leaf("pan-a"), leaf("pan-b")]);
    expect(gutterOwnerOf(t, "s0", 0, idOf)).toEqual({ pane: "pan-a", side: "bottom" });
    expect(canonicalSide("col")).toBe("bottom");
  });

  it("같은 축 중첩은 마지막 자식으로 내려간다 — s1 부분트리의 오른쪽 면은 c 가 갖는다", () => {
    expect(gutterOwnerOf(sameAxis, "s0", 1, idOf)).toEqual({ pane: "pan-c", side: "right" });
  });

  it("수직 중첩은 문서순 첫 자식으로 내려간다 — b·c 둘 다 닿지만 정본은 b 하나다", () => {
    expect(gutterOwnerOf(perpendicular, "s0", 0, idOf)).toEqual({
      pane: "pan-b",
      side: "right",
    });
  });

  it("마지막 자식 뒤에는 골이 없다 — 없는 것을 주소로 만들지 않는다", () => {
    expect(gutterOwnerOf(flatRow, "s0", 2, idOf)).toBeNull();
    expect(gutterOwnerOf(flatRow, "s0", -1, idOf)).toBeNull();
    expect(gutterOwnerOf(flatRow, "s-none", 0, idOf)).toBeNull();
  });
});

describe("③ 왕복 — 정본 주소를 내부 좌표로 되돌리면 출발한 골이다", () => {
  for (const [name, tree] of [
    ["평평한 row", flatRow],
    ["같은 축 중첩", sameAxis],
    ["수직 중첩", perpendicular],
  ] as const) {
    it(`${name}: 전 골 왕복 일치`, () => {
      for (const g of allGutters(tree)) {
        const owner = gutterOwnerOf(tree, g.splitId, g.index, idOf)!;
        expect(resolveGutter(tree, owner.pane, owner.side, idOf)).toEqual(g);
      }
    });
  }

  it("배치 바깥 모서리는 풀리지 않는다 — 마지막 칸의 right 에는 골이 없다", () => {
    expect(resolveGutter(flatRow, "pan-c", "right", idOf)).toBeNull();
    expect(resolveGutter(flatRow, "pan-a", "left", idOf)).toBeNull();
    expect(resolveGutter(flatRow, "pan-a", "bottom", idOf)).toBeNull();
  });

  it("트리에 없는 pane 은 null — 추측하지 않는다", () => {
    expect(resolveGutter(flatRow, "pan-zzz", "right", idOf)).toBeNull();
  });
});

describe("④ 별칭 — left|top 은 앞쪽 이음선이고, 되돌리면 정본형이다", () => {
  it("b.left 와 a.right 는 같은 골이다", () => {
    expect(resolveGutter(flatRow, "pan-b", "left", idOf)).toEqual(
      resolveGutter(flatRow, "pan-a", "right", idOf),
    );
    expect(canonicalGutter(flatRow, "pan-b", "left", idOf)).toEqual({
      pane: "pan-a",
      side: "right",
    });
  });

  it("top 도 같은 규칙 — 위 칸의 bottom 으로 되돌아온다", () => {
    const t = split("s0", "col", [leaf("pan-a"), leaf("pan-b")]);
    expect(canonicalGutter(t, "pan-b", "top", idOf)).toEqual({
      pane: "pan-a",
      side: "bottom",
    });
  });

  it("정본 방향을 넣어도 정본이 나온다 — 멱등", () => {
    expect(canonicalGutter(flatRow, "pan-a", "right", idOf)).toEqual({
      pane: "pan-a",
      side: "right",
    });
  });

  it("별칭이 가리키는 골도 정본 pane 이 다를 수 있다 — 중첩에서 별칭은 자기 이름을 못 쓴다", () => {
    // d.left = s0 의 골 0. 그 정본은 왼쪽 부분트리(col)의 문서순 첫 leaf = b.
    expect(canonicalGutter(perpendicular, "pan-d", "left", idOf)).toEqual({
      pane: "pan-b",
      side: "right",
    });
  });
});

describe("주소 문자열은 한 곳에서만 조립된다", () => {
  it("gutter/<pan-id>/<right|bottom>", () => {
    expect(gutterAddress("pan-a", "right")).toBe("gutter/pan-a/right");
    expect(gutterAddress("pan-b", "bottom")).toBe("gutter/pan-b/bottom");
  });
});
