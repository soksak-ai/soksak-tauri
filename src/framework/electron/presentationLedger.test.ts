// 문서 안 게스트의 표시 원장 — **판정은 수치다.**
//
// 이 검사는 어댑터가 낸 원장을 B05 정본 판정기(scripts/e2e/lib/browser-gate-b05.mjs)에 그대로
// 먹인다. 모양을 여기서 다시 적으면 판정기가 바뀌는 날 두 기준이 갈리고, 갈린 쪽은 조용하다.
// 자극·배치·정착은 하니스가 만드는 사실이라 여기서는 합성하되, **trace 쪽 전부는 실제 어댑터가
// 낸 값**이다 — 그 축이 이 유닛의 것이다.
import { beforeEach, describe, expect, it } from "vitest";
import { judgeB05MachineEvidence } from "../../../scripts/e2e/lib/browser-gate-b05.mjs";
import { mapB05LiveEvidence } from "../../../scripts/e2e/lib/browser-gate-b05-evidence.mjs";
import { presentationUnixMsFromDocumentTime } from "../../lib/presentationClock";
import {
  __resetContentViewSurfacesForTest,
  createDomPresentationLedger,
  domPresentationOwners,
  noteContentViewSurface,
} from "./presentationLedger";
import type { DisplayFrameSource } from "./presentationLedger";
import type { PresentationTraceReceipt } from "../presentationLedger";

const WINDOW_LABEL = "w-1";
const REFRESH_MS = 1000 / 60;
const VIEW_IDS = ["tab-left", "tab-right"] as const;
const label = (viewId: string) => `b-${WINDOW_LABEL}-${viewId}`;

interface Placed {
  slot: HTMLElement;
  guest: HTMLElement;
}

/** 공개 DOM 선언 그대로 — pane · view host · 콘텐츠 자리 · 게스트. */
function placeView(viewId: string, x: number): Placed {
  const pane = document.createElement("div");
  pane.setAttribute("data-pane", `pan-${viewId}`);
  const host = document.createElement("div");
  host.setAttribute("data-tab-id", viewId);
  host.setAttribute("data-view-addr", `addr/${viewId}`);
  const slot = document.createElement("div");
  slot.setAttribute("data-content-view-body", label(viewId));
  const guest = document.createElement("webview");
  guest.setAttribute("data-content-view", label(viewId));
  slot.append(guest);
  host.append(slot);
  pane.append(host);
  document.body.append(pane);
  setFrame(slot, x);
  // 게스트는 자리를 채운다(inset:0). 서브픽셀 반올림 말고는 자리와 같은 사각형이다.
  setFrame(guest, x + 0.25);
  noteContentViewSurface(label(viewId), guest);
  guest.dispatchEvent(new Event("dom-ready"));
  return { slot, guest };
}

function setFrame(element: HTMLElement, x: number): void {
  element.getBoundingClientRect = () => ({
    x, y: 40, width: 600, height: 480, top: 40, left: x, right: x + 600, bottom: 520,
    toJSON: () => ({}),
  }) as DOMRect;
}

/** 손으로 미는 프레임 콜백 — 합성기 자리에 서서 표시 시각만 준다. */
function fakeFrames() {
  const listeners = new Set<(documentTimeMs: number) => void>();
  return {
    source: {
      subscribe(onFrame) {
        listeners.add(onFrame);
        return () => listeners.delete(onFrame);
      },
      refreshIntervalMs: async () => REFRESH_MS,
    } satisfies DisplayFrameSource,
    emit(documentTimeMs: number) {
      for (const listener of [...listeners]) listener(documentTimeMs);
    },
    /** 무장이 표시 원천을 실제로 구독한 뒤에만 프레임을 민다 — 구독 전 emit 은 관측 밖이다. */
    async subscribed() {
      for (let turn = 0; turn < 100 && listeners.size === 0; turn += 1) await Promise.resolve();
      if (listeners.size === 0) throw new Error("무장이 표시 원천을 구독하지 않았다");
    },
    get subscribers() {
      return listeners.size;
    },
  };
}

async function runTrace(
  direction: "to-left" | "to-right",
  frameCount = 6,
): Promise<{ receipt: PresentationTraceReceipt; frames: ReturnType<typeof fakeFrames> }> {
  const frames = fakeFrames();
  const ledger = createDomPresentationLedger({
    source: frames.source,
    windowLabel: () => WINDOW_LABEL,
  });
  const owners = domPresentationOwners(WINDOW_LABEL).map(({ viewId, hostId, surfaceId }) => ({
    viewId, hostId, surfaceId,
  }));
  const start = performance.now() + REFRESH_MS;
  const armed = ledger.arm({ traceId: `t-${direction}`, owners, maxEvents: 64 });
  await frames.subscribed();
  frames.emit(start);
  await armed;
  for (let index = 1; index < frameCount; index += 1) {
    frames.emit(start + index * REFRESH_MS);
  }
  const receipt = await ledger.close({ traceId: `t-${direction}` });
  return { receipt, frames };
}

