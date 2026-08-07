// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  comparePaintOrder,
  layerRank,
  stackingPathOf,
} from "./browser-gate-b06-stacking.mjs";

const entry = (identity, over = {}) => ({
  identity,
  node: identity,
  zIndex: null,
  positioned: true,
  order: [0],
  ...over,
});

describe("B06 칠하는 순서 판정", () => {
  it("같은 문맥 안의 층 — 선언 없으면 배치 여부가 답한다", () => {
    expect(layerRank(entry("a", { zIndex: 7 }))).toBe(7);
    expect(layerRank(entry("a", { zIndex: null, positioned: true }))).toBe(0);
    expect(layerRank(entry("a", { zIndex: null, positioned: false }))).toBeLessThan(0);
    // 배치 여부조차 못 읽었으면 층이 아니다 — 0 으로 적으면 흐름 상자와 같은 자리에 선다.
    expect(layerRank({ identity: "a" })).toBeNull();
    expect(layerRank(null)).toBeNull();
  });

  // 이 게이트가 세워진 이유. 레일 평면(7)과 포커스 베일(6)은 같은 문맥에 없다 — 사이의
  // .space-plane(1)이 자기 문맥을 만들어 베일을 가둔다. 두 z 를 직접 빼면 7>6 이라 통과하는데,
  // 실제로 가른 것은 7>1 이다. 누가 .space-plane 을 8 로 올리면 두 수는 그대로인데 화면에서는
  // 베일이 레일을 덮는다.
  it("갈림길의 층으로 가른다 — 사이 stacking context 를 건너뛰지 않는다", () => {
    const root = entry("root", { zIndex: null, positioned: false, order: [0] });
    const rail = [root, entry("rail-plane", { zIndex: 7, order: [0, 1] })];
    const veil = [
      root,
      entry("space-plane", { zIndex: 1, order: [0, 0] }),
      entry("veil", { zIndex: 6, order: [0, 0, 3] }),
    ];
    expect(comparePaintOrder(rail, veil)).toBe(1);
    expect(comparePaintOrder(veil, rail)).toBe(-1);

    // 낀 판이 레일보다 위로 올라가면 그 안의 베일이 레일을 덮는다 — 두 수(7,6)는 그대로다.
    const raisedSpace = [
      root,
      entry("space-plane", { zIndex: 8, order: [0, 0] }),
      entry("veil", { zIndex: 6, order: [0, 0, 3] }),
    ];
    expect(comparePaintOrder(rail, raisedSpace)).toBe(-1);
  });

  it("층이 같으면 문서 순서가 가른다", () => {
    const root = entry("root", { order: [0] });
    const first = [root, entry("first", { zIndex: 3, order: [0, 1] })];
    const second = [root, entry("second", { zIndex: 3, order: [0, 2] })];
    expect(comparePaintOrder(second, first)).toBe(1);
    expect(comparePaintOrder(first, second)).toBe(-1);
  });

  it("못 가르는 자리는 null 이다 — 같은 층으로 적지 않는다", () => {
    const root = entry("root", { order: [0] });
    const ancestor = [root, entry("plane", { zIndex: 2, order: [0, 1] })];
    const descendant = [...ancestor, entry("child", { zIndex: 1, order: [0, 1, 0] })];
    // 한쪽이 다른 쪽의 조상이다 — 배경과 자손의 순서는 이 사슬 축이 답할 것이 아니다.
    expect(comparePaintOrder(ancestor, descendant)).toBeNull();
    expect(comparePaintOrder(ancestor, ancestor)).toBe(0);
    expect(comparePaintOrder(null, ancestor)).toBeNull();
    expect(comparePaintOrder([], ancestor)).toBeNull();
    // 갈림길의 층을 못 읽으면 답하지 않는다.
    const unreadable = [root, { identity: "opaque", order: [0, 2] }];
    expect(comparePaintOrder(ancestor, unreadable)).toBeNull();
  });

  it("사슬을 안 실은 측정은 빈 배열이 아니라 null 이다", () => {
    expect(stackingPathOf({ rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
    expect(stackingPathOf({ stacking: [] })).toBeNull();
    expect(stackingPathOf({ stacking: [{ zIndex: 1 }] })).toBeNull();
    const path = [entry("root")];
    expect(stackingPathOf({ stacking: path })).toBe(path);
  });
});
