import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { presentationBarrierLabels } from "./presentationBarrierScope";
import { invoke } from "@tauri-apps/api/core";
import { moduleState } from "../../lib/moduleState";
import { presentationNowUnixMs } from "../../lib/presentationClock";
import { contentViewHost } from "../../lib/contentViews";
import { themeCustomProperties } from "./pluginViewTheme";
import type { ExternalSurfaceTransitionTiming } from "../../lib/externalSurfaceTransition";
import { currentWindowLabel } from "../../lib/webviewLabels";
import type { LayoutMove, PreparedLayoutTransition } from "../../lib/layoutTransitionHost";
import { surfaceRectOf } from "../../lib/surfaceRect";
import {
  COMPOSITION_KIND_ATTR,
  compositionParticipantSelector,
  contentCompositionTopologyPath,
  declareCompositionParticipant,
  setCompositionParticipantVisible,
} from "../../lib/compositionParticipants";
import { surfaceLayoutContractOf } from "./surfaceLayoutContract";
import { classifyRendererTopology, type RendererTopologyFact } from "./surfaceAudit";
import {
  registerPluginViewPresentationHost,
  type PresentedPluginView,
  type PluginViewPresentationHost,
} from "../../plugins/viewPresentationHost";
import { viewPresentationRuntime } from "../../plugins/viewRegistry";
import { TAURI_PANE_RENDERER_ATTR } from "./holeMarkers";
import { CONTENT_VIEW_BODY } from "../../lib/contentViews";
import {
  isPluginViewCallExposed,
  isPluginViewSubscribeExposed,
  type PluginViewFailure,
  type PluginViewInit,
  type PluginViewNodeFrame,
  type PluginViewPlacementFrame,
  type PluginViewRpcRequest,
  type PluginViewRpcResponse,
  type PluginViewSlotFrame,
} from "./pluginViewProtocol";
import { createPluginViewReadySignal } from "./pluginViewActivation";
import { PluginViewSlotRegistry } from "./pluginViewSlots";
import { PluginViewReadiness } from "./pluginViewReadiness";
import { PluginViewMemberOwnership } from "./pluginViewMemberOwnership";
import { PluginViewSidecars } from "./pluginViewSidecars";
import { PluginViewVisibility } from "./pluginViewVisibility";
import { claimPaneSurface, releasePaneSurface } from "./surfaceOwnership";

interface DisposableLike { dispose(): void }

interface PresentedState {
  nativeHostId: string;
  logicalPaneId: string | null;
  renderer: string;
  viewId: string | null;
  container: HTMLElement;
  context: Parameters<PresentedPluginView["update"]>[0];
  app: Record<string, any>;
  members: Set<string>;
  slots: PluginViewSlotRegistry;
  projections: Map<string, HTMLElement>;
  subscriptions: Map<string, DisposableLike>;
  unlisten: UnlistenFn[];
  observer: ResizeObserver;
  grouped: boolean;
  disposed: boolean;
  visible: boolean;
  visibility: PluginViewVisibility;
  markReady(): void;
  /** 자식 renderer 가 낸 활성 실패를 준비 신호로 옮긴다 — 매달림 대신 이름 붙은 거절. */
  markFailed(reason: string): void;
  /** 활성 실패를 사유로 남긴다. 등록된 뷰가 하나도 없을 때만 준비를 거절한다. */
  reportActivationFailure(reason: string, registeredViews: number): void;
  sidecars: PluginViewSidecars;
}

const state = moduleState("framework/tauri#pluginViewPresentation", () => ({
  sequence: 0,
  views: new Map<string, PresentedState>(),
  readiness: new PluginViewReadiness(),
  memberOwnership: new PluginViewMemberOwnership(),
}));

const rectOf = (element: HTMLElement) => surfaceRectOf(element.getBoundingClientRect());

export const paneLayoutContractOf = surfaceLayoutContractOf;

type PaneRect = { x: number; y: number; w: number; h: number };
type DomPaneFact = {
  pane: string;
  viewId?: string | null;
  frame: PaneRect;
  members?: {
    label: string;
    frame: PaneRect;
    topologyPath?: string | null;
    viewport?: { w: number; h: number; revision: number; reportedAtUnixMs: number; receivedAtUnixMs: number };
  }[];
};
type NativePaneFact = {
  pane: string;
  window: string;
  /** 이 host가 품은 pane renderer의 native identity. */
  renderer?: string;
  /** 이 host가 품은 native member surface identity 전부. */
  members?: string[];
  cssFrame: PaneRect;
  contractFrame?: PaneRect | null;
  memberFrames?: { label: string; cssFrame: PaneRect | null; contractFrame?: PaneRect | null }[];
  rendererTopology?: RendererTopologyFact | null;
  chromeAboveHost?: boolean;
  alpha?: number;
  [key: string]: unknown;
};

type PaneHostIdentityBinding = {
  nativeHostId: string;
  logicalPaneId: string | null;
  viewId: string | null;
};

/**
 * AppKit registry keys and workspace pane ids are independent identities. The native command owns
 * only the former; the presentation registry is the authoritative join to the latter. Unbound
 * native hosts remain visible with null logical fields so diagnostics never infer an identity from
 * a framework label.
 */
export function exposePaneHostIdentities(
  native: readonly NativePaneFact[],
  bindings: readonly PaneHostIdentityBinding[],
) {
  const byNativeHost = new Map(bindings.map((binding) => [binding.nativeHostId, binding]));
  return native.map(({ pane, ...fact }) => {
    const binding = byNativeHost.get(pane);
    return {
      ...fact,
      nativeHostId: pane,
      logicalPaneId: binding?.logicalPaneId ?? null,
      viewId: binding?.viewId ?? null,
    };
  });
}

