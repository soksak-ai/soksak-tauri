// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB11MachineEvidence } from "./browser-gates.mjs";
import { mapB11TabEvidence } from "./browser-gate-b11-evidence.mjs";
import { B11_PANE_STAGES, B11_PANE_STAGE_KEYS } from "./browser-gate-b11.mjs";

const engine = "browser";

// 하니스가 실제로 들고 있는 모양 그대로다 — mapper가 따로 받아 주는 모양을 지어내면
// fixture만 green이 되고 실측은 null로 남는다.
function harnessTab(index) {
  const viewId = `view-${index}`;
  const requestedPath = `/evidence/full-${index}.png`;
  const sign = index === 0 ? 1 : -1;
  const page = {
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 640,
    viewportHeight: 480,
    documentWidth: 640,
    documentHeight: 1600,
  };
  const paneStage = (settledAtUnixMs, dx) => {
    const paneX = index * 660 + (index === 0 ? 0 : dx);
    const paneWidth = 660 + sign * dx;
    return {
      settledAtUnixMs,
      paneX,
      paneWidth,
      surfaceX: paneX + 8,
      surfaceWidth: paneWidth - 16,
      viewportWidth: 640 + sign * dx,
    };
  };
  return {
    viewId,
    scroll: {
      beforeY: 0,
      afterY: 480,
      restoredY: 0,
      requestedDy: [480, -480],
      settledAtUnixMs: 1_000,
      ledger: {
        before: { scrollSeq: 0, wheelEvents: 0, wheelDeltaY: 0 },
        after: { scrollSeq: 5, wheelEvents: 3, wheelDeltaY: 480 },
        restored: { scrollSeq: 9, wheelEvents: 6, wheelDeltaY: 0 },
      },
    },
    fullCapture: {
      requestedPath,
      returnedPath: requestedPath,
      reportedBytes: 4096,
      fileBytes: 4096,
      width: 640,
      height: 1600,
      capturedWidth: 1280,
      capturedHeight: 3200,
      viewId,
      before: page,
      after: page,
    },
    paneResize: {
      paneId: `pane-${index}`,
      side: index === 0 ? "left" : "right",
      requestedDx: 80,
      stages: {
        baseline: paneStage(2_000, 0),
        wider: paneStage(3_000, 80),
        restored: paneStage(4_000, 0),
      },
    },
  };
}

describe("B11 live evidence mapper", () => {
  it("휠 사건·산출물 실측·pane 왕복을 판정 봉투로 옮긴다", () => {
    const tabs = [0, 1].map((index) => mapB11TabEvidence(harnessTab(index)));
    expect(judgeB11MachineEvidence({ engine, tabs }).status).toBe("green");
    expect(tabs[0].capture.receipt.capturedHeight).toBe(3200);
    expect(tabs[1].paneResize.side).toBe("right");
    // 축 목록은 판정이 소유한다 — mapper가 손으로 다시 나열하면 하나가 빠진다.
    for (const name of B11_PANE_STAGES) {
      expect(Object.keys(tabs[0].paneResize.stages[name])).toEqual([...B11_PANE_STAGE_KEYS]);
    }
  });

  it("공개 응답에 없는 축을 0으로 채우지 않는다", () => {
    const tab = mapB11TabEvidence({ viewId: "view-0" });
    expect(tab.capture.receipt.capturedWidth).toBeNull();
    expect(tab.wheel.settledAtUnixMs).toBeNull();
    expect(tab.wheel.ledger.after.wheelEvents).toBeNull();
    expect(tab.paneResize.requestedDx).toBeNull();
    expect(tab.paneResize.stages.baseline.paneWidth).toBeNull();
    expect(judgeB11MachineEvidence({
      engine,
      tabs: [tab, mapB11TabEvidence({ viewId: "view-1" })],
    }).status).toBe("red");
  });

  it("요청값을 관측값으로 승격하지 않는다", () => {
    const source = harnessTab(0);
    // pane이 제자리에 있어도 요청 dx는 그대로 남는다 — 요청과 관측은 다른 자리에 산다.
    source.paneResize.stages.wider = source.paneResize.stages.baseline;
    const tab = mapB11TabEvidence(source);
    expect(tab.paneResize.requestedDx).toBe(80);
    expect(tab.paneResize.stages.wider.paneWidth).toBe(tab.paneResize.stages.baseline.paneWidth);
  });

  it("green 경로에서는 배선 장부가 깨끗하다", () => {
    expect(mapB11TabEvidence(harnessTab(0)).evidenceWiring).toEqual({
      source: "B11.tab",
      unconsumed: [],
      unproduced: [],
      error: null,
    });
  });

  it("어긋난 인계 필드를 양쪽 이름으로 부른다", () => {
    const value = harnessTab(0);
    value.capture = value.fullCapture;
    delete value.fullCapture;
    const tab = mapB11TabEvidence(value);
    expect(tab.evidenceWiring).toEqual({
      source: "B11.tab",
      unconsumed: ["capture"],
      unproduced: ["fullCapture"],
      error: null,
    });
    const verdict = judgeB11MachineEvidence({ engine, tabs: [tab, mapB11TabEvidence(harnessTab(1))] });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B11:wiring.B11.tab.capture=produced-not-consumed");
    expect(verdict.evidence).toContain("B11:wiring.B11.tab.fullCapture=consumed-not-produced");
  });

  it("pane 인계 기록이 이름을 갈면 그 이름이 판정에 실린다", () => {
    // pane resize 반쪽도 같은 인계 기록이다 — 이름이 갈리면 세 stage가 조용히 null이 된다.
    const value = harnessTab(0);
    value.pane = value.paneResize;
    delete value.paneResize;
    const tab = mapB11TabEvidence(value);
    const verdict = judgeB11MachineEvidence({ engine, tabs: [tab, mapB11TabEvidence(harnessTab(1))] });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B11:wiring.B11.tab.pane=produced-not-consumed");
    expect(verdict.evidence).toContain("B11:wiring.B11.tab.paneResize=consumed-not-produced");
  });

  it("던지는 인계 필드가 하니스를 죽이지 않는다", () => {
    const value = harnessTab(0);
    Object.defineProperty(value, "scroll", {
      enumerable: true,
      get() {
        throw new TypeError("wheel receipt read failed");
      },
    });
    let verdict;
    expect(() => {
      verdict = judgeB11MachineEvidence({
        engine,
        tabs: [mapB11TabEvidence(value), mapB11TabEvidence(harnessTab(1))],
      });
    }).not.toThrow();
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      'B11:wiring.B11.tab=mapper-threw/"TypeError: wheel receipt read failed"',
    );
  });
});
