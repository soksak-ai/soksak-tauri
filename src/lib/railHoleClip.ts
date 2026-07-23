// 레일-홀 클립 — "움직이는 사이드바는 기능창 아래로 지나간다"의 홀(네이티브 임베드) 성립부.
// DOM 표면은 z(레일 0 < 셀 1)로 성립하지만, 홀 뷰의 네이티브 표면은 웹뷰 DOM 전체 뒤에
// 있어 DOM 이 칠하는 픽셀이 무조건 그 위에 보인다. 따라서 레이아웃 모션 동안 레일 평면은
// 홀 영역을 클립으로 제외해 아예 칠하지 않는다 — 시각적으로 레일이 홀 뒤로 지나간다.
export type ClipRect = { x: number; y: number; w: number; h: number };

const px = (n: number) => `${Math.round(n * 100) / 100}`;

/** 호스트 좌표계 기준 홀 목록을 path(evenodd) 클립으로 합성한다. 홀이 없으면 빈 문자열(클립 해제). */
export function holeClipPath(
  host: { w: number; h: number },
  holes: ClipRect[],
): string {
  if (holes.length === 0) return "";
  const outer = `M0 0H${px(host.w)}V${px(host.h)}H0Z`;
  const cuts = holes
    .map(
      (r) =>
        `M${px(r.x)} ${px(r.y)}h${px(r.w)}v${px(r.h)}h${px(-r.w)}Z`,
    )
    .join("");
  return `path(evenodd, "${outer}${cuts}")`;
}

/** 뷰포트 rect 들을 호스트 상대 좌표로 옮기고, 호스트와 실교차하는 유효 홀만 남긴다. */
export function visibleHoles(
  host: { left: number; top: number; width: number; height: number },
  rects: Array<{ left: number; top: number; width: number; height: number }>,
): ClipRect[] {
  const out: ClipRect[] = [];
  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    const x1 = Math.max(r.left, host.left);
    const y1 = Math.max(r.top, host.top);
    const x2 = Math.min(r.left + r.width, host.left + host.width);
    const y2 = Math.min(r.top + r.height, host.top + host.height);
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ x: x1 - host.left, y: y1 - host.top, w: x2 - x1, h: y2 - y1 });
  }
  return out;
}

const HOLE_SLOT_SELECTOR = ".egroup-cell.cell-hole .egroup-body-slot";

/**
 * 모션 위상 동안 레일 평면의 clip-path 를 홀 rect 에 프레임 동기로 맞춘다.
 * rAF 는 폴링이 아니라 진행 중인 레이아웃 애니메이션의 프레임 추적이며, 반환된 정지
 * 함수(모션 종료 에지)가 루프와 클립을 함께 회수한다.
 */
export function trackRailHoleClip(plane: HTMLElement): () => void {
  let raf = 0;
  const tick = () => {
    const host = plane.getBoundingClientRect();
    const rects = Array.from(
      document.querySelectorAll<HTMLElement>(HOLE_SLOT_SELECTOR),
      (el) => el.getBoundingClientRect(),
    );
    plane.style.clipPath = holeClipPath(
      { w: host.width, h: host.height },
      visibleHoles(host, rects),
    );
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    plane.style.clipPath = "";
  };
}
