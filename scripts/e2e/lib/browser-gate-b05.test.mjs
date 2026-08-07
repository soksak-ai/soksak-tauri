// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES } from "./browser-gate-identity.mjs";
import { judgeB05MachineEvidence } from "./browser-gate-b05.mjs";
import { judgeBrowserMachineGateEvidence } from "./browser-gates.mjs";

const IDENTITY = Object.freeze({
  framework: "tauri", platform: "darwin", buildId: "b05-build", runId: "b05-run", nativeChildWebview: true,
});

const rect = (x) => ({ x, y: 120, w: 320, h: 480 });

function evidence(engine = "browser") {
  const owners = [`${engine}-left`, `${engine}-right`];
  const transition = (direction, targetViewId, offset) => {
    const traceId = `${engine}-${direction}`;
    const times = [1_004, 1_030, 1_070, 1_110, 1_150, 1_190, 1_230, 1_270, 1_310, 1_350]
      .map((time) => time + offset);
    const surfaces = (step) => owners.map((viewId, ownerIndex) => {
      const frame = rect(100 + ownerIndex * 400 - Math.min(step, 8) * 10);
      return {
        viewId,
        surfaceId: `${engine}-surface-${ownerIndex}`,
        generation: 1,
        live: true,
        visible: true,
        painted: true,
        domFrame: frame,
        surfaceFrame: { ...frame },
      };
    });
    const presentationEvents = times.map((presentedAtUnixMs, sequence) => ({
      sequence,
      sourceGeneration: 3,
      presentationRevision: 20 + sequence,
      displayTimestampUnixMs: presentedAtUnixMs,
      targetTimestampUnixMs: presentedAtUnixMs + 40,
      callbackObservedAtUnixMs: 1002 + sequence * 40 + offset,
      refreshIntervalMs: 40,
      presentedAtUnixMs,
      surfaces: surfaces(sequence),
    }));
    return {
      direction,
      targetViewId,
      trace: {
        traceId,
        clocks: {
          presentation: "unix-anchored-monotonic",
          stimulus: "unix-anchored-monotonic",
          layout: "unix-anchored-monotonic",
          settlement: "unix-anchored-monotonic",
        },
        closed: true,
        ownerViewIds: owners,
        armedAtUnixMs: 1_000 + offset,
        stimulus: { address: `win/w/node/${targetViewId}`, atUnixMs: 1_010 + offset },
        layout: {
          transactionId: `${traceId}-layout`,
          causeTraceId: traceId,
          phase: "committed",
          mode: "glide",
          startAtUnixMs: 1_020 + offset,
          preparedAtUnixMs: 1_012 + offset,
          closedAtUnixMs: 1_360 + offset,
          moves: [{ viewId: targetViewId, dx: 410 }],
        },
        baselineFrameSequence: 0,
        presentationEvents,
        settled: { atUnixMs: 1_365 + offset, frameSequence: 9, syncPending: false },
        hold: {
          startedAtUnixMs: 1_365 + offset,
          endedAtUnixMs: 1_615 + offset,
          surfaces: structuredClone(presentationEvents.at(-1).surfaces),
        },
        violations: { replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0 },
        observation: { callbackIntervalsSkipped: 0, maxCallbackLatencyMs: 2 },
      },
    };
  };
  return {
    engine,
    transitions: [
      transition("to-right", owners[1], 0),
      transition("to-left", owners[0], 1_000),
    ],
  };
}

