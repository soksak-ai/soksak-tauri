// 이 프레임워크의 표시 원장 — **문서 자신의 프레임 콜백이 곧 표시 사건이다.**
//
// 콘텐츠가 문서 안에 사는 프레임워크에는 따로 쫓아다닐 표면이 없다. 게스트는 자리의 자식이고,
// 자리와 게스트를 합성하는 것은 **하나의 합성기**다. 그러므로 그 합성기가 프레임을 낼 때
// 그 자리에서 두 rect 를 재면 그것이 그 표시 epoch 의 사실이다 — 좌표를 쓰는 추종 루프도,
// 표면을 감추는 베일도, 홀도 여기서는 만들지 않는다(그것은 콘텐츠가 문서 밖인 프레임워크가
// 자기 빚을 갚는 물건이고, 여기서 돌면 멀쩡한 판을 비운다).
//
// 표시 주기만은 문서가 모른다. 그것은 이 창이 놓인 디스플레이의 사실이라 프레임워크가 답한다.
// **못 읽으면 원장을 열지 않는다** — 60 을 채워 넣으면 건너뛴 프레임이 영원히 0 으로 보인다.
import { moduleState } from "../../lib/moduleState";
import {
  CONTENT_VIEW_BODY,
  contentViewSlotVisible,
  findContentViewSlot,
} from "../../lib/contentViews";
import {
  PRESENTATION_CLOCK,
  presentationNowUnixMs,
  presentationUnixMsFromDocumentTime,
} from "../../lib/presentationClock";
import {
  PRESENTATION_LEDGER_DEFAULT_EVENTS,
  type PresentationDisplayEvent,
  type PresentationLedgerHost,
  type PresentationOwner,
  type PresentationOwnerInventoryEntry,
  type PresentationRect,
  type PresentationSurfaceFrame,
  type PresentationTraceReceipt,
} from "../presentationLedger";

/** 첫 표시 사건을 기다리는 상한. 기다림은 끝나야 한다 — 안 오면 이름을 달고 실패한다. */
const FIRST_DISPLAY_TIMEOUT_MS = 1_000;

/** 공개 view identity 를 선언하는 앵커(viewHostAnchors) 와 배치 pane 앵커. */
const VIEW_ID_ATTR = "data-tab-id";
const VIEW_ADDR_ATTR = "data-view-addr";
const PANE_ATTR = "data-pane";

interface SurfaceInstance {
  element: HTMLElement;
  /** 이 label 자리에 선 실체의 세대. 실체가 갈리면 증가한다. */
  generation: number;
  /** 게스트가 자기 문서를 한 번이라도 커밋했는가. 죽으면 다시 거짓이 된다. */
  painted: boolean;
  release(): void;
}

const surfaces = moduleState(
  "framework/electron/presentationLedger#surfaces",
  () => ({ byLabel: new Map<string, SurfaceInstance>(), generation: 0 }),
);

/**
 * 게스트가 그렸는가 — **만들 때 건다.**
 *
 * `dom-ready` 는 한 번만 난다. 원장을 무장하는 시점에 구독하면 이미 지나간 그 사건을 영영 못
 * 듣고, 그러면 멀쩡히 그려진 표면이 "아직 안 그렸다"로 기록된다. 그래서 태그를 만드는 자리가
 * 곧바로 부른다(contentViews.open).
 */
export function noteContentViewSurface(label: string, element: HTMLElement): void {
  forgetContentViewSurface(label);
  surfaces.generation += 1;
  const instance: SurfaceInstance = {
    element,
    generation: surfaces.generation,
    painted: false,
    release: () => {},
  };
  const painted = () => { instance.painted = true; };
  // 렌더러가 죽으면 태그는 남고 픽셀만 사라진다. 그 자리를 painted 로 두면 빈 판이 원장에서
  // 정상으로 보인다 — 죽음도 사건이므로 그대로 받는다.
  const gone = () => { instance.painted = false; };
  element.addEventListener("dom-ready", painted);
  element.addEventListener("crashed", gone);
  element.addEventListener("destroyed", gone);
  element.addEventListener("render-process-gone", gone);
  instance.release = () => {
    element.removeEventListener("dom-ready", painted);
    element.removeEventListener("crashed", gone);
    element.removeEventListener("destroyed", gone);
    element.removeEventListener("render-process-gone", gone);
  };
  surfaces.byLabel.set(label, instance);
}

