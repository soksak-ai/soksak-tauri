// Electron B10 관측면 — DOM 자식이라는 단순한 모델을 사건과 실제 기하로 증명한다.
//
// native 거래는 BrowserWindow resize + WebContents presentation을 답하고, 이 파일은 같은
// 거래 세대에 renderer resize·ResizeObserver·slot·<webview>·guest viewport를 결합한다.
// rAF 횟수나 재시도는 settlement 근거가 아니다.
import { moduleState } from "../../lib/moduleState";
import { browserViewIdFromLabel, currentWindowLabel } from "../../lib/webviewLabels";
import type {
  ResizeCompositionObservation,
  ResizeContinuityCounters,
  ResizeProbeRequest,
} from "../../lib/windowResizeProbe";
import {
  countResizeContinuity,
  electronResizeObservation,
  type ElectronObservedTarget,
} from "./resizeObservation";
import { combineElectronCompositionProbe } from "./compositionProbe";

export interface Size2D {
  width: number;
  height: number;
}

export interface Rect2D extends Size2D {
  x: number;
  y: number;
}

interface DisplaySnapshot {
  id: string | number | null;
  scaleFactor: number;
  boundsDip: Rect2D;
}

interface PresentationProof {
  transactionGeneration: number;
  subscriptionGeneration: number;
  sequence: number;
  frameSize: Size2D;
  dirtyRect: Rect2D;
  expectedDip: Size2D;
  expectedPhysical: Size2D;
  devicePixelRatio: number;
}

interface PresentationReceipt {
  webContentsId: number;
  presentationRevision: number;
  proof: PresentationProof;
}

export interface ElectronNativeResizeReceipt {
  framework: "electron";
  label: string;
  transactionGeneration: number;
  status: "settled";
  changed: boolean;
  requested: { dip: Size2D; physical: Size2D; display: DisplaySnapshot };
  native: {
    resizeRevision: number;
    display: { pre: DisplaySnapshot; post: DisplaySnapshot };
    outerDip: Rect2D;
    outerPhysicalSpace: string;
    outerPhysicalMethod: string;
    outerPhysical: Rect2D | null;
    contentDip: Rect2D;
    contentPhysicalSpace: string;
    contentPhysicalMethod: string;
    contentPhysical: Rect2D | null;
  };
  renderer: PresentationReceipt;
  surfaces: PresentationReceipt[];
  settledRevision: number;
}

export type ElectronNativePhysicalResize = (args: {
  width: number;
  height: number;
  surfaceIds: number[];
}) => Promise<ElectronNativeResizeReceipt>;

interface GuestViewport {
  innerWidth: number;
  innerHeight: number;
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
}

interface ElectronWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  executeJavaScript?: (code: string) => Promise<unknown>;
}

interface ResizeTarget {
  element: ElectronWebviewElement;
  slotElement: HTMLElement | null;
  label: string;
  webContentsId: number | null;
  connected: boolean;
  visible: boolean;
  slotRect: Rect2D | null;
  surfaceRect: Rect2D;
}

export interface ElectronResizeProbe {
  setPhysicalSize(
    width: number,
    height: number,
    setNative: ElectronNativePhysicalResize,
  ): Promise<void>;
  /** 코어 resize 관측 봉투의 관측면. 요청 크기는 받지 않는다. */
  sample(request: ResizeProbeRequest): Promise<ResizeCompositionObservation>;
}