const rectDelta = (a: PaneRect, b: PaneRect) => ({
  x: Math.abs(a.x - b.x), y: Math.abs(a.y - b.y),
  w: Math.abs(a.w - b.w), h: Math.abs(a.h - b.h),
});

/** Immediate native-resize phase. The main and child renderer event loops may legitimately
 * coalesce intermediate sizes, so each AppKit frame is compared with the affine contract that
 * produced it. Final live DOM↔native equality remains comparePanePresentation's responsibility. */
export function comparePaneNativeContracts(
  native: readonly NativePaneFact[],
  windowLabel: string,
  tolerancePx = 1,
) {
  const scoped = native.filter((fact) => fact.window === windowLabel);
  const matches = scoped.map((fact) => {
    const delta = fact.contractFrame ? rectDelta(fact.cssFrame, fact.contractFrame) : null;
    const members = (fact.memberFrames ?? []).map((member) => {
      const memberDelta = member.cssFrame && member.contractFrame
        ? rectDelta(member.cssFrame, member.contractFrame)
        : null;
      return {
        label: member.label,
        actual: member.cssFrame,
        expected: member.contractFrame ?? null,
        delta: memberDelta,
        ok: memberDelta !== null
          && Object.values(memberDelta).every((value) => value <= tolerancePx),
      };
    });
    return {
      pane: fact.pane,
      actual: fact.cssFrame,
      expected: fact.contractFrame ?? null,
      delta,
      members,
      ok: delta !== null
        && Object.values(delta).every((value) => value <= tolerancePx)
        && members.length > 0
        && members.every((member) => member.ok),
    };
  });
  const matched = matches.length > 0 && matches.every((match) => match.ok);
  return { window: windowLabel, tolerancePx, matches, matched, verdict: matched ? "green" as const : "red" as const };
}

/**
 * 한 창의 공개 DOM pane과 AppKit PaneSurfaceHost를 동일한 CSS 좌표계에서 판정한다.
 * 존재·중복은 정확히 1:1이어야 하고 기하는 반올림 오차(1px)만 허용한다. 다른 창의 native
 * host는 섞어 판정하지 않되, 어댑터의 전역 장부 누수를 숨기지 않도록 별도 사실로 노출한다.
 */
export function comparePanePresentation(
  dom: readonly DomPaneFact[],
  native: readonly NativePaneFact[],
  windowLabel: string,
  tolerancePx = 1,
) {
  const windowCoordinateSpace = {
    logical: "css-px" as const,
    origin: "window-absolute" as const,
    referenceId: windowLabel,
  };
  const scoped = native.filter((fact) => fact.window === windowLabel);
  const foreignNative = native.filter((fact) => fact.window !== windowLabel).map((fact) => fact.pane);
  const matches = dom.map((domFact) => {
    const candidates = scoped.filter((fact) => fact.pane === domFact.pane);
    const nativeFact = candidates.length === 1 ? candidates[0] : null;
    const delta = nativeFact ? rectDelta(domFact.frame, nativeFact.cssFrame) : null;
    const memberMatches = (domFact.members ?? []).map((domMember) => {
      const nativeMembers = nativeFact?.memberFrames?.filter((fact) => fact.label === domMember.label) ?? [];
      const nativeMember = nativeMembers.length === 1 ? nativeMembers[0] : null;
      const memberDelta = nativeMember?.cssFrame
        ? rectDelta(domMember.frame, nativeMember.cssFrame)
        : null;
      return {
        label: domMember.label,
        topologyPath: domMember.topologyPath ?? null,
        coordinateSpace: {
          logical: "css-px" as const,
          origin: "presenter-local" as const,
          referenceId: domMember.label,
        },
        domFrame: domMember.frame,
        nativeFrame: nativeMember?.cssFrame ?? null,
        nativeCount: nativeMembers.length,
        delta: memberDelta,
        viewport: domMember.viewport ?? null,
        viewportDelta: domMember.viewport && nativeFact
          ? {
              w: Math.abs(domMember.viewport.w - nativeFact.cssFrame.w),
              h: Math.abs(domMember.viewport.h - nativeFact.cssFrame.h),
            }
          : null,
        ok: nativeMembers.length === 1 && memberDelta !== null
          && Object.values(memberDelta).every((value) => value <= tolerancePx),
      };
    });
    const ok = candidates.length === 1
      && delta !== null
      && Object.values(delta).every((value) => value <= tolerancePx)
      && memberMatches.every((match) => match.ok);
    return {
      pane: domFact.pane,
      viewId: domFact.viewId ?? null,
      coordinateSpace: windowCoordinateSpace,
      domFrame: domFact.frame,
      nativeFrame: nativeFact?.cssFrame ?? null,
      nativeCount: candidates.length,
      delta,
      memberMatches,
      rendererTopology: nativeFact?.rendererTopology
        ? classifyRendererTopology(nativeFact.rendererTopology)
        : null,
      chromeAboveHost: nativeFact?.chromeAboveHost === true,
      alpha: nativeFact?.alpha ?? null,
      ok,
    };
  });
  const domPanes = new Set(dom.map((fact) => fact.pane));
  const orphanNative = scoped.filter((fact) => !domPanes.has(fact.pane)).map((fact) => fact.pane);
  return {
    window: windowLabel,
    tolerancePx,
    matches,
    orphanNative,
    foreignNative,
    ok: matches.every((match) => match.ok) && orphanNative.length === 0,
  };
}

