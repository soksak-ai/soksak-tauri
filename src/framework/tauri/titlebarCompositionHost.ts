import { moduleState } from "../../lib/moduleState";
import { onPluginEvent } from "../../plugins/hooks";
import {
  TRAFFIC_LIGHT_ROLES,
  cssRectToPhysical,
  judgeTitlebarComposition,
  type PhysicalRect,
  type TitlebarCompositionVerdict,
  type TitlebarElement,
  type TrafficLightRole,
} from "./titlebarComposition";

export const TAURI_TITLEBAR_RESERVATION_NODE_PREFIX = "tauri/titlebar/traffic-light/";
export const TITLEBAR_NODE_ADDRESS = "titlebar";
export const TITLEBAR_COMPOSITION_EVENT = "soksak:tauri-titlebar-composition";

export interface NativeTitlebarState {
  schemaVersion: 2;
  kind: "tauri-titlebar-native-state";
  window: string;
  sequence: number;
  coordinateContract: "physical px, viewport top-left";
  cssToPhysicalScale: number;
  viewportPhysical: { w: number; h: number };
  buttons: readonly (TitlebarElement | null)[];
  declaredButtons: readonly (TitlebarElement | null)[];
  backings: readonly (NativeTitlebarBackingElement | null)[];
  windowKey: boolean;
  backingHiddenContract: boolean;
  owner: {
    installed: boolean;
    identity: string | null;
    drawOwnerCount: number;
    targetSequence: number;
    appliedTargetSequence: number;
    drawSequence: number;
    mutationSequence: number;
    applying: boolean;
    lastApplyOk: boolean;
    windowVisible: boolean;
  };
}

export interface NativeTitlebarBackingElement extends TitlebarElement {
  directHidden: boolean | null;
  expectedHidden: boolean;
  count: number;
  immediateBelowButton: boolean;
  hiddenMatchesWindowKey: boolean;
}

export type TitlebarCompositionStatus = Omit<TitlebarCompositionVerdict, "checks" | "issues" | "verdict"> & {
  schemaVersion: 2;
  kind: "tauri-titlebar-composition";
  window: string;
  nativeSequence: number;
  cssToPhysicalScale: number;
  viewportPhysical: { w: number; h: number };
  titlebarPhysical: PhysicalRect | null;
  reservations: readonly (TitlebarElement | null)[];
  buttons: readonly (TitlebarElement | null)[];
  declaredButtons: readonly (TitlebarElement | null)[];
  backings: readonly (NativeTitlebarBackingElement | null)[];
  windowKey: boolean;
  backingHiddenContract: boolean;
  owner: NativeTitlebarState["owner"];
  checks: TitlebarCompositionVerdict["checks"] & {
    nativeOwner: boolean;
    backingHierarchy: boolean;
    backingVisibility: boolean;
  };
  issues: (TitlebarCompositionVerdict["issues"][number]
    | "native-owner" | "backing-hierarchy" | "backing-visibility")[];
  verdict: "green" | "red";
};

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

type RectReader = (element: Element) => RectLike;
type Publish = (event: typeof TITLEBAR_COMPOSITION_EVENT, status: TitlebarCompositionStatus) => void;
type ReadNative = () => Promise<NativeTitlebarState>;

export interface TitlebarComposeRequest {
  titlebarPhysical: PhysicalRect;
  cssToPhysicalScale: number;
  expectedOwnerIdentity: string;
  expectedSequence: number;
}

type ComposeNative = (request: TitlebarComposeRequest) => Promise<NativeTitlebarState>;

export interface TitlebarCompositionHostOptions {
  document?: Document;
  readNative: ReadNative;
  composeNative: ComposeNative;
  rectOf?: RectReader;
  publish?: Publish;
  observeDom?: boolean;
  observeWindow?: boolean;
}

const host = moduleState("framework/tauri/titlebarCompositionHost#host", () => ({
  installed: false,
  installPromise: null as Promise<boolean> | null,
  generation: 0,
  document: null as Document | null,
  readNative: null as ReadNative | null,
  composeNative: null as ComposeNative | null,
  rectOf: null as RectReader | null,
  publish: null as Publish | null,
  observer: null as MutationObserver | null,
  resizeObserver: null as ResizeObserver | null,
  resizeObserved: null as HTMLElement | null,
  removeWindowObserver: null as (() => void) | null,
  removeZoomObserver: null as (() => void) | null,
  queued: false,
  tail: Promise.resolve() as Promise<void>,
  current: null as TitlebarCompositionStatus | null,
}));

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

