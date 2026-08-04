import type {
  PluginViewContext,
  PluginViewProvider,
} from "./viewRegistry";
import { allGroups, useSessions } from "../state/sessions";

interface MountedView {
  container: HTMLElement;
  provider: PluginViewProvider;
  context: () => PluginViewContext;
  registrations: number;
}

interface FocusIntent {
  viewId: string;
  controller: AbortController;
  queued: boolean;
  delivered: boolean;
  retries?: number;
}

// 착지 재시도 상한 — 리로드 직후 웜 복원(엔진 재부착)이 수 프레임 걸리는 실측 창을 덮는다.
// 인텐트가 교체·중단되면 즉시 멈추므로 상한은 최악 케이스 보고 시점일 뿐이다.
const FOCUS_LANDING_RETRY_LIMIT = 30;

interface ViewFocusCoordinatorOptions {
  schedule?: (callback: FrameRequestCallback) => number;
  onError?: (error: unknown) => void;
}

/**
 * Keyboard-focus ownership for mounted plugin views.
 *
 * Core owns the destination view and ordering. A provider owns only how its own
 * container commits transient input and reaches its canonical input element.
 * Mounting is never treated as focus intent; only the latest abortable request
 * may focus, so an asynchronously prepared stale view cannot steal focus.
 */
export class ViewFocusCoordinator {
  private readonly mounted = new Map<string, MountedView>();
  private readonly schedule: (callback: FrameRequestCallback) => number;
  private readonly onError: (error: unknown) => void;
  private intent: FocusIntent | null = null;
  private focusedViewId: string | null = null;

  constructor(options: ViewFocusCoordinatorOptions = {}) {
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.onError =
      options.onError ??
      ((error) => console.error("플러그인 뷰 포커스 전환 실패:", error));
  }

  /** 아직 안 온 마운트를 기다리는 호출자들. 마운트 순간에만 깨어난다. */
  private readonly mountWaiters = new Map<string, Set<() => void>>();