/**
 * Child renderer의 공개 content slot을 메인 문서 좌표계에 측정 가능한 DOM으로 투영한다.
 * `data-content-view-body`는 붙이지 않는다. 그것은 실제 content-view 생성 소유권이므로
 * 관측 노드가 bounds 추종기를 재기동해서는 안 된다.
 */
export function projectPluginViewSlot(
  container: HTMLElement,
  frame: PluginViewSlotFrame,
  composition?: {
    viewId: string;
    topologyPath: string;
    visible: boolean;
  },
  existing?: HTMLElement,
): HTMLElement {
  const element = existing ?? document.createElement("div");
  element.dataset.node = `tauri/plugin-view/${frame.label}/surface`;
  // **자기가 무엇인지 선언한다.** 자리 투영과 노드 투영은 이름 모양이 같은데 가운데 토막의
  // 뜻이 다르다 — 여기는 콘텐츠 표면의 label 이고 저기는 renderer realm 이다. 읽는 쪽이
  // 이름으로 추측하면 표면을 realm 으로 읽고 좌표 기준까지 틀린다(실측 2026-08-08).
  element.dataset.surface = frame.label;
  if (composition) {
    declareCompositionParticipant(element, { kind: "slot", ...composition });
    let renderer = element.querySelector<HTMLElement>(
      `:scope > ${compositionParticipantSelector("renderer")}`,
    );
    if (!renderer) {
      renderer = document.createElement("div");
      element.appendChild(renderer);
    }
    renderer.dataset.node = `tauri/plugin-view/${frame.label}/renderer`;
    declareCompositionParticipant(renderer, { kind: "renderer", ...composition });
    renderer.setAttribute("aria-hidden", "true");
    Object.assign(renderer.style, {
      position: "absolute", inset: "0", pointerEvents: "none", background: "transparent",
    });
  }
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    position: "absolute",
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    width: `${frame.w}px`,
    height: `${frame.h}px`,
    pointerEvents: "none",
    background: "transparent",
  });
  if (!existing) container.appendChild(element);
  return element;
}

function setProjectedCompositionVisibility(view: PresentedState, visible: boolean): void {
  for (const projection of view.projections.values()) {
    setCompositionParticipantVisible(projection, visible);
    for (const child of projection.querySelectorAll<HTMLElement>(`[${COMPOSITION_KIND_ATTR}]`)) {
      setCompositionParticipantVisible(child, visible);
    }
  }
}

export function projectPluginViewNode(
  container: HTMLElement,
  frame: PluginViewNodeFrame,
  existing?: HTMLElement,
): HTMLElement {
  const element = existing ?? document.createElement("div");
  // 주소는 노드가 **사는** realm 을 가리킨다 — 콘텐츠 표면 이름으로 지으면 조작이 노드 없는
  // 문서로 간다.
  element.dataset.node = `tauri/plugin-view/${frame.realm}/${frame.node}`;
  // 이 자리는 **그 realm 안의 노드**다(자리 투영과 구별되는 사실 — 위 dataset.surface 참조).
  element.dataset.realm = frame.realm;
  // 포커스는 관측면의 사실이다 — 호스트에서 읽을 수 있어야 "안 들어간다" 를 값으로 말한다.
  element.dataset.focused = String(frame.focused);
  element.dataset.realmFocused = String(frame.realmFocused);
  if (frame.control) {
    element.dataset.formControl = frame.control.kind;
    element.dataset.formValue = frame.control.value;
  } else {
    delete element.dataset.formControl;
    delete element.dataset.formValue;
  }
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    position: "absolute", left: `${frame.x}px`, top: `${frame.y}px`,
    width: `${frame.w}px`, height: `${frame.h}px`, pointerEvents: "none",
    background: "transparent",
  });
  if (!existing) container.appendChild(element);
  return element;
}

function event(renderer: string, name: string): string {
  return `soksak://plugin-view/${renderer}/${name}`;
}

function resolvePath(root: Record<string, any>, path: string): { owner: any; fn: (...args: any[]) => any } {
  const parts = path.split(".");
  const name = parts.pop();
  let owner: any = root;
  for (const part of parts) owner = owner?.[part];
  const fn = name ? owner?.[name] : undefined;
  if (typeof fn !== "function") throw new Error(`plugin view RPC에 노출되지 않은 호출: ${path}`);
  return { owner, fn };
}

// 자식 realm 이 부를 수 있는 경로는 protocol 이 소유한다 — 부모가 여기 다시 적으면 두 목록이
// 갈리고, 갈린 쪽은 조용히 죽는다. 기존 소비자를 위해 판정만 이 모듈 이름으로도 내준다.
export { isPluginViewCallExposed };

async function syncPaneFrame(view: PresentedState): Promise<void> {
  if (view.disposed) return;
  const rect = rectOf(view.container);
  if (view.grouped) {
    await invoke("webview_pane_bounds", {
      pane: view.nativeHostId,
      ...rect,
      layout: paneLayoutContractOf(view.container),
    });
  } else {
    await invoke("webview_bounds", { label: view.renderer, ...rect });
  }
}

/**
 * member surface 의 배치는 이 호스트가 소유한다. 그 자리에 사는 표면은 자기 프레임을 스스로
 * 알 수 없으므로, 적용한 쪽이 적용한 값을 그대로 알린다 — 표면이 슬롯을 다시 재면 같은 자리를
 * 두 기준으로 재게 되고, 늦은 쪽이 어긋난 채 굳는다(실측: offscreen 엔진의 applied bounds 가
 * 생성 시각에 멈춰 표시 원장이 프레임을 세우지 못했다 — 표시 대기는 영원히 타임아웃).
 */
