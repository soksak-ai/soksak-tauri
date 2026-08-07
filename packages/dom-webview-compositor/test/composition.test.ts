import { describe, expect, it } from "vitest";
import {
  compositionFrameComparisonVerdict,
  compositionInventoryVerdict,
  compositionObservationWindowVerdict,
  compositionSampleVerdict,
  compositionTimelineFrameAt,
  compositionTimelineVerdict,
  compositionTransactionVerdict,
  logicalRectToPhysical,
  motionModeForClocks,
  type CompositionInventory,
  type CompositionSample,
} from "../src/index";

const sample = (
  rendererX: number,
  surfaceX: number,
  scaleFactor = 2,
  overrides: Partial<CompositionSample> = {},
): CompositionSample => ({
  transactionId: "tx-1",
  sequence: 0,
  phase: "prepared",
  sampledAtUnixMs: 10,
  coordinateSpace: { logical: "css-px", scaleFactor },
  slot: { id: "slot", frame: { x: 100, y: 20, w: 300, h: 200 } },
  renderer: { id: "renderer", frame: { x: rendererX, y: 20, w: 300, h: 200 } },
  surface: { id: "surface", frame: { x: surfaceX, y: 20, w: 300, h: 200 } },
  ...overrides,
});

describe("DOM ↔ native webview composition contract", () => {
  it("좌표 원점과 reference가 다른 frame의 직접 비교를 거부한다", () => {
    const frame = { x: 0, y: 28, w: 300, h: 200 };
    expect(compositionFrameComparisonVerdict({
      expected: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "presenter-local",
          referenceId: "pane-host-a",
        },
      },
      actual: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "window-absolute",
          referenceId: "window-a",
        },
      },
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "coordinate-origin=presenter-local/window-absolute",
        "coordinate-reference=pane-host-a/window-a",
      ]),
    });

    expect(compositionFrameComparisonVerdict({
      expected: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "presenter-local",
          referenceId: "pane-host-a",
        },
      },
      actual: {
        frame,
        coordinateSpace: {
          logical: "css-px",
          scaleFactor: 2,
          origin: "presenter-local",
          referenceId: "pane-host-a",
        },
      },
    })).toMatchObject({ ok: true, errors: [] });
  });

  it("CSS 모서리를 물리 픽셀로 한 번만 반올림하고 임의 tolerance를 두지 않는다", () => {
    expect(logicalRectToPhysical({ x: 10.25, y: 20.5, w: 100.5, h: 40.25 }, 2)).toEqual({
      x: 21,
      y: 41,
      w: 201,
      h: 81,
    });
    expect(compositionSampleVerdict(sample(100.5, 100))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("renderer=")],
    });
    expect(compositionSampleVerdict(sample(100, 420))).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("surface=")],
    });
  });

  it("독립 inventory의 slot·renderer·surface가 view/topology/양 좌표계에서 정확히 1:1이어야 한다", () => {
    const observed = (kind: string, viewId: string, x: number) => ({
      id: `${kind}-${viewId}`,
      viewId,
      topologyPath: `workspace/pane/${viewId}/content`,
      visible: true as const,
      logicalFrame: { x, y: 20.25, w: 300.5, h: 200.25 },
      physicalFrame: logicalRectToPhysical({ x, y: 20.25, w: 300.5, h: 200.25 }, 2),
    });
    const inventory: CompositionInventory = {
      coordinateSpace: { logical: "css-px", physical: "device-px", scaleFactor: 2 },
      visibleViewIds: ["left", "right"],
      slots: [observed("slot", "left", 100.25), observed("slot", "right", 420.25)],
      renderers: [observed("renderer", "left", 100.25), observed("renderer", "right", 420.25)],
      surfaces: [observed("surface", "left", 100.25), observed("surface", "right", 420.25)],
    };
    expect(compositionInventoryVerdict(inventory)).toMatchObject({
      ok: true,
      matched: 2,
      errors: [],
    });

    const missing = structuredClone(inventory);
    missing.surfaces.pop();
    expect(compositionInventoryVerdict(missing)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("owners=")]),
    });

    const topologyDrift = structuredClone(inventory);
    topologyDrift.renderers[0].topologyPath = "workspace/pane/wrong/content";
    expect(compositionInventoryVerdict(topologyDrift)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("topology slot=")]),
    });

    // 값 안에 "/" 가 있으므로 "/" 로 이으면 값 경계가 사라진다 — 실측 2026-08-07: 빈 값 하나를
    // "경로가 두 번 이어붙었다"로 잘못 읽었고, 잘못 읽은 증거는 잘못된 자리를 고치게 한다.
    const surfaceSilent = structuredClone(inventory);
    surfaceSilent.surfaces[0].topologyPath = "";
    const silentTopology = compositionInventoryVerdict(surfaceSilent).errors
      .find((error) => error.includes(":topology "));
    expect(silentTopology).toContain("slot=");
    expect(silentTopology).toContain("renderer=");
    expect(silentTopology).toContain('surface=""');

    const physicalDrift = structuredClone(inventory);
    physicalDrift.surfaces[0].physicalFrame.x += 1;
    expect(compositionInventoryVerdict(physicalDrift)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("physical-rounding=")]),
    });

    const hiddenOmission = structuredClone(inventory);
    hiddenOmission.visibleViewIds.push("omitted-visible-view");
    expect(compositionInventoryVerdict(hiddenOmission)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("visible-owners=")]),
    });
  });

  it("배율은 양수인 공개 좌표계 사실이어야 한다", () => {
    expect(compositionSampleVerdict(sample(100, 100, 0))).toMatchObject({
      ok: false,
      errors: ["scaleFactor=0"],
    });
  });

  it("공유 presentation clock이 없으면 snap을 선택한다", () => {
    expect(motionModeForClocks(true)).toBe("glide");
    expect(motionModeForClocks(false)).toBe("snap");
  });

  it("녹화 프레임 없이 거래 순서·종료·삼자 일치를 수치 RED로 판정한다", () => {
    const green = [
      sample(100, 100, 2, { sequence: 0, phase: "prepared" }),
      sample(420, 420, 2, {
        sequence: 1,
        phase: "committed",
        slot: { id: "slot", frame: { x: 420, y: 20, w: 300, h: 200 } },
      }),
    ];
    expect(compositionTransactionVerdict(green, { motionMode: "snap" })).toMatchObject({
      ok: true,
      samples: 2,
      committed: true,
    });
    expect(compositionTransactionVerdict([
      green[0],
      { ...green[1], surface: { id: "surface", frame: { x: 100, y: 20, w: 300, h: 200 } } },
    ], { motionMode: "snap" })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("surface=")],
    });
  });

  it("거래 id·sequence·commit이 분리되면 좌표가 맞아도 RED다", () => {
    const rows = [
      sample(100, 100, 2, { sequence: 0, phase: "prepared" }),
      sample(100, 100, 2, { transactionId: "tx-2", sequence: 2, phase: "presenting" }),
    ];
    const verdict = compositionTransactionVerdict(rows, { motionMode: "glide" });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(expect.arrayContaining([
      "transaction-ids=tx-1/tx-2",
      "s1:sequence=2/1",
      "commit-missing",
    ]));
  });

  it("서로 다른 display cadence는 각 실제 epoch의 한 궤적으로 판정하고 nearest sample로 붙이지 않는다", () => {
    const frame = (x: number) => ({ x, y: 20, w: 300, h: 200 });
    const timed = (times: number[], step: number) => times.map((sampledAtUnixMs, sequence) => ({
      sequence,
      sampledAtUnixMs,
      frame: frame(sequence * step),
    }));
    const input = {
      coordinateSpace: { logical: "css-px" as const, scaleFactor: 2 },
      clocks: { window: "unix-anchored-monotonic", slot: "unix-anchored-monotonic", renderer: "unix-anchored-monotonic", surface: "unix-anchored-monotonic" },
      startAtUnixMs: 0,
      durationMs: 32,
      timingFunction: [0, 0, 1, 1] as const,
      from: frame(0),
      to: frame(32),
      // DOM은 60Hz, native는 120Hz여도 한 샘플을 두 번 붙여 비교하지 않는다.
      slot: timed([0, 16, 32], 16),
      renderer: timed([0, 8, 16, 24, 32], 8),
      surface: timed([0, 8, 16, 24, 32], 8),
    };
    expect(compositionTimelineVerdict(input)).toMatchObject({ ok: true, errors: [] });

    const lagged = structuredClone(input);
    lagged.surface[2].frame.x = 8;
    expect(compositionTimelineVerdict(lagged)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("surface[2]")]),
    });

    const roundingOnly = structuredClone(input);
    roundingOnly.from.x = 0.24;
    roundingOnly.to.x = 32.24;
    for (const samples of [roundingOnly.slot, roundingOnly.renderer, roundingOnly.surface]) {
      for (const sample of samples) sample.frame.x += 0.24;
    }
    roundingOnly.slot[1].frame.x += 0.24; // 0.48 physical px: quantization-only
    expect(compositionTimelineVerdict(roundingOnly)).toMatchObject({ ok: true, errors: [] });

    roundingOnly.slot[1].frame.x += 0.02; // 0.52 physical px: rounding으로 설명 불가
    expect(compositionTimelineVerdict(roundingOnly)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("slot[1]")]),
    });
  });

  it("거래 구간과 겹치지 않는 관측은 좌표를 비교하기 전에 거리로 거절한다", () => {
    const window = { startAtUnixMs: 1_000, endAtUnixMs: 1_340, clock: "unix-anchored-monotonic" };
    const on = (producer: string, first: number, last: number) => ({
      producer,
      clock: "unix-anchored-monotonic",
      firstSampledAtUnixMs: first,
      lastSampledAtUnixMs: last,
    });
    expect(compositionObservationWindowVerdict(window, [
      on("slot", 990, 1_400),
      on("surface", 1_340, 1_900),
    ])).toMatchObject({ ok: true, errors: [], gapMs: { slot: 0, surface: 0 } });

    expect(compositionObservationWindowVerdict(window, [
      on("renderer", 100, 900),
      on("surface", 1_341, 2_000),
    ])).toMatchObject({
      // 겹치지 않는 관측은 어긋남이 아니라 못 잼이다 — 거리는 그대로 남기고 자리만 옮긴다.
      ok: false,
      errors: [],
      unmeasured: ["renderer:no-samples-in-window=100", "surface:no-samples-in-window=1"],
      gapMs: { renderer: 100, surface: 1 },
    });

    expect(compositionObservationWindowVerdict(window, [
      on("surface", 1_400, 1_100),
    ])).toMatchObject({ ok: false, errors: ["surface:span=1400/1100"] });

    expect(compositionObservationWindowVerdict(
      { startAtUnixMs: 1_000, endAtUnixMs: Number.NaN, clock: "unix-anchored-monotonic" },
      [on("slot", 1_000, 1_100)],
    )).toMatchObject({ ok: false, errors: ["window=1000/NaN"] });
  });

  it("native producer가 다른 epoch를 쓰면 좌표 delta 대신 epoch 거리를 이름으로 남긴다", () => {
    // 실측(evidence/slot-freeze/last-red/browser/01-left): DOM/journal은 wall clock,
    // native display producer는 4,041,616ms 뒤처진 epoch를 같은 `...UnixMs` 이름으로 냈다.
    const startAtUnixMs = 1_786_071_385_870;
    const durationMs = 340;
    const frame = (x: number) => ({ x, y: 149, w: 281, h: 421 });
    const timelineFor = (times: readonly number[], xs: readonly number[]) => (
      times.map((sampledAtUnixMs, sequence) => ({
        sequence,
        sampledAtUnixMs,
        frame: frame(xs[sequence]),
      }))
    );
    const domTimes = [startAtUnixMs, startAtUnixMs + 170, startAtUnixMs + durationMs];
    const foreignEpochTimes = [
      1_786_067_343_619.7163,
      1_786_067_343_936.6433,
      1_786_067_344_253.5706,
    ];
    const timeline = {
      coordinateSpace: { logical: "css-px" as const, scaleFactor: 2 },
      // 실측 사건에서 두 관측기는 서로 다른 시계를 답했다 — native 는 uptime 에 고정된 표시
      // 시계를, DOM 장부는 wall clock 을 따라가는 시계를 냈다.
      clocks: {
        window: "unix-anchored-monotonic",
        slot: "unix-anchored-monotonic",
        renderer: "wall",
        surface: "wall",
      },
      startAtUnixMs,
      durationMs,
      timingFunction: [0, 0, 1, 1] as const,
      from: frame(60),
      to: frame(220),
      slot: timelineFor(domTimes, [60, 140, 220]),
      // 실측 native ledger는 거래 내내 이동 전 x를 들고 있었다.
      renderer: timelineFor(foreignEpochTimes, [60, 60, 60]),
      surface: timelineFor(foreignEpochTimes, [60, 60, 60]),
    };
    // 이름은 거리가 아니라 갈라진 시계다 — 거리는 두 시계 사이에서 뜻을 잃는다.
    expect(compositionTimelineVerdict(timeline)).toMatchObject({
      ok: false,
      errors: [
        "renderer:clock=wall/unix-anchored-monotonic",
        "surface:clock=wall/unix-anchored-monotonic",
      ],
    });

    // 같은 좌표를 같은 시계 위로 옮기면 epoch 실패가 사라지고 실제 결함(이동하지 않은 native
    // ledger)이 device pixel 수치로 드러난다. epoch 정렬은 판정을 무르게 하지 않는다.
    const aligned = {
      ...timeline,
      clocks: { ...timeline.clocks, renderer: "unix-anchored-monotonic", surface: "unix-anchored-monotonic" },
      renderer: timelineFor(domTimes, [60, 60, 60]),
      surface: timelineFor(domTimes, [60, 60, 60]),
    };
    const alignedVerdict = compositionTimelineVerdict(aligned);
    expect(alignedVerdict.ok).toBe(false);
    expect(alignedVerdict.errors).toEqual(expect.arrayContaining([
      // 착지 시각의 native ledger는 선언 궤적에서 320 physical px 떨어져 있다(=160 css px).
      'renderer[2]={"x":320,"y":0,"w":320,"h":0}',
      'surface[2]={"x":320,"y":0,"w":320,"h":0}',
      expect.stringContaining("renderer[1]="),
      expect.stringContaining("surface[1]="),
    ]));
    expect(alignedVerdict.errors.some((error) => error.includes(":clock="))).toBe(false);
  });
});