/**
 * 하니스가 만드는 사실만 합성한다. 자극은 baseline 다음 프레임, 배치 거래는 그 자극이 연
 * 것이며, 정착은 마지막 표시 프레임이다 — 원장의 실제 epoch 위에 세운다.
 */
function transitionFrom(
  direction: "to-left" | "to-right",
  receipt: PresentationTraceReceipt,
) {
  const events = receipt.presentationEvents;
  const baseline = events[0];
  const settledEvent = events[events.length - 1];
  const stimulusAt = baseline.presentedAtUnixMs + REFRESH_MS / 2;
  const targetViewId = receipt.ownerViewIds[direction === "to-left" ? 0 : 1];
  return {
    direction,
    targetViewId,
    presentation: receipt,
    clickReceipt: { address: `addr/${targetViewId}`, atUnixMs: stimulusAt },
    layout: {
      transactionId: `lt-${direction}`,
      causeTraceId: receipt.traceId,
      phase: "committed",
      mode: "glide",
      startAtUnixMs: stimulusAt + 1,
      preparedAtUnixMs: stimulusAt + 1,
      closedAtUnixMs: settledEvent.presentedAtUnixMs,
      moves: [{ viewId: targetViewId, dx: -240 }],
    },
    settlement: {
      settled: {
        atUnixMs: settledEvent.presentedAtUnixMs,
        frameSequence: settledEvent.sequence,
        syncPending: false,
      },
      hold: {
        startedAtUnixMs: settledEvent.presentedAtUnixMs,
        endedAtUnixMs: settledEvent.presentedAtUnixMs + 250,
        surfaces: settledEvent.surfaces,
      },
    },
  };
}

