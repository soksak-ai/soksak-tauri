// 레일-홀 클립 — "움직이는 사이드바는 기능창 아래로 지나간다"의 홀(네이티브 임베드) 성립부.
// DOM 표면은 z(레일 0 < 셀 1)로 성립하지만, 홀 뷰의 네이티브 표면은 웹뷰 DOM 전체 뒤에
// 있어 DOM 이 칠하는 픽셀이 무조건 그 위에 보인다. 따라서 레이아웃 모션 동안 레일 평면은
// 홀 영역을 클립으로 제외해 아예 칠하지 않는다 — 시각적으로 레일이 홀 뒤로 지나간다.
export type ClipRect = { x: number; y: number; w: number; h: number };

const px = (n: number) => `${Math.round(n * 100) / 100}`;

/**
 * 호스트 좌표계 기준 홀 목록을 path() 클립으로 합성한다. 홀이 없어도 외곽 전체-박스
 * 클립을 반환한다(시각 무영향) — "모션 중엔 항상 클립이 걸려 있다"가 명령면(ui.measure)
 * 에서 추적기 생존 신호로 실측되게 하는 계약이다. 해제("")는 모션 종료 시 추적기만 한다.
 * path() 의 fill-rule 인자는 WebKit 이 파싱하지 못해 값 전체가 무시되므로 쓰지 않는다 —
 * 기본 nonzero 권선에서 홀이 뚫리도록 외곽(시계)과 홀(반시계)을 반대 방향으로 그린다.
 */
export function holeClipPath(
  host: { w: number; h: number },
  holes: ClipRect[],
): string {
  const outer = `M0 0H${px(host.w)}V${px(host.h)}H0Z`;
  if (holes.length === 0) return `path("${outer}")`;
  const cuts = holes
    .map(
      (r) =>
        `M${px(r.x)} ${px(r.y)}v${px(r.h)}h${px(r.w)}v${px(-r.h)}Z`,
    )
    .join("");
  return `path("${outer}${cuts}")`;
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

// 홀 기준은 뷰의 transparent 선언 하나다(GroupArea 가 셀에 cell-hole 로 표시) — App.css
// 홀 배경 규칙과 같은 기준. 콘텐츠 클래스 등 제2 기준을 들이지 마라: 기준이 갈라지면
// 한쪽만 아는 홀이 생겨 사이드바가 그 표면 위에 칠해진다(실측: OSR 미절단 사고).
const HOLE_SLOT_SELECTOR = ".egroup-cell.cell-hole .egroup-body-slot";

/**
 * 모션 위상 동안 레일 평면의 clip-path 를 홀 rect 에 프레임 동기로 맞춘다.
 * rAF 는 폴링이 아니라 진행 중인 레이아웃 애니메이션의 프레임 추적이며, 반환된 정지
 * 함수(모션 종료 에지)가 루프와 클립을 함께 회수한다.
 */
let warnedRejected = false;

/**
 * 상시 계약: 사이드바는 홀(브라우저 네이티브 표면) 위에 픽셀을 칠하지 않는다 — 모션
 * 여부와 무관하게, 겹치면 언제나 사이드바가 브라우저 아래다(사용자 규정). 클립은 평면이
 * 아니라 각 레일 레이어(.sidebar)에 건다 — 시각 효과는 같고, 노출 노드(rail/left)의
 * computed clipPath 로 상태를 명령면(ui.measure)에서 실측할 수 있다. clip-path 좌표계는
 * 요소 자신의 박스이므로 홀 rect 를 레이어별 상대 좌표로 옮긴다.
 * 호출 시점: 매 React 커밋(정적 상태) + 애니메이션 위상 rAF(중간 프레임) 둘 다.
 */
export function applyRailHoleClip(plane: HTMLElement): void {
  const holeRects = Array.from(
    document.querySelectorAll<HTMLElement>(HOLE_SLOT_SELECTOR),
    (el) => el.getBoundingClientRect(),
  );
  for (const layer of Array.from(
    plane.querySelectorAll<HTMLElement>(".sidebar"),
  )) {
    const box = layer.getBoundingClientRect();
    const clip = holeClipPath(
      { w: box.width, h: box.height },
      visibleHoles(box, holeRects),
    );
    layer.style.clipPath = clip;
    // 수용 검증 — 엔진이 값을 거부하면 조용한 무클립이 된다. 침묵 금지.
    if (clip !== "" && layer.style.clipPath === "" && !warnedRejected) {
      warnedRejected = true;
      console.warn("[railHoleClip] clip-path 값이 거부됨:", clip);
    }
  }
}

/** 애니메이션 위상 동안 프레임 동기 재계산. 종료 시 해제가 아니라 최종 기하로 1회 정착한다(상시 계약). */
export function trackRailHoleClip(plane: HTMLElement): () => void {
  let raf = 0;
  const tick = () => {
    applyRailHoleClip(plane);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    applyRailHoleClip(plane);
  };
}