async function syncMemberFrame(view: PresentedState, frame: PluginViewSlotFrame): Promise<boolean> {
  if (!view.grouped || !view.members.has(frame.label) || view.disposed) return false;
  await invoke("webview_pane_member_bounds", {
    pane: view.nativeHostId,
    label: frame.label,
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    layout: {
      hostW: frame.rootW,
      hostH: frame.rootH,
      left: frame.x,
      top: frame.y,
      right: Math.max(0, frame.rootW - frame.x - frame.w),
      bottom: Math.max(0, frame.rootH - frame.y - frame.h),
    },
  });
  void emitTo(view.renderer, event(view.renderer, "placement"), {
    label: frame.label,
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    revision: frame.revision,
  } satisfies PluginViewPlacementFrame).catch(() => {});
  return true;
}

async function openAndGroup(
  view: PresentedState,
  label: string,
  options: Record<string, unknown>,
): Promise<void> {
  state.readiness.set(view.nativeHostId, false);
  const slot = await view.slots.wait(label);
  const paneRect = rectOf(view.container);
  claimPaneSurface(label, view.nativeHostId);
  state.memberOwnership.claim(label, view.renderer);
  let opened = false;
  try {
    await view.app.webview.open(label, {
      ...options,
      x: paneRect.x + slot.x,
      y: paneRect.y + slot.y,
      w: slot.w,
      h: slot.h,
    });
    opened = true;
    view.members.add(label);
    if (!view.grouped) {
      await invoke("webview_pane_group", {
        pane: view.nativeHostId,
        renderer: view.renderer,
        members: [...view.members],
        ...paneRect,
      });
      view.grouped = true;
      await syncPaneFrame(view);
    }
    if (await syncMemberFrame(view, slot)) view.slots.commit(slot);
    await view.visibility.request(view.visible);
    state.readiness.set(view.nativeHostId, true);
    view.markReady();
  } catch (error) {
    view.members.delete(label);
    state.memberOwnership.release(label, view.renderer);
    if (opened) await view.app.webview.close(label).catch(() => {});
    releasePaneSurface(label, view.nativeHostId);
    throw error;
  }
}

async function presentExisting(view: PresentedState, label: string): Promise<void> {
  state.readiness.set(view.nativeHostId, false);
  const slot = await view.slots.wait(label);
  const paneRect = rectOf(view.container);
  claimPaneSurface(label, view.nativeHostId);
  state.memberOwnership.claim(label, view.renderer);
  try {
    view.members.add(label);
    if (!view.grouped) {
      await invoke("webview_pane_group", {
        pane: view.nativeHostId,
        renderer: view.renderer,
        members: [...view.members],
        ...paneRect,
      });
      view.grouped = true;
      await syncPaneFrame(view);
    }
    if (await syncMemberFrame(view, slot)) view.slots.commit(slot);
    await view.visibility.request(view.visible);
    state.readiness.set(view.nativeHostId, true);
    view.markReady();
  } catch (error) {
    view.members.delete(label);
    state.memberOwnership.release(label, view.renderer);
    releasePaneSurface(label, view.nativeHostId);
    throw error;
  }
}

async function handleCall(view: PresentedState, request: PluginViewRpcRequest): Promise<unknown> {
  if (request.kind === "unsubscribe") {
    view.subscriptions.get(request.subscription)?.dispose();
    view.subscriptions.delete(request.subscription);
    return null;
  }
  if (request.kind === "subscribe") {
    if (!isPluginViewSubscribeExposed(request.path)) throw new Error(`구독 RPC 미노출: ${request.path}`);
    const callback = (payload: unknown) => {
      void emitTo(view.renderer, event(view.renderer, "subscription"), {
        subscription: request.subscription,
        payload,
      });
    };
    if (request.path === "sidecar.on") {
      const [handle, eventName] = request.args as [string, string];
      const disposable = view.sidecars.subscribe(handle, eventName, callback);
      view.subscriptions.set(request.subscription, disposable);
      return null;
    }
    const root = request.path.startsWith("context.")
      ? { context: view.context }
      : view.app;
    const { owner, fn } = resolvePath(root, request.path);
    const disposable = fn.apply(owner, [...request.args, callback]);
    const normalized: DisposableLike = typeof disposable === "function"
      ? { dispose: disposable }
      : disposable;
    view.subscriptions.set(request.subscription, normalized);
    return null;
  }
  if (!isPluginViewCallExposed(request.path)) throw new Error(`호출 RPC 미노출: ${request.path}`);
  if (request.path === "webview.open") {
    const [label, options] = request.args as [string, Record<string, unknown>];
    await openAndGroup(view, label, options);
    return null;
  }
  if (request.path === "webview.present") {
    await presentExisting(view, String(request.args[0] ?? ""));
    return null;
  }
  if (request.path === "sidecar.open") {
    if (!view.app.sidecar) throw new Error("sidecar capability가 없습니다");
    return await view.sidecars.open(view.app.sidecar, String(request.args[0] ?? ""));
  }
  if (request.path === "sidecar.send") {
    const [handle, message] = request.args as [string, Record<string, unknown>];
    return await view.sidecars.send(handle, message);
  }
  if (request.path === "sidecar.close") {
    await view.sidecars.close(String(request.args[0] ?? ""));
    return null;
  }
  const root = request.path.startsWith("context.")
    ? { context: view.context }
    : view.app;
  const { owner, fn } = resolvePath(root, request.path);
  return await fn.apply(owner, request.args);
}