describe("Electron 표시 원장", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    __resetContentViewSurfacesForTest();
    placeView(VIEW_IDS[0], 0);
    placeView(VIEW_IDS[1], 620);
  });

  it("공개 DOM 선언에서 owner 를 읽는다 — label 문자열을 뜯지 않는다", () => {
    expect(domPresentationOwners(WINDOW_LABEL)).toEqual([
      {
        viewId: "tab-left",
        window: WINDOW_LABEL,
        logicalPaneId: "pan-tab-left",
        rendererId: "addr/tab-left",
        hostId: label("tab-left"),
        surfaceId: label("tab-left"),
      },
      {
        viewId: "tab-right",
        window: WINDOW_LABEL,
        logicalPaneId: "pan-tab-right",
        rendererId: "addr/tab-right",
        hostId: label("tab-right"),
        surfaceId: label("tab-right"),
      },
    ]);
  });

  it("무장은 첫 실제 표시 사건 뒤에 끝나고, 닫으면 관측이 멈춘다", async () => {
    const { receipt, frames } = await runTrace("to-left");
    expect(receipt.closed).toBe(true);
    expect(receipt.baselineFrameSequence).toBe(0);
    expect(receipt.presentationEvents).toHaveLength(6);
    expect(frames.subscribers).toBe(0);
  });

  it("어댑터가 낸 원장이 B05 정본 판정기를 통과한다", async () => {
    const left = await runTrace("to-left");
    const right = await runTrace("to-right");
    const verdict = judgeB05MachineEvidence(mapB05LiveEvidence({
      engine: "browser",
      transitions: [
        transitionFrom("to-left", left.receipt),
        transitionFrom("to-right", right.receipt),
      ],
    }));
    expect(verdict.evidence).toEqual([
      "browser/B05:actual-presentation-events;stable-surface;rounding-only;hold=250ms",
    ]);
    expect(verdict.status).toBe("green");
  });

  // 오라클 생존 — 판정기가 죽어 있으면 위 GREEN 은 공짜다. 자리와 표면이 반올림보다 크게
  // 벌어진 원장은 같은 판정기가 RED 로 답해야 한다.
  it("자리에서 벗어난 표면은 같은 판정기가 RED 로 답한다", async () => {
    const left = await runTrace("to-left");
    const right = await runTrace("to-right");
    const drifted = structuredClone(left.receipt) as PresentationTraceReceipt;
    drifted.presentationEvents[2].surfaces[0].surfaceFrame.x += 4;
    const verdict = judgeB05MachineEvidence(mapB05LiveEvidence({
      engine: "browser",
      transitions: [
        transitionFrom("to-left", drifted),
        transitionFrom("to-right", right.receipt),
      ],
    }));
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toEqual([
      "B05:transitions[0].trace.presentationEvents[2].surfaces[0].x.delta<=1/4.25",
    ]);
  });

  it("건너뛴 표시 프레임은 gaps 로 센다 — 0 으로 두면 영원히 안 보인다", async () => {
    const frames = fakeFrames();
    const ledger = createDomPresentationLedger({
      source: frames.source,
      windowLabel: () => WINDOW_LABEL,
    });
    const owners = domPresentationOwners(WINDOW_LABEL).map(({ viewId, hostId, surfaceId }) => ({
      viewId, hostId, surfaceId,
    }));
    const start = performance.now() + REFRESH_MS;
    const armed = ledger.arm({ traceId: "t-gap", owners });
    await frames.subscribed();
    frames.emit(start);
    await armed;
    // 두 주기를 건너뛴 프레임 — 표시가 한 번 빠졌다는 뜻이다.
    frames.emit(start + REFRESH_MS * 3);
    // 역행 프레임은 원장에 실리지 않고 버린 사건으로 센다.
    frames.emit(start + REFRESH_MS);
    const receipt = await ledger.close({ traceId: "t-gap" });
    expect(receipt.violations).toEqual({
      replacements: 0, gaps: 2, disappearances: 0, unpresented: 0, droppedEvents: 1,
    });
    expect(receipt.presentationEvents).toHaveLength(2);
  });

  it("게스트가 죽으면 그 프레임은 unpresented 로 남는다", async () => {
    const frames = fakeFrames();
    const ledger = createDomPresentationLedger({
      source: frames.source,
      windowLabel: () => WINDOW_LABEL,
    });
    const owners = domPresentationOwners(WINDOW_LABEL).map(({ viewId, hostId, surfaceId }) => ({
      viewId, hostId, surfaceId,
    }));
    const start = performance.now() + REFRESH_MS;
    const armed = ledger.arm({ traceId: "t-dead", owners });
    await frames.subscribed();
    frames.emit(start);
    await armed;
    document.querySelector(`[data-content-view="${label("tab-left")}"]`)!
      .dispatchEvent(new Event("crashed"));
    frames.emit(start + REFRESH_MS);
    const receipt = await ledger.close({ traceId: "t-dead" });
    expect(receipt.violations.unpresented).toBe(1);
    expect(receipt.presentationEvents[1].surfaces[0].painted).toBe(false);
    expect(receipt.presentationEvents[0].surfaces[0].painted).toBe(true);
  });

  it("선언한 binding 이 공개 DOM 과 다르면 무장 자체를 거절한다", async () => {
    const frames = fakeFrames();
    const ledger = createDomPresentationLedger({
      source: frames.source,
      windowLabel: () => WINDOW_LABEL,
    });
    await expect(ledger.arm({
      traceId: "t-bad",
      owners: [{ viewId: "tab-left", hostId: "남의-자리", surfaceId: label("tab-left") }],
    })).rejects.toThrow(/binding/);
  });

  it("표시 주기를 못 읽으면 원장을 열지 않는다 — 60 을 채우지 않는다", async () => {
    const frames = fakeFrames();
    const ledger = createDomPresentationLedger({
      source: { ...frames.source, refreshIntervalMs: async () => Number.NaN },
      windowLabel: () => WINDOW_LABEL,
    });
    const owners = domPresentationOwners(WINDOW_LABEL).map(({ viewId, hostId, surfaceId }) => ({
      viewId, hostId, surfaceId,
    }));
    await expect(ledger.arm({ traceId: "t-norefresh", owners }))
      .rejects.toThrow(/표시 주기/);
  });

  it("무장 이전 프레임은 이 거래의 것이 아니다", async () => {
    const frames = fakeFrames();
    const ledger = createDomPresentationLedger({
      source: frames.source,
      windowLabel: () => WINDOW_LABEL,
    });
    const owners = domPresentationOwners(WINDOW_LABEL).map(({ viewId, hostId, surfaceId }) => ({
      viewId, hostId, surfaceId,
    }));
    const armed = ledger.arm({ traceId: "t-old", owners });
    await frames.subscribed();
    // 무장 시각보다 이른 표시 — 옛 화면을 기준선이라 부르면 안 된다.
    frames.emit(performance.now() - 100);
    const start = performance.now() + REFRESH_MS;
    frames.emit(start);
    const receiptPromise = armed.then(() => ledger.close({ traceId: "t-old" }));
    const receipt = await receiptPromise;
    expect(receipt.presentationEvents).toHaveLength(1);
    expect(receipt.presentationEvents[0].presentedAtUnixMs)
      .toBe(presentationUnixMsFromDocumentTime(start));
  });
});
