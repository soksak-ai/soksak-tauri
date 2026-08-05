export type DomTraceTarget = { address: string; el: Element };

export type DomAnimationSample = {
  name: string;
  playState: AnimationPlayState;
  startTime: number | null;
  currentTime: number | null;
  progress: number | null;
};

export type DomTraceSample = {
  captureFrame: number;
  frameTime: number;
  unixMs: number;
  nodes: Array<{
    address: string;
    connected: boolean;
    rect: { x: number; y: number; w: number; h: number };
    animations: DomAnimationSample[];
  }>;
};

/**
 * 캡처 플러그인이 저장 완료를 알린 바로 그 프레임 사건에서 여러 공개 DOM 노드를 읽는다.
 * 별도 rAF/타이머 시계를 만들지 않으므로 가려진 창에서도 멈추지 않고, PNG fNNNN과
 * sample.captureFrame이 항상 1:1로 대응한다.
 */
export function createFiniteDomTraceSampler(
  targets: readonly DomTraceTarget[],
): { sample(captureFrame: number, frameTime?: number): void; samples(): DomTraceSample[] } {
  const samples: DomTraceSample[] = [];
  return {
    sample(captureFrame, frameTime = performance.now()) {
      samples.push({
        captureFrame,
        frameTime,
        unixMs: performance.timeOrigin + frameTime,
        nodes: targets.map(({ address, el }) => {
          const rect = el.getBoundingClientRect();
          const animations = typeof el.getAnimations === "function"
            ? el.getAnimations().map((animation) => {
                const css = animation as CSSAnimation;
                const timing = animation.effect?.getComputedTiming();
                return {
                  name: css.animationName ?? "",
                  playState: animation.playState,
                  startTime: typeof animation.startTime === "number" ? animation.startTime : null,
                  currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
                  progress: typeof timing?.progress === "number" ? timing.progress : null,
                };
              })
            : [];
          return {
            address,
            connected: el.isConnected,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            animations,
          };
        }),
      });
    },
    samples: () => samples.slice(),
  };
}