export function forgetContentViewSurface(label: string): void {
  const instance = surfaces.byLabel.get(label);
  if (!instance) return;
  instance.release();
  surfaces.byLabel.delete(label);
}

export function __resetContentViewSurfacesForTest(): void {
  for (const label of [...surfaces.byLabel.keys()]) forgetContentViewSurface(label);
  surfaces.generation = 0;
}

const rectOf = (element: Element): PresentationRect => {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
};

/**
 * 지금 원장을 걸 수 있는 owner 전부 — **공개 DOM 선언에서만 읽는다.**
 *
 * label 문자열을 뜯어 view 를 복원하지 않는다: 그 규칙이 곧 계약이 되고, 규칙이 바뀌는 날
 * 원장은 엉뚱한 owner 의 frame 을 그 view 의 것이라고 답한다. 자리(CONTENT_VIEW_BODY)는
 * 자기가 어느 view host 안에 있는지 DOM 으로 이미 선언한다.
 */
export function domPresentationOwners(
  windowLabel: string,
  doc: Document = document,
): PresentationOwnerInventoryEntry[] {
  const owners: PresentationOwnerInventoryEntry[] = [];
  for (const slot of doc.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)) {
    const surfaceId = slot.getAttribute(CONTENT_VIEW_BODY) ?? "";
    const viewHost = slot.closest<HTMLElement>(`[${VIEW_ID_ATTR}]`);
    const viewId = viewHost?.getAttribute(VIEW_ID_ATTR) ?? "";
    if (!surfaceId || !viewId) continue;
    owners.push({
      viewId,
      window: windowLabel,
      logicalPaneId: slot.closest<HTMLElement>(`[${PANE_ATTR}]`)?.getAttribute(PANE_ATTR) ?? null,
      rendererId: viewHost?.getAttribute(VIEW_ADDR_ATTR) ?? viewId,
      hostId: surfaceId,
      surfaceId,
    });
  }
  return owners;
}

/** 한 표시 epoch 의 표면 사실. 자리·표면·실체 중 하나라도 없으면 그 프레임은 사실이 아니다. */
function captureSurfaces(
  owners: readonly PresentationOwner[],
  doc: Document,
): PresentationSurfaceFrame[] {
  return owners.map((owner) => {
    const slot = findContentViewSlot(owner.hostId, doc);
    const instance = surfaces.byLabel.get(owner.surfaceId);
    if (!slot || !instance) {
      throw new Error(
        `표시 원장 owner 의 자리나 표면이 없습니다: view=${owner.viewId} host=${owner.hostId} surface=${owner.surfaceId}`,
      );
    }
    const element = instance.element;
    const style = doc.defaultView?.getComputedStyle(element);
    const surfaceFrame = rectOf(element);
    return {
      viewId: owner.viewId,
      surfaceId: owner.surfaceId,
      generation: instance.generation,
      live: element.isConnected && slot.isConnected,
      visible: style?.visibility !== "hidden"
        && contentViewSlotVisible(slot)
        && surfaceFrame.w > 0
        && surfaceFrame.h > 0,
      painted: instance.painted,
      domFrame: rectOf(slot),
      surfaceFrame,
    };
  });
}

const identityOf = (frames: readonly PresentationSurfaceFrame[]) =>
  frames.map((frame) => `${frame.viewId}|${frame.surfaceId}|${frame.generation}`)
    .sort()
    .join("\n");

/**
 * 표시 사건 원천 — 합성기의 프레임 콜백과 이 디스플레이의 표시 주기.
 *
 * 둘 다 이 모듈 밖의 사실이다. 프레임은 문서가 내고 주기는 프레임워크가 답한다.
 */
export interface DisplayFrameSource {
  /** 프레임마다 문서 시계의 표시 시각을 준다. 반환은 멱등 해지. */
  subscribe(onFrame: (documentTimeMs: number) => void): () => void;
  /** 이 창이 놓인 디스플레이의 표시 주기(ms). 못 읽으면 던진다. */
  refreshIntervalMs(): Promise<number>;
}

