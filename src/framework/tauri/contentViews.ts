// Tauri 콘텐츠 뷰 구현 — 콘텐츠가 문서 밖에 산다.
//
// 플러그인은 `data-content-view-body=<label>` 자리만 선언한다. 이 어댑터가 그 자리를 읽어
// OS 자식 뷰의 bounds·가시성·veil 착지를 전담한다. 추종 입력은 레이아웃 커밋 사건과
// ResizeObserver뿐이다. 프레임 루프나 포인터 추측은 없다.
import { invoke } from "@tauri-apps/api/core";
import { moduleState } from "../../lib/moduleState";
import {
  contentViewSlotVisible,
  findContentViewSlot,
  type ContentViewHost,
} from "../../lib/contentViews";
import { onPluginEvent, type Disposable } from "../../plugins/hooks";
import { invalidateSlotSnapshot, noteSurfaceWrite } from "./slotFreezeHost";

const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  invoke(cmd, args) as Promise<T>;

interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SurfaceState {
  label: string;
  opened: boolean;
  desiredVisible: boolean | null;
  veiled: boolean;
  lastRect: string;
  observer: ResizeObserver | null;
  requested: boolean;
  force: boolean;
  draining: Promise<void> | null;
  waiters: { resolve: () => void; reject: (reason: unknown) => void }[];
  openOptions: Record<string, unknown> | null;
}

export interface NativeContentViewCompositionFact {
  label: string;
  opened: boolean;
  desiredVisible: boolean | null;
  veiled: boolean;
  slotPresent: boolean;
  slotRect: SlotRect | null;
  appliedRect: string | null;
  syncPending: boolean;
}

const composition = moduleState("framework/tauri.fix#contentViewComposition", () => ({
  surfaces: new Map<string, SurfaceState>(),
  subscriptions: [] as Disposable[],
  installed: false,
}));

function stateOf(label: string): SurfaceState {
  let state = composition.surfaces.get(label);
  if (!state) {
    state = {
      label,
      opened: false,
      desiredVisible: null,
      veiled: false,
      lastRect: "",
      observer: null,
      requested: false,
      force: false,
      draining: null,
      waiters: [],
      openOptions: null,
    };
    composition.surfaces.set(label, state);
  }
  return state;
}

/** DOM 좌표를 네이티브 경계와 같은 정수 경계로 바꾼다. 폭/높이는 같은 양끝에서 산출한다. */
function slotRect(slot: HTMLElement): SlotRect {
  const rect = slot.getBoundingClientRect();
  const x = Math.ceil(rect.left);
  const y = Math.ceil(rect.top);
  return {
    x,
    y,
    w: Math.max(1, Math.floor(rect.right) - x),
    h: Math.max(1, Math.floor(rect.bottom) - y),
  };
}

