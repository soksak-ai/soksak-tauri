import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motionModeForClocks } from "../../../packages/dom-webview-compositor/src/index";
import { moduleState } from "../../lib/moduleState";
import { railTravelDeclaredMs } from "../../lib/railMotion";
import { currentWindowLabel } from "../../lib/webviewLabels";
import type { LayoutMove, PreparedLayoutTransition } from "../../lib/layoutTransitionHost";
import { surfaceRectOf } from "../../lib/surfaceRect";
import { surfaceLayoutContractOf } from "./surfaceLayoutContract";
import { classifyRendererTopology, type RendererTopologyFact } from "./surfaceAudit";
import {
  registerPluginViewPresentationHost,
  type PresentedPluginView,
  type PluginViewPresentationHost,
} from "../../plugins/viewPresentationHost";
import { viewPresentationRuntime } from "../../plugins/viewRegistry";
import { TAURI_PANE_RENDERER_ATTR } from "./holeMarkers";
import {
  type PluginViewInit,
  type PluginViewNodeFrame,
  type PluginViewRpcRequest,
  type PluginViewRpcResponse,
  type PluginViewSlotFrame,
} from "./pluginViewProtocol";
import { PluginViewSlotRegistry } from "./pluginViewSlots";
import { PluginViewReadiness } from "./pluginViewReadiness";
import { PluginViewMemberOwnership } from "./pluginViewMemberOwnership";
import { PluginViewSidecars } from "./pluginViewSidecars";
import { claimPaneSurface, releasePaneSurface } from "./surfaceOwnership";

interface DisposableLike { dispose(): void }

interface PresentedState {
  pane: string;
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
  markReady(): void;
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
  frame: PaneRect;
  members?: {
    label: string;
    frame: PaneRect;
    viewport?: { w: number; h: number; revision: number; reportedAtUnixMs: number; receivedAtUnixMs: number };
  }[];
};
type NativePaneFact = {
  pane: string;
  window: string;
  cssFrame: PaneRect;
  contractFrame?: PaneRect | null;
  memberFrames?: { label: string; cssFrame: PaneRect | null; contractFrame?: PaneRect | null }[];
  rendererTopology?: RendererTopologyFact | null;
  chromeAboveHost?: boolean;
  alpha?: number;
  [key: string]: unknown;
};

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
  existing?: HTMLElement,
): HTMLElement {
  const element = existing ?? document.createElement("div");
  element.dataset.node = `tauri/plugin-view/${frame.label}/surface`;
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

export function projectPluginViewNode(
  container: HTMLElement,
  frame: PluginViewNodeFrame,
  existing?: HTMLElement,
): HTMLElement {
  const element = existing ?? document.createElement("div");
  element.dataset.node = `tauri/plugin-view/${frame.label}/${frame.node}`;
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

const CALL_PATHS = new Set([
  "commands.execute",
  "webview.open", "webview.navigate", "webview.zoom", "webview.openWindow", "webview.history",
  "webview.present",
  "webview.stop", "webview.devtools", "webview.eval", "webview.sendInput",
  "webview.wheel", "webview.captureFull", "webview.typeText", "webview.list", "webview.close",
  "data.kv.get", "data.kv.set", "data.kv.delete", "data.kv.keys",
  "sidecar.open", "sidecar.send", "sidecar.close",
  "bus.emit",
  "context.setBadge", "context.setStatus", "context.setTitle", "context.setIcon",
  "context.setRestoreState",
]);

export function isPluginViewCallExposed(path: string): boolean {
  return CALL_PATHS.has(path);
}

const SUBSCRIBE_PATHS = new Set([
  "events.on", "webview.on", "data.kv.watch", "bus.on", "settings.onChange",
  "sidecar.on",
  "context.onVisibilityChange",
]);

async function syncPaneFrame(view: PresentedState): Promise<void> {
  if (view.disposed) return;
  const rect = rectOf(view.container);
  if (view.grouped) {
    await invoke("webview_pane_bounds", {
      pane: view.pane,
      ...rect,
      layout: paneLayoutContractOf(view.container),
    });
  } else {
    await invoke("webview_bounds", { label: view.renderer, ...rect });
  }
}

async function syncMemberFrame(view: PresentedState, frame: PluginViewSlotFrame): Promise<boolean> {
  if (!view.grouped || !view.members.has(frame.label) || view.disposed) return false;
  await invoke("webview_pane_member_bounds", {
    pane: view.pane,
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
  return true;
}

async function openAndGroup(
  view: PresentedState,
  label: string,
  options: Record<string, unknown>,
): Promise<void> {
  const slot = await view.slots.wait(label);
  const paneRect = rectOf(view.container);
  claimPaneSurface(label, view.pane);
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
        pane: view.pane,
        renderer: view.renderer,
        members: [...view.members],
        ...paneRect,
      });
      view.grouped = true;
      state.readiness.set(view.pane, true);
      await syncPaneFrame(view);
    }
    if (await syncMemberFrame(view, slot)) view.slots.commit(slot);
    await invoke("webview_visible", { label, visible: view.visible, focus: false });
    view.markReady();
  } catch (error) {
    view.members.delete(label);
    state.memberOwnership.release(label, view.renderer);
    if (opened) await view.app.webview.close(label).catch(() => {});
    releasePaneSurface(label, view.pane);
    throw error;
  }
}

