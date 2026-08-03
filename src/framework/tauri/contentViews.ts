// Tauri 콘텐츠 뷰 구현 — 콘텐츠가 문서 밖에 산다.
//
// 플러그인은 `data-content-view-body=<label>` 자리만 선언한다. 이 어댑터가 그 자리를 읽어
// OS 자식 뷰의 bounds·가시성·배치 거래를 전담한다. 추종 입력은 공개 레이아웃 사건과
// DOM mutation·ResizeObserver뿐이다. 프레임 루프나 포인터 추측은 없다.
import { invoke } from "@tauri-apps/api/core";
import { moduleState } from "../../lib/moduleState";
import { surfaceRectOf } from "../../lib/surfaceRect";
import {
  contentViewSlotVisible,
  findContentViewSlot,
  type ContentViewHost,
} from "../../lib/contentViews";
import { onPluginEvent, type Disposable } from "../../plugins/hooks";
import type { LayoutMove, PreparedLayoutTransition } from "../../lib/layoutTransitionHost";

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
  appliedVisible: boolean | null;
  boundsWrites: number;
  precommitting: boolean;
  precommitTarget: string;
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
  appliedVisible: boolean | null;
  boundsWrites: number;
  slotPresent: boolean;
  slotRect: SlotRect | null;
  appliedRect: string | null;
  syncPending: boolean;
  precommitPending: boolean;
}

const composition = moduleState("framework/tauri.fix#contentViewComposition", () => ({
  surfaces: new Map<string, SurfaceState>(),
  subscriptions: [] as Disposable[],
  mutationObserver: null as MutationObserver | null,
  installed: false,
}));

