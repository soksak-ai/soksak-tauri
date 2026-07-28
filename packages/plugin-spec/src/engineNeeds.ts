// 표면이 렌더링 엔진에 요구하는 것 — 프레임워크도 OS 도 이름으로 적지 않는다.
//
// 세 축이 서로 다른 것을 가리킨다:
//   framework = Tauri | Electron        — 창·IPC·네이티브 API·패키징을 주는 것
//   platform  = macOS | Linux | Windows — 운영체제
//   engine    = WKWebView | Chromium | WebKitGTK — 웹을 그리는 것
//
// 플러그인이 아는 것은 **자기 표면이 무엇을 필요로 하는가**뿐이다. 그것이 어떻게 충족되는지는
// framework × platform 조합이 정한다:
//
//   requiresEngine: "chromium"
//     Tauri × macOS    → WKWebView 미달 → Chromium 사이드카로 승격
//     Tauri × Windows  → WebView2 가 이미 Chromium → 승격 no-op
//     Electron × 전부  → 프레임워크가 Chromium → 승격 no-op
//
// 프레임워크 이름으로 적으면 안 되는 이유가 이 표에 있다. astryx 는 macOS WKWebView 에서
// 동작하지 않아 Chromium 표면으로 승격된 첫 사례인데, 이것을 `not: ["electron"]` 로 적으면
// **Electron 에서 더 잘 도는 것을 숨기게 된다.** Electron 은 요구를 덜 충족하는 게 아니라
// 더 충족한다. 축이 반대다.
//
// 근거: docs/multiplatform-engine-strategy.md R4("chromium-grade 는 산출물이 아니라 등급이다 —
// 플랫폼의 OS 웹뷰가 이미 등급을 충족하면 승격은 no-op") 와 §6("판정 단위는 표면 × 플랫폼").

/** 표면이 요구하는 엔진 등급. 미지정 = 등급 무관(기본). */
export type EngineGrade = "chromium";

/** 한 프레임워크가 실제로 제공하는 것. 어댑터가 자기 사실로 채운다. */
export interface EngineProvision {
  /** 이 프레임워크·OS 조합의 웹뷰가 chromium 등급인가. */
  chromium: boolean;
  /**
   * 네이티브 자식 웹뷰를 창에 합성해 얹을 수 있는가.
   *
   * Tauri/macOS 는 hole-punch·hitTest 스위즐로 제공한다. Electron 은 자기 세계가 Chromium 이라
   * 그 장치 자체가 필요 없다 — 제공하지 않는 것이 아니라 **다른 방식으로 같은 일을 한다.**
   * 그래서 이 값이 false 인 프레임워크에서는 자식 웹뷰를 전제한 표면만 빠진다.
   */
  nativeChildWebview: boolean;
}

/** 플러그인이 선언하는 필요. 둘 다 선택 — 안 적으면 요구가 없다는 뜻이다. */
export interface EngineNeeds {
  requiresEngine?: EngineGrade;
  requiresNativeChildWebview?: boolean;
}

/** 필요를 못 채운 항목들. 비어 있으면 적재 가능하다. */
export function unmetNeeds(needs: EngineNeeds, has: EngineProvision): string[] {
  const unmet: string[] = [];
  if (needs.requiresEngine === "chromium" && !has.chromium) {
    unmet.push("requiresEngine=chromium");
  }
  if (needs.requiresNativeChildWebview && !has.nativeChildWebview) {
    unmet.push("requiresNativeChildWebview");
  }
  return unmet;
}
