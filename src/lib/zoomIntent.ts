// 줌 인텐트 라우터(플랜 golden-swinging-lynx) — "포커스가 범위를 정한다".
// 뷰에 DOM 포커스가 있으면 그 뷰의 zoom 훅으로(뷰가 자기 관례로 응답: 터미널=폰트,
// 브라우저=페이지 줌), 없으면(프레임 선택 = 크롬 클릭으로 포커스가 body) 창 전체 줌.
// 프레임 선택은 새 상태가 아니라 DOM 포커스의 자연 상태다 — 크롬 클릭이 곧 진입.
import { invoke } from "@tauri-apps/api/core";
import { deepActiveElement, viewContainerOf } from "../commands/catalogDom";
import { zoomFocusedView } from "../plugins/viewFocus";
import { useSettings } from "../state/settings";

export type ZoomAction = "in" | "out" | "reset";

/** 플랫폼 주 수정자 — macOS=⌘(metaKey), Windows/Linux=Ctrl. 줌 키의 3플랫폼 공통 문법. */
export function isPrimaryModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: string = navigator.platform,
): boolean {
  return /mac/i.test(platform) ? e.metaKey : e.ctrlKey;
}

export const ZOOM_STEP = 0.1;

/** 창 줌 배율 계약 — 0.5..2.0, 0.1 스텝 반올림(부동소수 누적 방지). */
export function clampWindowZoom(factor: number): number {
  return Math.min(2, Math.max(0.5, Math.round(factor * 10) / 10));
}

interface ZoomDeps {
  /** 뷰 줌 위임 — 훅 미구현이면 false(그래도 창 줌으로 새지 않는다: 옵트인 규약). */
  zoomView(viewId: string, action: ZoomAction): boolean;
  stepWindow(action: ZoomAction): void;
}

/** 창 전체 줌 한 스텝 — 값은 설정(windowZoom)이 단일 진실, 적용은 네이티브 일괄
 * (메인 웹뷰 + 자식 웹뷰 전부 같은 배율 = "값 하나, 소비 전원"). */
export function stepWindowZoom(action: ZoomAction): void {
  const s = useSettings.getState();
  const next =
    action === "reset"
      ? 1
      : clampWindowZoom(s.windowZoom + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
  s.setWindowZoom(next);
  applyWindowZoom(next);
}

export function applyWindowZoom(factor: number): void {
  void invoke("webview_zoom", { factor }).catch((e) =>
    console.error("창 줌 적용 실패:", e),
  );
}

const defaultDeps: ZoomDeps = {
  zoomView: zoomFocusedView,
  stepWindow: stepWindowZoom,
};

/** 훅 없는 뷰의 범용 폴백(§Zoom) — 컨테이너의 --view-font-size 를 스텝한다. 본문 폰트를
 * 이 변수로 선언한 뷰(파일 뷰어 등)는 자동으로 줌을 얻고, 미소비 뷰에는 무해하다(옵트인).
 * 행 그리드는 변수 소비 지점이 본문뿐이라 불가침(줌 불변식). */
export const VIEW_FONT_BASE = 13;

export function stepContainerFontVar(host: HTMLElement, action: ZoomAction): void {
  const raw = host.style.getPropertyValue("--view-font-size");
  const current = raw ? Number.parseFloat(raw) : VIEW_FONT_BASE;
  const next =
    action === "reset"
      ? VIEW_FONT_BASE
      : Math.max(6, Math.min(40, current + (action === "in" ? 1 : -1)));
  host.style.setProperty("--view-font-size", `${next}px`);
}

export function routeZoom(action: ZoomAction, deps: ZoomDeps = defaultDeps): void {
  const active = deepActiveElement();
  const host = viewContainerOf(active);
  const viewId = host?.dataset.paneId ?? null;
  if (viewId && host) {
    if (!deps.zoomView(viewId, action)) stepContainerFontVar(host, action);
    return;
  }
  deps.stepWindow(action);
}
