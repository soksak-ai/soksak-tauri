// webview_* — 자식 웹뷰와 메인 웹뷰 표면. 창 안에서만 답이 나오므로 프레임워크의 것이다.

const { frameworkError } = require("./error.cjs");

module.exports = {
  // 새 창은 DOM 이 만들 수 없다 — 이것만은 프레임워크가 답한다. 원본은 URL 을 파싱해
  // 팝업 창을 연다(파싱 실패는 오류다: 지어낸 URL 로 창을 열면 그 창이 무엇인지 아무도 모른다).
  webview_open_window: {
    concept: "외부 URL 새 창",
    source: "BrowserWindow — 창은 DOM 이 만들 수 없다",
    answer: (ctx, args) => {
      const raw = String(args.url ?? "");
      let url;
      try {
        url = new URL(raw);
      } catch (e) {
        throw frameworkError("INVALID_URL", `URL 이 아님: ${raw}`);
      }
      if (!/^https?:$/.test(url.protocol)) {
        throw frameworkError("INVALID_URL", `http(s) 가 아님: ${url.protocol}`);
      }
      ctx.createWindow(`w-popup-${Date.now()}`, null).loadURL(url.href);
      return null;
    },
  },

  // 브라우저 자식 웹뷰 목록(b-*). 프론트 GC 가 "살아있는 웹뷰 ⊆ 스토어의 뷰"를 대조한다.
  // 프레임워크는 자기가 라벨을 준 표면만 안다 — 그 레지스트리를 접두사로 거른 결과가 답이다. 이 프레임워크는
  // 아직 자식 뷰를 만들지 않아 오늘 답은 빈 목록이고, 그 빈 목록은 가정이 아니라 실측이다.
  webview_list: {
    concept: "브라우저 자식 웹뷰 목록",
    source: "프레임워크 표면 레지스트리(프레임워크가 라벨을 부여한 창·뷰)",
    answer: (ctx) => ctx.surfaces().filter((l) => l.startsWith("b-")),
  },

  // 복구 리로드 in-flight 1회 소모 — 프론트 GC 가 부팅 시 읽어 스윕을 보류한다.
  // 이 프레임워크는 크래시 복구 리로드를 시작하지 않는다 → in-flight 집합이 비어 있음을 프레임워크가 증명한다.
  // 관측 수단이 없어서가 아니라 만든 적이 없어서 비었다 — 그래서 false 가 지어낸 답이 아니다.
  webview_recovery_consume: {
    concept: "복구 리로드 in-flight 플래그",
    source: "프레임워크가 웹뷰 수명을 소유한다 — 이 프레임워크는 복구 리로드를 시작하지 않는다",
    answer: () => false,
  },


  // ── 렌더러가 소유하는 것들 ────────────────────────────────────────────────
  //
  // 콘텐츠는 <webview> 태그로 **이 렌더러의 DOM 안**에 산다(src/lib/contentViews.ts 의 domHost).
  // 그래서 이 명령들은 프로세스를 건널 이유가 없다 — 건너면 자기 자신에게 왕복하는 셈이다.
  // 앱은 contentViewHost() 를 거치므로 여기까지 오지 않는다.
  //
  // 그래도 표에 적는 이유: 이름이 프레임워크 갈래(webview_)라 표에 없으면 **부재로 거절**된다.
  // 그것은 거짓이다 — 개념은 있고 답하는 자리가 다를 뿐이다. 거짓 부재를 받은 사람은 없는
  // 기능이라 믿고 우회를 만든다.
  webview_open: {
    concept: "콘텐츠 뷰 열기",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_close: {
    concept: "콘텐츠 뷰 닫기",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_alive: {
    concept: "콘텐츠 뷰 생존",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_bounds: {
    concept: "콘텐츠 뷰 배치",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_visible: {
    concept: "콘텐츠 뷰 표시",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_navigate: {
    concept: "콘텐츠 뷰 항행",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_history: {
    concept: "세션 히스토리 이동",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_stop: {
    concept: "적재 정지",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_zoom: {
    concept: "확대 배율",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_zoom_view: {
    concept: "확대 배율(뷰)",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_devtools: {
    concept: "인스펙터 토글",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_inject_script: {
    concept: "스크립트 주입",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },
  webview_eval: {
    concept: "스크립트 평가",
    delegated:
      "렌더러가 답한다 — 콘텐츠가 <webview> 로 DOM 안에 살아 프로세스를 건널 이유가 " +
      "사라졌다. src/lib/contentViews.ts 의 domHost 를 거쳐라(app.webview.* 가 이미 그 길이다).",
  },


  // 홀 목록 조회 — 홀 자체가 없으니 조회할 것도 없다. 빈 배열을 답하면 "홀이 0개"가 되어
  // 있는 개념처럼 읽힌다(원본은 macOS 에서 실제 목록을 답한다).
  webview_holes: {
    concept: "홀 목록 조회",
    absent:
      "홀이 뜻을 갖는 전제(메인 웹뷰 아래 네이티브 형제)가 없다 — 조회할 목록 자체가 없다. 빈 배열은 '0개'라는 답이라 부재와 다르다.",
  },

  // 리사이즈 제스처를 사이드카에 알린다. 알릴 사이드카가 없다.
  webview_resize_gesture: {
    concept: "리사이즈 제스처 통지",
    absent:
      "원본은 이 신호를 사이드카 표면에 중계한다(sidecar::notify_all). 이 프레임워크는 콘텐츠가 DOM 안이라 중계할 사이드카 표면이 없다 — 드래그 중 재배치는 CSS 가 그대로 따라간다.",
  },

  // 창 전역 좌표 사건 중계 — 원본은 네이티브 자식이 가로챈 마우스를 DOM 으로 되돌린다.
  webview_emit_native: {
    concept: "네이티브 좌표 사건 중계",
    absent:
      "원본은 네이티브 자식이 가로챈 마우스 사건을 창 전체로 되돌린다(native-mouseleave 등). 가로채는 네이티브 자식이 없어 되돌릴 사건도 없다 — DOM 이 처음부터 받는다.",
  },

  // 건강 원장 조회 — 관측 대상은 회로차단기 상태이고, 그것은 앱 프로세스의 것이다.
  webview_health_query: {
    concept: "콘텐츠 뷰 건강 원장",
    absent:
      "원본이 읽는 것은 앱 프로세스 안의 회로차단기 맵(WebviewHealth)이다. 이 프레임워크는 그 맵을 만들지 않는다 — 만들지 않은 것을 빈 목록으로 답하면 '건강함'으로 읽힌다.",
  },

  // 복구 — 차단기를 되돌리고 그 웹뷰를 리로드한다. 차단기가 없다.
  webview_recover: {
    concept: "콘텐츠 뷰 복구",
    absent:
      "원본은 회로차단기를 reset 하고 그 웹뷰를 리로드한다. 되돌릴 차단기가 없고, 리로드는 렌더러가 태그로 직접 한다(contentViews 의 navigate).",
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
