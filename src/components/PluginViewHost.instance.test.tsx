import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry, type PluginViewContext } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";
import {
  __resetPluginViewPresentationHostForTest,
  registerPluginViewPresentationHost,
} from "../plugins/viewPresentationHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DECL = {
  id: "content",
  title: { en: "Browser" },
  placements: ["content"],
  defaultPlacement: "content",
  nativeSurface: true,
} as unknown as ContributedView;

describe("PluginViewHost — 인스턴스 수명과 DOM 수명 분리", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    __resetPluginViewPresentationHostForTest();
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host.remove();
    __resetPluginViewPresentationHostForTest();
  });

  it("connect가 명령 가능한 인스턴스를 먼저 등록하고 mount는 DOM만 소유한다", () => {
    const order: string[] = [];
    const disconnect = vi.fn(() => order.push("disconnect"));
    const provider = {
      connect(ctx: PluginViewContext) {
        order.push(`connect:${ctx.viewId}`);
        return disconnect;
      },
      mount() { order.push("mount"); },
      unmount() { order.push("unmount"); },
    };
    act(() => {
      useViewRegistry.getState().register("browser", DECL, provider as never);
      root = createRoot(host);
      root.render(
        <PluginViewHost
          viewKey="browser.content"
          projectId="p1"
          root="/project"
          region="content"
          viewId="tab-1"
        />,
      );
    });

    expect(order.slice(0, 2)).toEqual(["connect:tab-1", "mount"]);
    act(() => root!.unmount());
    root = null;
    expect(order.slice(-2)).toEqual(["unmount", "disconnect"]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("nativeSurface 선언도 플러그인 DOM mount를 다른 renderer에 위임하지 않는다", () => {
    const mount = vi.fn((el: HTMLElement) => { el.textContent = "browser chrome"; });
    registerPluginViewPresentationHost({
      mount: vi.fn(() => { throw new Error("presentation host must not own plugin DOM"); }),
    });
    act(() => {
      useViewRegistry.getState().register("browser", DECL, { mount } as never);
      root = createRoot(host);
      root.render(
        <PluginViewHost viewKey="browser.content" projectId="p1" root="/project" region="content" viewId="tab-1" />,
      );
    });
    expect(mount).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("browser chrome");
  });
});
