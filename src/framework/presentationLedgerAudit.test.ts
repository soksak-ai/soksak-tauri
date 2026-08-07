// 자가감사 RED — **한 구현이 안 세는 축은 0 으로 답한다.**
//
// 픽스처는 지어낸 값이 아니다. 실제 원장(~/.soksak-e2e/evidence/slot-freeze/**/native-presentation-raw.json)
// 에서 관측된 모양 두 가지다:
//   (1) 8.333ms 주기에서 20.83ms 떨어진 프레임 쌍 — 표시 하나를 건너뛴 실측 프레임
//   (2) 그 원장이 신고한 violations.gaps=0
// 이 둘이 한 영수증에 같이 있으면 그 0 은 사실이 아니라 침묵이다.
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_AUDITABLE_VIOLATIONS,
  auditPresentationReceipt,
  presentationEventsToCover,
  recomputePresentationViolations,
} from "./presentationLedgerAudit";
import {
  __resetPresentationLedgerForTest,
  registerPresentationLedgerHost,
} from "./presentationLedger";
import { PRESENTATION_CLOCK } from "../lib/presentationClock";
import { getSpec } from "../commands/registry";
import type { CommandContext } from "../commands/registry";
import type {
  PresentationDisplayEvent,
  PresentationTraceReceipt,
  PresentationViolations,
} from "./presentationLedger";

const REFRESH_120HZ = 8.333251953125;
const REFRESH_60HZ = 16.680419921875;

function surface(overrides: Record<string, unknown> = {}) {
  return {
    viewId: "tab-k6jivs",
    surfaceId: "b-main-tab-k6jivs",
    generation: 1,
    live: true,
    visible: true,
    painted: true,
    domFrame: { x: 0, y: 0, w: 640, h: 480 },
    surfaceFrame: { x: 0, y: 0, w: 640, h: 480 },
    ...overrides,
  } as PresentationDisplayEvent["surfaces"][number];
}

/** 표시 epoch 를 실제 원장처럼 주기 배수로 놓는다. `steps` 는 직전 프레임에서 흐른 주기 수다. */
function ledger(steps: readonly number[], refreshIntervalMs = REFRESH_120HZ) {
  const events: PresentationDisplayEvent[] = [];
  let displayedAt = 1_786_084_035_298.228;
  steps.forEach((step, index) => {
    if (index > 0) displayedAt += refreshIntervalMs * step;
    events.push({
      sequence: index,
      sourceGeneration: 1,
      presentationRevision: index + 1,
      displayTimestampUnixMs: displayedAt,
      targetTimestampUnixMs: displayedAt + refreshIntervalMs,
      callbackObservedAtUnixMs: displayedAt + 0.4,
      refreshIntervalMs,
      presentedAtUnixMs: displayedAt,
      surfaces: [surface()],
    });
  });
  return events;
}

function receipt(
  presentationEvents: PresentationDisplayEvent[],
  violations: Partial<PresentationViolations> = {},
): Pick<PresentationTraceReceipt, "clock" | "presentationEvents" | "violations"> {
  return {
    clock: PRESENTATION_CLOCK,
    presentationEvents,
    violations: {
      replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0, ...violations,
    },
  };
}

