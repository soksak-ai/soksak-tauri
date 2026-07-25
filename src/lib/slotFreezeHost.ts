// 슬롯 동결 엔진의 창 단위 소유자.
//
// 엔진의 범위는 창이다(홀 슬롯은 창의 DOM 에 살고, 모션 신호도 창 단위). 그런데 이전에는
// 프로젝트 pane 마다 엔진을 하나씩 만들면서 각자 document 전체를 스캔했다 — 수명은 프로젝트,
// 범위는 창이라는 불일치다. 결과: 프로젝트 N 개면 정착 에지마다 캡처 IPC 가 N 배, 한 슬롯에
// 스탠드인이 N 개 겹치고 veil 도 N 번 발화했다. 소유자를 창으로 올려 그 불일치를 없앤다.
//
// 폴링 없음: 모션 에지(onLayoutMotion)와 정착 에지(호출자)만이 입력이다.
import { createSlotFreeze, type SlotFreeze, type SlotFreezeDeps } from "./slotFreeze";
import { onLayoutMotion } from "./layoutMotion";

let host: SlotFreeze | null = null;
let offMotion: (() => void) | null = null;
let settleTimer = 0;
/** 정착 캡처 디바운스 — 레이아웃이 멈춘 뒤 한 번만 굽는다(위상 끝·reflow 뒤·부팅 1회). */
const SETTLE_DEBOUNCE_MS = 350;

/** 창에 엔진이 서 있게 한다(멱등). 두 번째 호출은 무연산 — 소유자는 창 하나에 하나다. */
export function ensureSlotFreezeHost(deps: SlotFreezeDeps): SlotFreeze {
  if (host) return host;
  const engine = createSlotFreeze(deps);
  host = engine;
  offMotion = onLayoutMotion((active, kinds, scope) => {
    engine.onMotion(active, kinds, scope);
    if (!active) scheduleSlotSettleCapture();
  });
  return engine;
}

export function slotFreezeHost(): SlotFreeze | null {
  return host;
}

/** 레이아웃 정착 에지 — 디바운스 후 1회 선캡처. */
export function scheduleSlotSettleCapture(): void {
  if (settleTimer) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    host?.captureSettled();
  }, SETTLE_DEBOUNCE_MS);
}

/** 활강의 전제 — 이 뷰들의 홀 표면을 전부 덮을 수 있는가(엔진이 없으면 덮을 수 없다). */
export function canGlideViews(viewIds: readonly string[]): boolean {
  return host ? host.canFreezeAll(viewIds) : false;
}

/** 내용이 바뀐 뷰의 스냅을 버린다(항행 등) — 낡은 프레임을 세우지 않는 유일한 축. */
export function invalidateSlotSnapshot(viewId: string): void {
  host?.invalidate(viewId);
}

/**
 * 표면 소유자가 착지 좌표를 실제로 썼다는 사실. 코어가 자기 쓰기 경로(webview.bounds)에서
 * 관측해 넘긴다 — 스탠드인은 이 사실 위에서 물러난다(시간 추측 금지).
 */
export function noteSurfaceWrite(viewId: string): void {
  host?.noteSurfaceWrite(viewId);
}

export function disposeSlotFreezeHost(): void {
  if (settleTimer) window.clearTimeout(settleTimer);
  settleTimer = 0;
  offMotion?.();
  offMotion = null;
  host?.dispose();
  host = null;
}