function rectKey(rect: SlotRect): string {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function observeSlot(state: SurfaceState, slot: HTMLElement): void {
  state.observer?.disconnect();
  state.observer = new ResizeObserver(() => {
    void requestSlotSync(state).catch((error) => {
      console.error(`[content-view] 슬롯 크기 추종 실패: ${state.label}`, error);
    });
  });
  state.observer.observe(slot);
}

async function openTrackedSurface(
  state: SurfaceState,
  opts: Record<string, unknown>,
): Promise<void> {
  const slot = findContentViewSlot(state.label, document);
  const rect = slot ? slotRect(slot) : null;
  if (!rect && ![opts.x, opts.y, opts.w, opts.h].every((value) => typeof value === "number")) {
    throw new Error(`콘텐츠 뷰 자리 또는 명시 bounds가 없습니다: ${state.label}`);
  }
  const desired = state.desiredVisible ?? (slot ? contentViewSlotVisible(slot) : true);
  state.openOptions = { ...opts };
  await call("webview_open", { label: state.label, ...opts, ...(rect ?? {}) });
  state.opened = true;
  state.desiredVisible = desired;
  state.lastRect = rect ? rectKey(rect) : "";
  if (slot) observeSlot(state, slot);
  if (!desired) {
    await call("webview_visible", { label: state.label, visible: false, focus: false });
  }
}

/** 복귀 에지에서 registry가 아니라 실제 child 부착을 확인하고, 어댑터가 자기 표면을 복구한다. */
async function restoreIfDetached(state: SurfaceState): Promise<void> {
  if (!state.opened || !state.openOptions) return;
  const alive = await call<boolean>("webview_alive", { label: state.label });
  if (alive !== false) return;
  state.opened = false;
  state.lastRect = "";
  await openTrackedSurface(state, state.openOptions);
}

/**
 * 사건 폭주에서도 이전 IPC가 새 좌표 뒤에 도착하지 않도록 label별 직렬화하고, 대기 중 사건은
 * 최신 DOM rect 한 번으로 합친다. 이것은 이벤트 코얼레싱이며 반복 감시가 아니다.
 */
function requestSlotSync(state: SurfaceState, force = false): Promise<void> {
  state.requested = true;
  state.force ||= force;
  const done = new Promise<void>((resolve, reject) => state.waiters.push({ resolve, reject }));
  if (state.draining) return done;

  state.draining = (async () => {
    while (state.requested) {
      const forced = state.force;
      state.requested = false;
      state.force = false;
      if (!state.opened || state.veiled) continue;
      const slot = findContentViewSlot(state.label, document);
      if (!slot) continue;
      const rect = slotRect(slot);
      const key = rectKey(rect);
      if (!forced && key === state.lastRect) continue;
      await call<boolean>("webview_bounds", { label: state.label, ...rect });
      state.lastRect = key;
      noteSurfaceWrite(state.label);
    }
  })()
    .then(() => {
      const waiters = state.waiters.splice(0);
      for (const waiter of waiters) waiter.resolve();
    })
    .catch((error) => {
      const waiters = state.waiters.splice(0);
      for (const waiter of waiters) waiter.reject(error);
      throw error;
    })
    .finally(() => {
      state.draining = null;
      // finally 직전에 새 사건이 들어온 경우 다음 drain을 연다.
      if (state.requested) void requestSlotSync(state).catch(() => {});
    });
  // 이벤트 호출자가 반환값을 기다리지 않아도 unhandled rejection이 되지 않게 내부 drain은 받는다.
  state.draining.catch(() => {});
  return done;
}

async function setVeil(label: string, veiled: boolean, hidden: boolean): Promise<void> {
  const state = composition.surfaces.get(label);
  if (!state?.opened) return;
  state.veiled = veiled;
  if (veiled) {
    if (hidden) {
      await call("webview_visible", { label: state.label, visible: false, focus: false });
    }
    return;
  }
  // 좌표를 먼저 확정하고 그 뒤에만 드러낸다. 역순이면 옛 자리 한 프레임이 보인다.
  await restoreIfDetached(state);
  await requestSlotSync(state, true);
  await call("webview_visible", {
    label: state.label,
    visible: state.desiredVisible ?? true,
    focus: false,
  });
}

/** 이 어댑터의 DOM 사건 배선. 선택된 프레임워크 install에서만 한 번 호출한다. */
export function installNativeContentViewComposition(): void {
  if (composition.installed) return;
  composition.installed = true;
  composition.subscriptions.push(
    onPluginEvent("layout.reflow", () => {
      for (const state of composition.surfaces.values()) {
        void requestSlotSync(state).catch((error) => {
          console.error(`[content-view] 레이아웃 추종 실패: ${state.label}`, error);
        });
      }
    }),
    onPluginEvent("content-view.veiled", ({ label, veiled, hidden }) => {
      void setVeil(label, veiled, hidden).catch((error) => {
        console.error(`[content-view] veil 합성 실패: ${label}`, error);
      });
    }),
  );
}

/** 공개 합성 상태 — 슬롯·적용 rect·veil·대기 여부를 한 label 단위로 대조한다. */
export function nativeContentViewCompositionStatus(): NativeContentViewCompositionFact[] {
  return [...composition.surfaces.values()].map((state) => {
    const slot = findContentViewSlot(state.label, document);
    return {
      label: state.label,
      opened: state.opened,
      desiredVisible: state.desiredVisible,
      veiled: state.veiled,
      slotPresent: slot !== null,
      slotRect: slot ? slotRect(slot) : null,
      appliedRect: state.lastRect || null,
      syncPending: state.requested || state.draining !== null,
    };
  });
}

export const nativeHost: ContentViewHost = {
  async open(label, opts) {
    const state = stateOf(label);
    await openTrackedSurface(state, opts);
  },
  async close(label) {
    const state = composition.surfaces.get(label);
    if (state) {
      state.opened = false;
      state.observer?.disconnect();
      composition.surfaces.delete(label);
    }
    await call("webview_close", { label });
  },
  list: () => call("webview_list"),
  alive: (label) => call("webview_alive", { label }),
  navigate: (label, url) => {
    invalidateSlotSnapshot(label);
    const state = composition.surfaces.get(label);
    if (state?.openOptions) state.openOptions = { ...state.openOptions, url };
    return call("webview_navigate", { label, url });
  },
  async bounds(label, x, y, w, h) {
    const result = await call<boolean>("webview_bounds", { label, x, y, w, h });
    const state = composition.surfaces.get(label);
    if (state) state.lastRect = rectKey({ x, y, w, h });
    noteSurfaceWrite(label);
    return result;
  },
  async visible(label, visible, focus) {
    const state = stateOf(label);
    state.desiredVisible = visible;
    if (!state.opened) return;
    if (!visible) {
      await call("webview_visible", { label, visible: false, focus });
      return;
    }
    if (state.veiled) return;
    await restoreIfDetached(state);
    await requestSlotSync(state);
    await call("webview_visible", { label, visible: true, focus });
  },
  history: (label, delta) => call("webview_history", { label, delta }),
  stop: (label) => call("webview_stop", { label }),
  zoom: (label, factor) => call("webview_zoom_view", { label, factor }),
  devtools: (label) => call("webview_devtools", { label }),
  evalJs: (label, js) => call("webview_eval", { label, js }),
  sendInput: async (label) => {
    throw new Error(`이 콘텐츠 뷰 구현은 입력 주입 통로가 없습니다: ${label}`);
  },
  injectScript: (label, code, phase) => {
    void call("webview_inject_script", { label, code, phase });
    return () => {};
  },
  openWindow: (url) => call("webview_open_window", { url }),
};

export function __resetNativeContentViewCompositionForTest(): void {
  for (const state of composition.surfaces.values()) state.observer?.disconnect();
  composition.surfaces.clear();
  for (const subscription of composition.subscriptions.splice(0)) subscription.dispose();
  composition.installed = false;
}
