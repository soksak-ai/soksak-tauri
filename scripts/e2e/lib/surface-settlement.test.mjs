import { describe, expect, it } from "vitest";
import {
  createSurfaceSettlementLedger,
  surfaceSettlementVerdict,
} from "./surface-settlement.mjs";

// RED 근거(실측 2026-08-07 · buildId=2ebb2eb4, framework=tauri/darwin): browser-chromium-offscreen
// 11칸이 전부 blocked, 사유는 한 문장이다 —
//   `sentinel-created settle tab-jmdj4s 실패: {"code":"TIMEOUT","message":"surface 12 actual presentation timeout"}`.
// 앱은 답했다. 창도 명령도 살아 있었고 봉투에 코드까지 실려 왔다. 답한 실패는 계약 사실이지
// 측정 불가가 아니다 — 던지면 그 사실은 이름 없이 사라지고 남은 칸까지 통째로 닫힌다.

describe("offscreen surface settlement verdict", () => {
  it("names an answered failure as a contract violation, not as an absent measurement", () => {
    const verdict = surfaceSettlementVerdict({
      stage: "sentinel-created",
      viewId: "tab-jmdj4s",
      reply: { ok: false, code: "TIMEOUT", message: "surface 12 actual presentation timeout" },
    });
    expect(verdict.answered).toBe(true);
    expect(verdict.settled).toBe(false);
    expect(verdict.reason).toBeNull();
    expect(verdict.violation).toContain("sentinel-created settle tab-jmdj4s");
    expect(verdict.violation).toContain("TIMEOUT");
    expect(verdict.violation).toContain("surface 12 actual presentation timeout");
  });

  it("carries the engine facts the answer brought so the violation names itself", () => {
    const verdict = surfaceSettlementVerdict({
      stage: "sentinel-created",
      viewId: "tab-jmdj4s",
      reply: {
        ok: false,
        code: "TIMEOUT",
        message: "surface 12 actual presentation timeout",
        // 엔진이 자기 표면에 대해 답한 사실. appliedBounds=null 은 "한 번도 프레임을 못 들었다"는
        // 뜻이고, 값이 있는데 정착하지 않은 것과 같은 값으로 표현될 수 없다.
        surface: { appliedBounds: null, presentation: null, hidden: false, painted: true },
      },
    });
    expect(verdict.violation).toContain("appliedBounds");
  });

  it("calls a missing answer unmeasurable and hands back the reason to throw", () => {
    const verdict = surfaceSettlementVerdict({
      stage: "first-paint-ledger",
      viewId: "tab-jmdj4s",
      reply: null,
    });
    expect(verdict.answered).toBe(false);
    expect(verdict.settled).toBe(false);
    expect(verdict.violation).toBeNull();
    expect(verdict.reason).toContain("first-paint-ledger settle tab-jmdj4s");
  });

  it("accepts an ok envelope as settled without inventing a violation", () => {
    const verdict = surfaceSettlementVerdict({
      stage: "final-ledger",
      viewId: "tab-jmdj4s",
      reply: { ok: true, surfaceId: 12, rect: { x: 0, y: 28, w: 574, h: 421 } },
    });
    expect(verdict.answered).toBe(true);
    expect(verdict.settled).toBe(true);
    expect(verdict.violation).toBeNull();
    expect(verdict.reason).toBeNull();
  });
});

describe("offscreen surface settlement ledger", () => {
  it("separates never-measured from measured-and-settled", () => {
    const ledger = createSurfaceSettlementLedger();
    expect(ledger.measured()).toBe(0);
    ledger.record(surfaceSettlementVerdict({
      stage: "final-ledger", viewId: "tab-a", reply: { ok: true },
    }));
    expect(ledger.measured()).toBe(1);
    expect(ledger.violations()).toEqual([]);
  });

  it("holds the run open for every other cell and still ends the engine RED", () => {
    const ledger = createSurfaceSettlementLedger();
    ledger.record(surfaceSettlementVerdict({
      stage: "sentinel-created",
      viewId: "tab-jmdj4s",
      reply: { ok: false, code: "TIMEOUT", message: "surface 12 actual presentation timeout" },
    }));
    expect(ledger.violations()).toHaveLength(1);
    expect(() => ledger.assertSettled("browser-chromium-offscreen"))
      .toThrow(/browser-chromium-offscreen.*sentinel-created settle tab-jmdj4s/s);
  });

  it("forgets the previous engine's violations when the next engine starts", () => {
    const ledger = createSurfaceSettlementLedger();
    ledger.record(surfaceSettlementVerdict({
      stage: "sentinel-created", viewId: "tab-a", reply: { ok: false, code: "TIMEOUT" },
    }));
    ledger.reset();
    expect(ledger.measured()).toBe(0);
    expect(ledger.violations()).toEqual([]);
    expect(() => ledger.assertSettled("browser")).not.toThrow();
  });

  it("refuses a verdict that is not one", () => {
    const ledger = createSurfaceSettlementLedger();
    expect(() => ledger.record({ stage: "x" })).toThrow(TypeError);
  });
});
