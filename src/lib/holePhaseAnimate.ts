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
// 발행 dedup: viewId → t0 입력(FLIP 변수) 키. 위상 중 변수가 갱신되는 커밋(클릭 위상은
// 여러 커밋에 걸친다 — 실측: 커밋 간 var 갱신을 DOM 은 라이브로 타고 CA 는 박제돼 ~75px
// 이탈)마다 키가 바뀌어 재구동된다. 같은 키 재커밋은 no-op.
const issued = new Map<string, string>();
// 직전 커밋의 슬롯 크기(viewId → w,h) — 위상 t0 의 크기 델타 산출용. 슬롯 크기는 위상
// 시작 커밋에 이미 최종값이므로, "이전" 은 상시 갱신되는 이 맵에서만 얻을 수 있다.
const lastSlotSize = new Map<string, { w: number; h: number }>();
export function __clearHolePhaseIssued(): void {
  issued.clear();
}

/** 매 커밋 호출(모션 여부 무관) — 홀 슬롯 크기 장부 갱신. 위상 밖 크기 변화는 추종 루프가 처리한다. */
export function noteHoleSlotSizes(): void {
  for (const slot of Array.from(
    document.querySelectorAll<HTMLElement>(".egroup-body-slot.hole-slot"),
  )) {
    const viewId = viewIdFromSlotNode(slot.dataset.node);
    if (viewId) lastSlotSize.set(viewId, { w: slot.offsetWidth, h: slot.offsetHeight });
  }
}
export function animateHoleChildrenToFinal(): void {
  if (pendingFrame) return; // 프레임당 1회(겹친 에지 합침) — 위상당 1회가 아니다
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    sampleAndDrive();
  });
}

/** 계산된 translate 문자열("12px 0px"|"none")의 x(px). 파싱 실패는 0. */
export function translateXOf(value: string): number {
  if (!value || value === "none") return 0;
  const m = /^(-?[\d.]+)px/.exec(value.trim());
  return m ? parseFloat(m[1]) : 0;
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
    const varOffset = phaseOffsetPx(railFlipPx, focusFlipPct, slot.offsetWidth);
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
    // 남은 이동량: t0(애니 미시작 — 계산된 translate 가 아직 기저값 0)는 FLIP 변수로,
    // 진행 중(재구동 — 변수 갱신 커밋)은 **살아있는 애니메이션 값**(계산된 translate)으로
    // 읽는다. 살아있는 값은 변수 재해석·단위 합성·커밋 간 갱신에 전부 면역이고, child 는
    // presentation 기준으로 이만큼만 더 가면 DOM 과 같은 점에 선다(Rust base=presentation).
    const live = translateXOf(cs.translate);
    const remaining = elapsedMs > 8 || Math.abs(live) >= 0.5 ? live : varOffset;
    // 크기 델타 — 슬롯은 t0 에 최종 크기로 스냅되므로 child 도 같은 델타를 t0 에 받아야
    // 한다. 추종 루프에 맡기면 위상 에지의 rAF 굶주림(실측 100~240ms)만큼 홀-child
    // 크기 불일치 밴드가 노출된다(#36). 이전 크기는 상시 장부(noteHoleSlotSizes)의 것.
    const prev = lastSlotSize.get(viewId);
    const dw = prev ? slot.offsetWidth - prev.w : 0;
    const dh = prev ? slot.offsetHeight - prev.h : 0;
    lastSlotSize.set(viewId, { w: slot.offsetWidth, h: slot.offsetHeight });
    if (Math.abs(varOffset) < 0.5 && Math.abs(remaining) < 0.5 && !dw && !dh) continue; // 무이동 위상
    const key = `${railFlipPx}|${focusFlipPct}|${slot.offsetWidth}x${slot.offsetHeight}`;
    if (issued.get(viewId) === key) continue; // 같은 t0 입력 — 이미 구동됨
    issued.set(viewId, key);
    void invoke("webview_animate_bounds", {
      label: browserLabel(viewId),
      dx: -remaining,
      dy: 0,
      dw,
      dh,
      durationMs: RAIL_TRAVEL_MS,
      easing: PHASE_EASING,
      elapsedMs,
      sentAtMs: Date.now(),
      dbg: `rem=${remaining.toFixed(1)} rail=${railFlipPx} focus=${focusFlipPct} node=${slot.dataset.node}`,
    }).catch(() => {
      // 없는 label(홀이지만 코어 소유 child 아님 — 엔진 서피스 등)·비-macOS 는 무해.
    });
  }
}
