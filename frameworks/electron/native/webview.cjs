// webview_* — 자식 웹뷰와 메인 웹뷰 표면. 창 안에서만 답이 나오므로 프레임워크의 것이다.

const fs = require("node:fs");
const { PNG } = require("pngjs");
const { frameworkError } = require("./error.cjs");

// 브라우저 자식 웹뷰 라벨 접두사 — 정본은 crates/soksak-core/src/window_spec.rs 다
// (event-name-scan 게이트가 대조한다). 갈리면 남의 창 웹뷰를 자기 것으로 센다.
const BROWSER_PREFIX = "b-";

/// 새 창으로 열어도 되는 주소인가 — 코어와 같은 규칙(soksak-core surface_spec).
///
/// http·https 만이다. file·data·javascript 는 창 하나가 로컬 파일을 읽거나 스크립트를 실행하는
/// 통로가 되고, 그 창은 이 앱의 창이라 사용자 눈에는 앱이 한 일이다. 스킴은 소문자로 비교한다 —
/// 한쪽만 대문자를 통과시키면 그 차이가 곧 우회로다.
function isOpenableUrl(raw) {
  const s = String(raw ?? "").trim();
  const at = s.indexOf(":");
  if (at < 0) return false;
  const rest = s.slice(at + 1);
  if (!rest.startsWith("//") || rest.length <= 2) return false;
  const scheme = s.slice(0, at).toLowerCase();
  return scheme === "http" || scheme === "https";
}

function tilePositions(total, viewport) {
  if (!(total > 0 && viewport > 0)) throw frameworkError("INVALID_CAPTURE_SIZE", "전체 캡처 기하가 0 이하입니다");
  const last = Math.max(0, total - viewport);
  const positions = [];
  for (let at = 0; at < last; at += viewport) positions.push(at);
  positions.push(last);
  return [...new Set(positions)];
}

