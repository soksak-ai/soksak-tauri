// 표면이 창 안에 있는가 — 문서 밖 표면의 기하 불변식.
//
// 사고 2026-08-09: 콘텐츠 표면들이 창 밖으로 흩어져 화면 오른쪽에 겹쳐 떠 있었다. 그때
// `ui.verify` 는 `passed` 를 답했다 — 그 판정은 DOM 만 보고 있었고, 나간 것은 DOM 이 아니라
// 문서 밖 표면이었다. 기하는 기하로 판정한다.

export interface SurfaceFrameFact {
  label: string;
  hidden?: boolean;
  effectivelyHidden?: boolean;
  frame: { x: number; y: number; w: number; h: number };
}

export interface SurfaceOverflow {
  label: string;
  frame: { x: number; y: number; w: number; h: number };
  overflow: { left: number; top: number; right: number; bottom: number };
}

/** 반올림 한 픽셀은 사고가 아니다 — 진짜 사고는 수백 px 로 나타났다. */
const TOLERANCE_PX = 2;

/** 보이는데 창 밖에 있는 표면 — 사람이 볼 수 없는 자리에 그려지고 있다는 뜻이다. */
export function surfacesOutsideWindow(
  surfaces: readonly SurfaceFrameFact[],
  window: { w: number; h: number },
): SurfaceOverflow[] {
  // 창 크기를 모르면 판정하지 않는다 — 0 으로 두면 모든 표면이 밖으로 읽힌다.
  if (!(window.w > 0) || !(window.h > 0)) return [];
  const out: SurfaceOverflow[] = [];
  for (const surface of surfaces) {
    if (surface.hidden === true || surface.effectivelyHidden === true) continue;
    const { x, y, w, h } = surface.frame;
    const overflow = {
      left: Math.max(0, Math.round(-x)),
      top: Math.max(0, Math.round(-y)),
      right: Math.max(0, Math.round(x + w - window.w)),
      bottom: Math.max(0, Math.round(y + h - window.h)),
    };
    const worst = Math.max(overflow.left, overflow.top, overflow.right, overflow.bottom);
    if (worst > TOLERANCE_PX) out.push({ label: surface.label, frame: surface.frame, overflow });
  }
  return out;
}

/**
 * 네이티브 층에 보이는데 **앱이 모르는** 표면.
 *
 * 앱의 유령 판정은 자기 장부를 훑는다. 그래서 장부에서 이미 빠지고 네이티브에만 남은 표면은
 * 영원히 안 잡힌다 — 실측 2026-08-09: 탭을 닫았는데 그 표면이 계속 보였고 `ghosts` 는 빈
 * 목록이었다. 그 표면은 매 전환마다 확인 비용을 내고 화면을 덮은 채 아무도 모른다.
 */
export function unknownSurfaces(
  surfaces: readonly SurfaceFrameFact[],
  /** 앎은 여러 출처에서 온다 — 이름 하나를 물으면 답하는 것이면 무엇이든 된다. */
  known: { has(label: string): boolean },
): string[] {
  return surfaces
    .filter((row) => row.hidden !== true && row.effectivelyHidden !== true)
    .map((row) => row.label)
    .filter((label) => !known.has(label));
}
