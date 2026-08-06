import { describe, expect, it, vi } from "vitest";
import { PluginViewSidecars } from "./pluginViewSidecars";

describe("Tauri plugin pane sidecar RPC handles", () => {
  it("open/send/on/close를 한 presentation 수명 안에서 중계하고 dispose가 잔존 handle을 닫는다", async () => {
    const listeners = new Map<string, (payload: Record<string, unknown>) => void>();
    const closeA = vi.fn(async () => undefined);
    const closeB = vi.fn(async () => undefined);
    let opened = 0;
    const api = {
      open: vi.fn(async () => {
        opened += 1;
        const close = opened === 1 ? closeA : closeB;
        return {
          send: vi.fn(async (message: Record<string, unknown>) => ({ echoed: message })),
          on(event: string, listener: (payload: Record<string, unknown>) => void) {
            listeners.set(event, listener);
            return { dispose: () => listeners.delete(event) };
          },
          close,
        };
      }),
    };
    const registry = new PluginViewSidecars();

    const first = await registry.open(api, "browser-chromium");
    const second = await registry.open(api, "browser-chromium");
    expect(await registry.send(first, { type: "stats" })).toEqual({
      echoed: { type: "stats" },
    });

    const received = vi.fn();
    const subscription = registry.subscribe(first, "created", received);
    listeners.get("created")?.({ id: 7 });
    expect(received).toHaveBeenCalledWith({ id: 7 });
    subscription.dispose();
    expect(listeners.has("created")).toBe(false);

    await registry.close(first);
    expect(closeA).toHaveBeenCalledTimes(1);
    await registry.dispose();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });

  it("자기 presentation이 열지 않은 handle을 거부한다", async () => {
    const registry = new PluginViewSidecars();
    await expect(registry.send("foreign", {})).rejects.toThrow("알 수 없는 sidecar handle");
  });
});