async function createPresentedView(
  input: Parameters<PluginViewPresentationHost["mount"]>[0],
  markReady: () => void,
  markFailed: (reason: string) => void,
  reportActivationFailure: (reason: string, registeredViews: number) => void,
): Promise<PresentedState> {
  const runtime = viewPresentationRuntime(input.provider);
  if (!runtime) throw new Error(`nativeSurface view의 renderer 실행 재료가 없습니다: ${input.registration.pluginId}`);
  const suffix = (++state.sequence).toString(36);
  const windowLabel = currentWindowLabel();
  const renderer = `pv-${windowLabel}-${suffix}`;
  const nativeHostId = `pane-${windowLabel}-${input.context.viewId ?? suffix}`;
  const app = runtime.app() as Record<string, any>;
  const view: PresentedState = {
    nativeHostId, logicalPaneId: input.logicalPaneId,
    renderer, viewId: input.context.viewId, container: input.container,
    context: input.context, app, members: new Set(), slots: new PluginViewSlotRegistry(),
    projections: new Map(),
    subscriptions: new Map(), unlisten: [], observer: null!, grouped: false,
    disposed: false, visible: input.context.isVisible(), markReady, markFailed, reportActivationFailure,
    visibility: null!,
    sidecars: new PluginViewSidecars(),
  };
  view.visibility = new PluginViewVisibility(async (visible) => {
    if (view.disposed) return;
    if (visible) await syncPaneFrame(view);
    await Promise.all([view.renderer, ...view.members].map((label) => invoke("webview_visible", {
      label,
      visible,
      focus: false,
    })));
    await emitTo(view.renderer, event(view.renderer, "visibility"), { visible });
    setProjectedCompositionVisibility(view, visible);
  });
  input.container.setAttribute(TAURI_PANE_RENDERER_ATTR, renderer);
  // 이 자리의 포인터는 호스트가 받는다(자식 표면이 메인 웹뷰 아래에 깔리므로) — 받은 자리를
  // realm-로컬 좌표로 바꿔 넘긴다. 넘기지 않으면 그 안의 것은 **보이기만 하고 눌리지 않는다.**
  //
  // 키보드까지 그 realm 으로 가려면 그 웹뷰가 입력 responder 여야 한다 — 눌린 순간 그것을
  // 요청한다(뜰 때가 아니라 눌릴 때다: 뜰 때 뺏으면 사용자가 치던 곳에서 커서가 튄다).
  // 호스트가 받은 사건을 **그대로** 내려보낸다 — 무엇이 일어났는지까지(누름·뗌·이동·버튼·
  // 클릭 수). 누름만 보내면 그 표면은 끌리지도 우클릭되지도 않는다.
  // 버튼이 눌린 채의 이동은 **끌기**다 — 그냥 이동으로 넘기면 그 realm 이 받는 mousemove 의
  // `buttons` 가 0 이라 끌기를 보는 코드가 아무 일도 안 한다.
  const KIND: Record<string, "down" | "up" | "move"> = {
    mousedown: "down", mouseup: "up", mousemove: "move",
  };
  const forwardPointer = (e: MouseEvent) => {
    const named = KIND[e.type];
    if (named === undefined) return;
    const kind = named === "move" && e.buttons !== 0 ? "drag" : named;
    const rect = input.container.getBoundingClientRect();
    // 계약의 축으로 보낸다 — 표면에 포인터를 넣는 자리는 이미 `sendInput` 이다. 여기서
    // 프레임워크 명령 이름을 부르면 그 축이 둘이 되고, 두 벌은 갈릴 때까지 조용하다.
    void contentViewHost().sendInput(renderer, {
      x: Math.round(e.clientX - rect.left),
      y: Math.round(e.clientY - rect.top),
      kind,
      button: e.button === 2 ? "right" : "left",
      clickCount: Math.max(1, e.detail),
    }).catch(() => {});
  };
  //  으로 듣는다 — 실클릭도 이것을 내고, 합성 클릭(ui.input.click)도 같은 이름을 낸다.
  // 이름이 갈리면 사람 경로와 검증 경로가 달라져 "검증은 되는데 손으로는 안 되는" 자리가 생긴다.
  // 세 사건을 다 듣는다 — 누름만 들으면 드래그도 우클릭도 성립하지 않는다. 실클릭과 합성
  // 클릭이 같은 이름을 내므로 사람 경로와 검증 경로가 같은 경로다.
  const POINTER_EVENTS = ["mousedown", "mouseup", "mousemove"] as const;
  for (const name of POINTER_EVENTS) input.container.addEventListener(name, forwardPointer, true);
  // 뷰가 사라지면 이 구독도 사라진다 — 남기면 죽은 realm 으로 계속 보낸다.
  view.unlisten.push(() => {
    for (const name of POINTER_EVENTS) input.container.removeEventListener(name, forwardPointer, true);
  });
  state.views.set(nativeHostId, view);
  state.readiness.set(nativeHostId, false);

  const ready = event(renderer, "ready");
  const failure = event(renderer, "failure");
  const rpc = event(renderer, "rpc");
  const slot = event(renderer, "slot");
  const node = event(renderer, "node");
  view.unlisten.push(await listen<{ renderer: string }>(ready, () => {
    const init: PluginViewInit = {
      source: runtime.source,
      pluginId: runtime.pluginId,
      windowLabel,
      viewId: input.context.viewId,
      label: input.context.viewId ? app.webview?.label(input.context.viewId) ?? null : null,
      locale: app.locale(),
      settings: app.settings.all(),
      // 테마는 코어의 사실이다 — 이 realm 에는 앱 스타일시트가 없으니 값으로 건넨다.
      theme: themeCustomProperties(document),
      project: app.project.current(),
      sidecarAvailable: !!app.sidecar,
      webviewCapabilities: app.webview?.capabilities ?? null,
      context: {
        projectId: input.context.projectId, root: input.context.root,
        paneId: input.context.paneId, viewId: input.context.viewId,
        boundViewId: input.context.boundViewId, command: input.context.command,
        restore: input.context.restore, visible: input.context.isVisible(),
      },
    };
    void emitTo(renderer, event(renderer, "init"), init);
  }));
  // 자식이 플러그인을 못 살렸다는 사실을 여기서 받는다. 듣지 않으면 준비는 영원히 pending 이고
  // 호출자는 이유 없는 mounted:false 만 본다. 다만 활성 실패가 곧 준비의 부재는 아니다 —
  // 등록을 마친 뒤 죽은 플러그인의 뷰는 이미 오고 있으므로 사유만 남기고 준비는 뷰가 정한다.
  view.unlisten.push(await listen<PluginViewFailure>(failure, ({ payload }) => {
    view.reportActivationFailure(
      `플러그인 활성 실패(${payload.pluginId} realm=${payload.realm}): ${payload.reason}`,
      payload.registeredViews,
    );
  }));
  view.unlisten.push(await listen<PluginViewSlotFrame>(slot, ({ payload }) => {
    view.slots.report(payload);
    const projected = projectPluginViewSlot(
      view.container,
      payload,
      view.viewId ? {
        viewId: view.viewId,
        topologyPath: contentCompositionTopologyPath(windowLabel, view.viewId, payload.label),
        visible: view.visible,
      } : undefined,
      view.projections.get(payload.label),
    );
    view.projections.set(payload.label, projected);
    void syncMemberFrame(view, payload).then((committed) => {
      if (committed) view.slots.commit(payload);
    }).catch((error) => console.error("pane member bounds 실패", error));
  }));
  view.unlisten.push(await listen<PluginViewNodeFrame>(node, ({ payload }) => {
    const key = `${payload.node}\u0000${payload.label}`;
    const projected = projectPluginViewNode(
      view.container,
      payload,
      view.projections.get(key),
    );
    view.projections.set(key, projected);
  }));
  view.unlisten.push(await listen<PluginViewRpcRequest>(rpc, ({ payload }) => {
    void handleCall(view, payload).then(
      (value) => emitTo(renderer, event(renderer, "response"), {
        id: payload.id, ok: true, value,
      } satisfies PluginViewRpcResponse),
      (error) => emitTo(renderer, event(renderer, "response"), {
        id: payload.id, ok: false, error: String(error),
      } satisfies PluginViewRpcResponse),
    );
  }));

  view.observer = new ResizeObserver(() => {
    void syncPaneFrame(view).catch((error) => console.error("pane host bounds 실패", error));
  });
  view.observer.observe(input.container);
  const rect = rectOf(input.container);
  const url = new URL("/plugin-view.html", window.location.href);
  url.searchParams.set("parent", windowLabel);
  url.searchParams.set("renderer", renderer);
  await invoke("webview_open", {
    label: renderer, url: url.toString(), ...rect, transparent: true,
  });
  await view.visibility.request(view.visible);
  return view;
}