async function scrollGuestTo(guest, x, y) {
  const expression = `new Promise(resolve => {
    const x=${JSON.stringify(x)}, y=${JSON.stringify(y)};
    const done=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({x:scrollX,y:scrollY})));
    if (Math.abs(scrollX-x)<0.5 && Math.abs(scrollY-y)<0.5) done();
    else { addEventListener("scroll", done, {once:true}); scrollTo(x,y); }
  })`;
  const reply = await guest.debugger.sendCommand("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  });
  return reply?.result?.value;
}

async function suppressGuestScrollbars(guest) {
  const reply = await guest.debugger.sendCommand("Runtime.evaluate", {
    expression: `(() => {
      const entries = [document.documentElement, document.body].filter(Boolean).map((element) => ({
        element,
        value: element.style.getPropertyValue("overflow"),
        priority: element.style.getPropertyPriority("overflow"),
      }));
      for (const entry of entries) entry.element.style.setProperty("overflow", "hidden", "important");
      return { entries };
    })()`,
    returnByValue: false,
  });
  const objectId = reply?.result?.objectId;
  if (!objectId) throw frameworkError("CAPTURE_SCROLLBAR_STATE", "전체 캡처 scrollbar 상태를 붙잡지 못했습니다");
  await guest.debugger.sendCommand("Runtime.evaluate", {
    expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
  });
  return objectId;
}

async function restoreGuestScrollbars(guest, objectId) {
  await guest.debugger.sendCommand("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      for (const entry of this.entries) {
        if (entry.value) entry.element.style.setProperty("overflow", entry.value, entry.priority);
        else entry.element.style.removeProperty("overflow");
      }
    }`,
  });
  await guest.debugger.sendCommand("Runtime.releaseObject", { objectId });
}

async function captureFullGuest(guest, outputPath, width, height) {
  const geometryReply = await guest.debugger.sendCommand("Runtime.evaluate", {
    expression: "({x:scrollX,y:scrollY,vw:innerWidth,vh:innerHeight})",
    returnByValue: true,
  });
  const geometry = geometryReply?.result?.value;
  const viewportWidth = Math.max(1, Math.round(Number(geometry?.vw)));
  const viewportHeight = Math.max(1, Math.round(Number(geometry?.vh)));
  const documentWidth = Math.max(1, Math.ceil(Number(width)));
  const documentHeight = Math.max(1, Math.ceil(Number(height)));
  const original = { x: Number(geometry?.x) || 0, y: Number(geometry?.y) || 0 };
  const xs = tilePositions(documentWidth, viewportWidth);
  const ys = tilePositions(documentHeight, viewportHeight);
  let output;
  let scale;
  const scrollbarState = await suppressGuestScrollbars(guest);
  try {
    for (const y of ys) {
      for (const x of xs) {
        const landed = await scrollGuestTo(guest, x, y);
        if (Math.abs(Number(landed?.x) - x) > 1 || Math.abs(Number(landed?.y) - y) > 1) {
          throw frameworkError("CAPTURE_SCROLL_MISMATCH", `전체 캡처 scroll 착지 실패: ${JSON.stringify({ x, y, landed })}`);
        }
        const tile = PNG.sync.read((await guest.capturePage(undefined, { stayAwake: true })).toPNG());
        const tileScale = tile.width / viewportWidth;
        if (!(tileScale > 0) || Math.abs(tile.height / viewportHeight - tileScale) > 0.03) {
          throw frameworkError("CAPTURE_SCALE_MISMATCH", `전체 캡처 tile 배율 불일치: ${tile.width}x${tile.height}`);
        }
        if (scale === undefined) {
          scale = tileScale;
          const outputWidth = Math.ceil(documentWidth * scale);
          const outputHeight = Math.ceil(documentHeight * scale);
          if (outputWidth * outputHeight > 100_000_000) {
            throw frameworkError("CAPTURE_TOO_LARGE", `전체 캡처가 1억 픽셀을 넘습니다: ${outputWidth}x${outputHeight}`);
          }
          output = new PNG({ width: outputWidth, height: outputHeight });
        } else if (Math.abs(tileScale - scale) > 0.03) {
          throw frameworkError("CAPTURE_SCALE_CHANGED", "전체 캡처 도중 device scale이 바뀌었습니다");
        }
        const destX = Math.round(x * scale);
        const destY = Math.round(y * scale);
        const copyWidth = Math.min(tile.width, output.width - destX);
        const copyHeight = Math.min(tile.height, output.height - destY);
        for (let row = 0; row < copyHeight; row += 1) {
          const from = row * tile.width * 4;
          const to = ((destY + row) * output.width + destX) * 4;
          tile.data.copy(output.data, to, from, from + copyWidth * 4);
        }
      }
    }
    const bytes = PNG.sync.write(output);
    fs.writeFileSync(outputPath, bytes);
    return bytes.length;
  } finally {
    // 캡처 성공보다 원래 사용자 상태 복원이 더 강한 사후조건이다. 복원 실패를 삼키면
    // 명령은 성공을 답하면서 실제 탭은 다른 scroll 위치에 남는다.
    const restored = await Promise.allSettled([
      scrollGuestTo(guest, original.x, original.y),
      restoreGuestScrollbars(guest, scrollbarState),
    ]);
    const failures = restored.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw frameworkError(
        "CAPTURE_RESTORE_FAILED",
        `전체 캡처 뒤 사용자 상태 복원 실패: ${failures.map((failure) => String(failure.reason)).join("; ")}`,
      );
    }
  }
}

module.exports = {
  // 검사가 픽스처로 코어와 대조한다.
  isOpenableUrl,
  // 새 창은 DOM 이 만들 수 없다 — 이것만은 프레임워크가 답한다. 원본은 URL 을 파싱해
  // 팝업 창을 연다(파싱 실패는 오류다: 지어낸 URL 로 창을 열면 그 창이 무엇인지 아무도 모른다).
  webview_open_window: {
    concept: "외부 URL 새 창",
    source: "BrowserWindow — 창은 DOM 이 만들 수 없다",
    answer: (ctx, args) => {
      const raw = String(args.url ?? "");
      if (!isOpenableUrl(raw)) {
        throw frameworkError("INVALID_URL", `http(s) 가 아님: ${raw}`);
      }
      ctx.createWindow(`w-popup-${Date.now()}`, null).loadURL(new URL(raw.trim()).href);
      return null;
    },
  },

  // 브라우저 자식 웹뷰 목록(b-*). 프론트 GC 가 "살아있는 웹뷰 ⊆ 스토어의 뷰"를 대조한다.
  // 프레임워크는 자기가 라벨을 준 표면만 안다 — 그 레지스트리를 접두사로 거른 결과가 답이다. 이 프레임워크는
  // 아직 자식 뷰를 만들지 않아 오늘 답은 빈 목록이고, 그 빈 목록은 가정이 아니라 실측이다.
  webview_list: {
    concept: "브라우저 자식 웹뷰 목록",
    source: "프레임워크 표면 레지스트리(프레임워크가 라벨을 부여한 창·뷰)",
    answer: (ctx) => ctx.surfaces().filter((l) => l.startsWith(BROWSER_PREFIX)),
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
  // 네이티브 마우스 다리 구동 — 앱은 native-mousedown/move/up 을 **자기 창 사건**으로 듣고
  // 그것으로 골 드래그 같은 제스처를 돌린다(App.tsx). 원본은 그 사건을 그대로 발행한다:
  // OS 입력 합성이 아니라 "네이티브 모니터가 낸 것과 같은 사건"이다.
  //
  // 사건을 창에 밀어 넣는 일은 프레임워크만 할 수 있다 — 그래서 여기 있다. 이 자리가 비면
  // 실마우스 없이 그 제스처를 구동할 길이 사라지고, 검증은 "재는 방법이 없다"로 멈춘다.
  // 그 멈춤은 프레임워크 차이가 아니라 **이식하지 않은 표면**이다.
  webview_emit_native: {
    concept: "네이티브 마우스 사건 발행",
    source: "창 사건 채널(프레임워크가 미는 자리)",
    answer: (ctx, args) => {
      if (!ctx.window) throw frameworkError("NO_WINDOW", "부른 창을 짚지 못했다");
      const kind = String(args.kind ?? "");
      if (!/^native-mouse(down|move|up)$/.test(kind)) {
        throw frameworkError("INVALID_KIND", `알 수 없는 종류: ${kind}`);
      }
      ctx.emitToWindow(ctx.window, kind, { x: Number(args.x ?? 0), y: Number(args.y ?? 0) });
      return null;
    },
  },

  // 콘텐츠 뷰 **안**으로 진짜 입력을 넣는다.
  //
  // 태그의 `sendInputEvent` 는 전달하지 않는다(계측 2026-08-02: 게스트에 arm 한 리스너가
  // 아무것도 못 받았다). 게스트의 webContents 에 직접 보내야 한다 — 그 핸들은 이 프로세스만
  // 쥔다. 스크립트로 만든 클릭에는 사용자 활성화가 없어 엔진이 창-열기 같은 것을 막으므로,
  // 그 경로를 검증하려면 엔진이 내는 진짜 입력이어야 한다(A27).
  webview_send_input: {
    concept: "콘텐츠 뷰에 입력 주입",
    source: "게스트 webContents — 태그는 전달하지 않는다",
    answer: (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) throw frameworkError("NO_CONTENT_VIEW", `그 콘텐츠 뷰가 없다: ${args.id}`);
      // 인자는 그대로 간다 — 기본값을 채우거나 반올림하면 그것이 규칙이 되고, 두 껍데기가
      // 같은 이름에 다른 좌표를 쓴다. 무엇이 유효한 좌표인가는 부르는 쪽이 정한다.
      //
      // **한 호출은 한 사건이다.** 여기서 누름과 뗌을 붙여 내보내면 부르는 쪽이 더블클릭도
      // 끌기도 만들 수 없다 — 계약이 무엇이 일어났는지를 나르는 이유가 그것이다.
      const kind = String(args.kind ?? "down");
      const type = {
        down: "mouseDown", up: "mouseUp", move: "mouseMove", drag: "mouseMove",
        enter: "mouseEnter", exit: "mouseLeave",
      }[kind];
      if (!type) throw frameworkError("INVALID_PARAMS", `모르는 마우스 사건: ${kind} (down|up|move|drag|enter|exit)`);
      const button = args.button === "right" ? "right" : "left";
      // 끌기의 `buttons` 는 수정자로 선다 — 안 세우면 끌기를 보는 코드에게는 그냥 이동이다.
      const held = kind === "drag" ? [button === "right" ? "rightButtonDown" : "leftButtonDown"] : [];
      guest.sendInputEvent({
        type, x: args.x, y: args.y, button,
        clickCount: Number(args.clickCount ?? 1),
        ...(held.length > 0 ? { modifiers: held } : {}),
      });
      return null;
    },
  },

  // **조합 중**인 글자를 세운다 — 확정 입력과 다른 사실이다. 빈 문자열은 조합을 푼다.
  webview_mark_text: {
    concept: "콘텐츠 뷰 조합 입력",
    source: "게스트 CDP Input.imeSetComposition / insertText",
    answer: async (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) throw frameworkError("NO_CONTENT_VIEW", `그 콘텐츠 뷰가 없다: ${args.id}`);
      const text = String(args.text ?? "");
      const attached = guest.debugger.isAttached();
      if (!attached) guest.debugger.attach("1.3");
      try {
        if (text.length === 0) {
          // 푸는 것은 조합을 지우고 끝내는 것이다 — 빈 조합을 세워 두면 열린 채로 남는다.
          await guest.debugger.sendCommand("Input.imeSetComposition", {
            text: "", selectionStart: -1, selectionEnd: -1,
          });
        } else {
          await guest.debugger.sendCommand("Input.imeSetComposition", {
            text, selectionStart: text.length, selectionEnd: text.length,
          });
        }
      } finally {
        if (!attached && guest.debugger.isAttached()) guest.debugger.detach();
      }
      return null;
    },
  },

  // 키 하나 — 글자가 아니라 키다. 확정 문자열로는 Enter·Escape·화살표를 만들 수 없다.
  webview_send_key: {
    concept: "콘텐츠 뷰 키 입력",
    source: "게스트 webContents sendInputEvent(keyDown/char/keyUp)",
    answer: (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) throw frameworkError("NO_CONTENT_VIEW", `그 콘텐츠 뷰가 없다: ${args.id}`);
      const key = String(args.key ?? "");
      if (key.length === 0) throw frameworkError("INVALID_PARAMS", "key 가 필요하다");
      const modifiers = [];
      if (args.ctrl) modifiers.push("control");
      if (args.shift) modifiers.push("shift");
      if (args.alt) modifiers.push("alt");
      if (args.meta) modifiers.push("meta");
      const base = { keyCode: key, modifiers };
      guest.sendInputEvent({ type: "keyDown", ...base });
      // 글자 하나는 char 사건까지 있어야 편집면에 들어간다 — 이름 있는 키에는 그 자리가 없다.
      if (key.length === 1) guest.sendInputEvent({ type: "char", ...base });
      guest.sendInputEvent({ type: "keyUp", ...base });
      return null;
    },
  },

  // 이 표면이 지금 포인터를 받을 수 있는 상태인가 — 게스트 프로세스만 아는 사실.
  webview_input_state: {
    concept: "콘텐츠 뷰 입력 배달 조건",
    source: "게스트 webContents",
    answer: (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) return { guestAlive: false };
      return {
        guestAlive: true,
        crashed: guest.isCrashed(),
        loading: guest.isLoading(),
        focused: guest.isFocused(),
        // 화면에 안 그려지는 표면은 입력을 받아도 사람이 볼 결과가 없다.
        painting: guest.isPainting?.() ?? true,
      };
    },
  },

  webview_send_wheel: {
    concept: "콘텐츠 뷰에 휠 입력 주입",
    source: "게스트 CDP Input.dispatchMouseEvent(mouseWheel)",
    answer: async (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) throw frameworkError("NO_CONTENT_VIEW", `그 콘텐츠 뷰가 없다: ${args.id}`);
      const attached = guest.debugger.isAttached();
      if (!attached) guest.debugger.attach("1.3");
      try {
        await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Number(args.x),
          y: Number(args.y),
          deltaX: Number(args.dx),
          deltaY: Number(args.dy),
        });
      } finally {
        if (!attached && guest.debugger.isAttached()) guest.debugger.detach();
      }
      return null;
    },
  },

  webview_capture_full: {
    concept: "콘텐츠 뷰 전체 문서 캡처",
    source: "guest scroll event/rAF + capturePage 유한 viewport 거래",
    answer: async (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) throw frameworkError("NO_CONTENT_VIEW", `그 콘텐츠 뷰가 없다: ${args.id}`);
      const attached = guest.debugger.isAttached();
      if (!attached) guest.debugger.attach("1.3");
      try {
        const bytes = await captureFullGuest(
          guest, String(args.path), Number(args.width), Number(args.height),
        );
        return { path: String(args.path), bytes };
      } finally {
        if (!attached && guest.debugger.isAttached()) guest.debugger.detach();
      }
    },
  },

  webview_type_text: {
    concept: "콘텐츠 뷰 확정 텍스트 입력",
    source: "게스트 webContents.insertText — 포커스된 편집 요소의 엔진 입력 경로",
    answer: async (ctx, args) => {
      const guest = ctx.webContentsById(Number(args.id));
      if (!guest) throw frameworkError("NO_CONTENT_VIEW", `그 콘텐츠 뷰가 없다: ${args.id}`);
      await guest.insertText(String(args.text ?? ""));
      return null;
    },
  },

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

  // native child 바로 위에 두는 AppKit 조명 평면. Electron의 content view는 DOM 자식이라
  // 공통 SVG 조명 평면 안에서 이미 합성되고, 별도 native projection은 개념 자체가 없다.
  webview_dim: {
    concept: "네이티브 콘텐츠 표면 포커스 조명",
    absent:
      "Electron 콘텐츠 뷰는 DOM 자식이라 공통 SVG 조명 평면이 직접 그린다 — 투영할 네이티브 형제 표면이나 AppKit veil이 없다.",
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

  // 네이티브 뷰 트리 덤프 — 이 프레임워크에는 그 트리가 없다. 콘텐츠가 페이지 안에 살아
  // 계층이 곧 DOM 이고, 그 사실은 이미 다른 자리가 답한다(webview.surfaces 의 bodies —
  // 노드 경로와 rect). 여기서 DOM 을 네이티브 트리 모양으로 찍어 주면 부른 쪽은 네이티브
  // 자식이 있다고 읽고, 그 오독 위에 홀·스위즐을 전제한 진단을 세운다.
  webview_debug_hierarchy: {
    concept: "네이티브 뷰 계층 덤프",
    absent:
      "이 프레임워크에는 네이티브 뷰 트리가 없다 — 콘텐츠가 페이지 안에 살아 계층이 곧 DOM 이다. 그 계층은 webview.surfaces 의 bodies 가 노드 경로와 rect 로 답한다.",
  },

  webview_divider_highlight: {
    concept: "네이티브 디바이더 강조 바",
    absent:
      "페이지 위에 그릴 네이티브 층이 없다 — 강조는 DOM 이 그리면 되고 그것으로 충분하다(그 판단은 UI 의 것이다).",
  },
};