  /**
   * 이 뷰가 명령을 받을 수 있을 때까지 기다린다. 이미 되어 있으면 즉시 true.
   *
   * 왜 필요한가: view.open 은 상태를 바꾸는 즉시 답하는데 플러그인 뷰는 그 다음 렌더에
   * 마운트된다. 그 사이에 그 뷰로 명령을 보내면 플러그인은 자기 뷰를 모른다(실측:
   * view.open 직후 navigate 가 NO_VIEW — 코어는 만들었다는데 쓸 수 없었다).
   * 명령이 ok 를 답했다면 그 결과는 쓸 수 있어야 한다.
   */
  awaitMounted(viewId: string, timeoutMs: number): Promise<boolean> {
    if (this.mounted.has(viewId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.mountWaiters.get(viewId)?.delete(wake);
        clearTimeout(timer);
        resolve(ok);
      };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const set = this.mountWaiters.get(viewId) ?? new Set<() => void>();
      set.add(wake);
      this.mountWaiters.set(viewId, set);
    });
  }

  registerMountedView(
    viewId: string,
    container: HTMLElement,
    provider: PluginViewProvider,
    context: () => PluginViewContext,
  ): () => void {
    const previous = this.mounted.get(viewId);
    if (previous?.container === container && previous.provider === provider) {
      // StrictMode나 동일 호스트의 중복 배선은 같은 세대의 멱등한 acquire다. 최신 context를
      // 사용하되 첫 cleanup이 나머지 등록까지 지우지 않도록 lease 수를 센다.
      previous.context = context;
      previous.registrations += 1;
      return this.releaseMountedView(viewId, previous);
    }

    // React는 새 effect를 세운 뒤 이전 effect의 cleanup을 실행할 수 있다. viewId는 제품
    // 정체성이고 DOM container는 렌더 세대다. 새 세대가 등록되면 한 거래로 소유권을 넘기고,
    // 이전 세대의 늦은 cleanup은 identity guard로 무시한다.
    if (previous && this.intent?.viewId === viewId) {
      this.intent.controller.abort();
      this.intent = {
        viewId,
        controller: new AbortController(),
        queued: false,
        delivered: false,
      };
    }
    const mounted = { container, provider, context, registrations: 1 };
    this.mounted.set(viewId, mounted);
    // 이 뷰가 이제 명령을 받을 수 있다 — provider.mount 가 끝난 뒤이므로 플러그인은 자기
    // 뷰를 등록해 두었다. 기다리던 호출자를 깨운다(폴링 없이 이 한 지점이 신호다).
    const waiters = this.mountWaiters.get(viewId);
    if (waiters) {
      this.mountWaiters.delete(viewId);
      for (const w of waiters) w();
    }
    if (this.intent?.viewId === viewId) this.publishFocused(viewId, true);
    else if (this.focusedViewId === viewId) this.publishFocused(viewId, true);
    this.queueCurrentIntent();

    return this.releaseMountedView(viewId, mounted);
  }

  private releaseMountedView(viewId: string, mounted: MountedView): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.mounted.get(viewId) !== mounted) return;
      mounted.registrations -= 1;
      if (mounted.registrations > 0) return;
      this.mounted.delete(viewId);
      if (this.intent?.viewId !== viewId) return;

      // The old provider may still be waiting for async readiness. Abort it,
      // but retain the destination so a remount can fulfill the same intent.
      this.intent.controller.abort();
      this.intent = {
        viewId,
        controller: new AbortController(),
        queued: false,
        delivered: false,
      };
    };
  }

  transferFocus<T>(
    sourceViewId: string | null,
    targetViewId: string,
    activate: () => T,
  ): T {
    if (sourceViewId && sourceViewId !== targetViewId) {
      const source = this.mounted.get(sourceViewId);
      if (source?.provider.prepareFocusTransfer) {
        try {
          source.provider.prepareFocusTransfer(
            source.container,
            source.context(),
          );
        } catch (error) {
          this.onError(error);
        }
      }
      this.publishFocused(sourceViewId, false);
    }

    const result = activate();
    this.requestFocus(targetViewId);
    return result;
  }

  requestFocus(viewId: string): AbortSignal {
    // State synchronization and the initiating event can report the same intent
    // in one turn. Coalesce only while it is still pending; a later re-click of
    // an already active view creates a fresh request and restores lost focus.
    if (
      this.intent?.viewId === viewId &&
      !this.intent.delivered &&
      !this.intent.controller.signal.aborted
    ) {
      this.publishFocused(viewId, true);
      return this.intent.controller.signal;
    }

    if (this.focusedViewId && this.focusedViewId !== viewId) {
      this.publishFocused(this.focusedViewId, false);
    }
    this.intent?.controller.abort();
    this.intent = {
      viewId,
      controller: new AbortController(),
      queued: false,
      delivered: false,
    };
    this.publishFocused(viewId, true);
    this.queueCurrentIntent();
    return this.intent.controller.signal;
  }

  clear(): void {
    if (this.focusedViewId) this.publishFocused(this.focusedViewId, false);
    this.intent?.controller.abort();
    this.intent = null;
  }

  /**
   * 레이아웃 이동(투영 재배열의 reparent) 은 그 안의 입력 포커스를 body 로 떨군다 —
   * "배달 완료"는 "정착"이 아니므로, 이동이 끝난 시점에 포커스가 몸을 잃었으면 같은
   * 인텐트를 재배달한다. 사용자가 다른 요소(body 아님)에 의도적으로 둔 포커스는
   * 훔치지 않는다.
   */
  redeliverIfLost(): void {
    const intent = this.intent;
    if (!intent || intent.controller.signal.aborted) return;
    const target = this.mounted.get(intent.viewId);
    if (!target) return;
    const doc = target.container.ownerDocument;
    const active = doc.activeElement;
    if (active && target.container.contains(active)) return; // 정착 유지
    if (active && active !== doc.body) return; // 의도 포커스 — 불가침
    intent.delivered = false;
    intent.retries = 0;
    this.queueCurrentIntent();
  }

  zoomView(viewId: string, action: "in" | "out" | "reset"): boolean {
    const mounted = this.mounted.get(viewId);
    if (!mounted?.provider.zoom) return false;
    try {
      mounted.provider.zoom(mounted.container, mounted.context(), action);
    } catch (error) {
      this.onError(error);
    }
    return true;
  }

  snapshot(): {
    requestedViewId: string | null;
    mounted: boolean;
    delivered: boolean;
  } {
    const viewId = this.intent?.viewId ?? null;
    return {
      requestedViewId: viewId,
      mounted: viewId ? this.mounted.has(viewId) : false,
      delivered: this.intent?.delivered ?? false,
    };
  }

  private queueCurrentIntent(): void {
    const intent = this.intent;
    if (
      !intent ||
      intent.queued ||
      intent.delivered ||
      intent.controller.signal.aborted ||
      !this.mounted.has(intent.viewId)
    ) {
      return;
    }
    intent.queued = true;
    this.schedule(() => this.deliver(intent));
  }

  private deliver(intent: FocusIntent): void {
    if (this.intent !== intent || intent.controller.signal.aborted) return;
    intent.queued = false;
    const target = this.mounted.get(intent.viewId);
    if (!target) return;

    const landed = (): boolean => {
      const active = target.container.ownerDocument.activeElement;
      return !!active && target.container.contains(active);
    };
    if (landed()) {
      intent.delivered = true;
      return;
    }

    if (!target.provider.focus) {
      intent.delivered = true;
      return;
    }
    try {
      target.provider.focus(target.container, target.context(), {
        signal: intent.controller.signal,
      });
    } catch (error) {
      this.onError(error);
    }
    // 배달 선언의 근거는 착지다 — provider 호출이 입력 포커스를 못 옮겼으면(실측 지문:
    // 클릭 후 activeElement 가 body 에 남음) 준비 창을 덮는 유한 재시도로 매 프레임
    // 다시 배달하고, 상한까지 미착지면 어느 뷰인지 보고한다(침묵 금지). 리로드 직후
    // 웜 복원처럼 엔진 재부착이 수 프레임 걸리는 창이 이 재시도의 존재 이유다.
    if (landed()) {
      intent.delivered = true;
      return;
    }
    const retries = (intent.retries ?? 0) + 1;
    intent.retries = retries;
    if (retries < FOCUS_LANDING_RETRY_LIMIT) {
      intent.queued = true;
      this.schedule(() => this.deliver(intent));
      return;
    }
    intent.delivered = true;
    this.onError(
      new Error(
        `포커스 미착지: ${intent.viewId} — provider.focus 가 입력 포커스를 옮기지 못함`,
      ),
    );
  }

  private publishFocused(viewId: string, focused: boolean): void {
    const mounted = this.mounted.get(viewId);
    if (focused) this.focusedViewId = viewId;
    else if (this.focusedViewId === viewId) this.focusedViewId = null;
    if (!mounted?.provider.setFocused) return;
    try {
      mounted.provider.setFocused(mounted.container, mounted.context(), focused);
    } catch (error) {
      this.onError(error);
    }
  }
}

