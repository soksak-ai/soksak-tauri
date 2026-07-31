// 뷰 본문 슬롯의 유효 가시성(시트 활성 && 탭 활성) — 코어가 한 곳에서 소유한다(R12 의 네이티브 층 확장).
// CSS parkedStyle 은 DOM 층만 다룬다. 네이티브 층은 코어가 직접 정리한다:
//   ① 코어 소유 child webview(browserLabel 스킴)를 표시/숨김 — 숨김은 responder 반납까지 수행
//      (webview_visible), 없는 label 은 코어 커맨드가 조용히 no-op.
//   ② 플러그인에 view.parked 사실을 통지 — 엔진 서피스 소유 플러그인이 표시/숨김·재스냅을 이 사실에
//      맞춘다. 각 플러그인의 뷰포트 추측(IntersectionObserver)·재스냅 경쟁이 규칙 하나로 대체된다.
// 멱등: 같은 상태 재커밋은 no-op — 렌더마다 불러도 비용은 변화 시에만 발생한다.
import { moduleState } from "../lib/moduleState";
import { contentViewHost } from "./contentViews";
import { emitPluginEvent } from "../plugins/hooks";
import { browserLabel } from "./webviewLabels";
import { parkedStyle } from "./layerPark";

// 뷰가 실제로 보이는가 — **세 층이 모두 참일 때만** 참이다: 프로젝트가 활성이고, 그 프로젝트 안에서
// 그 스페이스가 활성이고, 그 스페이스 안에서 그 뷰가 활성 탭이다. 한 층이라도 빠지면 코어는 보이지 않는
// 뷰를 "보인다"고 듣고 네이티브 child(브라우저 webview·엔진 서피스)를 화면에 남긴다 — 프로젝트를
// 전환해도 이전 프로젝트의 브라우저가 그대로 떠 있던 결함이 정확히 이것이었다(프로젝트 층 누락).
// CSS 는 이 층들을 각자 숨기지만 네이티브 층은 CSS 밖에 있으므로, 판정은 한 식으로 모은다.
export function surfaceShown(projectActive: boolean, spaceActive: boolean, tabActive: boolean): boolean {
  return projectActive && spaceActive && tabActive;
}

/**
 * 뷰 슬롯의 DOM/GPU 합성 계약. 평상시 비활성 탭은 세션 크기를 보존하는 오프스크린
 * 파킹을 쓰지만, 최대화처럼 한 표면만 존재해야 하는 exclusive 상태에서는 제외 슬롯을
 * display:none으로 합성 트리에서도 제거한다. DOM과 플러그인 인스턴스는 언마운트하지
 * 않으며, 복원 커밋의 layout.reflow가 다시 현재 슬롯 크기를 전달한다.
 */
export function viewSurfaceStyle(visible: boolean, exclusive: boolean) {
  return {
    ...parkedStyle(visible),
    display: exclusive && !visible ? "none" : undefined,
  };
}

// 갈아끼우기 경계 밖 — 이 표가 새것이 되면 채운 쪽은 이미 채웠다고 알아 다시 채우지 않는다.
const visibleByView = moduleState("lib/viewPark#visibleByView", () => new Map<string, boolean>());
export function commitViewVisibility(viewId: string, visible: boolean): void {
  if (visibleByView.get(viewId) === visible) return;
  visibleByView.set(viewId, visible);
  // **호스트를 거친다.** 이름으로 직접 부르면 콘텐츠가 DOM 안에 사는 프레임워크에서 그 이름이
  // 위임으로 거절되고(FRAMEWORK_DELEGATED), 파킹이 아예 일어나지 않는다 — 탭을 바꿔도 이전
  // 뷰가 떠 있고 새 뷰는 안 보인다(실측 2026-07-30: 그 거절이 요구 원장에 301건).
  // 앱이 콘텐츠를 어떻게 보여주는지는 contentViews 가 단일 소유자다.
  void contentViewHost()
    .visible(browserLabel(viewId), visible)
    .catch((e: unknown) => {
      // 삼키지 않는다 — 못 한 파킹은 "이전 브라우저가 안 사라진다"로만 나타나고, 그 증상에서
      // 이 자리로 돌아오는 길이 없다.
      console.warn(`[viewPark] 파킹 커밋 실패: ${viewId} visible=${visible}`, e);
    });
  emitPluginEvent("view.parked", { viewId, parked: !visible });
}

/** 뷰가 영구히 닫힐 때 상태 회수(맵 누적 방지). */
export function dropViewVisibility(viewId: string): void {
  visibleByView.delete(viewId);
}