interface TraceState {
  traceId: string;
  owners: readonly PresentationOwner[];
  armedAtUnixMs: number;
  sourceGeneration: number;
  refreshIntervalMs: number;
  maxEvents: number;
  events: PresentationDisplayEvent[];
  nextRevision: number;
  baselineIdentity: string | null;
  lastCallbackObservedAtUnixMs: number | null;
  violations: PresentationTraceReceipt["violations"];
  observation: PresentationTraceReceipt["observation"];
  unsubscribe: () => void;
}

export function createDomPresentationLedger({
  source,
  windowLabel,
  doc = document,
}: {
  source: DisplayFrameSource;
  windowLabel: () => string;
  doc?: Document;
}): PresentationLedgerHost {
  const traces = new Map<string, TraceState>();
  let sourceGeneration = 0;

  const receiptOf = (trace: TraceState, closed: boolean): PresentationTraceReceipt => ({
    traceId: trace.traceId,
    clock: PRESENTATION_CLOCK,
    closed,
    ownerViewIds: trace.owners.map((owner) => owner.viewId),
    armedAtUnixMs: trace.armedAtUnixMs,
    baselineFrameSequence: 0,
    presentationEvents: trace.events,
    violations: { ...trace.violations },
    observation: { ...trace.observation },
  });

  return {
    async owners() {
      return domPresentationOwners(windowLabel(), doc);
    },

    async arm({ traceId, owners, maxEvents = PRESENTATION_LEDGER_DEFAULT_EVENTS }) {
      if (!traceId) throw new Error("표시 원장 traceId 가 비었습니다");
      if (traces.has(traceId)) throw new Error(`표시 원장 traceId 가 이미 열려 있습니다: ${traceId}`);
      // 선언된 binding 이 지금 DOM 의 사실과 맞는지 먼저 본다. 안 맞는 채로 열면 첫 프레임에서
      // 죽고, 그 실패는 "표시가 없었다"로 보인다.
      const inventory = new Map(
        domPresentationOwners(windowLabel(), doc).map((entry) => [entry.viewId, entry]),
      );
      for (const owner of owners) {
        const entry = inventory.get(owner.viewId);
        if (!entry || entry.hostId !== owner.hostId || entry.surfaceId !== owner.surfaceId) {
          throw new Error(
            `표시 원장 owner binding 이 공개 DOM 과 다릅니다: view=${owner.viewId}`
            + ` host=${owner.hostId}/${entry?.hostId ?? "없음"}`
            + ` surface=${owner.surfaceId}/${entry?.surfaceId ?? "없음"}`,
          );
        }
      }
      const refreshIntervalMs = Number(await source.refreshIntervalMs());
      if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
        throw new Error(`디스플레이 표시 주기를 읽지 못했습니다: ${String(refreshIntervalMs)}`);
      }
      sourceGeneration += 1;
      const trace: TraceState = {
        traceId,
        owners,
        armedAtUnixMs: presentationNowUnixMs(),
        sourceGeneration,
        refreshIntervalMs,
        maxEvents,
        events: [],
        nextRevision: 1,
        baselineIdentity: null,
        lastCallbackObservedAtUnixMs: null,
        violations: {
          replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0,
        },
        observation: { callbackIntervalsSkipped: 0, maxCallbackLatencyMs: 0 },
        unsubscribe: () => {},
      };
      traces.set(traceId, trace);

      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (run: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          run();
        };
        const fail = (error: Error) => finish(() => {
          trace.unsubscribe();
          traces.delete(traceId);
          reject(error);
        });
        const timer = setTimeout(
          () => fail(new Error(
            `첫 표시 사건이 ${FIRST_DISPLAY_TIMEOUT_MS}ms 안에 오지 않았습니다: ${traceId}`,
          )),
          FIRST_DISPLAY_TIMEOUT_MS,
        );
        trace.unsubscribe = source.subscribe((documentTimeMs) => {
          const displayedAtUnixMs = presentationUnixMsFromDocumentTime(documentTimeMs);
          // 무장 이전의 프레임은 이 거래의 것이 아니다 — baseline 으로 삼으면 자극 전 화면이
          // 아니라 그보다 더 옛 화면을 기준선이라 부르게 된다.
          if (!Number.isFinite(displayedAtUnixMs)
              || displayedAtUnixMs + Number.EPSILON < trace.armedAtUnixMs) return;
          const callbackObservedAtUnixMs = presentationNowUnixMs();
          const targetTimestampUnixMs = displayedAtUnixMs + trace.refreshIntervalMs;
          if (trace.lastCallbackObservedAtUnixMs !== null) {
            const skipped = Math.floor(
              (callbackObservedAtUnixMs - trace.lastCallbackObservedAtUnixMs)
              / trace.refreshIntervalMs,
            );
            trace.observation.callbackIntervalsSkipped += Math.max(0, skipped - 1);
          }
          trace.lastCallbackObservedAtUnixMs = callbackObservedAtUnixMs;
          trace.observation.maxCallbackLatencyMs = Math.max(
            trace.observation.maxCallbackLatencyMs,
            Math.max(0, callbackObservedAtUnixMs - targetTimestampUnixMs),
          );
          const previous = trace.events[trace.events.length - 1];
          if (previous && displayedAtUnixMs <= previous.presentedAtUnixMs) {
            trace.violations.droppedEvents += 1;
            return;
          }
          if (trace.events.length >= trace.maxEvents) {
            trace.violations.droppedEvents += 1;
            return;
          }
          if (previous) {
            // 합성기가 건너뛴 표시. 관측 콜백을 놓친 것(callbackIntervalsSkipped)과 다른 사실이다.
            const skippedFrames = Math.round(
              (displayedAtUnixMs - previous.presentedAtUnixMs) / trace.refreshIntervalMs,
            ) - 1;
            if (skippedFrames > 0) trace.violations.gaps += skippedFrames;
          }
          let frames: PresentationSurfaceFrame[];
          try {
            frames = captureSurfaces(trace.owners, doc);
          } catch (error) {
            trace.violations.disappearances += 1;
            trace.violations.unpresented += 1;
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (frames.some((frame) => !frame.live || !frame.visible)) {
            trace.violations.disappearances += 1;
          }
          if (frames.some((frame) => !frame.painted)) trace.violations.unpresented += 1;
          const identity = identityOf(frames);
          if (trace.baselineIdentity === null) trace.baselineIdentity = identity;
          else if (trace.baselineIdentity !== identity) trace.violations.replacements += 1;

          const sequence = trace.events.length;
          trace.events.push({
            sequence,
            sourceGeneration: trace.sourceGeneration,
            presentationRevision: trace.nextRevision,
            displayTimestampUnixMs: displayedAtUnixMs,
            targetTimestampUnixMs,
            callbackObservedAtUnixMs,
            refreshIntervalMs: trace.refreshIntervalMs,
            presentedAtUnixMs: displayedAtUnixMs,
            surfaces: frames,
          });
          trace.nextRevision += 1;
          if (sequence === 0) {
            finish(() => resolve({
              traceId,
              clock: PRESENTATION_CLOCK,
              ownerViewIds: trace.owners.map((owner) => owner.viewId),
              armedAtUnixMs: trace.armedAtUnixMs,
              baselineFrameSequence: 0,
              sourceGeneration: trace.sourceGeneration,
            }));
          }
        });
      });
    },

    async close({ traceId }) {
      const trace = traces.get(traceId);
      if (!trace) throw new Error(`열려 있는 표시 원장이 없습니다: ${traceId}`);
      trace.unsubscribe();
      traces.delete(traceId);
      return receiptOf(trace, true);
    },
  };
}

/**
 * 이 문서의 프레임 콜백을 표시 사건 원천으로 세운다.
 *
 * 폴링이 아니다 — 합성기가 프레임을 낼 때만 불리고, 유한한 거래가 닫히면 구독이 끝난다.
 * 표시 주기는 문서가 모르므로 프레임워크에게 묻는다.
 */
export function documentDisplayFrameSource(
  readRefreshIntervalMs: () => Promise<number>,
  view: Window = window,
): DisplayFrameSource {
  return {
    subscribe(onFrame) {
      let handle = view.requestAnimationFrame(function step(documentTimeMs) {
        handle = view.requestAnimationFrame(step);
        onFrame(documentTimeMs);
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        view.cancelAnimationFrame(handle);
      };
    },
    refreshIntervalMs: readRefreshIntervalMs,
  };
}