const coordinator = new ViewFocusCoordinator();

export function registerMountedViewFocus(
  viewId: string,
  container: HTMLElement,
  provider: PluginViewProvider,
  context: () => PluginViewContext,
): () => void {
  return coordinator.registerMountedView(viewId, container, provider, context);
}

/** 그 뷰가 명령을 받을 수 있는가 — 되면 true, 제한 시간 안에 안 되면 false. */
export function awaitViewMounted(viewId: string, timeoutMs = 5000): Promise<boolean> {
  return coordinator.awaitMounted(viewId, timeoutMs);
}

export function requestViewFocus(viewId: string): AbortSignal {
  return coordinator.requestFocus(viewId);
}

export function transferViewFocus<T>(
  sourceViewId: string | null,
  targetViewId: string,
  activate: () => T,
): T {
  return coordinator.transferFocus(sourceViewId, targetViewId, activate);
}

export function activeSessionViewId(): string | null {
  const state = useSessions.getState();
  const project = state.projects.find((item) => item.id === state.activeId);
  const space = project?.spaces.find(
    (item) => item.id === project.activeSpaceId,
  );
  const panel = space
    ? allGroups(space.layout).find((item) => item.id === space.activePaneId)
    : null;
  return panel?.activeTabId ?? null;
}

/** Keep focus intent aligned with every active-chain state transition. */
export function startViewFocusSync(): () => void {
  let activeViewId = activeSessionViewId();
  if (activeViewId) coordinator.requestFocus(activeViewId);
  return useSessions.subscribe(() => {
    const next = activeSessionViewId();
    if (next === activeViewId) return;
    activeViewId = next;
    if (next) coordinator.requestFocus(next);
    else coordinator.clear();
  });
}

export function viewFocusSnapshot(): ReturnType<
  ViewFocusCoordinator["snapshot"]
> {
  return coordinator.snapshot();
}

/** 레이아웃 이동 종료 지점에서 호출 — 이동이 떨군 포커스를 같은 인텐트로 재배달한다. */
export function redeliverViewFocusIfLost(): void {
  coordinator.redeliverIfLost();
}

/** 줌 인텐트 위임(플랜 golden-swinging-lynx) — 마운트된 뷰의 선택 훅 zoom 을 호출한다.
 * 훅 미구현·미마운트면 false. 코어는 라우팅만 소유하고 의미(폰트/페이지 줌)는 뷰가 정한다. */
export function zoomFocusedView(
  viewId: string,
  action: "in" | "out" | "reset",
): boolean {
  return coordinator.zoomView(viewId, action);
}
