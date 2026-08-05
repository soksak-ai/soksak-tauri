import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutSettlementForTest,
  invalidateLayout,
  layoutSettlementFacts,
  onLayoutSettlement,
  settleLayout,
} from "./layoutSettlement";

describe("layoutSettlement — 상태 변이와 표시 해의 revision 장벽", () => {
  afterEach(__resetLayoutSettlementForTest);

  it("프로젝트별 최신 invalidation을 settle할 때만 닫힌다", () => {
    const listener = vi.fn();
    const off = onLayoutSettlement(listener);
    expect(invalidateLayout("t1")).toBe(1);
    expect(invalidateLayout("t1")).toBe(2);
    expect(invalidateLayout("t2")).toBe(1);
    expect(layoutSettlementFacts()).toMatchObject({ active: true });
    settleLayout("t1");
    expect(layoutSettlementFacts().pending.map((item) => item.key)).toEqual(["t2"]);
    settleLayout("t2");
    expect(layoutSettlementFacts()).toEqual({ active: false, pending: [] });
    expect(listener).toHaveBeenCalledTimes(5);
    off();
  });
});