function disposeView(view: PresentedState): void {
  if (view.disposed) return;
  view.disposed = true;
  view.observer.disconnect();
  view.slots.dispose();
  for (const subscription of view.subscriptions.values()) subscription.dispose();
  view.subscriptions.clear();
  for (const off of view.unlisten.splice(0)) void off();
  void view.sidecars.dispose().catch(() => {});
  void emitTo(view.renderer, event(view.renderer, "shutdown"), null).catch(() => {});
  for (const label of view.members) {
    if (state.memberOwnership.release(label, view.renderer)) {
      void view.app.webview.close(label)
        .catch(() => {})
        .finally(() => releasePaneSurface(label, view.nativeHostId));
    }
  }
  void invoke("webview_close", { label: view.renderer }).catch(() => {});
  view.container.removeAttribute(TAURI_PANE_RENDERER_ATTR);
  state.views.delete(view.nativeHostId);
  state.readiness.delete(view.nativeHostId);
}

export function pluginViewPresentationStatus() {
  return state.readiness.status();
}

export async function pluginViewPaneHostsStatus() {
  const native = await invoke<NativePaneFact[]>("webview_pane_hosts");
  const bindings = [...state.views.values()].map((view) => ({
    nativeHostId: view.nativeHostId,
    logicalPaneId: view.logicalPaneId,
    viewId: view.viewId,
  }));
  return exposePaneHostIdentities(native, bindings);
}

export async function pluginViewCompositionStatus() {
  const windowLabel = currentWindowLabel();
  const sampledAtUnixMs = presentationNowUnixMs();
  const dom = [...state.views.values()]
    .filter((view) => view.grouped && !view.disposed)
    .map((view) => ({
      pane: view.nativeHostId,
      viewId: view.viewId,
      frame: rectOf(view.container),
      members: view.slots.frames().map((slot) => ({
        label: slot.label,
        topologyPath: view.viewId
          ? contentCompositionTopologyPath(windowLabel, view.viewId, slot.label)
          : null,
        frame: { x: slot.x, y: slot.y, w: slot.w, h: slot.h },
        viewport: {
          w: slot.rootW, h: slot.rootH, revision: slot.revision,
          reportedAtUnixMs: slot.reportedAtUnixMs,
          receivedAtUnixMs: slot.receivedAtUnixMs,
        },
      })),
    }));
  const native = await invoke<NativePaneFact[]>("webview_pane_hosts");
  const result = comparePanePresentation(dom, native, windowLabel);
  const { ok, ...facts } = result;
  return {
    ...facts,
    matched: ok,
    sampledAtUnixMs,
    verdict: ok ? "green" as const : "red" as const,
  };
}

