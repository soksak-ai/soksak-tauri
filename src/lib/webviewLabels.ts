import { moduleState } from "../lib/moduleState";
import { currentWindow } from "../framework";

// 멀티 윈도우 식별자의 단일 진실. 브라우저 child webview label 처럼 *Tauri 전역에서 유일해야 하는*
// 이름은 반드시 여기서 파생한다 — 각 창의 sessions 스토어 id(viewId 등)는 창별 카운터라 창마다 겹친다
// (두 창이 같은 v1 을 만든다). 창 label 로 네임스페이스해 전역 유일성을 보장한다.
//
// [규칙] inline 으로 `b-${viewId}` 를 다시 정의하면(흩어진 정의) 네임스페이스가 빠져 두 창이 같은
// webview label 을 만들고 충돌한다(둘째 창 브라우저 미생성·좀비). 그래서 브라우저 label 은 오직
// browserLabel() 로만 만든다 — webviewLabels.test.ts 가 inline 재정의를 빌드로 막는다.

// 현재 창 label(캐시). 각 창은 독립 JS 컨텍스트라 자기 label 을 캐시한다. Tauri 런타임 밖(jsdom
// 테스트)에서는 getCurrentWebviewWindow 가 동기 throw 하므로 "" 로 폴백한다 — 테스트는 실제 webview 를
// 만들지 않아 이 값이 Tauri 와 대조되지 않는다(폴백 값은 무해).
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화가
// 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
const ms = moduleState("lib/webviewLabels#state", () => ({
  cached: null as string | null,
}));
export function currentWindowLabel(): string {
  if (ms.cached !== null) return ms.cached;
  try {
    ms.cached = currentWindow().label;
  } catch {
    ms.cached = "";
  }
  return ms.cached;
}

// 브라우저 child webview 의 전역 유일 label. 형식: b-<windowLabel>-<viewId>.
export function browserLabel(viewId: string): string {
  return `b-${currentWindowLabel()}-${viewId}`;
}

/** 브라우저 자식 웹뷰 라벨의 접두사 — 정본은 `soksak_core::window_spec::BROWSER_PREFIX` 다.
 *
 *  TS 는 Rust 상수를 못 읽으므로 사본이고, event-name-scan 게이트가 두 값을 대조한다.
 *  갈리면 한쪽은 남의 창 웹뷰를 자기 것으로 세거나 자기 것을 못 찾는다. */
export const BROWSER_PREFIX = "b-";

// 이 창의 브라우저 webview label 접두사 — GC 가 *자기 창* 브라우저만 대조·회수하도록 필터링한다
// (webview_list 는 앱 전역 모든 창의 브라우저를 반환하므로, 접두사로 자기 것만 골라야 다른 창 것을
// 잘못 닫지 않는다).
export function browserLabelPrefix(): string {
  return `${BROWSER_PREFIX}${currentWindowLabel()}-`;
}

// 전역 고아 판정 — 부모 창이 살아있지 않은 브라우저 child label. label 문법(b-<창>-<뷰>)의
// 소유는 이 모듈이므로 판정도 여기 산다(inline 재구성 금지 게이트의 대상 문법).
export function orphanBrowserLabels(labels: string[], windows: string[]): string[] {
  return labels.filter(
    (l) =>
      l.startsWith(BROWSER_PREFIX) &&
      !windows.some((w) => l.startsWith(`${BROWSER_PREFIX}${w}-`)),
  );
}

// browserLabel 의 역파생 — *이 창의* 브라우저 label 이면 viewId 를, 아니면 null.
// 다른 창의 브라우저(b-<다른창>-…)와 비-브라우저 webview 는 이 창이 이름을 모른다.
export function browserViewIdFromLabel(label: string): string | null {
  const prefix = browserLabelPrefix();
  return label.startsWith(prefix) ? label.slice(prefix.length) : null;
}
