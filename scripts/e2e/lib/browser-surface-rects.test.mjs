// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_SURFACE_OBSERVATION_SOURCES,
  browserSurfaceObservation,
  mapBrowserSurfaceRects,
} from "./browser-surface-rects.mjs";

const MAPPER = resolve(import.meta.dirname, "browser-surface-rects.mjs");

const views = ["tab-left", "tab-right"];
const labels = ["native-tab-left", "native-tab-right"];

const paneCompositionFact = ({ member = {}, pane = {}, ...rest } = {}) => ({
  sampledAtUnixMs: 1_700_000_000_010,
  matches: labels.map((label, index) => ({
    viewId: views[index],
    chromeAboveHost: true,
    alpha: 1,
    // DOM 투영은 자리가 예측한 값이고, native 는 AppKit 이 실제로 놓은 값이다. 픽스처는 둘을
    // 다르게 둔다 — 같은 숫자를 두 칸에 적으면 어느 쪽을 읽었는지 값으로 가릴 수 없다.
    domFrame: { x: index ? 900 : 900, y: 900, w: 281, h: 449 },
    nativeFrame: { x: index ? 513 : 60, y: 121, w: 281, h: 449 },
    memberMatches: [{
      label,
      topologyPath: `window/w-test/view/${views[index]}/content/${label}`,
      nativeCount: 1,
      ok: true,
      domFrame: { x: 900, y: 900, w: 281, h: 421 },
      nativeFrame: { x: 0, y: 28, w: 281, h: 421 },
      ...member,
    }],
    ...pane,
  })),
  ...rest,
});

/**
 * 문서 밖 offscreen 표면 한 장의 실측 모양.
 *
 * 엔진이 든 자리는 창 좌표가 아니다 — 호스트가 적용해 건넨 presenter-local 프레임(`{x:0,y:28}`)
 * 이고, 그 presenter 가 창의 어디에 앉았는지(`{x:513,y:121}`)는 AppKit 장부가 소유한다. 픽스처가
 * 이 둘을 이미 더해진 한 숫자로 두면, 원점을 안 더하는 결함이 초록으로 굳는다.
 */
const offscreenFact = ({ declared = {}, engine = {}, stats = {}, paneComposition } = {}) => ({
  nativeChildWebview: true,
  surface: "engine-offscreen",
  windowLabel: "w-test",
  viewIds: ["tab-right"],
  labels: ["offscreen-tab-right"],
  stats: {
    sampledAtUnixMs: 1_700_000_000_010,
    ids: [{ viewId: "tab-right", surfaceId: 7 }],
    surfaces: [{
      viewId: "tab-right",
      surfaceId: 7,
      label: "offscreen-tab-right",
      topologyPath: "window/w-test/view/tab-right/content/offscreen-tab-right",
      coordinateSpace: {
        logical: "css-px", origin: "presenter-local", referenceId: "offscreen-tab-right",
      },
      frame: { x: 0, y: 28, w: 281, h: 421 },
      ...declared,
    }],
    engine: {
      ids: [7],
      surfaces: [{
        id: 7,
        hidden: false,
        presentation: { x: 0, y: 28, w: 281, h: 421 },
        viewport: { matches: true },
        resize: { pending: false },
        ...engine,
      }],
    },
    ...stats,
  },
  paneComposition: paneComposition ?? {
    matches: [{
      viewId: "tab-right",
      nativeFrame: { x: 513, y: 121, w: 281, h: 449 },
      memberMatches: [{ label: "offscreen-tab-right", nativeCount: 1, ok: true }],
    }],
  },
});

