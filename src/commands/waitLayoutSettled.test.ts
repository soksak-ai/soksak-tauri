// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginLayoutMotion, endLayoutMotion, __resetLayoutMotionForTest } from "../lib/layoutMotion";
import { waitLayoutSettled } from "./waitLayoutSettled";
import {
  __resetLayoutSettlementForTest,
  invalidateLayout,
  settleLayout,
} from "../lib/layoutSettlement";
import {
  __resetContentViewHostForTest,
  registerContentViewHost,
  type ContentViewHost,
} from "../lib/contentViews";
import {
  __resetPluginViewPresentationHostForTest,
  registerPluginViewPresentationHost,
  type PluginViewPresentationHost,
} from "../plugins/viewPresentationHost";

describe("waitLayoutSettled — 이벤트 기반 레이아웃 거래 장벽", () => {
  afterEach(() => {
    __resetLayoutMotionForTest();
    __resetLayoutSettlementForTest();
    __resetContentViewHostForTest();
    __resetPluginViewPresentationHostForTest();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "getAnimations");
  });

  const animations = (values: Animation[]) => {
    Object.defineProperty(document, "getAnimations", {
      configurable: true,
      value: vi.fn(() => values),
    });
  };

  it("활성 위상이 닫히는 에지 전에는 완료하지 않는다", async () => {
    animations([]);
    beginLayoutMotion("move");
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    endLayoutMotion("move");
    await waiting;
    expect(done).toBe(true);
  });

  it("진행 중 CSS animation의 finished 에지가 온 뒤 완료한다", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const animation = {
      playState: "running",
      pending: false,
      animationName: "rail-flip-x",
      finished,
    } as unknown as Animation;
    animations([animation]);
    const getAnimations = document.getAnimations as ReturnType<typeof vi.fn>;
    getAnimations.mockReturnValueOnce([animation]).mockReturnValue([]);
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await waiting;
    expect(done).toBe(true);
  });

  it("상태 변이 revision을 렌더러가 ACK하기 전에는 완료하지 않는다", async () => {
    animations([]);
    invalidateLayout("t1");
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    settleLayout("t1");
    await waiting;
    expect(done).toBe(true);
  });

  it("현재 프로젝트와 무관한 pending revision은 현재 창의 정착을 막지 않는다", async () => {
    animations([]);
    invalidateLayout("inactive-project");
    const result = await waitLayoutSettled(4_000, "active-project");
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it("콘텐츠 호스트의 실제 표시 장벽 완료 전에는 답하지 않는다", async () => {
    animations([]);
    document.body.innerHTML = '<div data-content-view-body="b-current"></div>';
    let present!: () => void;
    const barrier = new Promise<void>((resolve) => { present = resolve; });
    const presentationSettled = vi.fn(() => barrier);
    registerContentViewHost({ presentationSettled } as unknown as ContentViewHost);
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(presentationSettled).toHaveBeenCalledWith(["b-current"]);
    present();
    await waiting;
    expect(done).toBe(true);
  });

  it("콘텐츠 표면과 플러그인 view presentation 장벽을 함께 닫기 전에는 답하지 않는다", async () => {
    animations([]);
    document.body.innerHTML = '<div data-content-view-body="b-current"></div>';
    let settleContent!: () => void;
    let settlePluginView!: () => void;
    const contentBarrier = new Promise<void>((resolve) => { settleContent = resolve; });
    const pluginViewBarrier = new Promise<void>((resolve) => { settlePluginView = resolve; });
    const contentPresentationSettled = vi.fn(() => contentBarrier);
    const pluginViewPresentationSettled = vi.fn(() => pluginViewBarrier);
    registerContentViewHost({
      presentationSettled: contentPresentationSettled,
    } as unknown as ContentViewHost);
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: pluginViewPresentationSettled,
    } as unknown as PluginViewPresentationHost);

    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    const bothArmedBeforeSettlement = contentPresentationSettled.mock.calls.length === 1
      && pluginViewPresentationSettled.mock.calls.length === 1;

    settleContent();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    const doneWithPluginViewPending = done;

    settlePluginView();
    await waiting;
    expect(contentPresentationSettled).toHaveBeenCalledWith(["b-current"]);
    expect(pluginViewPresentationSettled).toHaveBeenCalledWith();
    expect(bothArmedBeforeSettlement).toBe(true);
    expect(doneWithPluginViewPending).toBe(false);
    expect(done).toBe(true);
  });
});