const TITLEBAR_NATIVE_STATE_UNAVAILABLE_MESSAGES = new Set([
  // Tauri's invoke boundary rejects an unregistered command with this exact message.
  "Command titlebar_native_state not found",
  // An adapter may explicitly declare the same platform boundary unavailable.
  "Command titlebar_native_state is not supported",
]);

function isTitlebarNativeStateUnavailable(error: unknown): boolean {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : null;
  return message !== null && TITLEBAR_NATIVE_STATE_UNAVAILABLE_MESSAGES.has(message);
}

function isRole(value: string | null): value is TrafficLightRole {
  return value !== null && (TRAFFIC_LIGHT_ROLES as readonly string[]).includes(value);
}

function isRect(value: unknown): value is PhysicalRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return [rect.x, rect.y, rect.w, rect.h].every((part) => typeof part === "number")
    && finitePositive(rect.w as number)
    && finitePositive(rect.h as number)
    && Number.isFinite(rect.x as number)
    && Number.isFinite(rect.y as number);
}

function isElement(value: unknown): value is TitlebarElement | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const element = value as { role?: unknown; rect?: unknown; hidden?: unknown };
  return typeof element.role === "string"
    && isRole(element.role)
    && (element.rect === null || isRect(element.rect))
    && (element.hidden === undefined || typeof element.hidden === "boolean");
}

function isBackingElement(value: unknown): value is NativeTitlebarBackingElement | null {
  if (value === null) return true;
  if (!isElement(value)) return false;
  const backing = value as Partial<NativeTitlebarBackingElement>;
  return (backing.directHidden === null || typeof backing.directHidden === "boolean")
    && typeof backing.expectedHidden === "boolean"
    && typeof backing.count === "number"
    && Number.isSafeInteger(backing.count)
    && backing.count >= 0
    && typeof backing.immediateBelowButton === "boolean"
    && typeof backing.hiddenMatchesWindowKey === "boolean";
}

/** Native IPC is an untrusted boundary. An invalid fact set is never projected into DOM. */
export function isNativeTitlebarState(value: unknown): value is NativeTitlebarState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<NativeTitlebarState>;
  const owner = state.owner;
  const ownerSequence = (part: unknown): part is number => typeof part === "number"
    && Number.isSafeInteger(part) && part >= 0;
  return state.schemaVersion === 2
    && state.kind === "tauri-titlebar-native-state"
    && typeof state.window === "string"
    && state.window.length > 0
    && typeof state.sequence === "number"
    && Number.isSafeInteger(state.sequence)
    && state.sequence >= 0
    && state.coordinateContract === "physical px, viewport top-left"
    && typeof state.cssToPhysicalScale === "number"
    && finitePositive(state.cssToPhysicalScale)
    && !!state.viewportPhysical
    && finitePositive(state.viewportPhysical.w)
    && finitePositive(state.viewportPhysical.h)
    && Array.isArray(state.buttons)
    && state.buttons.every(isElement)
    && Array.isArray(state.declaredButtons)
    && state.declaredButtons.every(isElement)
    && Array.isArray(state.backings)
    && state.backings.every(isBackingElement)
    && typeof state.windowKey === "boolean"
    && typeof state.backingHiddenContract === "boolean"
    && !!owner
    && typeof owner.installed === "boolean"
    && (owner.identity === null || typeof owner.identity === "string")
    && ownerSequence(owner.drawOwnerCount)
    && ownerSequence(owner.targetSequence)
    && ownerSequence(owner.appliedTargetSequence)
    && ownerSequence(owner.drawSequence)
    && ownerSequence(owner.mutationSequence)
    && typeof owner.applying === "boolean"
    && typeof owner.lastApplyOk === "boolean"
    && typeof owner.windowVisible === "boolean"
    && owner.targetSequence === state.sequence
    && owner.appliedTargetSequence <= owner.targetSequence;
}

