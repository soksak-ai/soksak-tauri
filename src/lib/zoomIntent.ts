// 줌 인텐트 라우터(플랜 golden-swinging-lynx) — "포커스가 범위를 정한다".
// 뷰에 DOM 포커스가 있으면 그 뷰의 zoom 훅으로(뷰가 자기 관례로 응답: 터미널=폰트,
// 브라우저=페이지 줌), 없으면(프레임 선택 = 크롬 클릭으로 포커스가 body) 창 전체 줌.
// 프레임 선택은 새 상태가 아니라 DOM 포커스의 자연 상태다 — 크롬 클릭이 곧 진입.
import { framework } from "../framework";
import { deepActiveElement, viewContainerOf } from "../commands/catalogDom";
import { emitPluginEvent } from "../plugins/hooks";
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
  void applyWindowZoom(next).catch((error) => {
    console.error("창 줌 적용 실패:", error);
  });
}

export async function applyWindowZoom(factor: number): Promise<void> {
  // 어느 프레임워크인지 여기서 묻지 않는다 — 값은 하나고, 그 값이 화면에 닿는 방법은 그
  // 프레임워크의 것이다(계약 `setWindowZoom`). 한쪽의 명령 이름을 여기서 부르면 다른 쪽은
  // 부팅마다 거절한다(실측 2026-08-08: Electron 활동 피드의 매 부팅 reject 한 줄).
  await framework.setWindowZoom(factor);
  // 웹뷰 밖 표면(CEF 엔진 등)에 방송 — 각 엔진 플러그인이 창×뷰 합성 배율을 자기 표면에 적용.
  emitPluginEvent("window.zoom", { factor });
}

/** 부트의 first-frame barrier가 저장된 단일 zoom 진실을 native에 적용 완료할 때까지 기다린다. */
export function applySavedWindowZoom(): Promise<void> {
  return applyWindowZoom(useSettings.getState().windowZoom);
}

const defaultDeps: ZoomDeps = {
  zoomView: zoomFocusedView,
  stepWindow: stepWindowZoom,
};

/** 훅 없는 뷰의 범용 폴백(§Zoom) — 컨테이너의 본문 폰트 변수를 스텝한다. 본문 폰트를
 * 이 변수로 선언한 뷰(파일 뷰어 등)는 자동으로 줌을 얻고, 미소비 뷰에는 무해하다(옵트인).
 * 행 그리드는 변수 소비 지점이 본문뿐이라 불가침(줌 불변식).
 *
 * 이름 두 벌: 정본은 --tab-font-size(어휘 표준 — 인스턴스는 탭이다), 옛 이름 --view-font-size 도
 * 같은 값으로 함께 쓴다. 이 변수는 docs/PLUGIN-CONTRACT.md 가 공개한 계약면이고 옛 이름으로
 * 선언한 플러그인(editor-codemirror)이 이미 산다 — 한쪽만 쓰면 그 뷰의 줌이 죽는다.
 * 읽기도 새 이름 우선·옛 이름 폴백이다(플러그인이 인라인으로 초기값을 준 경우까지 잇는다).
 * 제거 조건: 이 변수를 선언한 플러그인 전부가 --tab-font-size 로 이행(검증 = 각 플러그인 repo
 * 의 grep 이 0) + PLUGIN-CONTRACT 문서 갱신. 그때 옛 이름 set/get 두 줄을 지운다. */
export const VIEW_FONT_BASE = 13;

const TAB_FONT_VAR = "--tab-font-size";
const TAB_FONT_VAR_LEGACY = "--view-font-size";

export function stepContainerFontVar(host: HTMLElement, action: ZoomAction): void {
  const raw =
    host.style.getPropertyValue(TAB_FONT_VAR) ||
    host.style.getPropertyValue(TAB_FONT_VAR_LEGACY);
  const current = raw ? Number.parseFloat(raw) : VIEW_FONT_BASE;
  const next =
    action === "reset"
      ? VIEW_FONT_BASE
      : Math.max(6, Math.min(40, current + (action === "in" ? 1 : -1)));
  host.style.setProperty(TAB_FONT_VAR, `${next}px`);
  host.style.setProperty(TAB_FONT_VAR_LEGACY, `${next}px`);
}

export function routeZoom(action: ZoomAction, deps: ZoomDeps = defaultDeps): void {
  const active = deepActiveElement();
  const host = viewContainerOf(active);
  const viewId = host?.dataset.tabId ?? null;
  if (viewId && host) {
    if (!deps.zoomView(viewId, action)) stepContainerFontVar(host, action);
    return;
  }
  deps.stepWindow(action);
}
