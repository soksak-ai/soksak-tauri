// window_* — 창 자체를 다루는 것들. 이 갈래는 cored 로 갈 수 없다: 그 프로세스엔 창이 없다.
//
// 콘텐츠 뷰와 다른 점이 여기 있다. 콘텐츠는 <webview> 로 DOM 안에 살 수 있어 프레임워크를
// 건널 필요가 없지만(src/lib/contentViews.ts), **창은 DOM 이 만들 수 없다.**
//
// 이름·인자·반환 모양은 앱의 것과 같다. 번역하면 프론트가 프레임워크마다 다른 것을 보고,
// 그 차이는 오류가 아니라 "이 프레임워크에서는 창 배치가 안 됨"으로 나타난다.

const { randomUUID } = require("node:crypto");
const { frameworkError } = require("./error.cjs");

/** 라벨로 창을 짚는다. 못 짚으면 이름을 달고 실패한다 — 아무 창이나 건드리면 남의 창을
 *  바꿔 놓고 성공을 돌려주게 된다. */
function need(ctx, args) {
  const label = String(args.label ?? "");
  const win = ctx.windowFor(label);
  if (!win || win.isDestroyed()) {
    throw frameworkError("NO_WINDOW", `창 없음: ${label}`);
  }
  return win;
}

/// 이 창은 어느 모니터의 것인가 — **중심점 기준 단일 판정**(soksak-core geometry 와 같은 규칙).
///
/// 오른쪽·아래 경계는 밖이다: 맞닿은 자리에서 한 점이 양쪽에 속하면 소속이 목록 순서에 따라
/// 흔들린다. 어느 화면에도 없으면 null 이다 — 0 으로 떨어뜨리면 "첫 모니터"와 구분되지 않는다.
/// 주어진 rect 가 쓸 수 있는 자리인가 — 코어와 같은 규칙(soksak-core window_spec).
///
/// 넷이 다 있고 다 수라야 한다. 하나라도 빠지면 자리 없음이다: 반쪽을 채워 만들면 창이 엉뚱한
/// 곳에 뜨고, 그 어긋남은 "복원했더니 자리가 틀렸다"로 나타난다. 크기 0 이하도 자리가 아니다 —
/// 만들어지긴 하는데 보이지 않아 "창이 안 뜬다"로만 보인다.
function rectOf(r) {
  if (!r) return null;
  const { x, y, w, h } = r;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/// 새 창을 앞으로 낼 것인가. 기본은 참 — 리스폰만 거짓으로 부른다(백그라운드 복원).
/// 기본을 거짓으로 두면 "새 창을 열었는데 아무 일도 안 일어난 것처럼" 보인다.
function shouldFocus(requested) {
  return requested !== false;
}

/// 이 라벨이 워크스페이스 창의 것인가 — 컨트롤 플레인("main")과 가르는 표식.
function isWorkspace(label) {
  return String(label ?? "").startsWith("w-");
}

function monitorOf(win, monitors) {
  const cx = win.x + Math.trunc(win.w / 2);
  const cy = win.y + Math.trunc(win.h / 2);
  const at = monitors.findIndex(
    (m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h,
  );
  return at < 0 ? null : at;
}

module.exports = {
  // 검사가 픽스처로 코어와 대조한다 — 사본이 갈리지 않는다는 것을 파일이 묶는다.
  monitorOf,
  rectOf,
  shouldFocus,
  isWorkspace,
  // 창 배경 — Tauri window.set_background_color 의 대응. 루트 DOM 이 투명이라 미도장 영역의
  // 색을 창이 책임진다. 기준(#rrggbb 6자리)은 코어와 같게 둔다: 같은 색 문자열에 두
  // 프레임워크가 다르게 답하면 테마가 프레임워크마다 달라진다.
  window_set_background: {
    concept: "창 배경색",
    source: "BrowserWindow.setBackgroundColor",
    answer: (ctx, args) => {
      const raw = String(args.color ?? "").trim();
      const hex = raw.replace(/^#/, "");
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
        throw frameworkError("INVALID_COLOR", `hex 색상(#rrggbb)이 아님: ${raw}`);
      }
      // 부른 창을 못 짚으면 아무 창도 칠하지 않는다(코어는 호출 창을 자동 주입한다).
      if (!ctx.window) throw frameworkError("NO_WINDOW", "부른 창을 짚지 못했다");
      ctx.window.setBackgroundColor(`#${hex.toLowerCase()}`);
      return null;
    },
  },

  window_list: {
    concept: "살아 있는 창 라벨",
    source: "프레임워크가 라벨을 부여하고 닫힘에서 지운다",
    answer: (ctx) => ctx.labels(),
  },

  // 라벨을 주면 그 라벨로, 없으면 프레임워크가 짓는다. 같은 라벨엔 **멱등** — 리스폰 재호출이 창을
  // 늘리면 재시작 복원이 창을 뿌린다.
  window_create: {
    concept: "창 생성",
    source: "BrowserWindow + 프레임워크의 라벨 레지스트리",
    answer: (ctx, args) => {
      // 프론트는 라벨 없이 부른다 — 사용자가 "새 창"을 열 때 그 창의 이름을 알 리 없다.
      // 그때는 프레임워크가 짓는다. 규칙은 코어와 같은 w-<uuid4> 다: 불투명하고 재사용되지
      // 않아야 닫힌 창의 라벨이 새 창에 붙는 유령 복원이 없고, 두 프레임워크의 복원 manifest
      // 가 같은 모양을 갖는다. 의도적 재사용은 respawn 뿐이고 그때는 라벨이 주어진다.
      const label = String(args.label ?? "").trim() || `w-${randomUUID()}`;
      const live = ctx.windowFor(label);
      if (live && !live.isDestroyed()) return label;
      const win = ctx.createWindow(label, rectOf(args.rect));
      if (shouldFocus(args.focus)) win.focus();
      return label;
    },
  },

  window_close: {
    concept: "창 닫기",
    source: "BrowserWindow.close",
    answer: (ctx, args) => {
      need(ctx, args).close();
      return null;
    },
  },

  window_focus: {
    concept: "창 포커스",
    source: "BrowserWindow.focus",
    answer: (ctx, args) => {
      need(ctx, args).focus();
      return null;
    },
  },

  // 물리 rect 를 그대로 놓는다. 전략(어디에 둘지)은 프론트의 순수함수가 정하고, 여기는 시행만
  // 한다 — 팩트/전략 분리.
  window_place: {
    concept: "창 배치",
    source: "BrowserWindow.setBounds",
    answer: (ctx, args) => {
      const win = need(ctx, args);
      for (const k of ["x", "y", "w", "h"]) {
        if (typeof args[k] !== "number") {
          throw frameworkError("INVALID_RECT", `${k} 가 수가 아님: ${JSON.stringify(args[k])}`);
        }
      }
      win.setBounds({ x: args.x, y: args.y, width: args.w, height: args.h });
      return null;
    },
  },

  // 모니터·창 배치 팩트 — 판단 없이 사실만. 소속 모니터는 창 중심이 어느 모니터 rect 안에
  // 있는가로 정한다(기하이지 판단이 아니다). 어디에도 안 들면 null 이다.
  window_monitors: {
    concept: "모니터·창 배치 팩트",
    source: "screen.getAllDisplays + 각 창의 bounds",
    // 소속 판정(중심점 기준·경계 규칙·버림 방향)은 코어가 소유한다. 여기 있는 사본은 매 창마다
    // 프로세스를 건너지 않기 위한 것이고, 갈리지 않는다는 것은 **같은 픽스처**가 묶는다
    // (soksak-core/fixtures/monitor-of.json — 양쪽 검사가 그 파일 하나를 읽는다).
    // 물어보는 방식도 재 봤다: 창마다 왕복이 붙고, 백엔드가 없으면 프레임워크 사실이 죽는다.
    answer: (ctx) => {
      const displays = ctx.screen.getAllDisplays();
      const monitors = displays.map((d, index) => ({
        index,
        name: d.label ?? "",
        x: d.bounds.x,
        y: d.bounds.y,
        w: d.bounds.width,
        h: d.bounds.height,
        scale: d.scaleFactor,
      }));
      const windows = [];
      for (const label of ctx.labels()) {
        const win = ctx.windowFor(label);
        const b = win.getBounds();
        const at = monitorOf({ x: b.x, y: b.y, w: b.width, h: b.height }, monitors);
        windows.push({
          label,
          title: win.getTitle(),
          alwaysOnTop: win.isAlwaysOnTop(),
          x: b.x,
          y: b.y,
          w: b.width,
          h: b.height,
          focused: win.isFocused(),
          monitor: at,
        });
      }
      return { monitors, windows };
    },
  },
};
