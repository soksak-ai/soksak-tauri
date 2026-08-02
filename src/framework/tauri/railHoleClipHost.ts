// 레일-홀 클립의 창 단위 소유자.
//
// 홀 슬롯은 창의 DOM 에 살고 모션 신호도 창 단위인데, 클립은 프로젝트 pane 이 소유하고
// 있었다 — slotFreezeHost 가 이미 같은 문장으로 고쳐 둔 그 불일치다("수명은 프로젝트,
// 범위는 창"). 세션 보존 때문에 프로젝트는 전부 동시에 마운트되므로, 커밋 한 번에
// document 전체 스캔이 프로젝트 수만큼 돌고 모션 위상에는 rAF 루프가 그만큼 떴다.
// 창이 소유하면 스캔은 패스당 1회, 루프는 창당 1개다.
//
// 폴링 없음: 입력은 두 가지 에지뿐이다 — React 커밋(호출자)과 모션 에지(onLayoutMotion).
// 위상 중 rAF 는 진행 중인 애니메이션의 프레임 추적이지 감시가 아니며, 위상 종료 에지가
// 루프를 회수하고 최종 기하로 1회 정착시킨다(상시 계약).
import { moduleState } from "../../lib/moduleState";
import { applyRailHoleClip, collectHoleRects } from "./railHoleClip";
import { onLayoutMotion } from "../../lib/layoutMotion";
import { onPluginEvent } from "../../plugins/hooks";
// 서로 다른 것은 따로 선다 — 한 가방에 넣으면 그것은 상태가 아니라 가방이다.
/** 모션 구독 해지 손잡이. */
const subscription = moduleState("framework/tauri/railHoleClipHost#subscription", () => ({
  offMotion: null as (() => void) | null,
  offReflow: null as (() => void) | null,
}));

/** 프레임 합치기 상태 — 구독과 수명이 다르다. */
const frame = moduleState("framework/tauri/railHoleClipHost#frame", () => ({
  raf: 0,
  coalescing: false,
}));

/** 등록된 모든 plane 에 클립을 건다 — 문서 스캔은 이 한 지점에서 1회. */
export function syncRailHoleClips(): void {
  const planes = document.querySelectorAll<HTMLElement>('[data-node="rail/plane"]');
  if (planes.length === 0) return;
  const holeRects = collectHoleRects();
  for (const plane of planes) applyRailHoleClip(plane, holeRects);
}

/**
 * 커밋에서 부른다. 같은 커밋의 중복 호출을 하나로 합친다.
 *
 * 합치는 지점이 마이크로태스크인 이유는 두 가지가 동시에 참이어야 하기 때문이다.
 * ① 클립은 페인트 전에 서 있어야 한다 — 한 프레임 늦으면 사이드바가 홀 위에 비친다.
 *    마이크로태스크는 커밋 스택이 풀린 직후, 브라우저가 그리기 전에 빈다.
 * ② 그 커밋에 등록된 plane 을 하나도 빠뜨리면 안 된다. React 는 컴포넌트별로
 *    [등록 effect, 동기 요청 effect] 를 번갈아 돌리므로, 첫 요청에서 즉시 훑으면
 *    그때 아직 등록되지 않은 pane 들이 그 프레임에 클립을 못 받는다.
 */
export function requestRailHoleClipSync(): void {
  if (frame.coalescing) return;
  frame.coalescing = true;
  queueMicrotask(() => {
    frame.coalescing = false;
    syncRailHoleClips();
  });
}

function startTracking(): void {
  if (frame.raf) return;
  const tick = () => {
    syncRailHoleClips();
    frame.raf = requestAnimationFrame(tick);
  };
  frame.raf = requestAnimationFrame(tick);
}

function stopTracking(): void {
  if (!frame.raf) return;
  cancelAnimationFrame(frame.raf);
  frame.raf = 0;
  syncRailHoleClips(); // 해제가 아니라 최종 기하로 정착
}

function ensureMotionSubscription(): void {
  if (subscription.offMotion) return;
  subscription.offMotion = onLayoutMotion((active) => {
    if (active) startTracking();
    else stopTracking();
  });
}

/**
 * 이 프레임워크는 홀을 판다 — 레일을 그 위에서 오려낸다.
 *
 * **거는 쪽은 프레임워크다.** 콘텐츠가 문서 안에 사는 프레임워크에는 오려낼 홀이 없고,
 * 거기서 오려내면 멀쩡한 레일에 구멍이 뚫린다. 안 걸면 아래 표면은 그대로 서 있되
 * 아무 일도 하지 않는다 — 부르는 쪽(pane)은 누가 걸었는지 몰라도 된다.
 */
export function installRailHoleClip(): void {
  ensureMotionSubscription();
  if (!subscription.offReflow) {
    subscription.offReflow = onPluginEvent("layout.reflow", requestRailHoleClipSync).dispose;
  }
  requestRailHoleClipSync();
}

export function __resetRailHoleClipHostForTest(): void {
  if (frame.raf) cancelAnimationFrame(frame.raf);
  frame.raf = 0;
  frame.coalescing = false;
  subscription.offMotion?.();
  subscription.offMotion = null;
  subscription.offReflow?.();
  subscription.offReflow = null;
}