// 규칙 — 관측 증명: 잰 어긋남만 red 다.
//
// 거래 창과 겹치는 관측이 하나도 없으면 그것은 "어긋났다"가 아니라 "재지 못했다"다. 둘을 같은
// 칸에 넣으면 관측기가 죽은 실행과 제품이 틀린 실행이 같은 답을 내고, 그 답은 고칠 자리를
// 가리키지 못한다. 실측 2026-08-07: B04·B05 가 표시 시계 침묵을 red 로 칠했고, 같은 빌드가
// 실행마다 green/red 를 오갔다.
//
// blocked 는 통과가 아니다 — 인수는 72칸 전부 green 을 요구한다. 이름이 달라질 뿐이고,
// 그 이름이 고칠 자리를 가리킨다.
describe("관측 증명", () => {
  const window = { startAtUnixMs: 1_000, endAtUnixMs: 1_340, clock: "unix-anchored-monotonic" };
  // 침묵을 재려면 먼저 같은 시계를 답해야 한다 — 시계가 갈린 관측은 침묵이 아니라 계약 위반이다.
  const on = (first: number, last: number) => ({
    producer: "presentation",
    clock: "unix-anchored-monotonic",
    firstSampledAtUnixMs: first,
    lastSampledAtUnixMs: last,
  });

  it("창과 겹치지 않는 관측은 red 가 아니라 못 잼이다", () => {
    const verdict = compositionObservationWindowVerdict(window, [on(100, 900)]);
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["presentation:no-samples-in-window=100"]);
    expect(verdict.gapMs).toMatchObject({ presentation: 100 });
  });

  it("창 뒤로 벗어난 관측도 같은 답이다", () => {
    const verdict = compositionObservationWindowVerdict(window, [on(1_341, 2_000)]);
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["presentation:no-samples-in-window=1"]);
  });

  // 모양이 틀린 것은 못 잼이 아니다 — 그건 계약 위반이고 red 로 남는다.
  it("모양이 틀린 선언은 여전히 red 다", () => {
    const verdict = compositionObservationWindowVerdict(window, [on(1_400, 1_100)]);
    expect(verdict.errors).toEqual(["presentation:span=1400/1100"]);
    expect(verdict.unmeasured).toEqual([]);
  });

  it("겹치는 관측은 못 잼도 어긋남도 아니다", () => {
    const verdict = compositionObservationWindowVerdict(window, [on(990, 1_400)]);
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual([]);
  });
});