describe("표시 원장 자가감사", () => {
  it("건너뛴 표시 epoch 를 0 으로 신고한 영수증을 이름으로 낸다", () => {
    // 실측 모양: 8.333ms 주기 열 안에 20.832ms 떨어진 쌍 하나(=표시 하나 건너뜀), 신고는 gaps=0.
    const audit = auditPresentationReceipt(receipt(ledger([1, 1, 1, 2.5, 1, 1])));
    expect(audit.errors).toEqual(["violations.gaps=1/0"]);
    expect(audit.underReported).toEqual([{ violation: "gaps", declared: 0, recomputed: 1 }]);
    expect(audit.ok).toBe(false);
  });

  it("건너뜀을 실제로 센 영수증은 통과한다", () => {
    const audit = auditPresentationReceipt(receipt(ledger([1, 1, 1, 2.5, 1, 1]), { gaps: 1 }));
    expect(audit).toEqual({ ok: true, underReported: [], errors: [] });
  });

  it("고른 표시 열에서는 어떤 축도 덜 세지 않았다고 답한다", () => {
    const audit = auditPresentationReceipt(receipt(ledger([1, 1, 1, 1, 1, 1], REFRESH_60HZ)));
    expect(audit).toEqual({ ok: true, underReported: [], errors: [] });
  });

  it("관측 지연은 표시 건너뜀이 아니다 — callback 이 늦게 와도 표시 epoch 가 고르면 gaps 는 0 이다", () => {
    // B04 가 display-gap 으로 부르던 값(29.75/16.69)의 실제 정체. 표시 epoch 는 한 주기 그대로다.
    const events = ledger([1, 1, 1, 1, 1, 1], REFRESH_60HZ);
    events[3].callbackObservedAtUnixMs = events[2].callbackObservedAtUnixMs + 29.75;
    expect(recomputePresentationViolations(events).gaps).toBe(0);
    expect(auditPresentationReceipt(receipt(events)).ok).toBe(true);
  });

  it("가변 주사율에서 주기가 바뀐 프레임을 건너뜀으로 읽지 않는다", () => {
    // 120Hz 프레임 뒤 60Hz 프레임: 실제 간격 16.68ms 는 직전 프레임이 선언한 다음 표시 시각이다.
    const events = ledger([1, 1, 1], REFRESH_120HZ);
    const pivot = events[1];
    pivot.refreshIntervalMs = REFRESH_60HZ;
    pivot.targetTimestampUnixMs = pivot.displayTimestampUnixMs + REFRESH_60HZ;
    events[2].displayTimestampUnixMs = pivot.targetTimestampUnixMs;
    events[2].presentedAtUnixMs = events[2].displayTimestampUnixMs;
    expect(recomputePresentationViolations(events).gaps).toBe(0);
  });

  it("사라짐·미표시·교체도 자기 사건에서 되찾는다", () => {
    const events = ledger([1, 1, 1]);
    // 안 보이는 표면은 사라짐이지 교체가 아니다 — 신원(surfaceId·generation)이 그대로다.
    events[1].surfaces = [surface({ visible: false })];
    events[2].surfaces = [surface({ painted: false, generation: 2 })];
    expect(recomputePresentationViolations(events)).toEqual({
      replacements: 1, gaps: 0, disappearances: 1, unpresented: 1,
    });
    expect(auditPresentationReceipt(receipt(events)).errors).toEqual([
      "violations.replacements=1/0",
      "violations.disappearances=1/0",
      "violations.unpresented=1/0",
    ]);
  });

  it("기록되지 못한 사실 때문에 신고가 더 큰 것은 결함이 아니다", () => {
    const audit = auditPresentationReceipt(
      receipt(ledger([1, 1, 1]), { disappearances: 3, unpresented: 3, droppedEvents: 135 }),
    );
    expect(audit.ok).toBe(true);
  });

  it("수가 아닌 위반 축은 이름으로 거절한다", () => {
    const broken = receipt(ledger([1, 1, 1]));
    (broken.violations as unknown as Record<string, unknown>).gaps = null;
    expect(auditPresentationReceipt(broken).errors).toEqual(["violations.gaps=integer/null"]);
  });

  it("되찾을 수 있는 축에 droppedEvents 는 없다 — 실린 적 없는 사건은 되찾지 못한다", () => {
    expect(PRESENTATION_AUDITABLE_VIOLATIONS).not.toContain("droppedEvents");
  });
});