function stateOf(label: string): SurfaceState {
  let state = composition.surfaces.get(label);
  if (!state) {
    state = {
      label,
      opened: false,
      desiredVisible: null,
      appliedVisible: null,
      boundsWrites: 0,
      precommitting: false,
      precommitTarget: "",
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
  return surfaceRectOf(slot.getBoundingClientRect());
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
  // `webview_open`은 살아 있는 기존 child를 재채택할 수 있다. 그 표면에는 직전 hidden 상태가
  // 남아 있으므로 생성 여부와 무관하게 장부의 현재 가시성을 명시적으로 재적용한다.
  await call("webview_visible", { label: state.label, visible: desired, focus: false });
  state.appliedVisible = desired;
}

/** 복귀 에지에서 registry가 아니라 실제 child 부착을 확인하고, 어댑터가 자기 표면을 복구한다. */
async function restoreIfDetached(state: SurfaceState): Promise<boolean> {
  if (!state.opened || !state.openOptions) return false;
  const alive = await call<boolean>("webview_alive", { label: state.label });
  if (alive !== false) return false;
  state.opened = false;
  state.lastRect = "";
  await openTrackedSurface(state, state.openOptions);
  return true;
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
      // 가시성 장부가 숨김인 동안에는 좌표를 적용하지 않는다. backend의 bounds는 순수 기하
      // 명령이며 show/hide를 추론하지 않지만, 불필요한 숨은 child 쓰기를 막고 복귀 에지에서
      // `force`로 최신 rect 하나만 먼저 적용하는 순서를 보장한다.
      if (
        !state.opened ||
        state.precommitting ||
        state.desiredVisible === false
      ) continue;
      const slot = findContentViewSlot(state.label, document);
      if (!slot) continue;
      const rect = slotRect(slot);
      const key = rectKey(rect);
      if (!forced && key === state.lastRect) continue;
      await call<boolean>("webview_bounds", { label: state.label, ...rect });
      state.boundsWrites += 1;
      state.lastRect = key;
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

function appliedFrame(state: SurfaceState): SlotRect | null {
  const parts = state.lastRect.split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/** 목표 DOM 도착은 native 쓰기가 아니라 precommit 잠금 해제 사건이다. */
function settlePreparedFrame(state: SurfaceState): boolean {
  if (!state.precommitting) return false;
  const slot = findContentViewSlot(state.label, document);
  if (slot && rectKey(slotRect(slot)) === state.precommitTarget) {
    state.precommitting = false;
    state.precommitTarget = "";
  }
  return true;
}

function slotViewId(slot: HTMLElement): string | null {
  const node = slot.closest<HTMLElement>('[data-node^="layout/tab/"]')?.dataset.node;
  return node?.startsWith("layout/tab/") ? node.slice("layout/tab/".length) : null;
}

/**
 * DOM 밖 표면의 배치 거래.
 *
 * 현재 native frame에 코어가 공개한 논리 이동량을 한 번 접어 목표 frame을 확정한다.
 * 문서 밖 표면은 CSS compositor와 같은 중간 프레임을 공유할 수 없으므로 glide를 가장하지
 * 않는다. 목표 DOM commit의 layout effect에서 실제 child bounds를 한 번 정착시키고 같은 최종
 * rect를 대조한다. 문서 안 표면만 있는 Electron은 이 host를 설치하지 않아 DOM glide 그대로다.
 */
export async function prepareNativeContentViewMove(
  moves: readonly LayoutMove[],
): Promise<PreparedLayoutTransition> {
  const byView = new Map(moves.map((move) => [move.viewId, move]));
  const targets = [...composition.surfaces.values()].flatMap((state) => {
    if (!state.opened || state.desiredVisible === false) return [];
    const slot = findContentViewSlot(state.label, document);
    const viewId = slot ? slotViewId(slot) : null;
    const move = viewId ? byView.get(viewId) : undefined;
    const before = appliedFrame(state);
    if (!move || !before || !slot || Math.abs(move.dx) < 0.5) return [];
    // 목표는 반드시 화면이 지금 그리는 DOM 슬롯에서 계산한다. native 장부는 직전 snap의
    // precommit 위치일 수 있어 연속 여정의 출발점이 아니다. 그 stale frame에 다음 dx를 접으면
    // 오차가 누적되어 DOM은 왼쪽인데 child는 가운데에 영구 정박한다.
    return [{
      state,
      before,
    }];
  });
  if (targets.length === 0) return {
    mode: "glide",
    commit: async () => {},
    cancel: () => {},
  };

  for (const { state } of targets) {
    state.precommitting = true;
    // prepare 단계에는 목표 좌표를 예측하지 않는다. 빈 목표는 중간 mutation이 잠금을
    // 조기에 풀 수 없게 하며, 실제 목표는 DOM commit의 layout effect에서만 정해진다.
    state.precommitTarget = "";
  }
  let closed = false;
  return {
    mode: "snap",
    commit: async () => {
      if (closed) return;
      closed = true;
      try {
        await Promise.all(targets.map(async ({ state, before }) => {
          if (state.draining) await state.draining;
          const slot = findContentViewSlot(state.label, document);
          if (!slot) throw new Error(`콘텐츠 뷰 자리가 커밋에서 사라졌습니다: ${state.label}`);
          // 이 함수는 목표 DOM의 layout effect에서 호출된다. 따라서 계산된 dx가 아니라 지금
          // 커밋된 공개 슬롯 rect가 좌표의 단일 진실이다. 그래야 pane 이동과 sidebar 이동이
          // 동시에 일어나도 둘 중 하나를 빠뜨린 예측 좌표에 native surface가 정박하지 않는다.
          const rect = slotRect(slot);
          const key = rectKey(rect);
          state.precommitTarget = key;
          // ResizeObserver·명시 bounds 같은 사건 경로가 같은 커밋 rect를 먼저 적용했으면 그
          // ACK가 이미 거래를 충족했다. 같은 frame을 다시 쓰는 것은 의미 없는 z/compositor
          // 자극이며 교차 클릭 한 번에 두 번 흔들리는 원인이므로 생략한다.
          if (state.lastRect === key) return;
          // 장부를 먼저 목표로 둔다. DOM mutation이 IPC ack보다 먼저 와도 일반 bounds sync가
          // 같은 목표를 다시 써 AppKit animation을 끊지 못한다.
          state.lastRect = key;
          state.boundsWrites += 1;
          try {
            await call<boolean>("webview_bounds", {
              label: state.label,
              ...rect,
            });
          } catch (error) {
            state.lastRect = rectKey(before);
            throw error;
          }
        }));
        for (const { state } of targets) settlePreparedFrame(state);
      } catch (error) {
        for (const { state } of targets) {
          state.precommitting = false;
          state.precommitTarget = "";
          void requestSlotSync(state, true).catch(() => {});
        }
        throw error;
      }
    },
    cancel: () => {
      if (closed) return;
      closed = true;
      for (const { state } of targets) {
        state.precommitting = false;
        state.precommitTarget = "";
        void requestSlotSync(state, true).catch(() => {});
      }
    },
  };
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
  );
  composition.mutationObserver = new MutationObserver(() => {
    for (const state of composition.surfaces.values()) {
      // 준비된 표면은 DOM의 중간 프레임을 추종하지 않는다. 목표 좌표 도착 mutation은
      // 잠금만 닫으며 이미 목표에 둔 native frame을 중복해서 쓰지 않는다.
      if (settlePreparedFrame(state)) continue;
      void requestSlotSync(state).catch((error) => {
        console.error(`[content-view] DOM 커밋 추종 실패: ${state.label}`, error);
      });
    }
  });
  composition.mutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
    childList: true,
    subtree: true,
  });
  const onAnimationEnd = () => {
    for (const state of composition.surfaces.values()) settlePreparedFrame(state);
  };
  document.addEventListener("animationend", onAnimationEnd, true);
  composition.subscriptions.push({
    dispose: () => document.removeEventListener("animationend", onAnimationEnd, true),
  });
}

/** 공개 합성 상태 — 슬롯·적용 rect·대기 여부를 한 label 단위로 대조한다. */
export function nativeContentViewCompositionStatus(): NativeContentViewCompositionFact[] {
  return [...composition.surfaces.values()].map((state) => {
    const slot = findContentViewSlot(state.label, document);
    return {
      label: state.label,
      opened: state.opened,
      desiredVisible: state.desiredVisible,
      appliedVisible: state.appliedVisible,
      boundsWrites: state.boundsWrites,
      slotPresent: slot !== null,
      slotRect: slot ? slotRect(slot) : null,
      appliedRect: state.lastRect || null,
      syncPending: state.requested || state.draining !== null,
      precommitPending: state.precommitting,
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
    const state = composition.surfaces.get(label);
    if (state?.openOptions) state.openOptions = { ...state.openOptions, url };
    return call("webview_navigate", { label, url });
  },
  async bounds(label, x, y, w, h) {
    const result = await call<boolean>("webview_bounds", { label, x, y, w, h });
    const state = composition.surfaces.get(label);
    if (state) state.lastRect = rectKey({ x, y, w, h });
    if (state) state.boundsWrites += 1;
    return result;
  },
  async visible(label, visible, focus) {
    const state = stateOf(label);
    state.desiredVisible = visible;
    if (!state.opened) return;
    if (!visible) {
      await call("webview_visible", { label, visible: false, focus });
      state.appliedVisible = false;
      return;
    }
    if (await restoreIfDetached(state)) return;
    await requestSlotSync(state);
    await call("webview_visible", { label, visible: true, focus });
    state.appliedVisible = true;
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
  composition.mutationObserver?.disconnect();
  composition.mutationObserver = null;
  composition.installed = false;
}
