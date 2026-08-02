// 슬롯 동결 엔진의 창 단위 소유자.
//
// 엔진의 범위는 창이다(홀 슬롯은 창의 DOM 에 살고, 모션 신호도 창 단위). 그런데 이전에는
// 프로젝트 pane 마다 엔진을 하나씩 만들면서 각자 document 전체를 스캔했다 — 수명은 프로젝트,
// 범위는 창이라는 불일치다. 결과: 프로젝트 N 개면 정착 에지마다 캡처 IPC 가 N 배, 한 슬롯에
// 스탠드인이 N 개 겹치고 veil 도 N 번 발화했다. 소유자를 창으로 올려 그 불일치를 없앤다.
//
// 폴링 없음: 모션 에지(onLayoutMotion)와 정착 에지(호출자)만이 입력이다.
import { moduleState } from "../lib/moduleState";
import { createSlotFreeze, type SlotFreeze, type SlotFreezeDeps } from "./slotFreeze";
import { onLayoutMotion } from "./layoutMotion";

// 서로 다른 것은 따로 선다 — 한 가방에 넣으면 그것은 상태가 아니라 가방이다.
/** 설치된 동결기 — 있으면 이미 붙은 것이다. */
const installed = moduleState("lib/slotFreezeHost#installed", () => ({
  host: null as SlotFreeze | null,
}));

/** 구독 해지 손잡이와 정착 타이머 — 설치와 별개로 붙었다 떨어진다. */
const subscription = moduleState("lib/slotFreezeHost#subscription", () => ({
  offMotion: null as (() => void) | null,
  settleTimer: 0,
}));
/** 정착 캡처 디바운스 — 레이아웃이 멈춘 뒤 한 번만 굽는다(위상 끝·reflow 뒤·부팅 1회). */
const SETTLE_DEBOUNCE_MS = 350;

/** 창에 엔진이 서 있게 한다(멱등). 두 번째 호출은 무연산 — 소유자는 창 하나에 하나다. */
export function ensureSlotFreezeHost(deps: SlotFreezeDeps): SlotFreeze {
  if (installed.host) return installed.host;
  const engine = createSlotFreeze(deps);
  installed.host = engine;
  subscription.offMotion = onLayoutMotion((active, kinds, scope) => {
    engine.onMotion(active, kinds, scope);
    if (!active) scheduleSlotSettleCapture();
  });
  return engine;
}

export function slotFreezeHost(): SlotFreeze | null {
  return installed.host;
}

/** 레이아웃 정착 에지 — 디바운스 후 1회 선캡처. */
export function scheduleSlotSettleCapture(): void {
  if (subscription.settleTimer) window.clearTimeout(subscription.settleTimer);
  subscription.settleTimer = window.setTimeout(() => {
    subscription.settleTimer = 0;
    installed.host?.captureSettled();
  }, SETTLE_DEBOUNCE_MS);
}

/**
 * 활강의 전제 — 이 뷰들의 이동하는 표면을 **전부 덮을 수 있는가**.
 *
 * 덮어야 하는 이유는 표면이 문서 밖에 살아 활강을 안 따라오기 때문이다. 콘텐츠가 문서 안에
 * 사는 프레임워크에는 그 장치가 걸리지 않고, 표면은 자기 자리의 자식이라 자리와 함께 움직인다
 * — **덮을 것이 없으므로 전제는 이미 성립이다.**
 *
 * 안 걸렸다고 `false` 를 답하면 "못 덮는다"와 "덮을 게 없다"가 한 값을 쓴다("0 의 두 얼굴").
 * 그 값은 `phase.glide` 로 굳고 → `railTraveling` 이 거짓이 되고 → 배치 전환이 활강 대신
 * **즉시 스냅**으로 떨어지며 `beginLayoutMotion` 조차 뜨지 않는다. 멀쩡한 전환이 통째로 죽는데
 * 아무것도 실패하지 않는다(실측 2026-08-03).
 */
export function canGlideViews(viewIds: readonly string[]): boolean {
  return installed.host ? installed.host.canFreezeAll(viewIds) : true;
}

/** 내용이 바뀐 뷰의 스냅을 버린다(항행 등) — 낡은 프레임을 세우지 않는 유일한 축. */
export function invalidateSlotSnapshot(viewId: string): void {
  installed.host?.invalidate(viewId);
}

/**
 * 표면 소유자가 착지 좌표를 실제로 썼다는 사실. 코어가 자기 쓰기 경로(webview.bounds)에서
 * 관측해 넘긴다 — 스탠드인은 이 사실 위에서 물러난다(시간 추측 금지).
 */
export function noteSurfaceWrite(viewId: string): void {
  installed.host?.noteSurfaceWrite(viewId);
}

export function disposeSlotFreezeHost(): void {
  if (subscription.settleTimer) window.clearTimeout(subscription.settleTimer);
  subscription.settleTimer = 0;
  subscription.offMotion?.();
  subscription.offMotion = null;
  installed.host?.dispose();
  installed.host = null;
}
