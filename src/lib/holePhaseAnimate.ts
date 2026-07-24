// 위상 이동의 파라메트릭 네이티브 구동 — 교차(레일 주행·FLIP 스왑)의 기하는 t0 에 전부
// 결정된다(FLIP: 최종 레이아웃 즉시 커밋 + translate 되감기). 매 프레임 JS 샘플-복사는
// 위상 에지의 메인스레드 혼잡에 rAF 가 굶어 머뭇→점프→늦은 스냅이 된다(bounds-trace 실측:
// 중반 60Hz 정상, 에지 240ms 침묵). 그래서 시작 에지에 DOM 과 같은 곡선(duration+bezier)을
// 네이티브(CA)에 한 번 건네 두 컴포지터가 같은 궤도를 병렬 주행하게 한다.
import { invoke } from "@tauri-apps/api/core";
import { browserLabel } from "./webviewLabels";
import { RAIL_TRAVEL_MS } from "./railMotion";

// App.css rail-flip-x 의 cubic-bezier(0.4, 0, 0.2, 1)와 같은 곡선 — 두 컴포지터 동조의 전제.
export const PHASE_EASING: readonly [number, number, number, number] = [0.4, 0, 0.2, 1];

/** 슬롯 노출 주소(layout/slot/<viewId>)에서 viewId 추출 — 형식 밖이면 null. */
export function viewIdFromSlotNode(node: string | undefined): string | null {
  if (!node) return null;
  const m = /^layout\/slot\/(.+)$/.exec(node);
  return m ? m[1] : null;
}

/**
 * 무변환(레이아웃) 뷰포트 박스 — FLIP 의 translate 를 무시한 최종 자리. offset 축은
 * transform 을 모르므로, 슬롯의 offset 좌표 + (비변환) offsetParent 의 뷰포트 원점으로 얻는다.
 */
export function untransformedViewportBox(
  el: HTMLElement,
): { x: number; y: number; w: number; h: number } | null {
  const op = el.offsetParent as HTMLElement | null;
  if (!op) return null; // display:none / 미부착
  const base = op.getBoundingClientRect();
  return {
    x: base.left + el.offsetLeft,
    y: base.top + el.offsetTop,
    w: el.offsetWidth,
    h: el.offsetHeight,
  };
}

/**
 * 위상 시작 에지 1회 호출 — 화면에 보이는 홀 슬롯의 네이티브 child 를 최종 박스로 CA 구동.
 * 파킹 슬롯(오프스크린/미표시)은 제외. 실패는 무해(추종 루프 + 종료 스냅이 정확성 그물).
 */
export function animateHoleChildrenToFinal(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  for (const slot of Array.from(
    document.querySelectorAll<HTMLElement>(".egroup-body-slot.hole-slot"),
  )) {
    const viewId = viewIdFromSlotNode(slot.dataset.node);
    if (!viewId) continue;
    const now = slot.getBoundingClientRect();
    if (now.right <= 0 || now.bottom <= 0 || now.left >= vw || now.top >= vh) continue; // 파킹
    const fin = untransformedViewportBox(slot);
    if (!fin) continue;
    void invoke("webview_animate_bounds", {
      label: browserLabel(viewId),
      x: fin.x,
      y: fin.y,
      w: fin.w,
      h: fin.h,
      durationMs: RAIL_TRAVEL_MS,
      easing: PHASE_EASING,
    }).catch(() => {
      // 없는 label(홀이지만 코어 소유 child 아님 — 엔진 서피스 등)·비-macOS 는 무해.
    });
  }
}
