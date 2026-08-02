import { describe, expect, it } from "vitest";
import { overlayRightInset } from "./overlayInset";

/** 겹침으로 못 가리는 표면이 있다 — 오버레이가 덮은 폭만큼 판이 좁아져야 한다. */
describe("오버레이가 덮은 폭", () => {
  it("닫혀 있으면 0", () => {
    expect(overlayRightInset({ open: false, mode: "overlay", width: 300 })).toBe(0);
  });

  it("오버레이면 그 폭만큼 판이 좁다", () => {
    expect(overlayRightInset({ open: true, mode: "overlay", width: 300 })).toBe(300);
  });

  /** 밀기는 흐름에서 이미 자리를 가져갔다 — 또 빼면 두 번 빼는 것이고, 뷰가 판 안쪽에서 뜬다. */
  it("밀기는 0 — 흐름이 이미 뺐다", () => {
    expect(overlayRightInset({ open: true, mode: "push", width: 300 })).toBe(0);
  });

  it("음수 폭은 0으로 — 뺄 수 없는 값이 상자를 키우면 안 된다", () => {
    expect(overlayRightInset({ open: true, mode: "overlay", width: -50 })).toBe(0);
  });
});
