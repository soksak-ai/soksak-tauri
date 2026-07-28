// webview_* — 자식 웹뷰와 메인 웹뷰 표면. 창 안에서만 답이 나오므로 셸의 것이다.

module.exports = {
  // 브라우저 자식 웹뷰 목록(b-*). 프론트 GC 가 "살아있는 웹뷰 ⊆ 스토어의 뷰"를 대조한다.
  // 셸은 자기가 라벨을 준 표면만 안다 — 그 레지스트리를 접두사로 거른 결과가 답이다. 이 셸은
  // 아직 자식 뷰를 만들지 않아 오늘 답은 빈 목록이고, 그 빈 목록은 가정이 아니라 실측이다.
  webview_list: {
    concept: "브라우저 자식 웹뷰 목록",
    source: "셸 표면 레지스트리(셸이 라벨을 부여한 창·뷰)",
    answer: (ctx) => ctx.surfaces().filter((l) => l.startsWith("b-")),
  },

  // 복구 리로드 in-flight 1회 소모 — 프론트 GC 가 부팅 시 읽어 스윕을 보류한다.
  // 이 셸은 크래시 복구 리로드를 시작하지 않는다 → in-flight 집합이 비어 있음을 셸이 증명한다.
  // 관측 수단이 없어서가 아니라 만든 적이 없어서 비었다 — 그래서 false 가 지어낸 답이 아니다.
  webview_recovery_consume: {
    concept: "복구 리로드 in-flight 플래그",
    source: "셸이 웹뷰 수명을 소유한다 — 이 셸은 복구 리로드를 시작하지 않는다",
    answer: () => false,
  },

  // ── 물음 자체가 성립하지 않는 것들 ────────────────────────────────────────
  //
  // 셋 다 **네이티브 자식 층**을 전제한다. 메인 웹뷰가 맨 위에 있고 그 아래 네이티브 형제가
  // 있어야 홀이 뜻을 갖고, 오버레이 게이트가 덮을 것이 있고, 페이지 위에 바를 그릴 수 없다.
  //
  // 이 프레임워크에는 그 층이 없다 — 못 만들어서가 아니라 **필요가 없어서**다. 콘텐츠는
  // <webview> 로 DOM 안에 살고(HTMLElement), 겹침은 z-index 로 해결되며, 그 위에 DOM 을 얹으면
  // DOM 이 위에 그려진다(scripts/electron/overlay-stacking.test.mjs 가 픽셀로 잰다).
  //
  // 그래서 이것들은 "Electron 이 못 하는 일"이 아니라 **없는 개념**이다. 앱도 묻지 않는다:
  // 프레임워크가 engineProvision.nativeChildWebview=false 를 밝히고, 홀 보고는 그 값을 보고
  // 아예 시작하지 않는다(src/lib/domHoles.ts). 그래도 표에 남기는 이유는 옛 프런트나 플러그인이
  // 물어 왔을 때 UNKNOWN_COMMAND 한 줄 대신 사유를 받게 하기 위해서다.

  webview_overlay_active: {
    concept: "오버레이 히트테스트 게이트",
    absent:
      "게이트가 덮을 홀이 없다 — 네이티브 자식 층이 없고(engineProvision.nativeChildWebview=false), 겹침은 z-index 로 해결된다.",
  },

  webview_dom_holes: {
    concept: "영역 단위 히트테스트 홀",
    absent:
      "홀이 뜻을 갖는 전제(메인 웹뷰 아래 네이티브 형제)가 없다 — 콘텐츠가 DOM 안에 살아 OS 히트테스트가 끼어들 자리가 없다. 앱은 제공 선언을 보고 묻지 않는다.",
  },

  webview_divider_highlight: {
    concept: "네이티브 디바이더 강조 바",
    absent:
      "페이지 위에 그릴 네이티브 층이 없다 — 강조는 DOM 이 그리면 되고 그것으로 충분하다(그 판단은 UI 의 것이다).",
  },
};