describe("B05 actual presentation continuity judge", () => {
  it("세 engine의 양방향 실제 presentation 사건 원장만 GREEN receipt가 된다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB05MachineEvidence(evidence(engine))).toMatchObject({ status: "green", reason: null });
      expect(judgeBrowserMachineGateEvidence({
        ...IDENTITY, engine, gate: "B05", evidence: evidence(engine),
      })).toMatchObject({ gate: "B05", engine, status: "green", judgeId: "B05-machine-v1" });
    }
    expect(judgeB05MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
  });

  it("지연·프레임 공백·revision 정지·source 교체를 RED로 만든다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.presentationEvents[1].presentedAtUnixMs += 31; },
      (value) => { value.transitions[0].trace.presentationEvents[3].presentedAtUnixMs += 11; },
      (value) => { value.transitions[0].trace.presentationEvents[2].presentationRevision -= 1; },
      (value) => { value.transitions[0].trace.presentationEvents[2].sourceGeneration += 1; },
      (value) => { value.transitions[0].trace.settled.atUnixMs += 196; },
    ];
    for (const mutate of cases) {
      const value = evidence(); mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });

  // 정정 2026-08-08: 이 단언은 callback coverage 누락을 RED 로 고정하고 있었다. 그 누락은
  // "재보니 어긋났다" 가 아니라 "못 쟀다" 다 — 관측자가 프레임을 못 본 것이지 제품이 프레임을
  // 안 그린 것이 아니다. 이 저장소의 계약은 그 둘을 이미 가른다(잰 어긋남=red, 못 잼=blocked).
  //
  // 기준을 낮추는 것이 아니다: blocked 도 통과가 아니고 인수는 72칸 전부 green 을 요구한다.
  // 이름을 바로잡아야 JS 스레드가 한 번 밀렸느냐가 판정을 가르지 않는다.
  it("시각 소실과 별개로 callback coverage 누락은 이름을 달고 못 잼으로 남긴다", () => {
    const value = evidence("browser");
    value.transitions[0].trace.observation.callbackIntervalsSkipped = 1;
    const verdict = judgeB05MachineEvidence(value);
    expect(verdict.status).toBe("blocked");
    expect(verdict.status).not.toBe("green");
    expect(verdict.reason).toContain("callbackIntervalsSkipped");
  });

  it("표면 교체·소실·미표시·DOM 불일치·hold 회귀를 RED로 만든다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].generation = 2; },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces.pop(); },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].visible = false; },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].painted = false; },
      (value) => { value.transitions[0].trace.presentationEvents[3].surfaces[0].surfaceFrame.x += 2; },
      (value) => { value.transitions[0].trace.hold.endedAtUnixMs -= 1; },
      (value) => { value.transitions[0].trace.hold.surfaces[0].visible = false; },
      (value) => { value.transitions[0].trace.violations.droppedEvents = 1; },
    ];
    for (const mutate of cases) {
      const value = evidence(); mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });

  // 실측 layout 시각. buildId c437078c / runId slot-freeze-0888b3ec 의 browser-chromium
  // to-left 거래에서 자극 epoch 대비 간격을 그대로 옮겼다: 자극 1786074192532,
  // preparedAtUnixMs +52, closedAtUnixMs +63, startAtUnixMs +148. 좌표·표시 사건은 이 판정과
  // 무관하므로 합성 원장을 그대로 쓴다 — 바꾼 것은 거래 시각 셋뿐이다.
  const OBSERVED_LAYOUT = Object.freeze({
    preparedAfterStimulusMs: 52,
    closedAfterStimulusMs: 63,
    startAfterStimulusMs: 148,
  });

  const observedEvidence = (closedAfterStimulusMs) => {
    const value = evidence("browser-chromium");
    for (const transition of value.transitions) {
      const stimulusAtUnixMs = transition.trace.stimulus.atUnixMs;
      transition.trace.layout.preparedAtUnixMs =
        stimulusAtUnixMs + OBSERVED_LAYOUT.preparedAfterStimulusMs;
      transition.trace.layout.closedAtUnixMs = stimulusAtUnixMs + closedAfterStimulusMs;
      transition.trace.layout.startAtUnixMs =
        stimulusAtUnixMs + OBSERVED_LAYOUT.startAfterStimulusMs;
    }
    return value;
  };

  it("실측 거래 시각을 그대로 두면 출발 epoch가 거래 밖이라고 이름 짓는다", () => {
    const verdict = judgeB05MachineEvidence(observedEvidence(OBSERVED_LAYOUT.closedAfterStimulusMs));
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toEqual([
      "B05:transitions[0].trace.layout.startAtUnixMs=within-transaction",
      "B05:transitions[1].trace.layout.startAtUnixMs=within-transaction",
    ]);
  });

  it("거래가 선언한 출발 epoch까지 열려 있으면 그 실패만 사라진다", () => {
    // 구현 수정의 모양: surface ACK(+63) 뒤에도 선언한 출발(+148)까지 거래를 열어 둔다.
    const verdict = judgeB05MachineEvidence(observedEvidence(OBSERVED_LAYOUT.startAfterStimulusMs));
    expect(verdict.status).toBe("green");
    expect(verdict.evidence).not.toEqual(expect.arrayContaining([
      expect.stringContaining("within-transaction"),
    ]));
  });

  it("증거가 예산·픽셀·누적 counter를 끼워 기준을 바꾸지 못한다", () => {
    const cases = [
      (value) => { value.transitions[0].trace.latencyBudgetMs = 10_000; },
      (value) => { value.transitions[0].trace.presentationEvents[0].blackPixels = 0; },
      (value) => { value.transitions[0].trace.countersBefore = { gaps: 0 }; },
    ];
    for (const mutate of cases) {
      const value = evidence(); mutate(value);
      expect(judgeB05MachineEvidence(value).status).toBe("red");
    }
  });
});

