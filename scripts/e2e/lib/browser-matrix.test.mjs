// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  browserImplementations,
  browserSurfaceInvariant,
  domTransitionTraceVerdict,
  fixtureHtml,
  parseBrowserEngines,
  fixtureMarkers,
  fixtureInputMarkers,
  fixtureInputMarkerSize,
  fixtureMotionMarkers,
  compositorCalibrationMarker,
  fixtureMarkerSize,
  markerEvidence,
  markerPixels,
  mapB04PresentationSamples,
  motionMarkerAlignment,
  normalizeB04JournalEntries,
  numericCompositionTraceVerdict,
  pinnedDomTraceVerdict,
  snapshotCssScale,
  selectFixtureMarkerComponent,
  fixtureMarkerRowVerdict,
  rendererTopologyOwnershipVerdict,
  resolveB04MovedParticipant,
  hostileWindowResizeSizes,
  summarizeFrameSequence,
  unwrapEvalValue,
  fullCaptureReceiptVerdict,
  viewportGeometryVerdict,
  transitionFrameAlignment,
  completeCalibrationComponents,
  calibrationFrameScale,
} from "./browser-matrix.mjs";
import { encodePng } from "./png.mjs";
import { B04_JOURNAL_ENTRY_KEYS } from "./browser-gates.mjs";

