// 위상 이동의 파라메트릭 네이티브 구동 — 교차(레일 주행·FLIP 스왑)의 기하는 t0 에 전부
// 결정된다(FLIP: 최종 레이아웃 즉시 커밋 + translate 되감기). 매 프레임 JS 샘플-복사는
// 위상 에지의 메인스레드 혼잡에 rAF 가 굶어 머뭇→점프→늦은 스냅이 된다(bounds-trace 실측:
// 중반 60Hz 정상, 에지 240ms 침묵). 그래서 시작 에지에 DOM 과 같은 곡선(duration+bezier)을
// 네이티브(CA)에 한 번 건네 두 컴포지터가 같은 궤도를 병렬 주행하게 한다.
//
// 구동은 절대 박스가 아니라 **델타**다: 코어는 child 가 슬롯 안 어디에 앵커되는지(플러그인
// 크롬 오프셋)를 모른다 — 절대 박스로 몰면 위상 동안 툴바 높이만큼 어긋난다(실측 28px).
// child 목표 = 현 모델 위치 + (슬롯의 FLIP 이동량) 이며, 이동량의 단일 진실은 슬롯 자신의
// FLIP 변수(--rail-flip-x px + --focus-flip-x %)다 — 두 위상 모두 이 변수로 표현된다.
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
 * FLIP 변수 → 위상 시작 시점의 시각 오프셋(px). 키프레임은 translate(오프셋)→0 으로
 * 되감으므로 child 가 최종 자리로 가려면 −오프셋 만큼 이동해야 한다(부호는 호출부가 적용).
 */
export function phaseOffsetPx(
  railFlipPx: number,
  focusFlipPct: number,
  slotWidthPx: number,
): number {
  return railFlipPx + (focusFlipPct / 100) * slotWidthPx;
}

/**
 * 위상 시작 에지 1회 호출 — 화면에 보이는 홀 슬롯의 네이티브 child 를 FLIP 델타만큼 CA 구동.
 * 파킹 슬롯(오프스크린/미표시)·무이동 슬롯은 제외. 실패는 무해(추종 루프 + 종료 스냅이
 * 정확성 그물).
 *
 * 샘플링 시점 계약: 레이아웃 이펙트가 아니라 rAF(첫 페인트 직전) — 레이아웃 이펙트는 다른
 * 컴포넌트의 커밋과 인터리브되어 FLIP 변수의 직전 위상 값을 읽을 수 있다(실측: 연속 3회
 * 전환 중 3번째가 이전 부호를 읽어 child 가 화면 밖으로 구동됨). rAF 는 DOM 애니메이션의
 * 첫 프레임과 같은 스타일을 본다 — 두 컴포지터가 같은 t0 기하에서 출발한다.
 */
let pendingFrame = 0;
export function animateHoleChildrenToFinal(): void {
  if (pendingFrame) return; // 같은 커밋 폭풍에서 두 위상 에지가 겹쳐도 샘플은 1회
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    sampleAndDrive();
  });
}

function sampleAndDrive(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  for (const slot of Array.from(
    document.querySelectorAll<HTMLElement>(".egroup-body-slot.hole-slot"),
  )) {
    const viewId = viewIdFromSlotNode(slot.dataset.node);
    if (!viewId) continue;
    const now = slot.getBoundingClientRect();
    if (now.right <= 0 || now.bottom <= 0 || now.left >= vw || now.top >= vh) continue; // 파킹
    const cs = getComputedStyle(slot);
    const railFlipPx = parseFloat(cs.getPropertyValue("--rail-flip-x")) || 0;
    const focusFlipPct = parseFloat(cs.getPropertyValue("--focus-flip-x")) || 0;
    const offset = phaseOffsetPx(railFlipPx, focusFlipPct, slot.offsetWidth);
    if (Math.abs(offset) < 0.5) continue; // 이 슬롯은 이동하지 않는 위상
    // 시작 시각 동기 — DOM 애니는 이미 몇 ms 진행했을 수 있고(커밋~rAF), invoke 는 IPC 를
    // 건넌다. 둘 다 CA timeOffset 으로 보상해 두 컴포지터가 같은 곡선의 같은 t 에서 만난다.
    let elapsedMs = 0;
    try {
      for (const a of slot.getAnimations()) {
        if ((a as CSSAnimation).animationName === "rail-flip-x") {
          elapsedMs = Number(a.currentTime ?? 0) || 0;
          break;
        }
      }
    } catch {
      // getAnimations 미지원 환경 — 보상 없이 진행(추종 그물 유지).
    }
    void invoke("webview_animate_bounds", {
      label: browserLabel(viewId),
      dx: -offset,
      dy: 0,
      durationMs: RAIL_TRAVEL_MS,
      easing: PHASE_EASING,
      elapsedMs,
      sentAtMs: Date.now(),
      dbg: `rail=${railFlipPx} focus=${focusFlipPct} w=${slot.offsetWidth} node=${slot.dataset.node}`,
    }).catch(() => {
      // 없는 label(홀이지만 코어 소유 child 아님 — 엔진 서피스 등)·비-macOS 는 무해.
    });
  }
}