/**
 * 메인 DOM settle과 별개인 child renderer→native member 거래가 현재 pane viewport에
 * 커밋될 때까지 사건으로 기다린다. timeout은 실패를 유한하게 만들 뿐 상태를 폴링하지 않는다.
 *
 * **호스트 frame을 바꾼 거래는 전부 이 배리어로 닫는다.** child renderer는 자기
 * ResizeObserver/`resize`로만 새 크기를 알게 되고 비전면 WKWebView에서 그 사건은 미뤄지므로,
 * 부르지 않은 거래는 renderer 평면이 직전 거래를 그대로 든 채 끝난다(창 resize에서 실측:
 * host/native는 새 크기, renderer는 한 거래 전 크기).
 *
 * 기다림이 시간 안에 안 닫혀도 던지지 않는다 — 못 닫힌 사실은 이어지는 관측이 stale한 frame과
 * `presented=false`로 답한다. 여기서 예외로 바꾸면 정착 하나 때문에 거래 자체가 죽고, 남는 것은
 * 사실이 아니라 사고다. 판정은 부른 쪽이 한다.
 */
export async function settlePluginViewComposition(timeoutMs = 10_000): Promise<void> {
  const views = [...state.views.values()].filter((view) => view.grouped && !view.disposed);
  await Promise.all(views.map(async (view) => {
    // Main renderer가 소유한 host frame을 현재 공개 DOM에 먼저 확정한다.
    await syncPaneFrame(view);
    const root = rectOf(view.container);
    // waiter를 먼저 등록해 즉시 돌아오는 child report와의 경쟁을 닫는다. 비전면 WebKit의
    // ResizeObserver에 기대지 않고 동일 reporter를 명시적 사건으로 한 번 실행한다.
    const committed = [...view.members].map((label) =>
      view.slots.waitCommittedRoot(label, root.w, root.h, timeoutMs));
    await emitTo(view.renderer, event(view.renderer, "measure"), null);
    await Promise.allSettled(committed);
  }));
}

/** 같은 배리어로 정착시킨 뒤 live DOM↔native를 판정한다. 안 맞으면 그 delta를 이름으로 던진다. */
export async function awaitPluginViewComposition(timeoutMs = 10_000) {
  await settlePluginViewComposition(timeoutMs);
  const result = await pluginViewCompositionStatus();
  if (result.verdict !== "green") {
    throw new Error(`pane composition commit 불일치: ${JSON.stringify(result)}`);
  }
  return result;
}

export async function pluginViewNativeContractStatus() {
  const windowLabel = currentWindowLabel();
  const native = await invoke<NativePaneFact[]>("webview_pane_hosts");
  return comparePaneNativeContracts(native, windowLabel);
}

export function awaitPluginViewPresentation(
  minGrouped: number,
  timeoutMs = 30_000,
) {
  return state.readiness.wait(minGrouped, timeoutMs);
}

