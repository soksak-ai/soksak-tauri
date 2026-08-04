// 캡처 갈래 — 창의 픽셀을 값으로 낸다.
//
// 이름은 앱과 **같다**(`plugin:webview-capture|*`). UI 는 자기가 어느 프레임워크 위에 있는지
// 모르고, 같은 호출이 같은 것을 돌려줘야 한다 — 이름을 바꾸면 프론트에 프레임워크 분기가 생긴다.
//
// 이 갈래는 갈래 접두사(window_·webview_ …)를 달 수 없다. 앱의 이름이 그렇게 생겼고, 이름은
// 앱의 것이다. 그래서 발견은 **등재**로 한다(claims 의 `cmd in TABLE`).
//
// 캡처는 포커스를 뺏지 않는다. 가려진 창도 담아야 하고(다른 앱 뒤에 있어도), 그러려면 배경
// 스로틀이 꺼져 있어야 한다 — 그 설정은 창을 만드는 자리가 준다(electron/main.cjs).
// 여기서 창을 앞으로 내면 사용자가 보던 화면이 캡처 때문에 바뀐다.

const fs = require("node:fs"), path = require("node:path");

const { frameworkError } = require("./error.cjs");

const SNAPSHOT = "plugin:webview-capture|snapshot";
const SNAPSHOT_REGION = "plugin:webview-capture|snapshot_region";
const RECORD = "plugin:webview-capture|record";
const SET_OCCLUSION = "plugin:webview-capture|set_occlusion";

const NO_WINDOW = "FRAMEWORK_NO_WINDOW";
const BAD_RECT = "FRAMEWORK_BAD_RECT";
const EMPTY_CAPTURE = "FRAMEWORK_EMPTY_CAPTURE";
// Electron 의 capturer 수명을 캡처 Promise 와 묶는다. 캡처 중 page를 visible로 취급하는 기본
// 동작은 창 포커스/전면화가 아니다. 이 동작을 `stayHidden:true`로 막으면 부모와 별도 compositor
// surface인 <webview> guest가 PNG에서 검게 빠지고 Viz 전이가 실패할 수 있다. 시스템 sleep만
// 막고, 보이는 창의 전체 합성 결과는 Electron의 정규 캡처 수명에 맡긴다.
const BACKGROUND_CAPTURE = Object.freeze({ stayAwake: true });

/** 부른 창의 웹콘텐츠. 없으면 이름을 달고 실패한다 — 빈 PNG 를 돌려주면 "검게 나왔다"가 된다. */
function contents(ctx) {
  const wc = ctx.window && ctx.window.webContents;
  if (!wc || typeof wc.capturePage !== "function") {
    throw frameworkError(NO_WINDOW, "캡처할 창이 없다 — 부른 창을 찾지 못했다");
  }
  return wc;
}

/** 담긴 것이 실제로 픽셀인가. 빈 이미지는 성공이 아니다 — 그 성공은 "화면이 검다"로만 보인다. */
function pngOf(image) {
  if (!image || typeof image.toPNG !== "function" || image.isEmpty?.()) {
    throw frameworkError(EMPTY_CAPTURE, "캡처가 빈 이미지를 냈다 — 창이 아직 그리지 않았다");
  }
  const png = image.toPNG();
  if (!png || png.length === 0) {
    throw frameworkError(EMPTY_CAPTURE, "캡처가 빈 PNG 를 냈다");
  }
  return png;
}

/** rect 는 CSS px 창 좌표다(ui.measure 와 같은 공간) — Electron 의 캡처 사각형과 같은 단위. */
function cropOf(args) {
  const { x, y, w, h } = args || {};
  if ([x, y, w, h].every((v) => v === undefined)) return null;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw frameworkError(BAD_RECT, "rect 는 {x,y,w,h} 숫자 필수");
  }
  if (w <= 0 || h <= 0) {
    throw frameworkError(BAD_RECT, `rect 의 폭·높이는 양수라야 한다: w=${w} h=${h}`);
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

module.exports = {
  [SNAPSHOT]: {
    concept: "창 전체를 PNG 파일로",
    source: "webContents.capturePage",
    answer: async (ctx, args) => {
      const out = String(args?.path || "");
      if (!out) throw frameworkError("INVALID_PARAMS", "path 필수");
      const png = pngOf(await contents(ctx).capturePage(undefined, BACKGROUND_CAPTURE));
      // 부모 폴더는 만들어 준다 — 앱의 같은 명령과 같은 약속이다.
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      return out;
    },
  },

  [SNAPSHOT_REGION]: {
    concept: "창의 한 영역을 base64 PNG 로",
    source: "webContents.capturePage(rect)",
    answer: async (ctx, args) => {
      const rect = cropOf(args);
      const png = pngOf(await contents(ctx).capturePage(rect ?? undefined, BACKGROUND_CAPTURE));
      return png.toString("base64");
    },
  },

  [RECORD]: {
    concept: "창 합성 픽셀의 유한 연사 PNG",
    source: "webContents.capturePage",
    answer: async (ctx, args) => {
      const dir = String(args?.dir || "");
      const frames = Number(args?.frames);
      const intervalMs = Number(args?.intervalMs ?? 0);
      if (!dir || !Number.isInteger(frames) || frames < 1 || frames > 600) {
        throw frameworkError("INVALID_PARAMS", "dir 및 frames(1..600) 필수");
      }
      if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        throw frameworkError("INVALID_PARAMS", "intervalMs는 0 이상의 수");
      }
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < frames; i += 1) {
        const started = Date.now();
        const png = pngOf(await contents(ctx).capturePage(undefined, BACKGROUND_CAPTURE));
        fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, "0")}.png`), png);
        if (i === 0) ctx.stream?.(args?.onReady, 1);
        const rest = intervalMs - (Date.now() - started);
        if (rest > 0 && i + 1 < frames) {
          await new Promise((resolve) => setTimeout(resolve, rest));
        }
      }
      return frames;
    },
  },

  [SET_OCCLUSION]: {
    concept: "가려진 창의 렌더 정지 여부",
    source: "webContents.setBackgroundThrottling",
    // 앱에서는 macOS 의 가림 감지를 껐다 켠다. 여기서는 같은 뜻의 손잡이가 배경 스로틀이다 —
    // 켜면 가려진 창이 그리기를 멈추고, 그 정지가 캡처를 옛 프레임에 가둔다.
    answer: (ctx, args) => {
      const wc = contents(ctx);
      const enabled = args?.enabled !== false;
      if (typeof wc.setBackgroundThrottling === "function") wc.setBackgroundThrottling(enabled);
      return null;
    },
  },
};
