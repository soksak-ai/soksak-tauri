import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSurfaceInvariantLedger,
  surfaceInvariantVerdict,
} from "./surface-invariant.mjs";

// RED 근거(실측 2026-08-07 · tauri/darwin): browser-chromium-offscreen 11칸이 전부 blocked,
// 사유는 한 문장이다 —
//   `sentinel-created: view→surface→engine 불일치 — ledger=[]/mapped=[4]`.
// 앱은 답했다. 창도 명령도 살아 있었고 stats 봉투에 그 모순이 실려 왔다. 답한 위반은 계약
// 사실이지 측정 불가가 아니다 — 던지면 그 사실은 이름 없이 사라지고 남은 칸까지 통째로 닫힌다.

describe("browser surface invariant verdict", () => {
  it("names an answered mismatch as a contract violation", () => {
    const verdict = surfaceInvariantVerdict({
      stage: "sentinel-created",
      windowLabel: "w-sentinel",
      verdict: { ok: false, errors: ["ledger=[]/mapped=[4]"], mappedIds: [4] },
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.violation).toContain("sentinel-created@w-sentinel");
    expect(verdict.violation).toContain("view→surface→engine 불일치");
    expect(verdict.violation).toContain("ledger=[]/mapped=[4]");
    expect(verdict.errors).toEqual(["ledger=[]/mapped=[4]"]);
  });

  it("keeps every named error the invariant answered", () => {
    const verdict = surfaceInvariantVerdict({
      stage: "final-ledger",
      verdict: {
        ok: false,
        errors: ["tab-a:mapping-missing", "owned-live=[7]/mapped=[]"],
        mappedIds: [],
      },
    });
    expect(verdict.violation).toContain("tab-a:mapping-missing");
    expect(verdict.violation).toContain("owned-live=[7]/mapped=[]");
  });

  it("accepts a consistent answer without inventing a violation", () => {
    const verdict = surfaceInvariantVerdict({
      stage: "first-paint-ledger",
      windowLabel: "w-fixture",
      verdict: { ok: true, errors: [], mappedIds: [4, 9] },
    });
    expect(verdict.consistent).toBe(true);
    expect(verdict.violation).toBeNull();
  });

  it("refuses an answer that is not an invariant verdict", () => {
    expect(() => surfaceInvariantVerdict({ stage: "x", verdict: null })).toThrow(TypeError);
    expect(() => surfaceInvariantVerdict({ stage: "x", verdict: { ok: false } })).toThrow(TypeError);
  });
});

describe("browser surface invariant ledger", () => {
  it("separates never-measured from measured-and-consistent", () => {
    const ledger = createSurfaceInvariantLedger();
    expect(ledger.measured()).toBe(0);
    ledger.record(surfaceInvariantVerdict({
      stage: "final-ledger", verdict: { ok: true, errors: [], mappedIds: [4] },
    }));
    expect(ledger.measured()).toBe(1);
    expect(ledger.violations()).toEqual([]);
  });

  it("holds the run open for every other cell and still ends the engine RED", () => {
    const ledger = createSurfaceInvariantLedger();
    ledger.record(surfaceInvariantVerdict({
      stage: "sentinel-created",
      windowLabel: "w-sentinel",
      verdict: { ok: false, errors: ["ledger=[]/mapped=[4]"], mappedIds: [4] },
    }));
    expect(ledger.violations()).toHaveLength(1);
    expect(() => ledger.assertConsistent("browser-chromium-offscreen"))
      .toThrow(/browser-chromium-offscreen.*sentinel-created@w-sentinel/s);
  });

  it("forgets the previous engine's violations when the next engine starts", () => {
    const ledger = createSurfaceInvariantLedger();
    ledger.record(surfaceInvariantVerdict({
      stage: "sentinel-created", verdict: { ok: false, errors: ["ledger=[]/mapped=[4]"] },
    }));
    ledger.reset();
    expect(ledger.measured()).toBe(0);
    expect(ledger.violations()).toEqual([]);
    expect(() => ledger.assertConsistent("browser")).not.toThrow();
  });

  it("refuses a verdict that is not one", () => {
    const ledger = createSurfaceInvariantLedger();
    expect(() => ledger.record({ stage: "x" })).toThrow(TypeError);
  });
});

describe("the run records the invariant instead of throwing it", () => {
  const run = readFileSync(resolve(import.meta.dirname, "../slot-freeze.mjs"), "utf8");

  it("does not end the engine run where the invariant answers a mismatch", () => {
    // 한 단계의 불일치가 남은 칸의 측정을 막으면 그 엔진은 blocked 로 닫힌다 — 그것이
    // browser-chromium-offscreen 11칸을 삼킨 자리다.
    expect(run).not.toContain("throw new Error(`${stage}: view→surface→엔진");
    expect(run).not.toMatch(/if \(!verdict\.ok\) throw new Error\(`\$\{stage\}: view→surface→engine/);
    expect(run).toContain("SURFACE_INVARIANT.record(surfaceInvariantVerdict(");
  });

  it("judges the recorded invariant after every cell has been measured", () => {
    expect(run).toContain("SURFACE_INVARIANT.reset();");
    expect(run).toContain("SURFACE_INVARIANT.assertConsistent(engine);");
  });
});
