// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapBrowserSurfaceRects } from "./browser-surface-rects.mjs";

const MAPPER = resolve(import.meta.dirname, "browser-surface-rects.mjs");

const views = ["tab-left", "tab-right"];
const labels = ["native-tab-left", "native-tab-right"];

describe("browser surface rect evidence", () => {
  it("projects PaneSurfaceHost member frames into window coordinates", () => {
    const result = mapBrowserSurfaceRects({
      nativeChildWebview: true,
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
      nativeChildWebview: true,
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

  // 콘텐츠가 문서 안에 사는 프레임워크의 표면 원장은 content view host 자신의 목록이다.
  // 자리(slot) 노드를 표면이라 부르면 표면이 통째로 사라져도 1:1 이 통과한다.
  it("reads the content view host ledger when content lives in the document", () => {
    const topologyPath = "window/w-test/view/tab-right/content/b-w-test-tab-right";
    const result = mapBrowserSurfaceRects({
      nativeChildWebview: false,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["b-w-test-tab-right"],
      contentViews: {
        detached: [],
        dom: [{
          label: "b-w-test-tab-right",
          slotLabel: "b-w-test-tab-right",
          composition: { kind: "renderer", viewId: "tab-right", topologyPath, visible: true },
          rect: { x: 513, y: 149, w: 281, h: 421 },
        }],
      },
    });

    expect(result).toEqual([{
      viewId: "tab-right",
      surfaceId: "b-w-test-tab-right",
      topologyPath,
      live: true,
      visible: true,
      presented: true,
      rect: { x: 513, y: 149, w: 281, h: 421 },
    }]);
  });

  it("rejects an in-document surface that lost its declaration, its slot, or its visibility", () => {
    const topologyPath = "window/w-test/view/tab-right/content/b-1";
    const fact = (over) => ({
      nativeChildWebview: false,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["b-1"],
      contentViews: {
        detached: [],
        dom: [{
          label: "b-1",
          slotLabel: "b-1",
          composition: { kind: "renderer", viewId: "tab-right", topologyPath, visible: true },
          rect: { x: 513, y: 149, w: 281, h: 421 },
          ...over,
        }],
      },
    });

    expect(() => mapBrowserSurfaceRects(fact({ composition: null })))
      .toThrow(/declares no composition owner/);
    expect(() => mapBrowserSurfaceRects(fact({
      composition: { kind: "renderer", viewId: "tab-left", topologyPath, visible: true },
    }))).toThrow(/declares no composition owner/);
    expect(() => mapBrowserSurfaceRects(fact({ slotLabel: null })))
      .toThrow(/is detached from its declared slot/);
    expect(() => mapBrowserSurfaceRects(fact({
      composition: { kind: "renderer", viewId: "tab-right", topologyPath, visible: false },
    }))).toThrow(/is not declared visible/);
    expect(() => mapBrowserSurfaceRects({
      nativeChildWebview: false,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["b-1"],
      contentViews: { detached: [], dom: [] },
    })).toThrow(/exactly one live content surface \(0\)/);
  });

  it("refuses to guess when the framework declared no provision axis", () => {
    expect(() => mapBrowserSurfaceRects({
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["b-1"],
    })).toThrow(/nativeChildWebview/);
  });

  it("rejects missing or ambiguous public ownership instead of guessing", () => {
    expect(() => mapBrowserSurfaceRects({
      nativeChildWebview: true,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["native-tab-right"],
      paneComposition: { matches: [] },
    })).toThrow(/tab-right.*surface evidence/);

    expect(() => mapBrowserSurfaceRects({
      nativeChildWebview: true,
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

  // 판정이 능력이 아니라 이름을 보면 프레임워크가 하나 늘 때마다 갈래가 는다.
  it("never asks which framework it is", () => {
    const source = readFileSync(MAPPER, "utf8");
    const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/["'`](tauri|electron)["'`]/);
  });
});
