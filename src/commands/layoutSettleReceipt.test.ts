// @vitest-environment jsdom
// 정착에는 시각이 있고, 확인한 주인이 있다.
//
// B05는 "자극 → 거래 종료 → 정착 → 유지"를 한 시간축에서 판정한다. 그러려면 정착 장벽이
// 두 가지를 답해야 한다.
//
//  1) 정착 epoch — 장벽이 닫힌 절대 시각. 호출자가 `Date.now()`로 대신 찍으면 그 값은 RPC
//     왕복까지 포함한 다른 사실이고, 배치 장부·native display 원장과 같은 축이 아니다.
//  2) syncPending — **표면 주인이 이 정착을 확인했는가**. DOM만 조용해지고 표면 주인이
//     아무 것도 확인하지 않은 상태를 `false`로 답하면, "모른다"가 "동기화 끝났다"로 둔갑한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginLayoutMotion, endLayoutMotion, __resetLayoutMotionForTest } from "../lib/layoutMotion";
import { waitLayoutSettled } from "./waitLayoutSettled";
import { __resetLayoutSettlementForTest } from "../lib/layoutSettlement";
import { presentationNowUnixMs } from "../lib/presentationClock";
import {
  __resetContentViewHostForTest,
  registerContentViewHost,
  type ContentViewHost,
} from "../lib/contentViews";
import { __resetPluginViewPresentationHostForTest } from "../plugins/viewPresentationHost";

afterEach(() => {
  __resetLayoutMotionForTest();
  __resetLayoutSettlementForTest();
  __resetContentViewHostForTest();
  __resetPluginViewPresentationHostForTest();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "getAnimations");
});

const noAnimations = () => {
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    value: vi.fn(() => []),
  });
};

function registerSurfaceOwner(settled: Promise<void>): void {
  registerContentViewHost({
    presentationSettled: async () => settled,
  } as unknown as ContentViewHost);
}

describe("waitLayoutSettled — 정착 영수증", () => {
  it("정착 epoch를 presentation clock으로 답한다", async () => {
    noAnimations();
    registerSurfaceOwner(Promise.resolve());
    const before = presentationNowUnixMs();
    const receipt = await waitLayoutSettled();
    const after = presentationNowUnixMs();

    expect(Number.isFinite(receipt.settledAtUnixMs)).toBe(true);
    expect(receipt.settledAtUnixMs).toBeGreaterThanOrEqual(before);
    expect(receipt.settledAtUnixMs).toBeLessThanOrEqual(after);
  });

  it("표면 주인이 정착을 확인했으면 syncPending=false다", async () => {
    noAnimations();
    registerSurfaceOwner(Promise.resolve());
    const receipt = await waitLayoutSettled();
    expect(receipt.syncPending).toBe(false);
  });

  it("표면 주인이 아무 것도 확인하지 않았으면 syncPending=true다 — 모른다를 끝났다로 쓰지 않는다", async () => {
    noAnimations();
    const receipt = await waitLayoutSettled();
    expect(receipt.syncPending).toBe(true);
  });

  it("위상이 다시 열렸다 닫히면 확인은 새 정착의 사실이다", async () => {
    noAnimations();
    let confirm!: () => void;
    registerSurfaceOwner(new Promise<void>((resolve) => { confirm = resolve; }));
    beginLayoutMotion("move");
    const waiting = waitLayoutSettled();
    await Promise.resolve();
    endLayoutMotion("move");
    confirm();
    const receipt = await waiting;

    expect(receipt.syncPending).toBe(false);
    expect(receipt.settledAtUnixMs).toBeGreaterThan(0);
  });
});
