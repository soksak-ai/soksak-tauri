// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyRendererTopology,
  directNativeSurfaces,
  normalizeNativeSurfaces,
  visibleAnchorFacts,
} from "./surfaceAudit";

describe("Tauri 표면 감사의 DOM 정본", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("실제 data-content-view-body 홀 자체를 앵커로 읽고 탭 identity는 공개 조상에서 얻는다", () => {
    const frame = document.createElement("div");
    frame.dataset.node = "layout/tab/v1";
    frame.dataset.projectId = "t1";
    const slot = document.createElement("div");
    slot.dataset.tauriHole = "content";
    slot.dataset.contentViewBody = "b-v1";
    slot.getBoundingClientRect = () =>
      ({ x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200 }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    expect(visibleAnchorFacts()).toEqual([
      {
        label: "b-v1",
        viewId: "v1",
        projectId: "t1",
        rect: { x: 10, y: 20, w: 300, h: 200 },
      },
    ]);
  });

  it("DOM renderer와 native surface가 창 루트에서만 만나는 구조를 panel-atomic 불가로 판정한다", () => {
    expect(classifyRendererTopology({
      domRendererPath: ["NSThemeFrame", "TaoView", "WryWebView"],
      nativeSurfacePath: ["NSThemeFrame", "TaoView", "EngineSurfaceHost", "NSView", "WryWebView"],
      lowestCommonAncestorDepth: 1,
      lowestCommonAncestorIsWindowContentRoot: true,
    })).toEqual({
      verdict: "independent-renderer-roots",
      panelAtomicMotion: false,
      sharedPaneHost: null,
    });
  });

  it("윈도우 프레임만 공유하는 구조를 pane host로 오인하지 않는다", () => {
    expect(classifyRendererTopology({
      domRendererPath: ["NSThemeFrame", "TaoView", "WryWebView"],
      nativeSurfacePath: ["NSThemeFrame", "DetachedSurfaceHost", "WryWebView"],
      lowestCommonAncestorDepth: 0,
      lowestCommonAncestorIsWindowContentRoot: false,
    }).panelAtomicMotion).toBe(false);
  });

  it("DOM renderer와 native surface가 같은 pane host 아래 있으면 panel-atomic 가능으로 판정한다", () => {
    expect(classifyRendererTopology({
      domRendererPath: ["TaoView", "PaneSurfaceHost", "WryWebView"],
      nativeSurfacePath: ["TaoView", "PaneSurfaceHost", "BrowserSurface"],
      lowestCommonAncestorDepth: 1,
      lowestCommonAncestorIsWindowContentRoot: false,
    })).toEqual({
      verdict: "shared-pane-host",
      panelAtomicMotion: true,
      sharedPaneHost: "PaneSurfaceHost",
    });
  });

  it("PaneSurfaceHost 소유 표면을 직접 DOM 홀 감사에서 다시 판정하지 않는다", () => {
    const surfaces = normalizeNativeSurfaces({
      surfaces: [
        {
          ptr: 1, label: "direct", pane: null, hidden: false, effectivelyHidden: false,
          frame: { x: 10, y: 20, w: 100, h: 80 },
        },
        {
          ptr: 2, label: "browser", pane: "pane-a", hidden: false, effectivelyHidden: false,
          frame: { x: 0, y: 0, w: 300, h: 200 },
        },
      ],
    }, 500);

    expect(surfaces.map((surface) => [surface.label, surface.pane])).toEqual([
      ["direct", null],
      ["browser", "pane-a"],
    ]);
    expect(directNativeSurfaces(surfaces).map((surface) => surface.label)).toEqual(["direct"]);
  });
});
