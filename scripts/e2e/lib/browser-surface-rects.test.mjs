import { describe, expect, it } from "vitest";
import { mapBrowserSurfaceRects } from "./browser-surface-rects.mjs";

const views = ["tab-left", "tab-right"];
const labels = ["native-tab-left", "native-tab-right"];

describe("browser surface rect evidence", () => {
  it("projects PaneSurfaceHost member frames into window coordinates", () => {
    const result = mapBrowserSurfaceRects({
      framework: "tauri",
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: views,
      labels,
      paneComposition: {
        matches: labels.map((label, index) => ({
          viewId: views[index],
          chromeAboveHost: true,
          domFrame: { x: index ? 513 : 60, y: 121, w: 281, h: 449 },
          memberMatches: [{
            label,
            topologyPath: `window/w-test/view/${views[index]}/content/${label}`,
            nativeCount: 1,
            ok: true,
            domFrame: { x: 0, y: 28, w: 281, h: 421 },
          }],
        })),
      },
    });

    expect(result).toEqual([
      {
        viewId: "tab-left", surfaceId: "native-tab-left", live: true,
        topologyPath: "window/w-test/view/tab-left/content/native-tab-left",
        visible: true, presented: true, rect: { x: 60, y: 149, w: 281, h: 421 },
      },
      {
        viewId: "tab-right", surfaceId: "native-tab-right", live: true,
        topologyPath: "window/w-test/view/tab-right/content/native-tab-right",
        visible: true, presented: true, rect: { x: 513, y: 149, w: 281, h: 421 },
      },
    ]);
  });

  it("uses the owner-published offscreen presentation bounds", () => {
    const result = mapBrowserSurfaceRects({
      framework: "tauri",
      surface: "engine-offscreen",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["offscreen-tab-right"],
      stats: {
        ids: [{ viewId: "tab-right", surfaceId: 7 }],
        engine: {
          ids: [7],
          surfaces: [{
            id: 7,
            hidden: false,
            bounds: { x: 513, y: 149, w: 281, h: 421 },
            presentation: { x: 513, y: 149, w: 281, h: 421 },
            viewport: { matches: true },
            resize: { pending: false },
          }],
        },
      },
    });

    expect(result).toEqual([{
      viewId: "tab-right", surfaceId: "7", live: true, visible: true, presented: true,
      rect: { x: 513, y: 149, w: 281, h: 421 },
    }]);
  });

  it("uses exposed surface DOM for an Electron implementation", () => {
    const result = mapBrowserSurfaceRects({
      framework: "electron",
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["native-tab-right"],
      uiNodes: [{
        address: "win/w-test/content/view/browser/tab/tab-right/node/surface",
        nodePath: "surface",
        rect: { x: 513, y: 149, w: 281, h: 421 },
      }],
    });

    expect(result).toEqual([{
      viewId: "tab-right",
      surfaceId: "win/w-test/content/view/browser/tab/tab-right/node/surface",
      live: true,
      visible: true,
      presented: true,
      rect: { x: 513, y: 149, w: 281, h: 421 },
    }]);
  });

  it("rejects missing or ambiguous public ownership instead of guessing", () => {
    expect(() => mapBrowserSurfaceRects({
      framework: "tauri",
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["native-tab-right"],
      paneComposition: { matches: [] },
    })).toThrow(/tab-right.*surface evidence/);

    expect(() => mapBrowserSurfaceRects({
      framework: "tauri",
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["native-tab-right"],
      paneComposition: { matches: [{
        viewId: "tab-right",
        chromeAboveHost: false,
        domFrame: { x: 513, y: 121, w: 281, h: 449 },
        memberMatches: [{
          label: "native-tab-right",
          topologyPath: "window/w-test/view/tab-right/content/native-tab-right",
          nativeCount: 1, ok: true,
          domFrame: { x: 0, y: 28, w: 281, h: 421 },
        }],
      }] },
    })).toThrow(/chrome is not above/);
  });
});