function rectOf(value: DOMRect | DOMRectReadOnly): Rect2D {
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/** Renderer 사각형은 screen 전역이 아니라 content-local이다. */
function contentLocalPhysicalRect(value: Rect2D | null, scaleFactor: number): Rect2D | null {
  if (!value) return null;
  const left = Math.round(value.x * scaleFactor);
  const top = Math.round(value.y * scaleFactor);
  const right = Math.round((value.x + value.width) * scaleFactor);
  const bottom = Math.round((value.y + value.height) * scaleFactor);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sameRect(a: Rect2D | null, b: Rect2D | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y &&
    a.width === b.width && a.height === b.height;
}

function targetFacts(doc: Document): ResizeTarget[] {
  return [...doc.querySelectorAll<ElectronWebviewElement>("[data-content-view]")].map((element) => {
    const surfaceRect = rectOf(element.getBoundingClientRect());
    const slotElement = element.closest<HTMLElement>("[data-content-view-body]");
    const style = doc.defaultView?.getComputedStyle(element);
    const connected = element.isConnected;
    const visible = connected && surfaceRect.width > 0 && surfaceRect.height > 0 &&
      style?.display !== "none" && style?.visibility !== "hidden";
    let webContentsId: number | null = null;
    try {
      const candidate = Number(element.getWebContentsId?.());
      if (Number.isSafeInteger(candidate) && candidate >= 0) webContentsId = candidate;
    } catch {
      // visible 표면이면 아래 검증에서 이름을 달아 실패한다.
    }
    return {
      element,
      slotElement,
      label: element.getAttribute("data-content-view") ?? "",
      webContentsId,
      connected,
      visible,
      slotRect: slotElement ? rectOf(slotElement.getBoundingClientRect()) : null,
      surfaceRect,
    };
  });
}

function visibleSurfaceIds(doc: Document): number[] {
  const ids = new Set<number>();
  for (const target of targetFacts(doc)) {
    if (!target.visible) continue;
    if (target.webContentsId === null) {
      throw namedError(
        "ELECTRON_SURFACE_ID_MISSING",
        `보이는 Electron 콘텐츠 표면의 WebContents id가 없다: ${target.label}`,
      );
    }
    ids.add(target.webContentsId);
  }
  return [...ids];
}

function rendererViewport(win: Window, doc: Document) {
  return {
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    clientWidth: doc.documentElement.clientWidth,
    clientHeight: doc.documentElement.clientHeight,
    devicePixelRatio: win.devicePixelRatio,
    visualViewport: win.visualViewport
      ? { width: win.visualViewport.width, height: win.visualViewport.height, scale: win.visualViewport.scale }
      : null,
  };
}

function namedError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

function finiteGuestViewport(value: unknown, label: string): GuestViewport {
  const candidate = value as Partial<GuestViewport> | null;
  const result = {
    innerWidth: Number(candidate?.innerWidth),
    innerHeight: Number(candidate?.innerHeight),
    clientWidth: Number(candidate?.clientWidth),
    clientHeight: Number(candidate?.clientHeight),
    devicePixelRatio: Number(candidate?.devicePixelRatio),
  };
  if (!Object.values(result).every(Number.isFinite) || result.innerWidth <= 0 || result.innerHeight <= 0) {
    throw namedError(
      "ELECTRON_GUEST_GEOMETRY_UNAVAILABLE",
      `보이는 Electron 콘텐츠 표면의 guest viewport가 유효하지 않다: ${label}`,
    );
  }
  return result;
}

export function createElectronResizeProbe(
  win: Window,
  doc: Document,
  { timeoutMs = 2_000, now = () => Date.now() }: {
    timeoutMs?: number;
    /** 표본 시각. 시계도 관측면이 답하는 사실이라 이 어댑터가 든다. */
    now?: () => number;
  } = {},
): ElectronResizeProbe {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`Electron renderer settlement timeout이 유효하지 않다: ${timeoutMs}`);
  }

  let layoutEventRevision = 0;
  let observerRevision = 0;
  let layoutSettledRevision = 0;
  let generationRevision = 0;
  // 관측 표본의 세대. 거래 세대와 다른 축이다 — 한 거래를 여러 번 관측할 수 있고, 관측하지
  // 않은 거래도 있을 수 있다.
  let sampleGeneration = 0;
  let lastNative: ElectronNativeResizeReceipt | null = null;
  // 한 거래를 사이에 둔 창 사건 세대. 거래가 없던 자리(baseline)는 두 값이 같은 것이 사실이다.
  let transactionEvents = { before: 0, after: 0 };
  // 끊긴 사실은 누적한다 — 다음 프레임이 멀쩡하다고 끊겼던 사실이 사라지지 않는다.
  let continuityLedger: ResizeContinuityCounters = {
    replacements: 0, gaps: 0, disappearances: 0, unpresented: 0,
  };
  let lastObservedTargets: ElectronObservedTarget[] | null = null;

  win.addEventListener("resize", () => {
    layoutEventRevision += 1;
  });

  /**
   * 지금 이 문서가 볼 수 있는 콘텐츠 뷰 세 평면. native 영수증이 아직 없어도 잰다 —
   * 첫 거래 전의 관측(baseline)이 없으면 무엇이 변했는지 판정할 수 없다.
   */
  const observeTargets = async (): Promise<ElectronObservedTarget[]> => {
    const native = lastNative;
    const presentationById = new Map(
      (native?.surfaces ?? []).map((surface) => [surface.webContentsId, surface]),
    );
    return Promise.all(targetFacts(doc).map(async (target) => {
      let guestViewport: GuestViewport | null = null;
      if (target.visible && typeof target.element.executeJavaScript === "function") {
        try {
          guestViewport = finiteGuestViewport(await target.element.executeJavaScript(`(() => ({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
            devicePixelRatio: window.devicePixelRatio
          }))()`), target.label);
        } catch {
          // 못 물은 사실은 없는 평면으로 남는다. 요소 상자로 대신 채우면 guest 가 따라오지
          // 못한 프레임이 그대로 GREEN 이 된다.
          guestViewport = null;
        }
      }
      const receipt = target.webContentsId === null
        ? null
        : presentationById.get(target.webContentsId) ?? null;
      return {
        label: target.label,
        // 뷰 이름은 label 문법 소유자가 답한다. 접두사로 소유를 추측하지 않는다.
        viewId: browserViewIdFromLabel(target.label) ?? target.label,
        visible: target.visible,
        slotRect: target.slotRect,
        elementRect: target.surfaceRect,
        guestViewport,
        presentation: receipt && native
          ? {
              revision: receipt.presentationRevision,
              // frame 구독 세대가 바뀌면 그 표면은 교체된 것이다.
              surfaceGeneration: receipt.proof.subscriptionGeneration,
              presented: receipt.presentationRevision > 0
                && receipt.proof.transactionGeneration === native.transactionGeneration,
            }
          : null,
      } satisfies ElectronObservedTarget;
    }));
  };

  const collect = async (native: ElectronNativeResizeReceipt) => {
    const presentationById = new Map(
      native.surfaces.map((surface) => [surface.webContentsId, surface]),
    );
    const scaleFactor = native.native.display.post.scaleFactor;
    const viewport = rendererViewport(win, doc);
    const violations: Array<{ code: string; message: string; label?: string }> = [];
    if (
      viewport.innerWidth !== native.native.contentDip.width
      || viewport.innerHeight !== native.native.contentDip.height
    ) {
      violations.push({
        code: "RENDERER_VIEWPORT_MISMATCH",
        message: `renderer=${viewport.innerWidth}x${viewport.innerHeight}, ` +
          `native content=${native.native.contentDip.width}x${native.native.contentDip.height}`,
      });
    }
    if (
      native.renderer.presentationRevision <= 0
      || native.renderer.proof.transactionGeneration !== native.transactionGeneration
    ) {
      violations.push({
        code: "RENDERER_PRESENTATION_UNPROVEN",
        message: `renderer presentation이 transaction ${native.transactionGeneration}을 증명하지 않는다`,
      });
    }

    const surfaces = await Promise.all(targetFacts(doc).map(async (target) => {
      let guestViewport: GuestViewport | null = null;
      if (target.visible) {
        if (target.webContentsId === null || typeof target.element.executeJavaScript !== "function") {
          violations.push({
            code: "GUEST_OBSERVATION_MISSING",
            message: "보이는 표면의 guest 관측면이 없다",
            label: target.label,
          });
        } else {
          guestViewport = finiteGuestViewport(await target.element.executeJavaScript(`(() => ({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
            devicePixelRatio: window.devicePixelRatio
          }))()`), target.label);
        }
      }
      const slotPhysicalRect = contentLocalPhysicalRect(target.slotRect, scaleFactor);
      const surfacePhysicalRect = contentLocalPhysicalRect(target.surfaceRect, scaleFactor);
      const presentation = target.webContentsId === null
        ? null
        : (presentationById.get(target.webContentsId) ?? null);
      if (target.visible) {
        if (!sameRect(slotPhysicalRect, surfacePhysicalRect)) {
          violations.push({
            code: "SLOT_SURFACE_MISMATCH",
            message: `slot=${JSON.stringify(slotPhysicalRect)}, surface=${JSON.stringify(surfacePhysicalRect)}`,
            label: target.label,
          });
        }
        if (
          guestViewport
          && (
            Math.round(target.surfaceRect.width) !== guestViewport.innerWidth
            || Math.round(target.surfaceRect.height) !== guestViewport.innerHeight
          )
        ) {
          violations.push({
            code: "SURFACE_GUEST_MISMATCH",
            message: `surface=${target.surfaceRect.width}x${target.surfaceRect.height}, ` +
              `guest=${guestViewport.innerWidth}x${guestViewport.innerHeight}`,
            label: target.label,
          });
        }
        if (
          !presentation
          || presentation.presentationRevision <= 0
          || presentation.proof.transactionGeneration !== native.transactionGeneration
          || (guestViewport && (
            presentation.proof.expectedDip.width !== guestViewport.innerWidth
            || presentation.proof.expectedDip.height !== guestViewport.innerHeight
          ))
        ) {
          violations.push({
            code: "SURFACE_PRESENTATION_UNPROVEN",
            message: `surface presentation이 transaction ${native.transactionGeneration}의 guest 기하를 증명하지 않는다`,
            label: target.label,
          });
        }
      }
      return {
        label: target.label,
        webContentsId: target.webContentsId,
        connected: target.connected,
        visible: target.visible,
        slotRect: target.slotRect,
        slotPhysicalRect,
        surfaceRect: target.surfaceRect,
        surfacePhysicalRect,
        physicalCoordinateSpace: "content-local-physical" as const,
        guestViewport,
        presentationRevision: presentation?.presentationRevision ?? null,
        presentationProof: presentation?.proof ?? null,
      };
    }));

    const actualVisibleIds = surfaces
      .filter((surface) => surface.visible && surface.webContentsId !== null)
      .map((surface) => surface.webContentsId as number)
      .sort((a, b) => a - b);
    const provenIds = native.surfaces.map((surface) => surface.webContentsId).sort((a, b) => a - b);
    if (JSON.stringify(actualVisibleIds) !== JSON.stringify(provenIds)) {
      violations.push({
        code: "SURFACE_SET_CHANGED",
        message: `native=${JSON.stringify(provenIds)}, renderer=${JSON.stringify(actualVisibleIds)}`,
      });
    }

    return {
      framework: "electron" as const,
      transactionGeneration: native.transactionGeneration,
      settled: native.status === "settled" && violations.length === 0,
      requested: native.requested,
      native: native.native,
      rendererPresentation: native.renderer,
      layout: {
        eventRevision: layoutEventRevision,
        observerRevision,
        settledRevision: layoutSettledRevision,
      },
      rendererViewport: viewport,
      surfaces,
      violations,
    };
  };

  return {
    async setPhysicalSize(width, height, setNative) {
      const ResizeObserverCtor = (win as Window & {
        ResizeObserver?: typeof ResizeObserver;
      }).ResizeObserver;
      if (typeof ResizeObserverCtor !== "function") {
        throw namedError(
          "ELECTRON_RESIZE_OBSERVER_UNAVAILABLE",
          "Electron renderer에 ResizeObserver가 없다",
        );
      }

      generationRevision += 1;
      const generation = generationRevision;
      const beforeLayoutRevision = layoutEventRevision;
      const surfaceIds = visibleSurfaceIds(doc);
      const rootObservations: Array<{ width: number; height: number; generation: number }> = [];
      let wake: (() => void) | null = null;
      const observer = new ResizeObserverCtor((entries) => {
        observerRevision += 1;
        const root = entries.find((entry) => entry.target === doc.documentElement);
        if (root) {
          rootObservations.push({
            width: root.contentRect.width,
            height: root.contentRect.height,
            generation,
          });
        }
        wake?.();
      });
      const observed = new Set<Element>();
      const observe = (element: Element | null) => {
        if (!element || observed.has(element)) return;
        observed.add(element);
        observer.observe(element);
      };
      observe(doc.documentElement);
      for (const target of targetFacts(doc)) {
        observe(target.slotElement);
        observe(target.element);
      }

      try {
        const native = await setNative({ width, height, surfaceIds });
        if (native.framework !== "electron" || native.status !== "settled") {
          throw namedError(
            "ELECTRON_NATIVE_SETTLEMENT_MISSING",
            "Electron native resize가 settlement 영수증을 반환하지 않았다",
          );
        }
        if (native.changed) {
          const committed = () => layoutEventRevision > beforeLayoutRevision && rootObservations.some(
            (record) => record.generation === generation
              && record.width === native.native.contentDip.width
              && record.height === native.native.contentDip.height,
          );
          if (!committed()) {
            await new Promise<void>((resolve, reject) => {
              const timer = win.setTimeout(() => {
                wake = null;
                reject(namedError(
                  "ELECTRON_RESIZE_SETTLEMENT_TIMEOUT",
                  `transaction ${native.transactionGeneration}의 renderer resize/ResizeObserver 기하가 ` +
                    `${timeoutMs}ms 안에 일치하지 않았다`,
                ));
              }, timeoutMs);
              wake = () => {
                if (!committed()) return;
                win.clearTimeout(timer);
                wake = null;
                resolve();
              };
              wake();
            });
          }
        }

        const facts = await collect(native);
        if (facts.violations.length > 0) {
          throw namedError(
            "ELECTRON_RESIZE_GEOMETRY_MISMATCH",
            `transaction ${native.transactionGeneration} 기하 불일치: ${JSON.stringify(facts.violations)}`,
          );
        }
        layoutSettledRevision += 1;
        lastNative = native;
        transactionEvents = { before: beforeLayoutRevision, after: layoutEventRevision };
      } finally {
        wake = null;
        observer.disconnect();
      }
    },
    async sample(request) {
      const targets = await observeTargets();
      const countersBefore = { ...continuityLedger };
      if (lastObservedTargets) {
        continuityLedger = countResizeContinuity(lastObservedTargets, targets, continuityLedger);
      }
      const countersAfter = { ...continuityLedger };
      lastObservedTargets = targets;
      // 아직 아무 거래도 없던 자리는 그 사실 그대로 답한다 — 거절하면 무엇이 변했는지 잴
      // 기준 자체가 사라지고, 지어내면 첫 거래가 항상 성공한 것이 된다.
      const events = request.kind === "step"
        ? transactionEvents
        : { before: layoutEventRevision, after: layoutEventRevision };
      sampleGeneration += 1;
      // 판정은 방금 잰 그 표본에서만 나온다. 요청 크기도 기대값도 여기 들어오지 않으므로,
      // 이 선언은 같은 관측과 절대 어긋날 수 없다.
      const composition = combineElectronCompositionProbe({
        generation: sampleGeneration,
        sampledAtUnixMs: now(),
        targets,
      });
      return { ...electronResizeObservation({
        windowLabel: currentWindowLabel(),
        scaleFactor: win.devicePixelRatio,
        eventGeneration: layoutEventRevision,
        eventGenerationBefore: events.before,
        eventGenerationAfter: events.after,
        transactionGeneration: lastNative?.transactionGeneration ?? 0,
        continuity: { countersBefore, countersAfter },
        targets,
      }), composition };
    },
  };
}

const activeState = moduleState("framework/electron/resizeProbe#active", () => ({
  probe: null as ElectronResizeProbe | null,
}));

/** 현재 Electron renderer의 단일 probe. HMR에서도 listener와 revision이 중복되지 않는다. */
export function activeElectronResizeProbe(): ElectronResizeProbe {
  if (!activeState.probe) activeState.probe = createElectronResizeProbe(window, document);
  return activeState.probe;
}
