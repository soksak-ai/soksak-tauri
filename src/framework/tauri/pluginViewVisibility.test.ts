import { describe, expect, it, vi } from "vitest";
import { PluginViewVisibility } from "./pluginViewVisibility";

describe("PluginViewVisibility — pane visibility 단일 소유권", () => {
  it("진행 중 hide 뒤에 요청된 show를 직렬 적용하고 최종 적용까지 정착하지 않는다", async () => {
    const releases: (() => void)[] = [];
    const apply = vi.fn(async () => new Promise<void>((resolve) => releases.push(resolve)));
    const visibility = new PluginViewVisibility(apply);

    const hidden = visibility.request(false);
    const shown = visibility.request(true);
    let settled = false;
    const barrier = visibility.settled().then(() => { settled = true; });

    await Promise.resolve();
    expect(apply.mock.calls.map(([visible]) => visible)).toEqual([false]);
    expect(settled).toBe(false);

    releases.shift()!();
    await Promise.resolve();
    expect(apply.mock.calls.map(([visible]) => visible)).toEqual([false, true]);
    expect(settled).toBe(false);

    releases.shift()!();
    await Promise.all([hidden, shown, barrier]);
    expect(settled).toBe(true);
  });
});