describe("browser surface rect evidence", () => {
  // slot·renderer 는 공개 DOM 을 읽는다. 표면까지 같은 DOM 투영을 옮겨 적으면 세 관측은 한
  // 숫자의 사본 셋이고, native 표면이 어디에 있든 1:1 판정이 통과한다.
  it("reads the AppKit ledger frames, never the DOM projection it predicted", () => {
    const result = mapBrowserSurfaceRects({
      nativeChildWebview: true,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: views,
      labels,
      paneComposition: paneCompositionFact(),
    });

    expect(result).toEqual([
      {
        viewId: "tab-left", surfaceId: "native-tab-left", live: true,
        topologyPath: "window/w-test/view/tab-left/content/native-tab-left",
        chromeAboveHost: true,
        visible: true, presented: true, rect: { x: 60, y: 149, w: 281, h: 421 },
      },
      {
        viewId: "tab-right", surfaceId: "native-tab-right", live: true,
        topologyPath: "window/w-test/view/tab-right/content/native-tab-right",
        chromeAboveHost: true,
        visible: true, presented: true, rect: { x: 513, y: 149, w: 281, h: 421 },
      },
    ]);
  });

  // 공개 topology 문자열은 DOM 이 선언한다. native 로 등재된 member 라벨에 매이지 않으면 세
  // 관측의 topology 동일성은 "한 출처에서 복사됐다"만 증명한다 — 그 자리에 신원은 없다.
  it("accepts a public topology identity only when it is anchored to the native member label", () => {
    const [receipt] = mapBrowserSurfaceRects({
      nativeChildWebview: true,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: views,
      labels,
      paneComposition: paneCompositionFact({
        member: { topologyPath: "window/w-test/view/tab-left/content/some-other-member" },
      }),
    });
    expect(receipt.topologyPath).toBe("");
  });

  it("names the ledger it read and when that ledger sampled itself", () => {
    expect(browserSurfaceObservation({
      nativeChildWebview: true,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: views,
      labels,
      paneComposition: paneCompositionFact(),
    })).toMatchObject({
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.paneMember,
      sampledAtUnixMs: 1_700_000_000_010,
    });

    // 표본 시각이 없는 원장은 null 로 남는다 — 모른다는 사실을 아는 값으로 바꾸지 않는다.
    expect(browserSurfaceObservation({
      nativeChildWebview: true,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: views,
      labels,
      paneComposition: paneCompositionFact({ sampledAtUnixMs: undefined }),
    }).sampledAtUnixMs).toBeNull();
  });

  // 표면을 앉힌 쪽이 자기 신원과 자리를 답한다. 그 자리의 원점은 창이 아니라 그 표면을 품은
  // presenter 이고, presenter 가 창의 어디에 앉았는지는 AppKit 장부가 소유한다.
  it("reads the identity and frame the surface owner declared", () => {
    expect(mapBrowserSurfaceRects(offscreenFact())).toEqual([{
      viewId: "tab-right", surfaceId: "7", live: true, visible: true, presented: true,
      topologyPath: "window/w-test/view/tab-right/content/offscreen-tab-right",
      rect: { x: 513, y: 149, w: 281, h: 421 },
    }]);
  });

  // 판정면이 자리(slot)와 같은 공식으로 주소를 채우면 셋은 한 공식의 사본이고, 표면이 엉뚱한
  // 라벨에 붙은 날에도 1:1 이 통과한다. 이 원장이 보증하는 것은 자기 라벨에 매인 주소뿐이다.
  it("never mints a topology path the owner did not answer", () => {
    expect(mapBrowserSurfaceRects(offscreenFact({ declared: { topologyPath: undefined } })))
      .toMatchObject([{ topologyPath: "" }]);
    expect(mapBrowserSurfaceRects(offscreenFact({
      declared: { topologyPath: "window/w-test/view/tab-right/content/offscreen-tab-other" },
    }))).toMatchObject([{ topologyPath: "" }]);
  });

  // 원점을 안 밝힌 숫자는 창 좌표로 읽힌다 — 좌표계 차이가 합성 결함과 같은 값이 된다.
  it("refuses a frame whose origin the owner never declared", () => {
    expect(mapBrowserSurfaceRects(offscreenFact({ declared: { coordinateSpace: undefined } })))
      .toMatchObject([{ rect: null }]);
    expect(mapBrowserSurfaceRects(offscreenFact({
      declared: { coordinateSpace: { logical: "css-px", origin: "screen", referenceId: "x" } },
    }))).toMatchObject([{ rect: null }]);
  });

  // 원점의 기준을 못 읽었는데 presenter-local 값을 그대로 실으면, 자리와 다른 축의 숫자가
  // 자리와 같은 축인 척한다.
  it("refuses a presenter-local frame with no presenter origin to resolve it against", () => {
    expect(mapBrowserSurfaceRects(offscreenFact({ paneComposition: { matches: [] } })))
      .toMatchObject([{ rect: null }]);
  });

  it("carries the owner ledger's own sample time", () => {
    expect(browserSurfaceObservation(offscreenFact())).toMatchObject({
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.engineLedger,
      sampledAtUnixMs: 1_700_000_000_010,
    });
  });

  // Number(null) 은 0 이고, 그 0 은 정착보다 이른 시각으로 읽힌다 — 안 잰 것이 잰 위반이 된다.
  it("never turns an unrecorded sample time into zero", () => {
    expect(browserSurfaceObservation(offscreenFact({ stats: { sampledAtUnixMs: undefined } })))
      .toMatchObject({ sampledAtUnixMs: null });
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
          computedVisibility: "visible",
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

  // 문서 안 표면의 원장은 콘텐츠 뷰 호스트 자신의 목록이다 — 자리를 읽는 DOM 트리와 다른
  // 원장이므로 이름도 달라야 한다. 같은 이름을 쓰면 판정이 두 원장을 하나로 읽는다.
  it("names the content view host ledger and its sample epoch", () => {
    const topologyPath = "window/w-test/view/tab-right/content/b-w-test-tab-right";
    expect(browserSurfaceObservation({
      nativeChildWebview: false,
      surface: "framework-native",
      windowLabel: "w-test",
      viewIds: ["tab-right"],
      labels: ["b-w-test-tab-right"],
      contentViews: {
        sampledAtUnixMs: 1_700_000_000_020,
        detached: [],
        dom: [{
          label: "b-w-test-tab-right",
          slotLabel: "b-w-test-tab-right",
          composition: { kind: "renderer", viewId: "tab-right", topologyPath, visible: true },
          computedVisibility: "visible",
          rect: { x: 513, y: 149, w: 281, h: 421 },
        }],
      },
    })).toMatchObject({
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.contentViewHost,
      sampledAtUnixMs: 1_700_000_000_020,
    });
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
          computedVisibility: "visible",
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
    // 도장 하나로는 접힌 표면이 스스로 보인다고 말할 수 있다 — 실제 합성 사실을 함께 본다.
    expect(() => mapBrowserSurfaceRects(fact({ computedVisibility: "hidden" })))
      .toThrow(/is not composited/);
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
  });

  // 소유자를 못 찾는 것(주소 없음)과 소유자가 계약을 어긴 것은 다른 사실이다. 어긴 사실을
  // 던져서 지우면 그 실행은 blocked 가 되고 위반은 보고서에서 이름을 잃는다 — 영수증에 실어
  // judge 가 이름 붙은 RED 를 내게 한다.
  const violating = (overrides) => mapBrowserSurfaceRects({
    nativeChildWebview: true,
    surface: "framework-native",
    windowLabel: "w-test",
    viewIds: ["tab-right"],
    labels: ["native-tab-right"],
    paneComposition: { matches: [{
      viewId: "tab-right",
      chromeAboveHost: true,
      alpha: 1,
      domFrame: { x: 900, y: 900, w: 281, h: 449 },
      nativeFrame: { x: 513, y: 121, w: 281, h: 449 },
      memberMatches: [{
        label: "native-tab-right",
        topologyPath: "window/w-test/view/tab-right/content/native-tab-right",
        nativeCount: 1, ok: true,
        domFrame: { x: 900, y: 900, w: 281, h: 421 },
        nativeFrame: { x: 0, y: 28, w: 281, h: 421 },
        ...(overrides.member ?? {}),
      }],
      ...(overrides.pane ?? {}),
    }] },
  })[0];

  it("carries the measured sibling order instead of aborting the run", () => {
    expect(violating({ pane: { chromeAboveHost: false } }))
      .toMatchObject({ chromeAboveHost: false, rect: { x: 513, y: 149, w: 281, h: 421 } });
    expect(violating({ pane: { chromeAboveHost: undefined } }))
      .toMatchObject({ chromeAboveHost: false });
  });

  it("carries a blank public topology identity instead of aborting the run", () => {
    expect(violating({ member: { topologyPath: "" } })).toMatchObject({ topologyPath: "" });
  });

  it("carries host liveness and exactness as measured values", () => {
    expect(violating({ member: { nativeCount: 0 } })).toMatchObject({ live: false });
    expect(violating({ member: { ok: false } })).toMatchObject({ presented: false });
  });

  it("reports the engine's own hidden answer instead of a second visibility definition", () => {
    const engineSurface = (hidden) => mapBrowserSurfaceRects(offscreenFact({ engine: { hidden } }))[0];
    expect(engineSurface(true)).toMatchObject({ visible: false });
    expect(engineSurface(false)).toMatchObject({ visible: true });
  });

  it("carries an unreadable frame as a null rect instead of aborting the run", () => {
    expect(violating({ member: { nativeFrame: { x: 0, y: 28, w: 0, h: 421 } } }))
      .toMatchObject({ rect: null });
    // native 자리를 아예 못 읽었는데 DOM 투영을 대신 적으면, 표면이 사라진 순간에도 좌표가 산다.
    expect(violating({ member: { nativeFrame: null } })).toMatchObject({ rect: null });
  });

  // 판정이 능력이 아니라 이름을 보면 프레임워크가 하나 늘 때마다 갈래가 는다.
  it("never asks which framework it is", () => {
    const source = readFileSync(MAPPER, "utf8");
    const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/["'`](tauri|electron)["'`]/);
  });
});