// 규칙 — 시계 선언: `...UnixMs` 라는 이름은 같은 시계를 뜻하지 않는다.
//
// 관측을 내는 자가 자기 시계를 선언한다. 선언 없는 시계는 판정 입력이 될 수 없다. 이 선언이
// 서야 창 밖 표본이 뜻하는 두 사실이 기계적으로 갈린다 — 선언이 다르면 계약 위반(red), 선언이
// 같은데 창 안 표본이 0 이면 못 잼(blocked)이다. 크기로 가르지 않는다.
//
// 실측 2026-08-07(tauri/darwin): DOM 시계는 wall clock 을 따라갔고 native 시계는 unix 로 한 번
// 고정한 뒤 media time 으로만 나아갔다. 그래서 wall clock 이 4.12s 뒤로 밟힌 실행에서 두 시계가
// 갈라졌고, system sleep 67분이 낀 실행에서는 반대 부호로 4,041,616ms 갈라졌다. 두 사건 다
// 관측기는 살아 있었다 — 침묵이 아니라 시계가 달랐다.
describe("시계 선언", () => {
  const window = { startAtUnixMs: 1_000, endAtUnixMs: 1_340, clock: "unix-anchored-monotonic" };

  it("선언한 시계가 다르면 창 밖 표본은 못 잼이 아니라 red 다", () => {
    const verdict = compositionObservationWindowVerdict(window, [{
      producer: "renderer",
      clock: "wall",
      firstSampledAtUnixMs: 100,
      lastSampledAtUnixMs: 900,
    }]);
    expect(verdict.errors).toEqual(["renderer:clock=wall/unix-anchored-monotonic"]);
    expect(verdict.unmeasured).toEqual([]);
  });

  it("시계가 갈렸으면 표본이 창과 겹쳐도 red 다 — 겹침은 우연일 수 있다", () => {
    const verdict = compositionObservationWindowVerdict(window, [{
      producer: "renderer",
      clock: "wall",
      firstSampledAtUnixMs: 1_100,
      lastSampledAtUnixMs: 1_200,
    }]);
    expect(verdict.errors).toEqual(["renderer:clock=wall/unix-anchored-monotonic"]);
  });

  // 정정 2026-08-08: 이 단언은 시계 미선언을 red 로 고정하고 있었다. 갈린 시계는 계약 위반이지만
  // 안 밝힌 시계는 **맞댈 기준이 없는 것**이라 못 잼이다 — 같은 파일의 주석도 "이 창에서 잴 수
  // 없는 것" 이라 적어 놓고 판정만 red 였다. 기준을 낮추는 것이 아니다: blocked 도 통과가 아니고
  // 인수는 전 칸 green 을 요구한다. 없는 사실을 red 로 세면 그 뒤 모든 표본이 어긋나 보여
  // 고칠 자리가 수백 개로 늘어난다(실측: offscreen B04 red 556 건 중 514 건이 그 결과였다).
  it("선언 없는 시계는 판정 입력이 될 수 없다 — 어긋남이 아니라 못 잼이다", () => {
    const verdict = compositionObservationWindowVerdict(window, [{
      producer: "renderer",
      firstSampledAtUnixMs: 1_100,
      lastSampledAtUnixMs: 1_200,
    } as never]);
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["renderer:clock-undeclared=none/unix-anchored-monotonic"]);
  });

  it("창이 자기 시계를 선언 안 하면 어느 관측도 그 창에서 판정될 수 없다", () => {
    const verdict = compositionObservationWindowVerdict(
      { startAtUnixMs: 1_000, endAtUnixMs: 1_340 } as never,
      [{
        producer: "renderer",
        clock: "unix-anchored-monotonic",
        firstSampledAtUnixMs: 1_100,
        lastSampledAtUnixMs: 1_200,
      }],
    );
    // 같은 정정 — 창이 안 밝힌 것도 맞댈 기준이 없는 것이지 어긋난 것이 아니다.
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["renderer:clock-undeclared=unix-anchored-monotonic/none"]);
  });

  it("같은 시계를 선언한 producer 가 창에서 침묵한 것은 못 잼이다", () => {
    const verdict = compositionObservationWindowVerdict(window, [{
      producer: "renderer",
      clock: "unix-anchored-monotonic",
      firstSampledAtUnixMs: 100,
      lastSampledAtUnixMs: 900,
    }]);
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["renderer:no-samples-in-window=100"]);
  });

  it("같은 시계를 선언하고 창과 겹치면 못 잼도 어긋남도 아니다", () => {
    const verdict = compositionObservationWindowVerdict(window, [{
      producer: "renderer",
      clock: "unix-anchored-monotonic",
      firstSampledAtUnixMs: 990,
      lastSampledAtUnixMs: 1_400,
    }]);
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual([]);
  });
});