function cssRect(rect: RectLike): PhysicalRect {
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function elementByRole(
  items: readonly (TitlebarElement | null)[],
  role: TrafficLightRole,
): TitlebarElement | null {
  const matches = items.filter((item) => item?.role === role);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function reservationNode(role: TrafficLightRole): string {
  return `${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}${role}`;
}

function reservationRole(element: Element): TrafficLightRole | null {
  const address = element.getAttribute("data-node");
  if (!address?.startsWith(TAURI_TITLEBAR_RESERVATION_NODE_PREFIX)) return null;
  const role = address.slice(TAURI_TITLEBAR_RESERVATION_NODE_PREFIX.length);
  return isRole(role) ? role : null;
}

function slots(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(
    `[data-node^="${TAURI_TITLEBAR_RESERVATION_NODE_PREFIX}"]`,
  ));
}

function titlebarOf(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[data-node="${TITLEBAR_NODE_ADDRESS}"]`);
}

function titlebarCssRect(doc: Document, rectOf: RectReader): PhysicalRect | null {
  const titlebar = titlebarOf(doc);
  return titlebar ? cssRect(rectOf(titlebar)) : null;
}

function assertComposeReceipt(
  read: NativeTitlebarState,
  receipt: NativeTitlebarState,
): void {
  if (receipt.window !== read.window) {
    throw new Error("titlebar_compose returned a receipt for another window");
  }
  if (receipt.owner.identity !== read.owner.identity) {
    throw new Error("titlebar_compose returned a receipt from another native owner generation");
  }
  if (!Number.isSafeInteger(read.sequence + 1) || receipt.sequence !== read.sequence + 1) {
    throw new Error("titlebar_compose receipt must advance exactly one transaction");
  }
}

async function readAndCompose(
  doc: Document,
  rectOf: RectReader,
  readNative: ReadNative,
  composeNative: ComposeNative,
): Promise<NativeTitlebarState> {
  const read: unknown = await readNative();
  if (!isNativeTitlebarState(read)) {
    throw new Error("titlebar_native_state returned an invalid contract");
  }
  const css = titlebarCssRect(doc, rectOf);
  if (!css) return read;
  const titlebarPhysical = cssRectToPhysical(css, read.cssToPhysicalScale);
  if (!titlebarPhysical) {
    throw new Error("public titlebar DOM rect is not finite and positive");
  }
  if (!read.owner.installed || !read.owner.identity) {
    throw new Error("titlebar composition requires one installed native owner generation");
  }
  const request: TitlebarComposeRequest = {
    titlebarPhysical,
    cssToPhysicalScale: read.cssToPhysicalScale,
    expectedOwnerIdentity: read.owner.identity,
    expectedSequence: read.sequence,
  };
  const receipt: unknown = await composeNative(request);
  if (!isNativeTitlebarState(receipt)) {
    throw new Error("titlebar_compose returned an invalid contract");
  }
  assertComposeReceipt(read, receipt);
  return receipt;
}

/**
 * AppKit's three native button frames are projected to three transparent, addressable DOM slots.
 * Their geometry is not guessed from padding: it is the native physical frame divided by the
 * explicitly reported CSS-to-backing scale.
 */
export function syncTitlebarReservationSlots(
  doc: Document,
  state: NativeTitlebarState,
): HTMLElement[] {
  const titlebar = titlebarOf(doc);
  if (!titlebar || !isNativeTitlebarState(state)) {
    for (const slot of slots(doc)) slot.remove();
    return [];
  }

  const existing = slots(doc);
  const kept = new Set<HTMLElement>();
  const result: HTMLElement[] = [];
  for (const role of TRAFFIC_LIGHT_ROLES) {
    const matches = existing.filter((slot) => reservationRole(slot) === role);
    const slot = matches.shift() ?? doc.createElement("span");
    for (const duplicate of matches) duplicate.remove();
    kept.add(slot);
    slot.setAttribute("data-node", reservationNode(role));
    slot.setAttribute("aria-hidden", "true");
    const native = elementByRole(state.buttons, role);
    const rect = native?.rect;
    slot.style.position = "fixed";
    slot.style.boxSizing = "border-box";
    slot.style.pointerEvents = "none";
    if (rect) {
      const scale = state.cssToPhysicalScale;
      slot.style.display = "block";
      slot.style.left = `${rect.x / scale}px`;
      slot.style.top = `${rect.y / scale}px`;
      slot.style.width = `${rect.w / scale}px`;
      slot.style.height = `${rect.h / scale}px`;
    } else {
      slot.style.display = "none";
      slot.style.removeProperty("left");
      slot.style.removeProperty("top");
      slot.style.removeProperty("width");
      slot.style.removeProperty("height");
    }
    if (slot.parentElement !== titlebar) titlebar.appendChild(slot);
    result.push(slot);
  }
  for (const stale of existing) {
    if (!kept.has(stale)) stale.remove();
  }
  const currentOrder = slots(doc).filter((slot) => slot.parentElement === titlebar);
  const canonicalOrder = currentOrder.length === result.length
    && result.every((slot, index) => currentOrder[index] === slot);
  if (!canonicalOrder) {
    for (const slot of result) titlebar.appendChild(slot);
  }
  return result;
}

function readReservations(
  doc: Document,
  state: NativeTitlebarState,
  rectOf: RectReader,
): (TitlebarElement | null)[] {
  return slots(doc).map((slot) => {
    const role = reservationRole(slot);
    if (!role || slot.style.display === "none") return null;
    const physical = cssRectToPhysical(cssRect(rectOf(slot)), state.cssToPhysicalScale);
    return { role, rect: physical };
  });
}

/** Read one committed 3:3 composition ledger in the sole physical coordinate contract. */
export function readTitlebarComposition(
  doc: Document,
  state: NativeTitlebarState,
  rectOf: RectReader = (element) => element.getBoundingClientRect(),
): TitlebarCompositionStatus {
  const titlebar = titlebarOf(doc);
  const titlebarPhysical = titlebar
    ? cssRectToPhysical(cssRect(rectOf(titlebar)), state.cssToPhysicalScale)
    : null;
  const reservations = readReservations(doc, state, rectOf);
  const verdict = judgeTitlebarComposition({
    titlebar: titlebarPhysical,
    reservations,
    buttons: state.buttons,
    declaredButtons: state.declaredButtons,
    backings: state.backings,
  });
  const nativeOwner = state.owner.installed
    && state.owner.identity !== null
    && state.owner.drawOwnerCount === 1
    && state.owner.targetSequence > 0
    && state.owner.appliedTargetSequence === state.owner.targetSequence
    && !state.owner.applying
    && state.owner.lastApplyOk;
  const backingHierarchy = state.backings.length === TRAFFIC_LIGHT_ROLES.length
    && state.backings.every((backing) => backing !== null
      && backing.count === 1
      && backing.immediateBelowButton);
  const backingVisibility = state.backingHiddenContract
    && state.backings.length === TRAFFIC_LIGHT_ROLES.length
    && state.backings.every((backing) => backing !== null
      && backing.hiddenMatchesWindowKey
      && backing.directHidden === backing.expectedHidden);
  const checks = { ...verdict.checks, nativeOwner, backingHierarchy, backingVisibility };
  const issues: TitlebarCompositionStatus["issues"] = [...verdict.issues];
  if (!nativeOwner) issues.push("native-owner");
  if (!backingHierarchy) issues.push("backing-hierarchy");
  if (!backingVisibility) issues.push("backing-visibility");
  return {
    schemaVersion: 2,
    kind: "tauri-titlebar-composition",
    window: state.window,
    nativeSequence: state.sequence,
    cssToPhysicalScale: state.cssToPhysicalScale,
    viewportPhysical: state.viewportPhysical,
    titlebarPhysical,
    reservations,
    buttons: state.buttons,
    declaredButtons: state.declaredButtons,
    backings: state.backings,
    windowKey: state.windowKey,
    backingHiddenContract: state.backingHiddenContract,
    owner: state.owner,
    ...verdict,
    checks,
    issues,
    verdict: verdict.verdict === "green"
      && nativeOwner && backingHierarchy && backingVisibility ? "green" : "red",
  };
}

function commit(status: TitlebarCompositionStatus, publish: Publish): void {
  host.current = status;
  publish(TITLEBAR_COMPOSITION_EVENT, status);
}

function composeInstalledHost(): Promise<TitlebarCompositionStatus | null> {
  if (
    !host.installed
    || !host.document
    || !host.readNative
    || !host.composeNative
    || !host.rectOf
    || !host.publish
  ) {
    return Promise.resolve(null);
  }
  const doc = host.document;
  const readNative = host.readNative;
  const composeNative = host.composeNative;
  const rectOf = host.rectOf;
  const publish = host.publish;
  const generation = host.generation;
  const execute = async (): Promise<TitlebarCompositionStatus> => {
    if (generation !== host.generation || !host.installed) {
      throw new Error("titlebar composition host generation changed before compose");
    }
    const value = await readAndCompose(doc, rectOf, readNative, composeNative);
    if (generation !== host.generation || !host.installed) {
      throw new Error("titlebar composition host generation changed during compose");
    }
    syncTitlebarReservationSlots(doc, value);
    const status = readTitlebarComposition(doc, value, rectOf);
    commit(status, publish);
    return status;
  };
  const transaction = host.tail.then(execute, execute);
  host.tail = transaction.then(() => undefined, () => undefined);
  return transaction;
}

function inspectInstalledHost(): Promise<TitlebarCompositionStatus | null> {
  if (!host.installed || !host.document || !host.readNative || !host.rectOf) {
    return Promise.resolve(null);
  }
  const doc = host.document;
  const readNative = host.readNative;
  const rectOf = host.rectOf;
  const generation = host.generation;
  const execute = async (): Promise<TitlebarCompositionStatus> => {
    if (generation !== host.generation || !host.installed) {
      throw new Error("titlebar composition host generation changed before inspection");
    }
    const value: unknown = await readNative();
    if (generation !== host.generation || !host.installed) {
      throw new Error("titlebar composition host generation changed during inspection");
    }
    if (!isNativeTitlebarState(value)) {
      throw new Error("titlebar_native_state returned an invalid contract");
    }
    // Inspection must not heal the evidence: no compose, slot sync, publish, or current-status write.
    return readTitlebarComposition(doc, value, rectOf);
  };
  const inspection = host.tail.then(execute, execute);
  host.tail = inspection.then(() => undefined, () => undefined);
  return inspection;
}

function bindTitlebarResizeObserver(): void {
  if (!host.resizeObserver || !host.document) return;
  const next = titlebarOf(host.document);
  if (next === host.resizeObserved) return;
  if (host.resizeObserved) host.resizeObserver.unobserve(host.resizeObserved);
  host.resizeObserved = next;
  if (next) host.resizeObserver.observe(next);
}

function scheduleRefresh(): void {
  if (host.queued || !host.installed) return;
  host.queued = true;
  queueMicrotask(() => {
    host.queued = false;
    void composeInstalledHost().catch(() => {
      // The native command existed at install time; a later transport failure is observable to the
      // explicit command caller. We retain the last committed status instead of fabricating facts.
    });
  });
}

function containsTitlebar(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  const selector = `[data-node="${TITLEBAR_NODE_ADDRESS}"]`;
  return element.matches(selector) || element.querySelector(selector) !== null;
}

function titlebarStructureChanged(records: MutationRecord[]): boolean {
  const selector = `[data-node="${TITLEBAR_NODE_ADDRESS}"]`;
  return records.some((record) => {
    if (record.target.nodeType === 1 && (record.target as Element).matches(selector)) return true;
    return [...record.addedNodes, ...record.removedNodes].some(containsTitlebar);
  });
}

/** Read-only gate: judge the current native facts against the current DOM without repairing either. */
export async function inspectTitlebarComposition(): Promise<TitlebarCompositionStatus> {
  const status = await inspectInstalledHost();
  if (!status) throw new Error("Tauri macOS titlebar composition host is not installed");
  return status;
}

/** Explicit mutation: compose from the public DOM target and return that transaction's receipt. */
export async function composeTitlebarComposition(): Promise<TitlebarCompositionStatus> {
  const status = await composeInstalledHost();
  if (!status) throw new Error("Tauri macOS titlebar composition host is not installed");
  return status;
}

export function currentTitlebarComposition(): TitlebarCompositionStatus | null {
  return host.current;
}

/**
 * Install only when the macOS-only native command exists. Absence means this adapter boundary does
 * not apply; it does not create an `unsupported` result, DOM marker, event or public status.
 */
export async function installTitlebarCompositionHost(
  options: TitlebarCompositionHostOptions,
): Promise<boolean> {
  if (host.installed) return true;
  if (host.installPromise) return host.installPromise;
  const generation = host.generation;
  const installation = installTitlebarCompositionHostGeneration(options, generation);
  host.installPromise = installation;
  try {
    return await installation;
  } finally {
    if (host.installPromise === installation) host.installPromise = null;
  }
}

async function installTitlebarCompositionHostGeneration(
  options: TitlebarCompositionHostOptions,
  generation: number,
): Promise<boolean> {
  const doc = options.document ?? document;
  const rectOf = options.rectOf ?? ((element: Element) => element.getBoundingClientRect());
  let read: unknown;
  try {
    read = await options.readNative();
  } catch (error) {
    if (isTitlebarNativeStateUnavailable(error)) return false;
    throw error;
  }
  if (generation !== host.generation) return false;
  if (!isNativeTitlebarState(read)) {
    throw new Error("titlebar_native_state returned an invalid contract");
  }
  let initial = read;
  const titlebarCss = titlebarCssRect(doc, rectOf);
  if (titlebarCss) {
    const titlebarPhysical = cssRectToPhysical(titlebarCss, read.cssToPhysicalScale);
    if (!titlebarPhysical) {
      throw new Error("public titlebar DOM rect is not finite and positive");
    }
    if (!read.owner.installed || !read.owner.identity) {
      throw new Error("titlebar composition requires one installed native owner generation");
    }
    initial = await options.composeNative({
      titlebarPhysical,
      cssToPhysicalScale: read.cssToPhysicalScale,
      expectedOwnerIdentity: read.owner.identity,
      expectedSequence: read.sequence,
    });
    if (!isNativeTitlebarState(initial)) {
      throw new Error("titlebar_compose returned an invalid contract");
    }
    if (generation !== host.generation) return false;
    assertComposeReceipt(read, initial);
  }

  if (generation !== host.generation) return false;
  host.installed = true;
  host.document = doc;
  host.readNative = options.readNative;
  host.composeNative = options.composeNative;
  host.rectOf = rectOf;
  host.publish = options.publish ?? ((event, status) => {
    window.dispatchEvent(new CustomEvent(event, { detail: status }));
  });

  syncTitlebarReservationSlots(doc, initial);
  commit(readTitlebarComposition(doc, initial, host.rectOf), host.publish);

  if (options.observeDom !== false) {
    host.observer = new MutationObserver((records) => {
      if (titlebarStructureChanged(records)) {
        bindTitlebarResizeObserver();
        scheduleRefresh();
      }
    });
    host.observer.observe(doc.documentElement, { childList: true, subtree: true });
  }
  if (options.observeWindow !== false) {
    if (typeof ResizeObserver !== "undefined") {
      host.resizeObserver = new ResizeObserver(() => scheduleRefresh());
      bindTitlebarResizeObserver();
    }
    const onWindowGeometry = () => scheduleRefresh();
    window.addEventListener("resize", onWindowGeometry);
    window.addEventListener("fullscreenchange", onWindowGeometry);
    host.removeZoomObserver = onPluginEvent("window.zoom", onWindowGeometry).dispose;
    host.removeWindowObserver = () => {
      window.removeEventListener("resize", onWindowGeometry);
      window.removeEventListener("fullscreenchange", onWindowGeometry);
    };
  }
  return true;
}

export function __resetTitlebarCompositionHostForTest(): void {
  host.generation += 1;
  host.observer?.disconnect();
  host.observer = null;
  host.resizeObserver?.disconnect();
  host.resizeObserver = null;
  host.resizeObserved = null;
  host.removeWindowObserver?.();
  host.removeWindowObserver = null;
  host.removeZoomObserver?.();
  host.removeZoomObserver = null;
  if (host.document) {
    for (const slot of slots(host.document)) slot.remove();
  }
  host.installed = false;
  host.installPromise = null;
  host.document = null;
  host.readNative = null;
  host.composeNative = null;
  host.rectOf = null;
  host.publish = null;
  host.queued = false;
  host.tail = Promise.resolve();
  host.current = null;
}