describe("브라우저 구현 행렬", () => {
  it("Tauri plugin chrome와 native surface는 같은 pane presentation root를 공유한다", () => {
    expect(rendererTopologyOwnershipVerdict({
      verdict: "shared-pane-host",
      panelAtomicMotion: true,
      sharedPaneHost: "PaneSurfaceHost",
    })).toEqual({ ok: true, errors: [] });
    expect(rendererTopologyOwnershipVerdict({
      verdict: "independent-renderer-roots",
      panelAtomicMotion: false,
      sharedPaneHost: null,
    })).toMatchObject({ ok: false });
    expect(rendererTopologyOwnershipVerdict(null)).toMatchObject({ ok: false });
  });

  it("화면 경계에서 전체 창이 축소된 프레임은 DOM 기준자로 실제 pixel 배율을 복원한다", () => {
    expect(calibrationFrameScale([
      { width: 60, height: 60 },
      { width: 60, height: 60 },
      { width: 30, height: 60 },
    ])).toBe(1.5);
  });
  it("사이드바와 탭 pane의 단일 DOM·공유 animation epoch 위반을 RED로 만든다", () => {
    const node = (address, x, startTime, currentTime, connected = true) => ({
      address,
      connected,
      rect: { x, y: 20, w: 160, h: 500 },
      animations: startTime == null ? [] : [{
        name: "rail-flip-x", playState: "running", startTime, currentTime,
        progress: currentTime / 280,
      }],
    });
    const verdict = domTransitionTraceVerdict([
      { nodes: [node("rail", 500, null, null), node("pane", 100, null, null)] },
      { nodes: [node("rail", 500, 100, 20), node("pane", 100, 112, 8)] },
      { nodes: [node("rail", 300, 100, 120, false), node("pane", 300, 112, 108)] },
    ], { railAddress: "rail", paneAddresses: ["pane"] });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("disconnected:rail");
    expect(verdict.errors.join("\n")).toContain("clock-start-skew");
  });

  it("하나의 지속 rail DOM과 pane이 같은 FLIP 시계를 공유하면 GREEN이다", () => {
    const sample = (xRail, xPane, currentTime = null) => ({ nodes: [
      {
        address: "rail", connected: true, rect: { x: xRail, y: 20, w: 160, h: 500 },
        animations: currentTime == null ? [] : [{ name: "rail-flip-x", playState: "running", startTime: 100, currentTime, progress: currentTime / 280 }],
      },
      {
        address: "pane", connected: true, rect: { x: xPane, y: 20, w: 500, h: 500 },
        animations: currentTime == null ? [] : [{ name: "rail-flip-x", playState: "running", startTime: 100, currentTime, progress: currentTime / 280 }],
      },
    ] });
    const verdict = domTransitionTraceVerdict([
      sample(500, 100), sample(500, 100, 20), sample(400, 200, 120), sample(300, 300),
    ], { railAddress: "rail", paneAddresses: ["pane"] });
    expect(verdict).toMatchObject({ ok: true, sharedClockFrames: 2 });
  });

  it("비전면 전환은 rail/pane이 같은 단일 프레임에 중간 좌표 없이 snap하면 GREEN이다", () => {
    const node = (address, x) => ({
      address, connected: true, rect: { x, y: 20, w: 160, h: 500 }, animations: [],
    });
    const sample = (railX, leftX, rightX) => ({ nodes: [
      node("rail", railX), node("left", leftX), node("right", rightX),
    ] });
    const verdict = domTransitionTraceVerdict([
      sample(347, 60, 513), sample(347, 60, 513), sample(54, 220, 513), sample(54, 220, 513),
    ], { railAddress: "rail", paneAddresses: ["left", "right"], motionMode: "snap" });
    expect(verdict).toMatchObject({ ok: true, motionMode: "snap", sharedClockFrames: 0 });
  });

  it("비전면 snap에서 중간 좌표나 rail/pane 프레임 차이를 RED로 만든다", () => {
    const node = (address, x) => ({
      address, connected: true, rect: { x, y: 20, w: 160, h: 500 }, animations: [],
    });
    const sample = (railX, paneX) => ({ nodes: [node("rail", railX), node("pane", paneX)] });
    const intermediate = domTransitionTraceVerdict([
      sample(347, 60), sample(200, 60), sample(54, 220),
    ], { railAddress: "rail", paneAddresses: ["pane"], motionMode: "snap" });
    expect(intermediate.ok).toBe(false);
    expect(intermediate.errors.join("\n")).toContain("snap-intermediate:rail");

    const skewed = domTransitionTraceVerdict([
      sample(347, 60), sample(54, 60), sample(54, 220),
    ], { railAddress: "rail", paneAddresses: ["pane"], motionMode: "snap" });
    expect(skewed.ok).toBe(false);
    expect(skewed.errors.join("\n")).toContain("snap-frame-skew");
  });

  it("PIN 포커스 전환에서 rail/pane 좌표 변화나 FLIP을 RED로 만든다", () => {
    const node = (address, x, animations = []) => ({
      address, connected: true, rect: { x, y: 20, w: 160, h: 500 }, animations,
    });
    const verdict = pinnedDomTraceVerdict([
      { nodes: [node("rail", 0), node("left", 160), node("right", 680)] },
      { nodes: [node("rail", 0), node("left", 160), node("right", 520, [{ name: "rail-flip-x" }])] },
      { nodes: [node("rail", 0), node("left", 160), node("right", 680)] },
    ], { addresses: ["rail", "left", "right"] });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("rect-changed:right:x=680/520");
    expect(verdict.errors.join("\n")).toContain("animation-forbidden:right:rail-flip-x");
  });

  it("PIN 포커스 전환에서 같은 DOM·같은 rect·무 animation이면 GREEN이다", () => {
    const sample = () => ({ nodes: [
      { address: "rail", connected: true, rect: { x: 0, y: 20, w: 160, h: 500 }, animations: [] },
      { address: "left", connected: true, rect: { x: 160, y: 20, w: 520, h: 500 }, animations: [] },
      { address: "right", connected: true, rect: { x: 680, y: 20, w: 520, h: 500 }, animations: [] },
    ] });
    expect(pinnedDomTraceVerdict([sample(), sample(), sample()], {
      addresses: ["rail", "left", "right"],
    })).toMatchObject({ ok: true, frames: 3 });
  });

  it("녹화 픽셀 없이 관측된 322px DOM/native 이탈을 RED로 만든다", () => {
    const sample = (domX, nativeX, uncertaintyMs = 0.4) => ({
      uncertaintyMs,
      surfaces: [{
        viewId: "iana",
        domRect: { x: domX, y: 120, w: 322, h: 500 },
        presentationRect: { x: nativeX, y: 120, w: 322, h: 500 },
      }],
    });
    const verdict = numericCompositionTraceVerdict([
      sample(442, 442),
      sample(120, 442),
      sample(120, 120),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.maxDelta).toBe(322);
    expect(verdict.errors).toContain("s1:iana:x=120/442 dx=322");
  });

  it("합성 trace의 시계 불확실성과 rounding-only 기준을 함께 검사한다", () => {
    const samples = Array.from({ length: 3 }, (_, index) => ({
      uncertaintyMs: index === 2 ? 2.1 : 0.5,
      surfaces: [{
        viewId: "v1",
        domRect: { x: 10.4, y: 20, w: 300, h: 200 },
        presentationRect: { x: 11, y: 20, w: 300, h: 200 },
      }],
    }));
    const verdict = numericCompositionTraceVerdict(samples);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain("s2:clock-uncertainty=2.1/2ms");
  });

  it("첫 실패에서 멈추지 않고 전체 이동 궤적과 최대 이탈을 보고한다", () => {
    const verdict = summarizeFrameSequence([
      { frame: "f0001.png", errors: ["motion-x=10/16 dx=6"], motionDx: 6 },
      { frame: "f0002.png", errors: ["motion-x=10/266 dx=256"], motionDx: 256 },
      { frame: "f0003.png", errors: [], motionDx: 0 },
    ]);

    expect(verdict).toMatchObject({ ok: false, checked: 3, failed: 2, maxMotionDx: 256 });
    expect(verdict.summary).toContain("f0001.png");
    expect(verdict.summary).toContain("f0002.png");
    expect(verdict.summary).toContain("maxMotionDx=256");
  });

  it("기본값은 Native·Windowed Chromium·Offscreen Chromium 전부다", () => {
    expect(parseBrowserEngines(undefined)).toEqual([
      "browser",
      "browser-chromium",
      "browser-chromium-offscreen",
    ]);
    expect(Object.keys(browserImplementations)).toEqual(parseBrowserEngines(undefined));
  });

  it("fixture 배경은 marker hue와 합쳐지지 않는 무채색이어야 한다", () => {
    const html = fixtureHtml();
    expect(html).toContain("background:#181818");
    expect(html).toContain("background:#292929");
    expect(html).not.toContain("#10202c");
    expect(html).not.toContain("#16394a");
  });

  it("fixture 본문은 좁은 pane에서도 viewport를 넘지 않는다", () => {
    expect(fixtureHtml()).toContain("width:min(520px,100%)");
  });

  it("알 수 없는 구현을 조용히 건너뛰지 않는다", () => {
    expect(() => parseBrowserEngines("browser,unknown")).toThrow("지원하지 않는 브라우저 구현");
  });

  it("각 구현의 공개 native surface 주소를 선언적으로 만든다", () => {
    expect(browserImplementations.browser.label("w-a", "tab-1")).toBe("b-w-a-tab-1");
    expect(browserImplementations["browser-chromium"].label("w-a", "tab-1")).toBe("chromium-tab-1");
    expect(browserImplementations["browser-chromium-offscreen"].label("w-a", "tab-1")).toBe("offscreen-tab-1");
  });

  it("native와 windowed는 프레임워크 표시 원장의 같은 코어 이름을 부른다", () => {
    const native = browserImplementations.browser.presentationTrace;
    const windowed = browserImplementations["browser-chromium"].presentationTrace;
    expect(windowed).toBe(native);
    // 이름에 프레임워크가 없다 — 있으면 다른 프레임워크에서 이 게이트가 통째로 안 재진다.
    expect(native).toMatchObject({
      ownerCommand: "view.presentation.owners",
      armCommand: "view.presentation.trace.arm",
      readCommand: "view.presentation.trace.close",
    });
    for (const command of [native.ownerCommand, native.armCommand, native.readCommand]) {
      expect(command).not.toMatch(/tauri|electron|webview|appkit/i);
    }
    const owners = native.resolveOwners({
      facts: {
        owners: [{
          window: "w-a", logicalPaneId: "pane-left", viewId: "view-left",
          rendererId: "renderer-left", hostId: "host-w-a-view-left", surfaceId: "surface-left",
        }],
      },
      windowLabel: "w-a",
      viewIds: ["view-left"],
      paneIds: ["pane-left"],
      surfaceIds: ["surface-left"],
    });
    expect(owners).toEqual([{
      viewId: "view-left",
      logicalPaneId: "pane-left",
      hostId: "host-w-a-view-left",
      rendererId: "renderer-left",
      surfaceId: "surface-left",
    }]);
    expect(native.armParams({ traceId: "trace-1", owners })).toEqual({
      traceId: "trace-1",
      owners: [{ viewId: "view-left", hostId: "host-w-a-view-left", surfaceId: "surface-left" }],
      maxEvents: 512,
    });
    expect(native.events({
      closed: true,
      violations: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0 },
      presentationEvents: [{
        presentedAtUnixMs: 1_000,
        surfaces: [{
          viewId: "view-left", live: true, visible: true, painted: true,
          domFrame: { x: 10, y: 20, w: 300, h: 200 },
          surfaceFrame: { x: 10, y: 20, w: 300, h: 200 },
        }],
      }],
    }, { targetViewId: "view-left" })).toEqual([{
      sampledAtUnixMs: 1_000,
      connected: true,
      slotFrame: { x: 10, y: 20, w: 300, h: 200 },
      rendererFrame: { x: 10, y: 20, w: 300, h: 200 },
      surfaceFrame: { x: 10, y: 20, w: 300, h: 200 },
    }]);
  });

  it("offscreen은 보간 DOM 진단을 renderer 사실로 가장하지 않고 단일 native presenter를 정규화한다", () => {
    const adapter = browserImplementations["browser-chromium-offscreen"].presentationTrace;
    expect(adapter).toMatchObject({
      ownerCommand: "plugin.soksak-plugin-browser-chromium-offscreen.stats",
      armCommand: "plugin.soksak-plugin-browser-chromium-offscreen.surface.trace.start",
      readCommand: "plugin.soksak-plugin-browser-chromium-offscreen.surface.trace.read",
    });
    const owners = adapter.resolveOwners({
      facts: { ids: [{ viewId: "view-right", surfaceId: 17 }] },
      viewIds: ["view-right"],
      paneIds: ["pane-right"],
    });
    expect(owners).toEqual([{
      viewId: "view-right",
      logicalPaneId: "pane-right",
      rendererId: "offscreen-renderer:17",
      surfaceId: "17",
    }]);
    expect(adapter.armParams({ traceId: "ignored", owners })).toEqual({ durationMs: 800 });
    expect(adapter.readParams({ traceId: 4 })).toEqual({ traceId: 4 });
    expect(adapter.events({
      samples: [{
        atUnixMs: 2_000,
        surfaces: [{
          viewId: "view-right",
          // 이 값은 plugin의 rAF 두 표본 사이를 보간한 진단값일 수 있다. 실제 display
          // callback이 읽은 presenter frame과 일부러 다르게 두어 판정면 유입을 막는다.
          domRect: { x: 437, y: 20, w: 300, h: 200 },
          rendererFrame: { x: 401, y: 20, w: 299, h: 200 },
          surfaceFrame: { x: 400, y: 20, w: 300, h: 200 },
        }],
      }],
    }, { targetViewId: "view-right" })).toEqual([{
      sampledAtUnixMs: 2_000,
      connected: true,
      slotFrame: { x: 437, y: 20, w: 300, h: 200 },
      rendererFrame: { x: 401, y: 20, w: 299, h: 200 },
      surfaceFrame: { x: 400, y: 20, w: 300, h: 200 },
    }]);
    expect(() => adapter.events({
      samples: [{
        atUnixMs: 2_001,
        surfaces: [{
          viewId: "view-right",
          domRect: { x: 400, y: 20, w: 300, h: 200 },
          rendererFrame: null,
          surfaceFrame: { x: 400, y: 20, w: 300, h: 200 },
        }],
      }],
    }, { targetViewId: "view-right" })).toThrow("native renderer/surface frame");
  });

  it("presentation owner가 누락·중복되면 추측하지 않고 실패한다", () => {
    const adapter = browserImplementations.browser.presentationTrace;
    const input = {
      windowLabel: "w-a",
      viewIds: ["view-left"],
      paneIds: ["pane-left"],
      surfaceIds: ["surface-left"],
    };
    expect(() => adapter.resolveOwners({ facts: { owners: [] }, ...input }))
      .toThrow("owner=0/1");
    const owner = {
      window: "w-a", logicalPaneId: "pane-left", viewId: "view-left",
      rendererId: "renderer-left", hostId: "host-w-a-view-left", surfaceId: "surface-left",
    };
    expect(() => adapter.resolveOwners({ facts: { owners: [owner, { ...owner }] }, ...input }))
      .toThrow("owner=2/1");
    // 묶였는데 identity 가 빈 owner 는 부재가 아니라 깨진 join 이다 — 추측으로 메우지 않는다.
    expect(() => adapter.resolveOwners({
      facts: { owners: [{ ...owner, rendererId: "" }] },
      ...input,
    })).toThrow("renderer identity");
  });

  it("B04는 actual DOM presentation frame을 같은 시각의 native surface에 결합한다", () => {
    const domSample = (
      sequence,
      sampledAtUnixMs,
      trigger,
      sampleTransactionId,
      domCommittedAtUnixMs,
      railX,
      paneX,
      slotX,
    ) => ({
      sequence,
      sampledAtUnixMs,
      trigger,
      transactionId: sampleTransactionId,
      domCommittedAtUnixMs,
      nodes: [
        { address: "rail", connected: true, rect: { x: railX, y: 0, w: 60, h: 500 } },
        { address: "pane", connected: true, rect: { x: paneX, y: 0, w: 500, h: 500 } },
        { address: "slot", connected: true, rect: { x: slotX, y: 60, w: 460, h: 420 } },
      ],
    });
    const event = (sampledAtUnixMs, x) => ({
      sampledAtUnixMs,
      connected: true,
      rendererFrame: { x, y: 60, w: 460, h: 420 },
      surfaceFrame: { x, y: 60, w: 460, h: 420 },
    });
    const trace = mapB04PresentationSamples({
      events: [event(1_001, 110), event(1_099, 270), event(1_101, 430)],
      domSamples: [
        domSample(0, 900, "initial", null, null, 10, 80, 110),
        domSample(1, 1_010, "layout-dom-commit", "tx", 1_010, 700, 250, 270),
        // 실제 rAF callback에서 읽은 raw rect. rail/pane을 slot 이동량으로 투영하면 안 된다.
        domSample(2, 1_100, "presentation-frame", "tx", 1_010, 777, 333, 430),
      ],
      owner: { rendererId: "renderer", surfaceId: "surface" },
      targetViewId: "view",
      transactionId: "tx",
      domCommittedAtUnixMs: 1_010,
      presentationStartAtUnixMs: 1_100,
      durationMs: 340,
      moveDx: -320,
      railAddress: "rail",
      paneAddress: "pane",
      slotAddress: "slot",
    });
    expect(trace.joins.map(({ trigger }) => trigger)).toEqual([
      "initial", "layout-dom-commit", "presentation-frame",
    ]);
    expect(trace.joins.map(({ gapMs }) => gapMs)).toEqual([101, 89, 1]);
    expect(trace.samples).toHaveLength(2);
    expect(trace.samples.map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
    expect(trace.samples[1]).toMatchObject({
      rail: { id: "rail", frame: { x: 777, y: 0, w: 60, h: 500 } },
      pane: { id: "pane", frame: { x: 333, y: 0, w: 500, h: 500 } },
      slot: { id: "slot", frame: { x: 430, y: 60, w: 460, h: 420 } },
      renderer: { id: "renderer", frame: { x: 430, y: 60, w: 460, h: 420 } },
      surface: { id: "surface", frame: { x: 430, y: 60, w: 460, h: 420 } },
    });
    expect(trace.timeline).toMatchObject({
      startAtUnixMs: 1_100,
      timingFunction: [0.4, 0, 0.2, 1],
      slot: [
        { sequence: 0, sampledAtUnixMs: 1_010, frame: { x: 270 } },
        { sequence: 1, sampledAtUnixMs: 1_100, frame: { x: 430 } },
      ],
      renderer: expect.any(Array),
      surface: expect.any(Array),
    });
  });

  it("B04는 클릭된 target이 아니라 공개 장부의 유일한 moved view owner와 raw DOM 주소를 선택한다", () => {
    const owners = [
      { viewId: "view-left", rendererId: "renderer-left", surfaceId: "surface-left" },
      { viewId: "view-right", rendererId: "renderer-right", surfaceId: "surface-right" },
    ];
    const moved = resolveB04MovedParticipant({
      transactions: [{
        transactionId: "tx-right-click",
        phase: "committed",
        moves: [{ viewId: "view-left", dx: 160 }],
      }],
      owners,
      viewIds: ["view-left", "view-right"],
      paneAddresses: ["pane-left", "pane-right"],
      slotAddresses: ["slot-left", "slot-right"],
    });

    // 오른쪽 클릭이어도 장부가 실제로 이동했다고 밝힌 owner는 왼쪽이다.
    expect(moved).toEqual({
      targetViewId: "view-left",
      owner: owners[0],
      paneAddress: "pane-left",
      slotAddress: "slot-left",
    });
    expect(() => resolveB04MovedParticipant({
      transactions: [{ moves: [
        { viewId: "view-left", dx: 160 },
        { viewId: "view-right", dx: -160 },
      ] }],
      owners,
      viewIds: ["view-left", "view-right"],
      paneAddresses: ["pane-left", "pane-right"],
      slotAddresses: ["slot-left", "slot-right"],
    })).toThrow("moved views=2/1");
  });

  it("B04 mapper는 양쪽 pane/slot을 함께 관측해도 moved owner의 raw 참가자만 1:1 선택한다", () => {
    const rawSample = (
      sequence,
      sampledAtUnixMs,
      trigger,
      sampleTransactionId,
      domCommittedAtUnixMs,
      leftX,
      rightX,
    ) => ({
      sequence,
      sampledAtUnixMs,
      trigger,
      transactionId: sampleTransactionId,
      domCommittedAtUnixMs,
      nodes: [
        { address: "rail", connected: true, rect: { x: 10, y: 0, w: 60, h: 500 } },
        { address: "pane-left", connected: true, rect: { x: leftX, y: 0, w: 500, h: 500 } },
        { address: "slot-left", connected: true, rect: { x: leftX + 30, y: 60, w: 460, h: 420 } },
        { address: "pane-right", connected: true, rect: { x: rightX, y: 0, w: 500, h: 500 } },
        { address: "slot-right", connected: true, rect: { x: rightX + 30, y: 60, w: 460, h: 420 } },
      ],
    });
    const trace = mapB04PresentationSamples({
      events: [
        { sampledAtUnixMs: 1_001, connected: true, rendererFrame: { x: 130, y: 60, w: 460, h: 420 }, surfaceFrame: { x: 130, y: 60, w: 460, h: 420 } },
        { sampledAtUnixMs: 1_019, connected: true, rendererFrame: { x: 290, y: 60, w: 460, h: 420 }, surfaceFrame: { x: 290, y: 60, w: 460, h: 420 } },
      ],
      domSamples: [
        rawSample(0, 990, "initial", null, null, 100, 700),
        rawSample(1, 1_010, "layout-dom-commit", "tx", 1_010, 100, 700),
        rawSample(2, 1_015, "presentation-frame", "tx", 1_010, 260, 700),
      ],
      owner: { rendererId: "renderer-left", surfaceId: "surface-left" },
      targetViewId: "view-left",
      transactionId: "tx",
      domCommittedAtUnixMs: 1_010,
      presentationStartAtUnixMs: 1_015,
      durationMs: 340,
      moveDx: -160,
      railAddress: "rail",
      paneAddress: "pane-left",
      slotAddress: "slot-left",
    });
    expect(trace.samples.at(-1)).toMatchObject({
      pane: { id: "pane-left", frame: { x: 260 } },
      slot: { id: "slot-left", frame: { x: 290 } },
      renderer: { id: "renderer-left", frame: { x: 290 } },
      surface: { id: "surface-left", frame: { x: 290 } },
    });
  });

  it("B04 canonical journal은 snap epoch 누락을 null로 정규화하고 raw 장부는 바꾸지 않는다", () => {
    const rawSnap = {
      sequence: 4,
      transactionId: "tx-snap",
      phase: "committed",
      mode: "snap",
      preparedAtUnixMs: 1_000,
      domCommittedAtUnixMs: 1_001,
      closedAtUnixMs: 1_001,
      moves: [{ viewId: "view-left", dx: 160 }],
    };
    const rawGlide = { ...rawSnap, transactionId: "tx-glide", mode: "glide", startAtUnixMs: 999 };
    const canonical = normalizeB04JournalEntries([rawSnap, rawGlide]);

    expect(canonical[0]).toEqual({ ...rawSnap, startAtUnixMs: null, durationMs: null });
    expect(canonical[1]).toEqual({ ...rawGlide, durationMs: null });
    expect(Object.hasOwn(rawSnap, "startAtUnixMs")).toBe(false);
    expect(canonical[0]).not.toBe(rawSnap);
  });

  it("코어가 장부에 필드를 더 노출해도 canonical receipt는 선언한 목록 그대로다", () => {
    const raw = {
      sequence: 7,
      transactionId: "tx-cause",
      causeTraceId: "browser-01-left-uuid",
      phase: "committed",
      mode: "glide",
      startAtUnixMs: 1_010,
      durationMs: 340,
      preparedAtUnixMs: 1_000,
      domCommittedAtUnixMs: 1_002,
      closedAtUnixMs: 1_004,
      moves: [{ viewId: "view-left", dx: 160 }],
    };
    const [canonical] = normalizeB04JournalEntries([raw]);

    expect(Object.keys(canonical).sort()).toEqual([...B04_JOURNAL_ENTRY_KEYS].sort());
    expect(Object.hasOwn(canonical, "causeTraceId")).toBe(false);
    expect(Object.hasOwn(canonical, "sequence")).toBe(true);
  });

  it("B04 raw DOM trace에 initial·DOM-commit·presentation frame 중 하나라도 없으면 RED다", () => {
    const input = {
      events: [
        { sampledAtUnixMs: 999, connected: true, rendererFrame: { x: 1, y: 2, w: 3, h: 4 }, surfaceFrame: { x: 1, y: 2, w: 3, h: 4 } },
        { sampledAtUnixMs: 1_020, connected: true, rendererFrame: { x: 2, y: 2, w: 3, h: 4 }, surfaceFrame: { x: 2, y: 2, w: 3, h: 4 } },
      ],
      domSamples: [
        {
          sequence: 0,
          sampledAtUnixMs: 900,
          trigger: "initial",
          transactionId: null,
          domCommittedAtUnixMs: null,
          nodes: ["rail", "pane", "slot"].map((address) => ({
            address, connected: true, rect: { x: 1, y: 2, w: 3, h: 4 },
          })),
        },
        {
          sequence: 1,
          sampledAtUnixMs: 1_100,
          trigger: "layout-dom-commit",
          transactionId: "wrong-tx",
          domCommittedAtUnixMs: 1_000,
          nodes: ["rail", "pane", "slot"].map((address) => ({
            address, connected: true, rect: { x: 2, y: 2, w: 3, h: 4 },
          })),
        },
      ],
      owner: { rendererId: "renderer", surfaceId: "surface" },
      targetViewId: "view",
      transactionId: "tx",
      domCommittedAtUnixMs: 1_000,
      presentationStartAtUnixMs: 1_000,
      durationMs: 340,
      moveDx: -1,
      railAddress: "rail",
      paneAddress: "pane",
      slotAddress: "slot",
    };
    expect(() => mapB04PresentationSamples(input)).toThrow("DOM-commit sample=0/1");
    expect(() => mapB04PresentationSamples({
      ...input,
      domSamples: input.domSamples
        .filter((sample) => sample.trigger !== "initial")
        .map((sample, sequence) => ({ ...sample, sequence })),
    })).toThrow("initial sample=0/1");
    expect(() => mapB04PresentationSamples({
      ...input,
      domSamples: [
        input.domSamples[0],
        { ...input.domSamples[1], transactionId: "tx" },
        {
          ...input.domSamples[1],
          sequence: 2,
          trigger: "presentation-frame",
          transactionId: "tx",
          domCommittedAtUnixMs: 1_000,
          sampledAtUnixMs: 1_000,
        },
      ],
    })).not.toThrow();
    expect(() => mapB04PresentationSamples({
      ...input,
      domSamples: input.domSamples.map((sample) => ({
        ...sample,
        transactionId: sample.trigger === "initial" ? null : "wrong-tx",
      })),
    })).toThrow("DOM-commit sample=0/1");
  });

  it("B04는 가려진 창에서 rAF가 멈춰도 실제 DOM-commit 경계를 native 표시와 결합한다", () => {
    const node = (address, x) => ({
      address,
      connected: true,
      rect: { x, y: 0, w: 300, h: 200 },
    });
    const trace = mapB04PresentationSamples({
      events: [
        { sampledAtUnixMs: 1_001, connected: true, rendererFrame: { x: 100, y: 20, w: 280, h: 160 }, surfaceFrame: { x: 100, y: 20, w: 280, h: 160 } },
        { sampledAtUnixMs: 1_020, connected: true, rendererFrame: { x: 260, y: 20, w: 280, h: 160 }, surfaceFrame: { x: 260, y: 20, w: 280, h: 160 } },
      ],
      domSamples: [
        { sequence: 0, sampledAtUnixMs: 990, trigger: "initial", transactionId: null, domCommittedAtUnixMs: null, nodes: [node("rail", 10), node("pane", 80), node("slot", 100)] },
        { sequence: 1, sampledAtUnixMs: 1_010, trigger: "layout-dom-commit", transactionId: "tx", domCommittedAtUnixMs: 1_010, nodes: [node("rail", 10), node("pane", 240), node("slot", 260)] },
      ],
      owner: { rendererId: "renderer", surfaceId: "surface" },
      targetViewId: "view",
      transactionId: "tx",
      domCommittedAtUnixMs: 1_010,
      presentationStartAtUnixMs: 1_010,
      durationMs: 340,
      moveDx: -160,
      railAddress: "rail",
      paneAddress: "pane",
      slotAddress: "slot",
    });
    expect(trace.joins.map(({ trigger }) => trigger)).toEqual(["initial", "layout-dom-commit"]);
    expect(trace.samples.at(-1)).toMatchObject({ pane: { frame: { x: 240 } }, slot: { frame: { x: 260 } } });
  });

  it("전체 창 resize는 큰 폭의 양방향 교차를 반복하고 정확히 원복한다", () => {
    const sizes = hostileWindowResizeSizes({ w: 2400, h: 1600 });
    expect(sizes.length).toBeGreaterThanOrEqual(12);
    expect(sizes.at(-1)).toEqual({ w: 2400, h: 1600 });
    const dw = sizes.slice(1).map((size, i) => Math.sign(size.w - sizes[i].w));
    const dh = sizes.slice(1).map((size, i) => Math.sign(size.h - sizes[i].h));
    expect(new Set(dw)).toEqual(new Set([-1, 0, 1]));
    expect(new Set(dh)).toEqual(new Set([-1, 0, 1]));
  });

  it("windowed view→surface→engine 장부가 창 owner·가시성·presentation까지 일치해야 한다", () => {
    expect(browserSurfaceInvariant({
      surface: "engine-windowed",
      plugin: "soksak-plugin-browser-chromium",
      windowLabel: "w-a",
      viewIds: ["tab-left", "tab-right"],
      expectedVisible: [true, true],
      stats: {
        ids: [11, 12, 90],
        idMap: { "chromium-tab-left": 11, "chromium-tab-right": 12 },
        ledger: [11, 12],
        visibility: { "chromium-tab-left": true, "chromium-tab-right": true },
        surfaces: [
          { id: 11, owner: "soksak-plugin-browser-chromium@w-a", hidden: false, bounds: { x: 1, y: 2, w: 300, h: 200 } },
          { id: 12, owner: "soksak-plugin-browser-chromium@w-a", hidden: false, bounds: { x: 301, y: 2, w: 300, h: 200 } },
          { id: 90, owner: "soksak-plugin-browser-chromium@w-b", hidden: false },
        ],
      },
    })).toEqual({ ok: true, errors: [], mappedIds: [11, 12] });
  });

  it("PaneSurfaceHost에 결합된 windowed surface는 composition을 배치 정본으로 인정한다", () => {
    expect(browserSurfaceInvariant({
      surface: "engine-windowed",
      plugin: "soksak-plugin-browser-chromium",
      windowLabel: "w-a",
      viewIds: ["tab-left"],
      expectedVisible: [true],
      stats: {
        ids: [11], idMap: { "chromium-tab-left": 11 }, ledger: [11],
        visibility: { "chromium-tab-left": true },
        surfaces: [{ id: 11, owner: "soksak-plugin-browser-chromium@w-a", hidden: false, bounds: null, composition: { host: {} } }],
      },
    }).ok).toBe(true);
  });

  it("offscreen의 죽은 surface 매핑·타 창 owner·pending resize를 모두 RED로 만든다", () => {
    const verdict = browserSurfaceInvariant({
      surface: "engine-offscreen",
      plugin: "soksak-plugin-browser-chromium-offscreen",
      windowLabel: "w-a",
      viewIds: ["tab-left", "tab-right"],
      expectedVisible: [true, true],
      stats: {
        ids: [
          { viewId: "tab-left", surfaceId: 3 },
          { viewId: "tab-right", surfaceId: 7 },
        ],
        ledger: [3, 7],
        engine: {
          ids: [7],
          surfaces: [{
            id: 7,
            owner: "soksak-plugin-browser-chromium-offscreen@w-b",
            hidden: false,
            resize: { pending: true },
            viewport: { matches: false },
          }],
        },
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("tab-left:engine-live-missing:3");
    expect(verdict.errors.join("\n")).toContain("tab-right:owner");
    expect(verdict.errors.join("\n")).toContain("tab-right:resize-pending");
    expect(verdict.errors.join("\n")).toContain("tab-right:viewport-mismatch");
  });
});

describe("공통 브라우저 fixture", () => {
  it("전체 캡처의 identity는 선언된 3개 표식 행이 정확히 한 번 있어야 한다", () => {
    const valid = [
      { count: 2_560, x: 24, y: 195, width: 64, height: 40, bodyWidth: 64, bodyHeight: 40 },
      { count: 2_560, x: 96, y: 195, width: 64, height: 40, bodyWidth: 64, bodyHeight: 40 },
      { count: 2_560, x: 168, y: 195, width: 64, height: 40, bodyWidth: 64, bodyHeight: 40 },
    ];
    expect(fixtureMarkerRowVerdict(valid, { scale: 1 })).toMatchObject({ ok: true });
    expect(fixtureMarkerRowVerdict(valid.slice(0, 2), { scale: 1 })).toMatchObject({ ok: false });
    expect(fixtureMarkerRowVerdict([...valid, { ...valid[2], x: 240 }], { scale: 1 })).toMatchObject({ ok: false });
    expect(fixtureMarkerRowVerdict(valid.map((component, index) => ({
      ...component,
      x: component.x + index * 5,
    })), { scale: 1 })).toMatchObject({ ok: false });
  });

  it("window.snapshot의 실제 PNG 좌표계를 물리 창 크기와 scale에서 산출한다", () => {
    const png = encodePng({ w: 800, h: 600, ch: 3, px: Buffer.alloc(800 * 600 * 3) });
    expect(snapshotCssScale(png, { w: 1600, h: 1200, scale: 2 })).toBe(1);
    const retinaPng = encodePng({ w: 1600, h: 1200, ch: 3, px: Buffer.alloc(1600 * 1200 * 3) });
    expect(snapshotCssScale(retinaPng, { w: 1600, h: 1200, scale: 2 })).toBe(2);
  });

  it("DOM viewport와 CSS fixed marker를 PNG와 무관한 수치로 판정한다", () => {
    expect(viewportGeometryVerdict({
      slot: { w: 608, h: 262 },
      viewport: { w: 608, h: 262 },
      marker: fixtureMarkerSize,
    })).toEqual({ ok: true, errors: [] });
    expect(viewportGeometryVerdict({
      slot: { w: 900, h: 400 },
      viewport: { w: 608, h: 262 },
      marker: { width: 63, height: 40 },
    }).ok).toBe(false);
    // PNG pixel 정보는 이 판정의 입력이 아니다. 사람이 보는 visual report에서만 다룬다.
    expect(viewportGeometryVerdict({
      slot: { w: 608, h: 262 },
      viewport: { w: 608, h: 262 },
      marker: fixtureMarkerSize,
      markerPixels: { width: 1, height: 1 },
      scale: 99,
    })).toEqual({ ok: true, errors: [] });
  });

  it("full capture는 명시 view·영수증·문서 수치·scroll 보존만 기계 판정한다", () => {
    const input = {
      requestedViewId: "tab-left",
      outputPath: "/evidence/full.png",
      fileBytes: 4096,
      before: {
        y: 0,
        viewport: { w: 608, h: 262 },
        document: { w: 608, h: 2140 },
      },
      after: {
        y: 0,
        viewport: { w: 608, h: 262 },
        document: { w: 608, h: 2140 },
      },
      result: {
        viewId: "tab-left",
        path: "/evidence/full.png",
        bytes: 4096,
        width: 608,
        height: 2140,
      },
    };
    expect(fullCaptureReceiptVerdict(input)).toEqual({ ok: true, errors: [] });
    expect(fullCaptureReceiptVerdict({
      ...input,
      result: { ...input.result, viewId: "tab-right" },
      after: { ...input.after, y: 480 },
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["viewId=tab-right/tab-left", "scroll=480/0"]),
    });
  });

  it("창 합성 epoch의 전역 배율과 브라우저 고유 stretch를 구분한다", () => {
    expect(transitionFrameAlignment({
      browser: { width: 128, height: 80 },
      dom: [{ width: 80, height: 80 }, { width: 80, height: 80 }],
    })).toEqual({ ok: true, errors: [] });
    const chromeTear = transitionFrameAlignment({
      browser: { width: 128, height: 80 },
      dom: [{ width: 80, height: 80 }, { width: 70, height: 80 }],
    });
    expect(chromeTear.ok).toBe(false);
    expect(chromeTear.errors).toContain("chrome-epoch-tear=2x2/1.75x2");
    expect(chromeTear.errors.join("\n")).not.toContain("browser-only");
    expect(transitionFrameAlignment({
      browser: { width: 96, height: 60 },
      dom: [{ width: 80, height: 80 }, { width: 80, height: 80 }],
    }).errors).toContain("browser-only-stretch=1.5x1.5/dom:2x2");
  });

  it("전이 crop에 잘린 보정자는 epoch 배율 근거로 쓰지 않는다", () => {
    expect(completeCalibrationComponents([
      { count: 6400, width: 80, height: 80 },
      { count: 3830, width: 80, height: 48 },
    ])).toEqual([{ count: 6400, width: 80, height: 80 }]);
    expect(completeCalibrationComponents([
      { count: 3830, width: 80, height: 48 },
    ])).toEqual([]);
  });

  it("평탄/중첩 eval 봉투를 같은 페이지 반환값으로 푼다", () => {
    const page = { value: "한글", active: true, ledger: { inputEvents: 1 } };
    expect(unwrapEvalValue(page)).toEqual(page);
    expect(unwrapEvalValue({ value: page, viewId: "tab-1" })).toEqual(page);
    const scroll = { y: 480, h: 2400, v: 600 };
    expect(unwrapEvalValue(scroll)).toEqual(scroll);
    expect(unwrapEvalValue({ value: scroll, viewId: "tab-1" })).toEqual(scroll);
  });

  it("엔진 중립 신원과 실제 편집 요소·입력 사건 장부를 제공한다", () => {
    const html = fixtureHtml();
    expect(html).toContain("Browser Boundary");
    expect(html).not.toContain("Native Boundary");
    expect(html).toContain('id="ime"');
    expect(html).toContain("beforeinput");
    expect(html).toContain("inputEvents");
    expect(html).toContain('id="marker"');
    expect(html.match(/class="fixture-marker"/g)).toHaveLength(3);
    expect(html).toContain('id="marker" class="fixture-marker"');
    expect(html).toContain('id="typed-marker"');
    expect(html).toContain(fixtureInputMarkers[0]);
    expect(html).toContain(`#typed-marker{height:${fixtureInputMarkerSize.height}px`);
    expect(html).toContain(`width:${fixtureMarkerSize.width}px;height:${fixtureMarkerSize.height}px`);
    expect(html).toContain("@media(max-height:520px)");
  });

  it("무포커스 조명 합성 뒤에도 marker hue를 표면 생존 증거로 센다", () => {
    const px = Buffer.alloc(20 * 20 * 3, 0);
    for (let i = 0; i < 120; i += 1) {
      px[i * 3] = 117;
      px[i * 3 + 1] = 25;
      px[i * 3 + 2] = 123;
    }
    const png = encodePng({ w: 20, h: 20, ch: 3, px });
    expect(markerPixels(png, fixtureMarkers[0])).toBe(120);
    expect(markerPixels(png, fixtureMarkers[1])).toBe(0);
  });

  it("blocked 70% + 비활성 창 조명 뒤의 magenta도 채도로 식별한다", () => {
    const px = Buffer.alloc(20 * 20 * 3, 0);
    for (let i = 0; i < 120; i += 1) {
      px[i * 3] = 23;
      px[i * 3 + 1] = 0;
      px[i * 3 + 2] = 23;
    }
    const png = encodePng({ w: 20, h: 20, ch: 3, px });
    expect(markerPixels(png, fixtureMarkers[0])).toBe(120);
    expect(markerPixels(png, fixtureMarkers[1])).toBe(0);
  });

  it("색 관리가 주 채널을 비대칭 변환한 실제 magenta도 같은 hue로 식별한다", () => {
    const px = Buffer.alloc(20 * 20 * 3, 0);
    for (let i = 0; i < 120; i += 1) {
      px[i * 3] = 234;
      px[i * 3 + 1] = 51;
      px[i * 3 + 2] = 247;
    }
    const png = encodePng({ w: 20, h: 20, ch: 3, px });
    expect(markerPixels(png, fixtureMarkers[0])).toBe(120);
    expect(markerPixels(png, fixtureMarkers[1])).toBe(0);
  });

  it("같은 조명 아래 cyan/yellow/green도 동일한 채도 기준으로 식별한다", () => {
    for (const [color, rgb] of [
      [fixtureMarkers[1], [0, 23, 23]],
      [fixtureInputMarkers[0], [23, 23, 0]],
      [fixtureInputMarkers[1], [0, 23, 0]],
    ]) {
      const px = Buffer.alloc(20 * 20 * 3, 0);
      for (let i = 0; i < 120; i += 1) {
        px[i * 3] = rgb[0]; px[i * 3 + 1] = rgb[1]; px[i * 3 + 2] = rgb[2];
      }
      expect(markerPixels(encodePng({ w: 20, h: 20, ch: 3, px }), color)).toBe(120);
    }
  });

  it("밝기만 비슷한 무채색은 marker로 오인하지 않는다", () => {
    const px = Buffer.alloc(20 * 20 * 3, 117);
    const png = encodePng({ w: 20, h: 20, ch: 3, px });
    expect(markerPixels(png, fixtureMarkers[0])).toBe(0);
    expect(markerPixels(png, fixtureMarkers[1])).toBe(0);
  });

  it("DOM compositor 기준자의 순수 파랑을 별도 연결 성분으로 센다", () => {
    const px = Buffer.alloc(80 * 50 * 3, 0);
    for (let y = 5; y < 45; y += 1) for (let x = 8; x < 72; x += 1) px[(y * 80 + x) * 3 + 2] = 255;
    const evidence = markerEvidence(encodePng({ w: 80, h: 50, ch: 3, px }), "#0000ff");
    expect(evidence.largest).toEqual({
      count: 2560, x: 8, y: 5, width: 64, height: 40, bodyWidth: 64, bodyHeight: 40,
    });
  });

  it("흩어진 장식 픽셀과 넓게 이어진 fixture marker를 구분한다", () => {
    const px = Buffer.alloc(180 * 50 * 3, 0);
    for (let y = 10; y < 34; y += 1) for (let x = 20; x < 160; x += 1) {
      const at = (y * 180 + x) * 3;
      px[at] = 255; px[at + 2] = 255;
    }
    const evidence = markerEvidence(encodePng({ w: 180, h: 50, ch: 3, px }), fixtureMarkers[0]);
    expect(evidence.largest.width).toBe(140);
    expect(evidence.largest.height).toBe(24);
  });

  it("표식에 같은 색 장식이 일부 붙어도 직사각형 본체 크기는 변하지 않는다", () => {
    const px = Buffer.alloc(120 * 100 * 3, 0);
    const mark = (x, y) => {
      const at = (y * 120 + x) * 3;
      px[at + 1] = 255; px[at + 2] = 255;
    };
    for (let y = 20; y < 60; y += 1) for (let x = 20; x < 84; x += 1) mark(x, y);
    for (let n = 0; n < 18; n += 1) mark(84 + n, 20 + n);
    const evidence = markerEvidence(encodePng({ w: 120, h: 100, ch: 3, px }), fixtureMarkers[1]);
    expect(evidence.largest.width).toBeGreaterThan(64);
    expect(evidence.largest.height).toBe(40);
    expect(evidence.largest.bodyWidth).toBe(64);
    expect(evidence.largest.bodyHeight).toBe(40);
  });

  it("같은 hue의 긴 배경 줄기에 연결돼도 선언된 직사각 본체를 선택한다", () => {
    const px = Buffer.alloc(120 * 240 * 3, 0);
    const mark = (x, y) => {
      const at = (y * 120 + x) * 3;
      px[at + 1] = 127; px[at + 2] = 127;
    };
    for (let y = 20; y < 220; y += 1) for (let x = 10; x < 18; x += 1) mark(x, y);
    for (let y = 80; y < 120; y += 1) for (let x = 10; x < 74; x += 1) mark(x, y);
    const evidence = markerEvidence(encodePng({ w: 120, h: 240, ch: 3, px }), fixtureMarkers[1]);
    expect(evidence.largest.bodyWidth).toBe(8);
    expect(selectFixtureMarkerComponent(evidence.components, {
      expectedWidth: 64,
      expectedHeight: 40,
      minCount: 200,
    })).not.toBeNull();
  });

  it("같은 hue의 큰 배경보다 선언된 64x40 표식 성분을 선택한다", () => {
    const selected = selectFixtureMarkerComponent([
      { count: 90_000, bodyWidth: 264, bodyHeight: 364 },
      { count: 2_560, bodyWidth: 64, bodyHeight: 40 },
    ], { expectedWidth: 64, expectedHeight: 40, minCount: 200 });
    expect(selected).toMatchObject({ bodyWidth: 64, bodyHeight: 40 });
  });

  it("다른 합성 레이어가 표식 내부를 가려도 정확한 외곽 경계와 생존 픽셀로 선택한다", () => {
    const selected = selectFixtureMarkerComponent([
      {
        count: 512,
        x: 538,
        y: 344,
        width: 64,
        height: 40,
        bodyWidth: 62,
        bodyHeight: 34,
        rowRuns: [62, 62, 56, 48],
        sampleStep: 1,
      },
    ], { expectedWidth: 64, expectedHeight: 40, minCount: 200 });
    expect(selected).toMatchObject({ width: 64, height: 40 });
  });

  it("같은 프레임의 DOM anchor와 surface marker x좌표를 엄격히 판정한다", () => {
    const frame = (surfaceX) => {
      const px = Buffer.alloc(100 * 60 * 3, 0);
      for (const [x0, y0] of [[10, 4], [surfaceX, 32]]) {
        for (let y = y0; y < y0 + 12; y += 1) for (let x = x0; x < x0 + 12; x += 1) {
          const at = (y * 100 + x) * 3;
          px[at] = 128;
          px[at + 2] = 255;
        }
      }
      return encodePng({ w: 100, h: 60, ch: 3, px });
    };

    expect(motionMarkerAlignment(frame(10), fixtureMotionMarkers[0], 1).ok).toBe(true);
    expect(motionMarkerAlignment(frame(38), fixtureMotionMarkers[0], 1)).toMatchObject({
      ok: false,
      errors: ["motion-x=10/38 dx=28"],
    });
  });

  it("상위 장식이 두 anchor를 조각내도 경계 안에서 복원하고 x 기준은 유지한다", () => {
    const frame = (surfaceX) => {
      const px = Buffer.alloc(100 * 70 * 3, 0);
      for (const [x0, y0] of [[10, 4], [surfaceX, 32]]) {
        for (let y = y0; y < y0 + 12; y += 1) for (let x = x0; x < x0 + 12; x += 1) {
          if (x >= x0 + 4 && x < x0 + 8) continue;
          const at = (y * 100 + x) * 3;
          px[at] = 128;
          px[at + 2] = 255;
        }
      }
      return encodePng({ w: 100, h: 70, ch: 3, px });
    };
    expect(motionMarkerAlignment(frame(10), fixtureMotionMarkers[0], 1)).toMatchObject({ ok: true, dx: 0 });
    expect(motionMarkerAlignment(frame(30), fixtureMotionMarkers[0], 1)).toMatchObject({
      ok: false,
      errors: ["motion-x=10/30 dx=20"],
    });
  });

  it("상위 장식이 2x 기준자의 오른쪽 5px을 덮어도 남은 왼쪽 경계로 x를 판정한다", () => {
    const frame = (surfaceX) => {
      const px = Buffer.alloc(160 * 100 * 3, 0);
      for (const [x0, y0, visibleWidth] of [[20, 8, 24], [surfaceX, 64, 19]]) {
        for (let y = y0; y < y0 + 24; y += 1) for (let x = x0; x < x0 + visibleWidth; x += 1) {
          const at = (y * 160 + x) * 3;
          px[at] = 128;
          px[at + 2] = 255;
        }
      }
      return encodePng({ w: 160, h: 100, ch: 3, px });
    };
    expect(motionMarkerAlignment(frame(20), fixtureMotionMarkers[0], 2)).toMatchObject({ ok: true, dx: 0 });
    expect(motionMarkerAlignment(frame(60), fixtureMotionMarkers[0], 2)).toMatchObject({
      ok: false,
      errors: ["motion-x=20/60 dx=40"],
    });
  });

  it("motion 팔레트는 다른 fixture 색과 겹치지 않고 조명 감광 뒤에도 검출된다", () => {
    expect(new Set([
      ...fixtureMarkers,
      ...fixtureInputMarkers,
      ...fixtureMotionMarkers,
      compositorCalibrationMarker,
      "#ff0000",
    ]).size).toBe(8);
    const px = Buffer.alloc(80 * 50 * 3, 0);
    for (const [x0, level] of [[8, 1], [40, 0.5]]) {
      for (let y = 8; y < 20; y += 1) for (let x = x0; x < x0 + 12; x += 1) {
        const at = (y * 80 + x) * 3;
        px[at] = Math.round(128 * level);
        px[at + 2] = Math.round(255 * level);
      }
    }
    const evidence = markerEvidence(encodePng({ w: 80, h: 50, ch: 3, px }), fixtureMotionMarkers[0]);
    expect(evidence.components.filter((component) => component.width === 12 && component.height === 12)).toHaveLength(2);
  });

  it("비활성 native 표면의 감광 orange 기준자를 장식 조각 대신 선택한다", () => {
    const px = Buffer.alloc(100 * 70 * 3, 0);
    // DOM anchor: 색 관리가 적용된 밝은 orange.
    for (let y = 4; y < 16; y += 1) for (let x = 10; x < 22; x += 1) {
      const at = (y * 100 + x) * 3;
      px[at] = 119; px[at + 1] = 67; px[at + 2] = 25;
    }
    // Native surface marker: 제품의 비활성 밝기 합성 뒤 실측값.
    for (let y = 32; y < 44; y += 1) for (let x = 10; x < 22; x += 1) {
      const at = (y * 100 + x) * 3;
      px[at] = 54; px[at + 1] = 30; px[at + 2] = 11;
    }
    // 같은 hue의 장식은 바깥 bbox만 비슷하고 직사각 본체가 아니다.
    for (let y = 20; y < 32; y += 1) for (let x = 60; x < 72 - Math.abs(26 - y); x += 1) {
      const at = (y * 100 + x) * 3;
      px[at] = 133; px[at + 1] = 70; px[at + 2] = 20;
    }
    expect(motionMarkerAlignment(
      encodePng({ w: 100, h: 70, ch: 3, px }), fixtureMotionMarkers[1], 1,
    )).toMatchObject({ ok: true, dx: 0 });
  });
});