const host: PluginViewPresentationHost = {
  mount(input) {
    let view: PresentedState | null = null;
    let disposed = false;
    let desiredContext = input.context;
    let desiredLogicalPaneId = input.logicalPaneId;
    let desiredVisible = input.context.isVisible();
    const signal = createPluginViewReadySignal();
    const markReady = () => void signal.markReady();
    // 실패 사유는 화면 카드(ready 거절)와 status 축 둘 다로 나간다 — 채널이 하나면 그 채널을
    // 안 보는 소비자에게는 없는 사실이 된다.
    const markFailed = (reason: string) => {
      if (!signal.markFailed(reason)) return;
      input.context.setStatus({ code: "error", message: reason });
    };
    // 활성 실패는 언제나 사유로 남는다. 준비를 거절하는 것은 등록된 뷰가 하나도 없을 때뿐이다 —
    // 등록을 마친 뒤 죽은 플러그인의 뷰는 이미 오고 있고, 그것을 거절하면 살아 있는 표면을 죽인다.
    const reportActivationFailure = (reason: string, registeredViews: number) => {
      if (registeredViews > 0) {
        input.context.setStatus({ code: "error", message: reason });
        return;
      }
      markFailed(reason);
    };
    input.container.setAttribute(TAURI_PANE_RENDERER_ATTR, "pending");
    void createPresentedView(input, markReady, markFailed, reportActivationFailure).then((created) => {
      if (disposed) {
        disposeView(created);
        return;
      }
      view = created;
      view.context = desiredContext;
      view.logicalPaneId = desiredLogicalPaneId;
      view.visible = desiredVisible;
      void view.visibility.request(desiredVisible).catch((error) => {
        console.error("pane presentation visibility 실패", error);
      });
      void emitTo(view.renderer, event(view.renderer, "context"), {
        projectId: desiredContext.projectId, root: desiredContext.root,
        paneId: desiredContext.paneId, viewId: desiredContext.viewId,
        boundViewId: desiredContext.boundViewId, command: desiredContext.command,
        restore: desiredContext.restore, visible: desiredVisible,
      });
    }).catch((error) => {
      markFailed(String(error));
      input.container.removeAttribute(TAURI_PANE_RENDERER_ATTR);
      console.error("Tauri plugin view renderer 생성 실패", error);
    });
    return {
      ready: signal.ready,
      update(context) {
        desiredContext = context;
        if (!view) return;
        view.context = context;
        void emitTo(view.renderer, event(view.renderer, "context"), {
          projectId: context.projectId, root: context.root, paneId: context.paneId,
          viewId: context.viewId, boundViewId: context.boundViewId, command: context.command,
          restore: context.restore, visible: context.isVisible(),
        });
      },
      setLogicalPaneId(logicalPaneId) {
        desiredLogicalPaneId = logicalPaneId;
        if (view) view.logicalPaneId = logicalPaneId;
      },
      setVisible(visible) {
        desiredVisible = visible;
        if (!view) return;
        view.visible = visible;
        void view.visibility.request(visible).catch((error) => {
          console.error("pane presentation visibility 실패", error);
        });
      },
      dispose() {
        disposed = true;
        // 해제는 뷰의 사실이 아니라 호스트의 결정이다 — status 축에 오류로 남기지 않는다.
        signal.markFailed("plugin presentation이 준비되기 전에 해제되었습니다");
        if (view) disposeView(view);
        else input.container.removeAttribute(TAURI_PANE_RENDERER_ATTR);
      },
    };
  },
  async presentationSettled() {
    // 세 단계의 시간을 따로 남긴다 — 합계만 알면 고칠 자리를 못 찾는다(실측 2026-08-09:
    // 정착 100~250ms 가 전부 이 배리어였는데 어느 단계인지 물을 자리가 없었다).
    const views = [...state.views.values()].filter((view) => !view.disposed);
    const at = performance.now();
    await Promise.all(views.map((view) => view.visibility.settled()));
    const visibilityMs = Math.round(performance.now() - at);
    const compositionAt = performance.now();
    await awaitPluginViewComposition();
    const compositionMs = Math.round(performance.now() - compositionAt);
    const presentedAt = performance.now();
    // 무엇이 지금 화면에 있는가는 문서의 선언이 안다 — 뷰의 기억만 믿으면 사라진 표면을
    // 계속 기다린다(실측 2026-08-09: 탭 목록에 없는 표면 하나를 100ms 기다리고 있었다).
    const declared = new Set<string>([
      ...[...document.querySelectorAll<HTMLElement>(`[${TAURI_PANE_RENDERER_ATTR}]`)]
        .map((node) => node.getAttribute(TAURI_PANE_RENDERER_ATTR) ?? "")
        .filter(Boolean),
      ...[...document.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)]
        .map((node) => node.getAttribute(CONTENT_VIEW_BODY) ?? "")
        .filter(Boolean),
    ]);
    const labels = presentationBarrierLabels(views, declared);
    const each: Array<[string, number]> = [];
    await Promise.all(labels.map(async (label) => {
      const one = performance.now();
      await invoke("webview_presented", { label });
      each.push([label, Math.round(performance.now() - one)]);
    }));
    lastPresentationCost = {
      visibilityMs,
      compositionMs,
      presentedMs: Math.round(performance.now() - presentedAt),
      each: each.sort((left, right) => right[1] - left[1]),
    };
  },
};

/** 직전 확인 구간의 분해 — 관측면(진단이 이 값을 읽는다). */
let lastPresentationCost: {
  visibilityMs: number;
  compositionMs: number;
  presentedMs: number;
  each: Array<[string, number]>;
} | null = null;

export function pluginViewPresentationCost() {
  return lastPresentationCost;
}

export function installPluginViewPresentation(): void {
  registerPluginViewPresentationHost(host);
}

/**
 * PaneSurfaceHost와 메인 WebKit 합성기는 포커스와 무관하게 같은 절대 epoch를 소비한다.
 * 포커스는 입력·조명 상태일 뿐 presentation clock capability가 아니다. 포커스를 잃었다는
 * 이유로 React commit 뒤 native snap으로 바꾸면 두 별도 compositor 사이에 실제 한 표시
 * 프레임이 생긴다.
 */
export const presentedTransitionMode = (): "glide" => "glide";

export async function preparePresentedPluginViewMove(
  moves: readonly LayoutMove[],
  timing: ExternalSurfaceTransitionTiming,
): Promise<PreparedLayoutTransition> {
  const byView = new Map(moves.map((move) => [move.viewId, move]));
  const targets = [...state.views.values()].flatMap((view) => {
    if (!view.grouped || !view.visible || !view.viewId) return [];
    const move = byView.get(view.viewId);
    if (!move || Math.abs(move.dx) < 0.5) return [];
    const before = rectOf(view.container);
    return [{ view, target: { ...before, x: before.x - Math.round(move.dx) } }];
  });
  if (!targets.length) return { mode: "glide", commit: async () => {}, cancel: () => {} };
  // PaneSurfaceHost는 renderer/member의 공통 presentation owner다. 메인 projection의 FLIP과
  // 같은 절대 epoch·duration을 사용한다. 포커스 여부로 거래 방식을 바꾸지 않으며 host의
  // 자식 frame은 전환 중 한 번도 쓰지 않는다.
  presentedTransitionMode();
  const { startAtUnixMs, durationMs } = timing;
  await Promise.all(targets.map(({ view, target }) => invoke("webview_pane_transition_prepare", {
    pane: view.nativeHostId, ...target, startAtUnixMs, durationMs,
  })));
  return { mode: "glide", startAtUnixMs, durationMs, commit: async () => {}, cancel: () => {} };
}