// 규칙 — 시계 선언: 이 게이트의 판정은 네 영수증의 시각을 한 줄로 세운 인과 사슬이다.
//
// 실측 2026-08-07(buildId 02e65703, tauri/darwin): 실행 도중 wall clock 이 4.12s 뒤로 밟혀
// DOM 시계와 native 표시 시계가 갈라졌다. B05 는 그 한 사실을 네 증상으로 흩어 보고했다 —
// `trace.baseline=armed<=baseline<=stimulus`, `trace.firstPresentedLatency<=50`,
// `trace.settled.frameSequence=recent-event`, `trace.causal-times=...`. 넷 다 원인을 안 가리킨다.
describe("B05 시계 선언", () => {
  it("영수증들이 서로 다른 시계를 답하면 지연이 아니라 갈라진 선언을 이름으로 낸다", () => {
    const split = evidence("browser");
    split.transitions[0].trace.clocks.presentation = "wall";
    const verdict = judgeB05MachineEvidence(split);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toEqual([
      "B05:transitions[0].trace.clocks=one/"
      + "presentation=wall,stimulus=unix-anchored-monotonic,"
      + "layout=unix-anchored-monotonic,settlement=unix-anchored-monotonic",
    ]);
  });

  // 정정 2026-08-08: 이 단언은 시계 미선언을 red 로 고정하고 있었다. compositor 에서 이미 세운
  // 축과 같다 — 갈린 시계는 계약 위반이지만 안 밝힌 시계는 맞댈 기준이 없는 것이라 못 잼이다.
  // blocked 도 통과가 아니므로 기준을 낮추는 것이 아니다.
  it("선언이 없는 영수증도 판정 입력이 될 수 없다 — 조용한 통과가 아니라 못 잼이다", () => {
    const undeclared = evidence("browser");
    undeclared.transitions[0].trace.clocks.settlement = null;
    const verdict = judgeB05MachineEvidence(undeclared);
    expect(verdict.status).toBe("blocked");
    expect(verdict.status).not.toBe("green");
    expect(verdict.reason).toContain(
      "transitions[0].trace.clocks-undeclared="
      + "presentation=unix-anchored-monotonic,stimulus=unix-anchored-monotonic,"
      + "layout=unix-anchored-monotonic,settlement=none",
    );
  });
});

// 규칙 — 관측자가 못 본 프레임을 합성기가 안 그린 것으로 세지 않는다.
//
// `violations.gaps` 는 **관측된 사건들의 표시 시각 차**로 계산된다. 관측자가 콜백을 놓치면 그
// 프레임을 아예 못 보고, 다음 사건의 간격이 벌어져 gaps 가 오른다 — 합성기는 정상으로 표시했는데도.
// 원장 주석은 둘이 다른 사실이라 하지만, 계산은 그 둘을 가르지 못한다.
//
// 실측 2026-08-07: 같은 전이가 `violations.gaps=0/1` 과 `callbackIntervalsSkipped=0/1` 을 함께
// 냈다. 같은 사건을 두 번 센 것이다.
describe("건너뜀의 주인은 관측 자기보고가 가른다", () => {
  it("관측자가 콜백을 놓쳤으면 gaps 를 합성기 결함으로 세지 않는다", () => {
    const value = evidence();
    const transition = value.transitions[0];
    transition.trace.violations.gaps = 1;
    transition.trace.observation.callbackIntervalsSkipped = 1;
    const verdict = judgeB05MachineEvidence(value);
    expect(verdict.evidence.filter((row) => row.includes("violations.gaps"))).toEqual([]);
    expect(verdict.status).toBe("blocked");
    expect(verdict.reason).toContain("callbackIntervalsSkipped");
  });

  it("관측자가 안 놓쳤으면 gaps 는 그대로 red 다", () => {
    const value = evidence();
    const transition = value.transitions[0];
    transition.trace.violations.gaps = 1;
    transition.trace.observation.callbackIntervalsSkipped = 0;
    const verdict = judgeB05MachineEvidence(value);
    expect(verdict.evidence.some((row) => row.includes("violations.gaps=0/1"))).toBe(true);
    expect(verdict.status).toBe("red");
  });

  it("gaps 가 없으면 관측자가 놓쳤어도 이 축은 조용하다", () => {
    const value = evidence();
    value.transitions[0].trace.observation.callbackIntervalsSkipped = 2;
    const verdict = judgeB05MachineEvidence(value);
    expect(verdict.evidence.filter((row) => row.includes("violations.gaps"))).toEqual([]);
  });
});

// 규칙 — 시계가 갈린 것과 시계를 안 밝힌 것은 다른 답이다.
//
// compositor 에서 이미 세운 축이다(clock-undeclared). B05 도 같은 자리를 한 이름으로 내고 있었다
// — 실측 2026-08-08: offscreen 이 `clocks=one/presentation=none,stimulus=unix-anchored-...` 로
// red 였는데, 그건 사이드카가 시계를 안 답한 것이지 두 시계가 어긋난 것이 아니다.
describe("B05 시계 미선언은 못 잼이다", () => {
  it("한 축이 시계를 안 밝혔으면 blocked 다", () => {
    const value = evidence();
    value.transitions[0].trace.clocks.presentation = null;
    const verdict = judgeB05MachineEvidence(value);
    expect(verdict.status).toBe("blocked");
    expect(verdict.status).not.toBe("green");
    expect(verdict.reason).toContain("clocks-undeclared");
  });

  it("선언한 시계가 서로 다르면 red 다", () => {
    const value = evidence();
    value.transitions[0].trace.clocks.presentation = "media-time";
    const verdict = judgeB05MachineEvidence(value);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.some((row) => row.includes("clocks=one"))).toBe(true);
  });
});
