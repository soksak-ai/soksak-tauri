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
import { LAYOUT_MOTION_MS, layoutMotionFacts } from "./layoutMotion";
import { adoptLayoutAnimation, beginJourney, endJourney, noteRectMotionSkip } from "./motionDebug";

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
  // 요소당 활성 보간 1개 — 새 변화가 오면 이전 것을 취소하고 이어서 시작한다. 취소 없이
  // 겹치면 두 애니메이션이 동시에 살아 겹침·잔상이 되고(실측: 사용자 화면), 진행 중 gBCR
  // (보간값)을 prev 로 삼아 다음 FLIP 의 출발점까지 오염된다.
  const running = new WeakMap<HTMLElement, Animation>();
  return {
    ref: (el) => {
      if (el) els.add(el);
    },
    flush: () => {
      const facts = layoutMotionFacts();
      // 위상 스킵의 정밀 조건 — 전면 스킵은 1/50 간헐 원속의 원인이었다(실측: resize 순간
      // 다른 활강 위상이 열려 있으면 무관한 pane 의 FLIP 까지 통째로 죽어 즉시 점프).
      //  · resize 위상(드래그): 전면 스킵 — 즉각 추종이 계약.
      //  · move 위상: scope 안의 탭 슬롯만 스킵(그 이동은 스탠드인 시스템 소유 — 이중 구동
      //    금지). scope 밖 요소·pane 계열은 보간한다. 전역(scope null) move 는 보수적으로
      //    전면 스킵.
      const skipAll =
        facts.active && (facts.kinds.includes("resize") || facts.scope === null);
      for (const el of els) {
        if (!el.isConnected) {
          els.delete(el);
          continue;
        }
        // 측정 전 이전 보간 취소 — cancel 은 스타일을 최종값으로 되돌리므로, 지금 재는
        // rect 는 항상 "레이아웃의 진짜 현재"다(보간 중간값 오염 차단).
        const prevAnim = running.get(el);
        if (prevAnim) {
          try {
            prevAnim.cancel();
          } catch {
            /* 이미 끝남 */
          }
          running.delete(el);
        }
        const r = el.getBoundingClientRect();
        const now: Snap = { x: r.x, y: r.y, w: r.width, h: r.height };
        const was = prev.get(el);
        prev.set(el, now);
        // 가시성 전환(파킹↔등장)은 FLIP 대상이 아니다 — 파킹은 transform 오프스크린이라
        // rect 차이가 화면폭급이고, 그걸 보간하면 슬롯이 화면을 가로질러 날아간다(실측
        // 여정 로그: 탭 교체 1회에 573→-1027 여정 발화 — 사용자가 본 "a·b 가 두 번
        // 교체되는" 모션의 정체). 보이는→보이는 레이아웃 변화만 보간한다.
        if (!was || el.classList.contains("hole")) continue;
        // 파킹 전환은 FLIP 대상이 아니다 — 판정은 프록시(가시성)가 아니라 좌표다: 파킹은
        // 항상 뷰포트 밖(-200vw)이므로, 출발·도착 어느 쪽이든 화면 밖이면 그것은 레이아웃
        // 모션이 아니라 파킹↔등장이다. (가시성 프록시는 스타일 반영 시차로 오판했다 —
        // 실측 여정 로그 vis:true/true 로 파킹 보간이 발화, 슬롯이 화면을 가로질러 날았다.)
        const vw = window.innerWidth || 4096;
        const offscreen = (r2: Snap) => r2.x + r2.w <= 0 || r2.x >= vw;
        if (offscreen(was) || offscreen(now)) {
          noteRectMotionSkip(el.dataset.node ?? el.className, "park-transition");
          continue;
        }
        const tabId = el.dataset.node?.startsWith("layout/tab/")
          ? el.dataset.node.slice("layout/tab/".length)
          : null;
        const skip =
          skipAll || (facts.active && tabId !== null && (facts.scope?.has(tabId) ?? false));
        if (skip) {
          noteRectMotionSkip(el.dataset.node ?? el.className, facts.kinds.join("+") || "live");
          continue;
        }
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
          // keyframe 은 시작·끝 두 개다 — 단일 keyframe 은 WAAPI 에서 to 로 해석돼 종료 시
          // 시작값으로 스냅한다(실측: 정상 활강 뒤 원점 점프 — 품질 오라클이 잡음). 끝 px 는
          // 취소-후-측정한 진짜 현재값이라 CSS 계산값과의 오차가 없다. "종료 후 1회 더"의
          // 실제 원인은 끝 px 가 아니라 요소당 애니메이션 중복이었고, 그것은 cancel 단일화가
          // 막는다.
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
          running.set(el, a);
          const j = beginJourney(
            el.dataset.node ?? el.className,
            { x: was.x, y: was.y, w: was.w, h: was.h },
            now,
          );
          const landRect = () => {
            const lr = el.getBoundingClientRect();
            return { x: lr.x, y: lr.y, w: lr.width, h: lr.height };
          };
          a.onfinish = () => {
            if (running.get(el) === a) running.delete(el);
            endJourney(j, "finish", landRect());
          };
          a.oncancel = () => {
            endJourney(j, "cancel", landRect());
          };
          adoptLayoutAnimation(a, el.dataset.node ?? el.className, LAYOUT_MOTION_MS);
        } catch {
          /* 애니메이션 불가 환경(테스트 jsdom 등) — 즉시 반영 그대로 */
        }
      }
    },
  };
}