describe("close 가 감사를 싣는다", () => {
  it("영수증에 selfAudit 이 실려 온다 — 부르는 쪽이 안 물어도 사실이 간다", async () => {
    __resetPresentationLedgerForTest();
    const events = ledger([1, 1, 1, 2.5, 1, 1]);
    registerPresentationLedgerHost({
      owners: async () => [],
      arm: async () => ({
        traceId: "t-1", clock: PRESENTATION_CLOCK, ownerViewIds: ["tab-k6jivs"], armedAtUnixMs: 0,
        baselineFrameSequence: 0, sourceGeneration: 1,
      }),
      close: async ({ traceId }) => ({
        traceId,
        clock: PRESENTATION_CLOCK,
        closed: true,
        ownerViewIds: ["tab-k6jivs"],
        armedAtUnixMs: 0,
        baselineFrameSequence: 0,
        presentationEvents: events,
        violations: {
          replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0,
        },
        observation: { callbackIntervalsSkipped: 1, maxCallbackLatencyMs: 0 },
      }),
    });
    const spec = getSpec("view.presentation.trace.close");
    expect(spec).toBeTruthy();
    const closed = await spec!.handler({ traceId: "t-1" }, {} as CommandContext) as {
      selfAudit: { ok: boolean; errors: string[] };
    };
    expect(closed.selfAudit).toEqual({
      ok: false,
      underReported: [{ violation: "gaps", declared: 0, recomputed: 1 }],
      errors: ["violations.gaps=1/0"],
    });
    __resetPresentationLedgerForTest();
  });
});

describe("표시 창을 덮는 용량", () => {
  it("같은 창이 주사율마다 다른 수를 요구한다", () => {
    // 하니스가 선언한 창(정착 8s + 유지 310ms)을 덮는 데 필요한 수. 512 는 60Hz 에서만 맞다.
    expect(presentationEventsToCover({ coverMs: 8_310, refreshIntervalMs: REFRESH_60HZ })).toBe(500);
    expect(presentationEventsToCover({ coverMs: 8_310, refreshIntervalMs: REFRESH_120HZ })).toBe(999);
  });

  it("실측 손실을 되짚는다 — 512 는 120Hz 에서 4.27초를 못 덮는다", () => {
    // 실측: 궤적이 4270.8ms 열려 있었고 512 칸이 다 차서 실제 표시 프레임 135 개를 잃었다.
    expect(presentationEventsToCover({ coverMs: 4_270.8, refreshIntervalMs: REFRESH_120HZ }))
      .toBeGreaterThan(512);
  });

  it("창도 주기도 양수여야 한다", () => {
    expect(() => presentationEventsToCover({ coverMs: 0, refreshIntervalMs: REFRESH_60HZ }))
      .toThrow(/coverMs/);
    expect(() => presentationEventsToCover({ coverMs: 100, refreshIntervalMs: 0 }))
      .toThrow(/refreshIntervalMs/);
  });
});

// 규칙 — 시계 선언: `...UnixMs` 라는 이름은 같은 시계를 뜻하지 않는다. 원장을 낸 자가 자기
// 시계를 선언해야 다른 producer 의 시각과 한 축에서 비교할 수 있다. 선언 없는 원장은 판정
// 입력이 될 수 없고, 그 부재는 조용한 0 이 아니라 이름으로 나와야 한다.
describe("시계 선언", () => {
  it("시계를 선언 안 한 영수증은 감사에서 이름으로 걸린다", () => {
    const base = receipt(ledger([1, 1, 1]));
    const { clock: _clock, ...withoutClock } = base;
    const audit = auditPresentationReceipt(withoutClock as typeof base);
    expect(audit.ok).toBe(false);
    expect(audit.errors).toEqual(expect.arrayContaining(["clock=non-empty/undefined"]));
  });

  it("시계를 선언한 영수증은 그 축으로 걸리지 않는다", () => {
    const audit = auditPresentationReceipt(receipt(ledger([1, 1, 1])));
    expect(audit.errors.some((error) => error.startsWith("clock="))).toBe(false);
  });
});