// 규칙 — 관측자가 놓친 것과 표시가 건너뛴 것은 다른 사실이다.
//
// 궤적의 시각 간격만 보면 두 사실이 같은 모양으로 나온다. 관측 콜백이 밀려 표본을 못 낸 것과
// 합성기가 프레임을 실제로 건너뛴 것은 다르고, 앱의 원장이 그 구별을 이미 답한다
// (callbackIntervalsSkipped — Tauri presentation_trace.rs, Electron presentationLedger.ts 둘 다).
//
// 구별하지 않으면 JS 스레드가 한 번 밀렸느냐가 green/red 를 가른다 — 그것이 운이다.
// blocked 는 통과가 아니다. 이름이 달라질 뿐이고 그 이름이 고칠 자리를 가리킨다.
describe("건너뜀의 주인", () => {
  const base = {
    coordinateSpace: { logical: "css-px" as const, scaleFactor: 2 },
    clocks: { window: "w", slot: "w", renderer: "w", surface: "w" },
    startAtUnixMs: 1_000,
    durationMs: 100,
    refreshIntervalMs: 10,
    timingFunction: [0, 0, 1, 1] as const,
    from: { x: 0, y: 0, w: 10, h: 10 },
    to: { x: 100, y: 0, w: 10, h: 10 },
  };
  // 30ms 구멍 하나(주기 10ms → 2 epoch 건너뜀)를 가진 열.
  const gapped = (name: string) => ({
    ...base,
    slot: track(name === "slot"),
    renderer: track(name === "renderer"),
    surface: track(name === "surface"),
  });
  function track(withGap: boolean) {
    const times = withGap ? [1_000, 1_010, 1_040, 1_050] : [1_000, 1_010, 1_020, 1_030];
    return times.map((sampledAtUnixMs, sequence) => ({
      sequence,
      sampledAtUnixMs,
      frame: compositionTimelineFrameAt(base, sampledAtUnixMs),
    }));
  }

  it("관측자가 콜백을 놓쳤다고 답하면 그 열은 못 잼이다", () => {
    const verdict = compositionTimelineVerdict({
      ...gapped("slot"),
      observation: { slot: { callbackIntervalsSkipped: 2 } },
    });
    expect(verdict.errors.filter((error) => error.includes("skipped-display-epochs"))).toEqual([]);
    expect(verdict.unmeasured).toContain("slot:observer-missed-callbacks=2");
  });

  it("관측자가 안 놓쳤다고 답하면 그 구멍은 표시가 건너뛴 것이다", () => {
    const verdict = compositionTimelineVerdict({
      ...gapped("slot"),
      observation: { slot: { callbackIntervalsSkipped: 0 } },
    });
    expect(verdict.errors).toContain("slot:skipped-display-epochs=2");
    expect(verdict.unmeasured).not.toContain("slot:observer-missed-callbacks=0");
  });

  // 안 답한 관측자를 "안 놓쳤다" 로 읽으면 없는 사실을 만든 것이다.
  it("자기보고가 없으면 건너뜀의 주인을 답하지 않는다", () => {
    const verdict = compositionTimelineVerdict(gapped("slot"));
    expect(verdict.errors.filter((error) => error.includes("skipped-display-epochs"))).toEqual([]);
    expect(verdict.unmeasured).toContain("slot:skip-owner-undeclared=2");
  });
});

