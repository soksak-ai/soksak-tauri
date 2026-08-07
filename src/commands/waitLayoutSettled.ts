import { layoutMotionFacts, onLayoutMotion } from "../lib/layoutMotion";
import {
  layoutSettlementFacts,
  onLayoutSettlement,
} from "../lib/layoutSettlement";
import {
  CONTENT_VIEW_BODY,
  contentViewHost,
  contentViewSlotVisible,
  hasContentViewHost,
} from "../lib/contentViews";
import { pluginViewPresentationHost } from "../plugins/viewPresentationHost";
import { presentationNowUnixMs } from "../lib/presentationClock";

type NamedAnimation = Animation & { animationName?: string };

function liveLayoutAnimations(): NamedAnimation[] {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return [];
  return document.getAnimations().filter((animation) => {
    const named = animation as NamedAnimation;
    return (
      (animation.playState === "running" || animation.pending) &&
      (named.animationName === "rail-flip-x" || animation.id === "phase")
    );
  }) as NamedAnimation[];
}

function visibleContentViewLabels(): string[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)]
    .filter(contentViewSlotVisible)
    .map((slot) => slot.getAttribute(CONTENT_VIEW_BODY) ?? "")
    .filter(Boolean);
}

/** 현재 창 레이아웃 장벽의 공개 진단면. TIMEOUT과 수동 진단이 같은 사실을 읽는다. */
export function layoutSettlementStatus(settlementKey?: string) {
  const animations = liveLayoutAnimations();
  return {
    settled: !layoutMotionFacts().active
      && !layoutSettlementFacts(settlementKey).active
      && animations.length === 0,
    motion: layoutMotionFacts(),
    settlement: layoutSettlementFacts(settlementKey),
    animations: animations.map((animation) => ({
      id: animation.id,
      name: animation.animationName ?? "",
      playState: animation.playState,
      pending: Boolean(animation.pending),
    })),
    contentViewLabels: visibleContentViewLabels(),
  };
}

/**
 * 레이아웃 거래가 닫히는 에지를 기다린다. 표본 조회나 interval은 없다. 레이아웃 상태 에지와
 * Web Animations finished promise만 소비하며 timeout은 결함 시 명령을 영구 점유하지 않는 상한이다.
 *
 * 영수증은 정착 epoch(presentation clock — 배치 장부·native display 원장과 같은 축)와
 * 표면 주인의 확인 여부를 함께 답한다. 호출자가 자기 시계로 정착 시각을 대신 찍으면 그 값은
 * RPC 왕복까지 포함한 다른 사실이 된다.
 */
export function waitLayoutSettled(timeoutMs = 4_000, settlementKey?: string): Promise<{
  waitedMs: number;
  animations: number;
  settledAtUnixMs: number;
  syncPending: boolean;
}> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let closed = false;
    let generation = 0;
    let timer = 0;
    let unsubscribe = () => {};
    let unsubscribeSettlement = () => {};
    let presentationPending: Promise<void> | null = null;
    let presentationSettled = false;

    const close = (error?: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeSettlement();
      if (error) reject(error);
      // syncPending은 "표면 주인이 이 정착을 확인했는가"다. DOM만 조용해지고 아무 표면
      // 주인도 확인하지 않은 상태를 false로 답하면 "모른다"가 "동기화 끝났다"로 둔갑한다.
      else {
        resolve({
          waitedMs: Math.round(performance.now() - started),
          animations: generation,
          settledAtUnixMs: presentationNowUnixMs(),
          syncPending: !presentationSettled,
        });
      }
    };

    const inspect = () => {
      if (closed) return;
      if (layoutMotionFacts().active || layoutSettlementFacts(settlementKey).active) {
        presentationSettled = false;
        return;
      }
      const animations = liveLayoutAnimations();
      generation = Math.max(generation, animations.length);
      if (animations.length > 0) presentationSettled = false;
      if (animations.length === 0) {
        const pluginPresentation = pluginViewPresentationHost();
        if (!presentationSettled && (hasContentViewHost() || pluginPresentation)) {
          if (!presentationPending) {
            const barriers = [
              ...(hasContentViewHost()
                ? [contentViewHost().presentationSettled(visibleContentViewLabels())]
                : []),
              ...(pluginPresentation ? [pluginPresentation.presentationSettled()] : []),
            ];
            presentationPending = Promise.all(barriers)
              .then(() => { presentationSettled = true; })
              .then(inspect, (error) => close(error instanceof Error ? error : new Error(String(error))))
              .finally(() => { presentationPending = null; });
          }
          return;
        }
        queueMicrotask(() => {
          if (
            !layoutMotionFacts().active &&
            !layoutSettlementFacts(settlementKey).active &&
            liveLayoutAnimations().length === 0
          ) close();
        });
        return;
      }
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(inspect);
    };

    unsubscribe = onLayoutMotion(() => inspect());
    unsubscribeSettlement = onLayoutSettlement(() => inspect());
    timer = window.setTimeout(
      () => close(new Error(
        `레이아웃 거래가 ${timeoutMs}ms 안에 닫히지 않았습니다: ${JSON.stringify(layoutSettlementStatus(settlementKey))}`,
      )),
      timeoutMs,
    );
    inspect();
  });
}