async function presentExisting(view: PresentedState, label: string): Promise<void> {
  const slot = await view.slots.wait(label);
  const paneRect = rectOf(view.container);
  claimPaneSurface(label, view.pane);
  state.memberOwnership.claim(label, view.renderer);
  try {
    view.members.add(label);
    if (!view.grouped) {
      await invoke("webview_pane_group", {
        pane: view.pane,
        renderer: view.renderer,
        members: [...view.members],
        ...paneRect,
      });
      view.grouped = true;
      state.readiness.set(view.pane, true);
      await syncPaneFrame(view);
    }
    if (await syncMemberFrame(view, slot)) view.slots.commit(slot);
    await invoke("webview_visible", { label, visible: view.visible, focus: false });
    view.markReady();
  } catch (error) {
    view.members.delete(label);
    state.memberOwnership.release(label, view.renderer);
    releasePaneSurface(label, view.pane);
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
    if (!SUBSCRIBE_PATHS.has(request.path)) throw new Error(`구독 RPC 미노출: ${request.path}`);
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
): Promise<PresentedState> {
  const runtime = viewPresentationRuntime(input.provider);
  if (!runtime) throw new Error(`nativeSurface view의 renderer 실행 재료가 없습니다: ${input.registration.pluginId}`);
  const suffix = (++state.sequence).toString(36);
  const windowLabel = currentWindowLabel();
  const renderer = `pv-${windowLabel}-${suffix}`;
  const pane = `pane-${windowLabel}-${input.context.viewId ?? suffix}`;
  const app = runtime.app() as Record<string, any>;
  const view: PresentedState = {
    pane, renderer, viewId: input.context.viewId, container: input.container,
    context: input.context, app, members: new Set(), slots: new PluginViewSlotRegistry(),
    projections: new Map(),
    subscriptions: new Map(), unlisten: [], observer: null!, grouped: false,
    disposed: false, visible: input.context.isVisible(), markReady,
    sidecars: new PluginViewSidecars(),
  };
  input.container.setAttribute(TAURI_PANE_RENDERER_ATTR, renderer);
  state.views.set(pane, view);
  state.readiness.set(pane, false);

  const ready = event(renderer, "ready");
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
  view.unlisten.push(await listen<PluginViewSlotFrame>(slot, ({ payload }) => {
    view.slots.report(payload);
    const projected = projectPluginViewSlot(
      view.container,
      payload,
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
  await invoke("webview_visible", { label: renderer, visible: view.visible, focus: false });
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
        .finally(() => releasePaneSurface(label, view.pane));
    }
  }
  void invoke("webview_close", { label: view.renderer }).catch(() => {});
  view.container.removeAttribute(TAURI_PANE_RENDERER_ATTR);
  state.views.delete(view.pane);
  state.readiness.delete(view.pane);
}

export function pluginViewPresentationStatus() {
  return state.readiness.status();
}

export async function pluginViewCompositionStatus() {
  const windowLabel = currentWindowLabel();
  const sampledAtUnixMs = Date.now();
  const dom = [...state.views.values()]
    .filter((view) => view.grouped && !view.disposed)
    .map((view) => ({
      pane: view.pane,
      frame: rectOf(view.container),
      members: view.slots.frames().map((slot) => ({
        label: slot.label,
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
 */
export async function awaitPluginViewComposition(timeoutMs = 10_000) {
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
    await Promise.all(committed);
  }));
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
    let desiredVisible = input.context.isVisible();
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let readyDone = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const markReady = () => {
      if (readyDone) return;
      readyDone = true;
      resolveReady();
    };
    input.container.setAttribute(TAURI_PANE_RENDERER_ATTR, "pending");
    void createPresentedView(input, markReady).then((created) => {
      if (disposed) {
        disposeView(created);
        return;
      }
      view = created;
      view.context = desiredContext;
      view.visible = desiredVisible;
      void invoke("webview_visible", {
        label: view.renderer, visible: desiredVisible, focus: false,
      });
      void emitTo(view.renderer, event(view.renderer, "context"), {
        projectId: desiredContext.projectId, root: desiredContext.root,
        paneId: desiredContext.paneId, viewId: desiredContext.viewId,
        boundViewId: desiredContext.boundViewId, command: desiredContext.command,
        restore: desiredContext.restore, visible: desiredVisible,
      });
    }).catch((error) => {
      if (!readyDone) {
        readyDone = true;
        rejectReady(error);
      }
      input.container.removeAttribute(TAURI_PANE_RENDERER_ATTR);
      input.context.setStatus({ code: "error", message: String(error) });
      console.error("Tauri plugin view renderer 생성 실패", error);
    });
    return {
      ready,
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
      setVisible(visible) {
        desiredVisible = visible;
        if (!view) return;
        view.visible = visible;
        void invoke("webview_visible", { label: view.renderer, visible, focus: false });
        for (const label of view.members)
          void invoke("webview_visible", { label, visible, focus: false });
        void emitTo(view.renderer, event(view.renderer, "visibility"), { visible });
      },
      dispose() {
        disposed = true;
        if (!readyDone) {
          readyDone = true;
          rejectReady(new Error("plugin presentation이 준비되기 전에 해제되었습니다"));
        }
        if (view) disposeView(view);
        else input.container.removeAttribute(TAURI_PANE_RENDERER_ATTR);
      },
    };
  },
  async presentationSettled() {
    const views = [...state.views.values()].filter((view) => !view.disposed);
    await awaitPluginViewComposition();
    await Promise.all(views
      .filter((view) => view.visible)
      .flatMap((view) => [view.renderer, ...view.members])
      .map((label) => invoke("webview_presented", { label })));
  },
};

export function installPluginViewPresentation(): void {
  registerPluginViewPresentationHost(host);
}

export const presentedTransitionMode = (windowFocused: boolean): "glide" | "snap" =>
  motionModeForClocks(windowFocused);

export async function preparePresentedPluginViewMove(
  moves: readonly LayoutMove[],
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
  // WebKit은 비전면 window의 document timeline을 멈출 수 있지만 AppKit의 media clock은
  // 계속 흐른다. 두 시계를 같은 epoch로 묶으면 native pane만 먼저 이동한다. 비전면에서는
  // prepare가 화면을 바꾸지 않고, 목표 React DOM이 커밋된 뒤 공통 host 하나를 snap한다.
  if (presentedTransitionMode(await getCurrentWindow().isFocused()) === "snap") {
    let closed = false;
    return {
      mode: "snap",
      commit: async () => {
        if (closed) return;
        closed = true;
        await Promise.all(targets.map(({ view, target }) => invoke("webview_pane_bounds", {
          pane: view.pane,
          ...target,
          layout: paneLayoutContractOf(view.container, target),
        })));
      },
      cancel: () => { closed = true; },
    };
  }
  // PaneSurfaceHost는 renderer/member의 공통 presentation owner다. 메인 projection의 FLIP과
  // 같은 절대 epoch·duration을 사용하고, host의 자식 frame은 전환 중 한 번도 쓰지 않는다.
  const startAtUnixMs = Date.now() + 100;
  const durationMs = railTravelDeclaredMs();
  await Promise.all(targets.map(({ view, target }) => invoke("webview_pane_transition_prepare", {
    pane: view.pane, ...target, startAtUnixMs, durationMs,
  })));
  return { mode: "glide", startAtUnixMs, commit: async () => {}, cancel: () => {} };
}
