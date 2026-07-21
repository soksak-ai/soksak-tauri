// 캡처 정착 — window.snapshot 이 "명령을 받으면 상태 불문 정확한 프레임"을 내도록 보장한다.
//
// 비전면(가려진/백그라운드) 창은 macOS 가 occlusion 으로 document.timeline 을 멈춘다. 그러면
// 진입 전이 애니메이션(예: 다이얼로그 fade-in, opacity 0→1)이 시작 프레임(opacity 0)에 갇힌다.
// arm_capture 가 가림을 풀고 렌더를 깨워도 timeline 은 다시 흐르지 않으므로, 갇힌 중간 프레임이
// 그대로 찍힌다(모달이 열려 있는데 투명하게 찍히는 현상의 근본).
//
// 그래서 캡처 직전, 유한 반복 애니메이션을 끝 상태로 명시 정착(finish)해 "지금 보여야 할 최종
// 프레임"을 만든다. finish 는 timeline 정지와 무관하게 애니메이션을 끝으로 seek 하고 스타일을
// 확정한다. 무한 반복(스피너 등)은 어느 위상이든 유효한 프레임이므로 건드리지 않는다.
// 플러그인 뷰는 Shadow DOM 안에 마운트되므로 shadowRoot 를 재귀 순회한다.

export function isFiniteAnimation(iterations: number | undefined): boolean {
  return typeof iterations === "number" && Number.isFinite(iterations);
}

function collectAnimations(root: Document | ShadowRoot, out: Animation[]): void {
  const anyRoot = root as unknown as { getAnimations?: () => Animation[] };
  if (typeof anyRoot.getAnimations === "function") {
    for (const a of anyRoot.getAnimations()) out.push(a);
  }
  // shadow root 는 getAnimations 로 자기 트리를 안 준다 → 자식의 shadowRoot 를 재귀.
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) collectAnimations(el.shadowRoot, out);
  }
}

export function settleAnimationsForCapture(doc: Document = document): void {
  const anims: Animation[] = [];
  collectAnimations(doc, anims);
  for (const a of anims) {
    const iters = a.effect?.getComputedTiming?.().iterations;
    if (isFiniteAnimation(iters)) {
      // 이미 끝났거나(InvalidState) 미지원이면 무시 — 나머지 정착을 막지 않는다.
      try {
        a.finish();
      } catch {
        /* noop */
      }
    }
  }
  void doc.documentElement.offsetHeight; // 강제 리플로우 — finish 스타일을 캡처 전에 반영.
}
