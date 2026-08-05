import { describe, expect, it } from "vitest";
import {
  comparePanePresentation,
  isPluginViewCallExposed,
  projectPluginViewNode,
  projectPluginViewSlot,
} from "./pluginViewPresentation";

describe("Tauri plugin renderer RPC surface", () => {
  it("공개 content surface 생성 거래인 webview.open을 노출한다", () => {
    expect(isPluginViewCallExposed("webview.open")).toBe(true);
  });

  it("임의의 app 내부 경로는 노출하지 않는다", () => {
    expect(isPluginViewCallExposed("internal.anything")).toBe(false);
  });

  it("child content slot을 메인 좌표계의 공개 측정 DOM으로 투영한다", () => {
    const container = document.createElement("div");
    const projected = projectPluginViewSlot(container, {
      label: "b-main-tab-1", x: 11, y: 47, w: 320, h: 180,
    });
    expect(projected.dataset.node).toBe("surface");
    expect(projected.dataset.tauriNativeSlot).toBe("b-main-tab-1");
    expect(projected.hasAttribute("data-content-view-body")).toBe(false);
    expect(projected.style.cssText).toContain("left: 11px");
    expect(projected.style.cssText).toContain("height: 180px");
  });

  it("child toolbar도 같은 탭 주소 아래 공개 측정 DOM으로 투영한다", () => {
    const container = document.createElement("div");
    const projected = projectPluginViewNode(container, {
      label: "b-main-tab-1", node: "toolbar", x: 4, y: 8, w: 300, h: 40,
    });
    expect(projected.dataset.node).toBe("toolbar");
    expect(projected.dataset.tauriNativeNode).toBe("b-main-tab-1");
    expect(projected.style.top).toBe("8px");
  });

  it("호출 창의 DOM pane과 native host를 1:1·반올림 오차만으로 판정한다", () => {
    const verdict = comparePanePresentation(
      [
        { pane: "pane-a", frame: { x: 60.2, y: 121, w: 481.2, h: 929 } },
        { pane: "pane-b", frame: { x: 713.2, y: 121, w: 180.8, h: 929 } },
      ],
      [
        { pane: "pane-a", window: "w-1", cssFrame: { x: 60, y: 121, w: 481, h: 929 } },
        { pane: "pane-b", window: "w-1", cssFrame: { x: 500, y: 121, w: 180, h: 929 } },
        { pane: "foreign", window: "w-2", cssFrame: { x: 0, y: 0, w: 1, h: 1 } },
      ],
      "w-1",
    );
    expect(verdict.matches).toHaveLength(2);
    expect(verdict.matches[0]).toMatchObject({ pane: "pane-a", ok: true });
    expect(verdict.matches[1]).toMatchObject({ pane: "pane-b", ok: false });
    expect(verdict.foreignNative).toEqual(["foreign"]);
    expect(verdict.ok).toBe(false);
  });
});