// 규칙 — 시계가 갈린 것과 시계를 안 밝힌 것은 다른 답이다.
//
// 두 관측이 서로 다른 시계를 **선언했으면** 그 둘을 한 창에서 맞댄 것 자체가 계약 위반이다(red).
// 그러나 한쪽이 시계를 **안 밝혔으면** 그건 잴 수 없는 것이지 어긋난 것이 아니다 — 이 코드의
// 주석도 "이 창에서 잴 수 없는 것" 이라 적어 놓고 판정은 red 로 넣고 있었다.
//
// 실측 2026-08-08: offscreen 사이드카가 시계를 안 답해 B04 가 red 556 건을 냈다. 그중 514 건은
// 시계 미선언의 결과였다 — 시계가 안 맞으면 모든 표본이 어긋나 보인다. 없는 사실을 red 로 세면
// 고칠 자리가 514 개로 보인다.
describe("시계 미선언은 못 잼이다", () => {
  const window = { startAtUnixMs: 1_000, endAtUnixMs: 1_340, clock: "unix-anchored-monotonic" };
  const span = (clock: string | undefined) => ([{
    producer: "presentation",
    ...(clock === undefined ? {} : { clock }),
    firstSampledAtUnixMs: 1_010,
    lastSampledAtUnixMs: 1_300,
  }] as never);

  it("서로 다른 시계를 선언했으면 red 다", () => {
    const verdict = compositionObservationWindowVerdict(window, span("media-time"));
    expect(verdict.errors).toEqual(["presentation:clock=media-time/unix-anchored-monotonic"]);
    expect(verdict.unmeasured).toEqual([]);
  });

  it("시계를 안 밝혔으면 못 잼이다", () => {
    const verdict = compositionObservationWindowVerdict(window, span(undefined));
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["presentation:clock-undeclared=none/unix-anchored-monotonic"]);
  });

  it("창이 시계를 안 밝혔어도 못 잼이다 — 맞댈 기준이 없다", () => {
    const verdict = compositionObservationWindowVerdict(
      { startAtUnixMs: 1_000, endAtUnixMs: 1_340 } as never,
      span("unix-anchored-monotonic"),
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.unmeasured).toEqual(["presentation:clock-undeclared=unix-anchored-monotonic/none"]);
  });

  it("같은 시계를 선언했으면 지금 계약 그대로다", () => {
    const verdict = compositionObservationWindowVerdict(window, span("unix-anchored-monotonic"));
    expect(verdict.ok).toBe(true);
  });
});
