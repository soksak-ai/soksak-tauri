// 명령발 레이아웃 변화의 JS 소유 보간(FLIP) — 사용자 확정 기준(2026-07-26): 분할·최대화·
// 닫기·비율 변화는 실제 모션이어야 하고, 슬로우·정지·추적(ui.motion/ui.trace)이 그 본체에
// 걸려야 한다.
//
// 왜 CSS 전이가 아닌가(실측): WKWebView 는 커스텀 프로퍼티(--l 등) 변경으로 calc 소비
// 속성의 전이를 발동하지 않고, @property 등록 변수의 전이도 보간하지 않는다(computed 는
// 서 있는데 rect 는 한 프레임에 점프 — ui.trace 표본). 그래서 코어가 rect 차이를 직접
// element.animate 로 보간하고, motionDebug 에 입양시켜 배수·정지를 예외 없이 따르게 한다.
//
// 제외 규칙(각각 소유자가 있다):
//  - 위상 중(isLayoutMotionActive): 드래그·활강은 기존 시스템이 이동을 소유한다.
//  - 홀 요소(.hole): 네이티브 표면은 보간 프레임을 따라가지 못한다(visualEffectOwnership).
import { isLayoutMotionActive, LAYOUT_MOTION_MS } from "./layoutMotion";
import { adoptLayoutAnimation } from "./motionDebug";

interface Snap {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RectMotionTracker {
  /** map 렌더 안에서 ref 로 넘긴다 — 등록만 하고, 소멸은 flush 가 isConnected 로 걷는다. */
  ref: (el: HTMLElement | null) => void;
  /** 커밋 직후(useLayoutEffect) 한 번 — 이전 rect 와 비교해 변화분을 보간한다. */
  flush: () => void;
}

export function createRectMotionTracker(): RectMotionTracker {
  const els = new Set<HTMLElement>();
  const prev = new WeakMap<HTMLElement, Snap>();
  return {
    ref: (el) => {
      if (el) els.add(el);
    },
    flush: () => {
      const live = isLayoutMotionActive();
      for (const el of els) {
        if (!el.isConnected) {
          els.delete(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        const now: Snap = { x: r.x, y: r.y, w: r.width, h: r.height };
        const was = prev.get(el);
        prev.set(el, now);
        if (!was || live || el.classList.contains("hole")) continue;
        const dx = was.x - now.x;
        const dy = was.y - now.y;
        const dw = was.w - now.w;
        const dh = was.h - now.h;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dw) < 0.5 && Math.abs(dh) < 0.5)
          continue;
        const cs = getComputedStyle(el);
        const L = parseFloat(cs.left) || 0;
        const T = parseFloat(cs.top) || 0;
        try {
          const a = el.animate(
            [
              {
                left: `${L + dx}px`,
                top: `${T + dy}px`,
                width: `${now.w + dw}px`,
                height: `${now.h + dh}px`,
              },
              { left: `${L}px`, top: `${T}px`, width: `${now.w}px`, height: `${now.h}px` },
            ],
            { duration: LAYOUT_MOTION_MS, easing: "ease" },
          );
          adoptLayoutAnimation(a, el.dataset.node ?? el.className, LAYOUT_MOTION_MS);
        } catch {
          /* 애니메이션 불가 환경(테스트 jsdom 등) — 즉시 반영 그대로 */
        }
      }
    },
  };
}
