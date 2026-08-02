import { moduleState } from "../../lib/moduleState";
import { TAURI_CONTENT_HOLE } from "./holeMarkers";
// 레일-홀 클립 — "움직이는 사이드바는 기능창 아래로 지나간다"의 홀(네이티브 임베드) 성립부.
// DOM 표면은 z(레일 0 < 셀 1)로 성립하지만, 홀 뷰의 네이티브 표면은 웹뷰 DOM 전체 뒤에
// 있어 DOM 이 칠하는 픽셀이 무조건 그 위에 보인다. 따라서 레이아웃 모션 동안 레일 평면은
// 홀 영역을 클립으로 제외해 아예 칠하지 않는다 — 시각적으로 레일이 홀 뒤로 지나간다.
export type ClipRect = { x: number; y: number; w: number; h: number };

const px = (n: number) => `${Math.round(n * 100) / 100}`;

/**
 * 호스트 좌표계 기준 홀 목록을 path() 클립으로 합성한다.
 *
 * **자를 것이 없으면 클립을 걸지 않는다("none").** 옛 기준은 홀이 없어도 외곽 전체-박스
 * 클립을 걸고 그것을 "추적기 생존 신호(시각 무영향)"라 불렀다. 시각 무영향이 아니었다:
 * clip-path 는 요소를 클립 노드로 만들고, 클립이 커질 때 새로 드러난 영역을 엔진이
 * 무효화하지 않는다 — 창을 키우면 레일에서 옛 높이 아래가 옛 픽셀 그대로 남아 카드
 * 하단 테두리가 사라졌다(실측 2026-07-27, scripts/e2e/rail-border.mjs). 같은 행에서
 * 클립이 없는 콘텐츠 칸은 멀쩡히 다시 칠해졌다. 아무것도 자르지 않는 클립이 도색 정확성을
 * 무너뜨린 것이다. 생존 신호는 그리기 속성이 아니라 자기 채널(data-rail-clip)이 진다.
 *
 * path() 의 fill-rule 인자는 WebKit 이 파싱하지 못해 값 전체가 무시되므로 쓰지 않는다 —
 * 기본 nonzero 권선에서 홀이 뚫리도록 외곽(시계)과 홀(반시계)을 반대 방향으로 그린다.
 */
export function holeClipPath(
  host: { w: number; h: number },
  holes: ClipRect[],
): string {
  if (holes.length === 0) return "none";
  const outer = `M0 0H${px(host.w)}V${px(host.h)}H0Z`;
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
  rects: ReadonlyArray<{ left: number; top: number; width: number; height: number }>,
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

// 실제 content-view 슬롯에서 Tauri가 투영한 private marker가 유일한 합성 기준이다.
/** Tauri 합성 슬롯 셀렉터 — 레일 클립·본문 동결이 공유한다. */
export const HOLE_SELECTOR = TAURI_CONTENT_HOLE;

/**
 * 모션 위상 동안 레일 평면의 clip-path 를 홀 rect 에 프레임 동기로 맞춘다.
 * rAF 는 폴링이 아니라 진행 중인 레이아웃 애니메이션의 프레임 추적이며, 반환된 정지
 * 함수(모션 종료 에지)가 루프와 클립을 함께 회수한다.
 */
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화가
// 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
const ms = moduleState("framework/tauri/railHoleClip#state", () => ({
  warnedRejected: false,
}));
/**
 * 상시 계약: 사이드바는 홀(브라우저 네이티브 표면) 위에 픽셀을 칠하지 않는다 — 모션
 * 여부와 무관하게, 겹치면 언제나 사이드바가 브라우저 아래다(사용자 규정). 클립은 평면이
 * 아니라 각 레일 레이어(.sidebar)에 건다 — 시각 효과는 같고, 노출 노드(rail/left)의
 * computed clipPath 로 상태를 명령면(ui.measure)에서 실측할 수 있다. clip-path 좌표계는
 * 요소 자신의 박스이므로 홀 rect 를 레이어별 상대 좌표로 옮긴다.
 * 호출 시점: 매 React 커밋(정적 상태) + 애니메이션 위상 rAF(중간 프레임) 둘 다.
 */
export function applyRailHoleClip(
  plane: HTMLElement,
  holeRects: ReadonlyArray<{ left: number; top: number; width: number; height: number }>,
): void {
  // 읽기를 전부 끝낸 뒤 쓰기를 전부 한다. 레이어마다 read→write 를 번갈아 하면 한 번의
  // clipPath 쓰기가 다음 getBoundingClientRect 를 강제 재레이아웃으로 만든다(레이아웃 스래싱).
  const layers = Array.from(plane.querySelectorAll<HTMLElement>(".sidebar"));
  const clips = layers.map((layer) => {
    const box = layer.getBoundingClientRect();
    const holes = visibleHoles(box, holeRects);
    return { clip: holeClipPath({ w: box.width, h: box.height }, holes), cut: holes.length > 0 };
  });
  layers.forEach((layer, i) => {
    const { clip, cut } = clips[i];
    // 추적기 생존·클립 상태는 자기 채널로 관측한다 — 그리기 속성을 신호로 겸업시키지 않는다.
    layer.dataset.railClip = cut ? "cut" : "none";
    layer.style.clipPath = clip;
    // 수용 검증 — 엔진이 값을 거부하면 조용한 무클립이 된다. 침묵 금지.
    if (clip !== "none" && layer.style.clipPath === "" && !ms.warnedRejected) {
      ms.warnedRejected = true;
      console.warn("[railHoleClip] clip-path 값이 거부됨:", clip);
    }
  });
}

/**
 * 홀 rect 수집 — 문서 전체 스캔이다. 홀은 창의 사실이지 어느 프로젝트의 사실이 아니므로
 * 한 패스에 한 번만 부른다(railHoleClipHost 가 그 소유자다).
 */
export function collectHoleRects(): DOMRect[] {
  return Array.from(document.querySelectorAll<HTMLElement>(HOLE_SELECTOR), (el) =>
    el.getBoundingClientRect(),
  );
}
