// Electron 셸 — 스파이크. Tauri 셸과 **형제**이며 교체가 아니다.
//
// 목적은 셸 층의 질문에만 답하는 것이다: 같은 UI 가 이 셸 위에서 뜨는가, 창 조작·전역
// 이벤트·스트림이 계약대로 도는가, 그리고 UI 가 백엔드에 **무엇을 어떤 순서로** 요구하는가.
// 마지막 것이 러스트 cored 분리(2단계)의 우선순위 입력이다.
//
// 규칙: 백엔드가 아직 없는 명령은 **조용히 성공한 척하지 않는다**. 이름을 달아 실패하고
// 요구 원장에 남긴다 — 가짜 성공은 "돌아간다"는 착시를 만들고, 그 착시가 이식 판단을 망친다.
//
// 다만 전부가 백엔드의 것은 아니다. 창·웹뷰·네이티브 표면(NATIVE 표)은 셸이 스스로 답한다 —
// cored 프로세스엔 창이 없어 영영 그리로 못 간다. 그 표는 소켓 앞에 선다.

const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createBackendClient, resolveSocketPath } = require("./backend.cjs");
const { shellIdentity, coredBinary, ensureCored } = require("./cored.cjs");
const activity = require("./activity.cjs");

const DEV_URL = process.env.SOKSAK_ELECTRON_URL || "http://localhost:1420";

// 이 셸의 정체성 — 홈은 identifier 에서 나오고, 원장도 cored 소켓도 그 홈 안에 산다.
// 홈은 셸의 것이다: cored는 이 값을 부팅 인자로 **받는다**(파생하지 않는다).
const IDENTITY = shellIdentity();
const SPIKE_HOME = IDENTITY.home;
const DEMAND_LOG = path.join(SPIKE_HOME, "invoke-demand.jsonl");

fs.mkdirSync(SPIKE_HOME, { recursive: true });

/** 창 라벨 ↔ BrowserWindow. 라벨은 앱의 정체성 축이므로 셸이 부여하고 지킨다. */
const windows = new Map();
let seq = 0;

/** UI 가 백엔드에 요구한 명령을 순서대로 남긴다 — 2단계 우선순위의 실측 근거.
 *  서빙된 것(served:true)과 못 한 것을 가르고, 못 한 것은 사유(code)까지 남긴다 — "cored 가
 *  무엇을 더 져야 하는가"는 요구 목록만으로는 안 나오고 실패 사유가 있어야 갈린다.
 *  by="shell" 은 셸이 스스로 답한 줄이다. 순서는 남기되 cored 요구 목록에는 섞이지 않는다 —
 *  창·웹뷰·네이티브 표면은 cored 로 갈 수 없으므로(다른 프로세스엔 창이 없다) 그 목록에 실리면
 *  영영 못 옮길 일을 할 일로 세게 된다. */
function recordDemand(cmd, served, code, by) {
  try {
    const entry = { t: Date.now(), cmd, served };
    if (by) entry.by = by;
    if (!served && code) entry.code = code;
    fs.appendFileSync(DEMAND_LOG, JSON.stringify(entry) + "\n");
  } catch {
    /* 원장 실패가 앱을 막지 않는다 */
  }
}

function createWindow(label) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--soksak-window-label=${label}`],
    },
  });
  windows.set(label, win);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => windows.delete(label));
  void win.loadURL(DEV_URL);
  return win;
}

function windowFor(label) {
  return (label && windows.get(label)) || null;
}

// ── 셸의 것 — 네이티브 명령 ──────────────────────────────────────────────────
// 창·웹뷰·네이티브 표면 명령은 cored 로 갈 수 없다: 다른 프로세스엔 창이 없다. 그래서 이 표가
// 소켓 앞에 선다. 표는 두 줄만 구분한다.
//
//   answer — 이 셸이 아는 사실. Electron API 나 셸 자신의 레지스트리가 답한다.
//   absent — 이 셸에 대응 개념이 없다. 이름(SHELL_CONCEPT_ABSENT)을 달고 거절한다.
//
// 없는 것을 조용히 성공시키지 않는 이유: UI 는 성공을 받으면 그 기능이 있다고 믿고 그 믿음대로
// 그린다(홀 위에 그리는 강조 바, 오버레이 게이트에 기대는 모달). 없다고 답해야 UI 가 그에 맞게
// 그릴 수 있고, 그 사유는 shell_capabilities 로 읽힌다.
//
// "부재"를 답으로 쓰는 기준: 셸이 **증명할 수 있는 부재**만 값으로 답한다(자기가 만든 것의
// 목록이 비었다 = 실측). 관측할 수단조차 없는 것(사이드카가 창에 붙이는 엔진 서피스)은 0 을
// 돌려주지 않는다 — 재지 않은 것을 쟀다고 말하는 것이 곧 가짜 성공이다.
const ABSENT_CODE = "SHELL_CONCEPT_ABSENT";

function shellError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const NATIVE = {
  // 창 배경 — Tauri window.set_background_color 의 대응. 루트 DOM 이 투명이라 미도장 영역의
  // 색을 창이 책임진다. 기준(#rrggbb 6자리)은 코어와 같게 둔다: 같은 색 문자열에 두 셸이
  // 다르게 답하면 테마가 셸마다 달라진다.
  window_set_background: {
    concept: "창 배경색",
    source: "BrowserWindow.setBackgroundColor",
    answer: (ctx, args) => {
      const raw = String(args.color ?? "").trim();
      const hex = raw.replace(/^#/, "");
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
        throw shellError("INVALID_COLOR", `hex 색상(#rrggbb)이 아님: ${raw}`);
      }
      // 부른 창을 못 짚으면 아무 창도 칠하지 않는다 — 아무 창이나 칠하면 남의 창을 바꿔 놓고
      // 성공을 돌려주게 된다(코어는 호출 창을 자동 주입한다).
      if (!ctx.window) throw shellError("NO_WINDOW", "부른 창을 짚지 못했다");
      ctx.window.setBackgroundColor(`#${hex.toLowerCase()}`);
      return null;
    },
  },

  // 브라우저 자식 웹뷰 목록(b-*). 프론트 GC 가 "살아있는 웹뷰 ⊆ 스토어의 뷰"를 대조한다.
  // 셸은 자기가 라벨을 준 표면만 안다 — 그 레지스트리를 접두사로 거른 결과가 답이다. 이 셸은
  // 아직 자식 뷰를 만들지 않아 오늘 답은 빈 목록이고, 그 빈 목록은 가정이 아니라 실측이다.
  webview_list: {
    concept: "브라우저 자식 웹뷰 목록",
    source: "셸 표면 레지스트리(셸이 라벨을 부여한 창·뷰)",
    answer: () => [...windows.keys()].filter((l) => l.startsWith("b-")),
  },

  // 복구 리로드 in-flight 1회 소모 — 프론트 GC 가 부팅 시 읽어 스윕을 보류한다.
  // 이 셸은 크래시 복구 리로드를 시작하지 않는다 → in-flight 집합이 비어 있음을 셸이 증명한다.
  // 관측 수단이 없어서가 아니라 만든 적이 없어서 비었다 — 그래서 false 가 지어낸 답이 아니다.
  webview_recovery_consume: {
    concept: "복구 리로드 in-flight 플래그",
    source: "셸이 웹뷰 수명을 소유한다 — 이 셸은 복구 리로드를 시작하지 않는다",
    answer: () => false,
  },

  // 능력면 — UI 가 그리기 전에 물어볼 수 있는 자리. 표 자체가 답이라 선언과 행동이 갈릴 수 없다.
  shell_capabilities: {
    concept: "셸 네이티브 명령 능력표",
    source: "이 표",
    answer: () => ({
      shell: "electron",
      commands: Object.fromEntries(
        Object.entries(NATIVE).map(([cmd, e]) => [
          cmd,
          e.absent
            ? { supported: false, concept: e.concept, reason: e.absent }
            : { supported: true, concept: e.concept, source: e.source },
        ]),
      ),
    }),
  },

  // ── 대응 개념이 없는 것들 ──────────────────────────────────────────────────

  // 신호등 뒤 백킹(macOS): 비활성 점의 backdrop 합성이 웹뷰 레이어를 못 샘플링해 생기는 유령을
  // 테마색 원형 뷰로 메우는 보정. Electron 의 신호등 API 는 위치·가시성뿐(trafficLightPosition·
  // setWindowButtonPosition·setWindowButtonVisibility) — 뒤에 무엇을 깔 자리가 없다.
  // setBackgroundColor 는 이것의 대응이 아니다: 그쪽은 창 배경(window_set_background)이고 색도
  // 다르다(bg vs side). 한 표면에 둘을 쓰면 나중 호출이 창 전체를 타이틀바 색으로 칠한다.
  titlebar_backing: {
    concept: "신호등 뒤 백킹 색",
    absent:
      "Electron 의 신호등 API 는 위치·가시성뿐이라 버튼 뒤에 뷰를 깔 자리가 없다. setBackgroundColor 는 창 배경(window_set_background)의 대응이며 색이 다르다(bg vs side) — 겸용하면 창 전체가 타이틀바 색이 된다. setTitleBarOverlay 는 win32/linux 전용이고 Window Controls Overlay 창을 요구한다.",
  },

  // 오버레이(모달·메뉴) 동안 홀 통과 차단 + 사이드카 표면 가림 통지. 이 셸엔 게이트가 덮을
  // 홀 자체가 없고(webview_dom_holes 부재), 사이드카 중계도 셸의 것이 아니다.
  webview_overlay_active: {
    concept: "오버레이 히트테스트 게이트",
    absent:
      "이 셸엔 게이트가 덮을 홀이 없다(영역 히트테스트 부재) — 메인 웹뷰 아래 네이티브 자식이 없고, 사이드카 표면 통지도 셸의 것이 아니다.",
  },

  // 영역 단위 히트테스트 통과. Electron 의 마우스 통과는 창 단위(setIgnoreMouseEvents — 창의
  // *모든* 이벤트를 아래 **창**으로)뿐이라 "이 사각형만 DOM 이 받는다"를 표현할 수 없다.
  webview_dom_holes: {
    concept: "영역 단위 히트테스트 홀",
    absent:
      "Electron 의 마우스 통과는 창 단위(setIgnoreMouseEvents)뿐이고 대상도 아래 창이다 — 사각형 단위 통과가 없어 홀 계약을 재현할 수 없다.",
  },

  // 네이티브 자식 위에 그리는 강조 바. Electron 엔 페이지 위에 네이티브를 그리는 자리가 없다.
  webview_divider_highlight: {
    concept: "네이티브 디바이더 강조 바",
    absent:
      "Electron 엔 페이지 위에 네이티브 바를 그리는 API 가 없다 — 강조는 DOM 이 그려야 하고, 그 판단은 UI 의 것이다.",
  },

  // CEF 엔진 호스트 뷰의 숨김/복귀. 이 셸엔 사이드카 표면을 창에 붙이는 배선이 없어 호스트가 없다.
  engine_host_visible: {
    concept: "엔진 호스트 뷰 가시성",
    absent: "이 셸엔 엔진 호스트 뷰가 없다 — 사이드카 표면을 창에 붙이는 배선이 없다.",
  },

  // 엔진 서피스 실측(가시성·frame). 이 셸은 엔진 서피스를 등록받지 않으므로 셀 대상이 없는 게
  // 아니라 **볼 눈이 없다**. registered:0 을 돌려주면 재지 않은 것을 쟀다고 말하게 되고, 표면
  // 감사는 그 0 으로 "보여야 할 것이 안 보인다"는 없는 결함을 발행한다.
  engine_surface_stats: {
    concept: "엔진 서피스 실측",
    absent:
      "이 셸은 엔진 서피스를 등록받지 않는다 — 0 을 돌려주면 재지 않은 것을 쟀다고 말하게 되고, 표면 감사가 없는 결함을 발행한다.",
  },
};

/** 네이티브 명령 한 건. 답도 거절도 원장에 셸의 것으로 남는다. */
function serveNative(cmd, entry, args, sender) {
  if (entry.absent) {
    recordDemand(cmd, false, ABSENT_CODE, "shell");
    return { ok: false, code: ABSENT_CODE, message: `${entry.concept}: ${entry.absent}`, command: cmd };
  }
  try {
    const value = entry.answer({ window: BrowserWindow.fromWebContents(sender) }, args ?? {});
    recordDemand(cmd, true, undefined, "shell");
    return { ok: true, value };
  } catch (e) {
    const code = e.code || "ERROR";
    recordDemand(cmd, false, code, "shell");
    return { ok: false, code, message: String(e.message || e), command: cmd };
  }
}

// ── 백엔드 다리 ──────────────────────────────────────────────────────────────
// 요청은 소켓 너머로 간다(electron/backend.cjs — 한 줄 JSON, id 상관, 유지 연결).
//
// 소켓이 오는 길은 둘이다.
//   ① 외부 지목(SOKSAK_SOCKET / --soksak-socket=) — 그 소켓은 남의 것이다. 그대로 붙고,
//      띄우지도 거두지도 않는다.
//   ② 지목이 없으면 셸이 자기 정체성으로 cored를 띄운다(electron/cored.cjs). 기본 경로를
//      지어내 남의 소켓에 붙는 일은 여전히 없다 — 이 소켓은 이 셸의 홈 안에 있다.
const externalSocket = resolveSocketPath();

/** 살아 있는 다리. 준비되기 전 호출은 backendReady 에서 기다린다(폴링 없음). */
let backend = null;
/** 우리가 띄운 cored. 외부 지목이거나 이미 살아 있던 것이면 null — 남의 것은 거두지 않는다. */
let ownedCored = null;

function connectBackend(socketPath) {
  backend = createBackendClient({ socketPath, onDemand: recordDemand });
  return backend;
}

/** cored를 세우고 그 소켓에 다리를 놓는다. 못 세우면 이름을 달고 실패한다(조용한 no-op 아님). */
async function standUpCored() {
  const binary = coredBinary({ root: path.join(__dirname, "..") });
  const cored = await ensureCored({
    identity: IDENTITY,
    binary,
    onLog: (line) => console.error(`[soksak-cored] ${line}`),
  });
  if (cored.origin === "spawned") ownedCored = cored;
  console.log(
    `[electron-spike] cored ${cored.origin === "spawned" ? `띄움(pid ${cored.pid})` : "이미 살아 있음"}` +
      `: ${binary} → ${cored.socketPath}`,
  );
  return connectBackend(cored.socketPath);
}

const backendReady = externalSocket
  ? Promise.resolve(connectBackend(externalSocket))
  : standUpCored();

// 실패 사유는 기동 때 한 번 드러낸다. 호출은 저마다 이름을 달고 실패하지만, 왜 그렇게 됐는지는
// 첫 호출을 기다리지 않고 알 수 있어야 한다.
backendReady.catch((e) =>
  console.error(`[electron-spike] 백엔드를 세우지 못했다: ${e.code || "ERROR"} — ${e.message}`),
);

async function callBackend(cmd, args) {
  let client;
  try {
    client = await backendReady;
  } catch (e) {
    // 다리를 세우지 못한 실패는 다리를 타지 않으므로 원장도 여기서 남긴다 — 사유가 없으면
    // "무엇 때문에 못 했는가"가 원장에서 사라진다.
    recordDemand(cmd, false, e.code || "ERROR");
    throw e;
  }
  return client.call(cmd, args);
}

// ── 활동 부채질 ──────────────────────────────────────────────────────────────
// cored는 발행 3단 중 **적재만** 하고 도장 찍힌 항목을 답에 실어 준다(그 프로세스엔 창이 없다).
// 창은 셸의 것이므로 그 항목을 창에 뿌리는 것은 여기서 한다 — 안 하면 프론트가 반환값을
// 버리므로(void invoke) listen("activity") 구독자가 오류 한 줄 없이 굶는다.
//
// 대상은 이 셸의 창 레지스트리 전부다(코어의 broadcast 와 같다 — 발신 창을 빼지도 더하지도
// 않는다). 규칙과 배달은 activity.cjs 가 진다: 셸을 띄우지 않고도 검증되어야 한다.
function fanOutActivity(entry) {
  if (!activity.isActivityEntry(entry)) {
    // 적재분이 아니면 부채질할 것이 없다. 아닌 것을 밀면 구독자가 조용히 어긋나고,
    // 성공을 돌려주면 뿌린 적 없는 것을 뿌렸다고 답하게 된다.
    throw shellError(
      activity.NOT_AN_ENTRY,
      `적재분이 아닌 답은 창에 뿌리지 않는다: ${JSON.stringify(entry ?? null).slice(0, 200)}`,
    );
  }
  // 배달 실패는 발행을 멈추지 않는다(적재분이 원장의 진실이고 창은 구독자 하나다) — 다만
  // 삼키지 않는다: 굶는 구독자는 증상이 없어 이 줄이 유일한 자국이다.
  if (!activity.fanOut(entry, windows.values())) {
    console.error(`[electron-spike] 활동 배달이 일부 창에 닿지 못했다 — seq=${entry.seq}`);
  }
}

ipcMain.handle("shell:invoke", async (e, { cmd, args }) => {
  // 셸의 것이 먼저다 — 창·웹뷰·네이티브 표면은 소켓 너머로 물어볼 수 없다(거기엔 창이 없다).
  const native = NATIVE[cmd];
  if (native) return serveNative(cmd, native, args, e && e.sender);
  try {
    const value = await callBackend(cmd, args);
    // 답을 돌려주기 전에 뿌린다 — 코어도 발행 안에서 창에 먼저 닿고 반환은 그다음이라,
    // 순서를 뒤집으면 같은 창에서 구독자와 호출자가 보는 시점이 셸마다 갈린다.
    if (cmd === activity.ACTIVITY_PUBLISH) fanOutActivity(value);
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      code: err.code || "ERROR",
      message: String(err.message || err),
      command: cmd,
    };
  }
});

// ── 호스트 능력 ──────────────────────────────────────────────────────────────
// 계약의 app/path/dialog. 백엔드 없이 Electron·Node 가 그대로 답하는 것들이라 원장에
// 남기지 않는다 — 원장은 "러스트 cored 가 무엇을 져야 하는가"의 목록이다.
ipcMain.handle("shell:host", async (e, { op, args }) => {
  try {
    switch (op) {
      case "appName":
        return { ok: true, value: app.getName() };
      case "appVersion":
        return { ok: true, value: app.getVersion() };
      case "tempDir":
        return { ok: true, value: os.tmpdir() };
      case "join":
        return { ok: true, value: path.join(...(args?.parts ?? []).map(String)) };
      case "openDirectory": {
        const options = { properties: ["openDirectory"] };
        if (typeof args?.title === "string") options.title = args.title;
        if (typeof args?.defaultPath === "string") options.defaultPath = args.defaultPath;
        // 소유 창을 주면 그 창에 붙은 시트로 뜬다. 못 찾으면 앱 모달로 떨어진다.
        const owner = BrowserWindow.fromWebContents(e.sender);
        const r = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
        return { ok: true, value: r.canceled ? null : (r.filePaths[0] ?? null) };
      }
      default:
        return { ok: false, code: "UNKNOWN_OP", message: `호스트 능력 미구현: ${op}` };
    }
  } catch (err) {
    return { ok: false, code: "ERROR", message: String(err.message || err) };
  }
});

ipcMain.handle("shell:window", async (e, { label, op, args, exact }) => {
  // exact 는 렌더러가 라벨로 지목한 경우다. 그 라벨의 창이 없으면 발신 창으로 폴백하지
  // 않는다 — 폴백하면 다른 창을 조작하고도 성공을 돌려주게 된다.
  const win = windowFor(label) || (exact ? null : BrowserWindow.fromWebContents(e.sender));
  // 존재 질의는 창이 없어도 답이 있다(계약의 windowByLabel → null).
  if (op === "exists") return { ok: true, value: !!win };
  if (!win) return { ok: false, code: "NO_WINDOW", message: `창 없음: ${label}` };
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  try {
    switch (op) {
      case "setTitle":
        win.setTitle(String(args.title));
        return { ok: true };
      case "setSize":
        win.setSize(Math.round(args.width), Math.round(args.height));
        return { ok: true };
      case "setPosition":
        win.setPosition(Math.round(args.x), Math.round(args.y));
        return { ok: true };
      case "setPhysicalSize":
        win.setSize(Math.round(args.width / scale), Math.round(args.height / scale));
        return { ok: true };
      case "setPhysicalPosition":
        win.setPosition(Math.round(args.x / scale), Math.round(args.y / scale));
        return { ok: true };
      case "setFocus":
        win.focus();
        return { ok: true };
      case "setAlwaysOnTop":
        win.setAlwaysOnTop(!!args.on);
        return { ok: true };
      case "setTheme":
        // 창 크롬 밝기 — Electron 은 nativeTheme 이 앱 전역이라 창 단위가 아니다.
        // 계약은 "비지원 플랫폼은 무해히 무시"이므로 여기서 조용히 통과하는 것이 맞다.
        return { ok: true };
      case "maximize":
        win.maximize();
        return { ok: true };
      case "unmaximize":
        win.unmaximize();
        return { ok: true };
      case "outerPosition": {
        const b = win.getBounds();
        return { ok: true, value: { x: Math.round(b.x * scale), y: Math.round(b.y * scale) } };
      }
      case "innerPosition": {
        const b = win.getContentBounds();
        return { ok: true, value: { x: Math.round(b.x * scale), y: Math.round(b.y * scale) } };
      }
      case "outerSize": {
        const b = win.getBounds();
        return {
          ok: true,
          value: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) },
        };
      }
      case "scaleFactor":
        return { ok: true, value: scale };
      default:
        return { ok: false, code: "UNKNOWN_OP", message: `창 조작 미구현: ${op}` };
    }
  } catch (e) {
    return { ok: false, code: "ERROR", message: String(e.message || e) };
  }
});

/** 창 기하 변화는 셸이 렌더러로 밀어 준다(계약의 onResized/onMoved). */
function wireWindowEvents(label, win) {
  const send = (name) => () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    win.webContents.send("shell:window-event", { label, name, bounds: b });
  };
  win.on("resize", send("resized"));
  win.on("move", send("moved"));
}

app.whenReady().then(() => {
  const label = `w-electron-${++seq}`;
  const win = createWindow(label);
  wireWindowEvents(label, win);
  console.log(`[electron-spike] 창 ${label} → ${DEV_URL}`);
  console.log(`[electron-spike] 요구 원장: ${DEMAND_LOG}`);
  // 어느 정체성으로 어느 백엔드에 말을 거는지는 기동 시 드러낸다 — 붙지 않은 채 도는 것과
  // 엉뚱한 소켓에 붙은 것은 로그 없이는 구분되지 않는다.
  console.log(`[electron-spike] 정체성: ${IDENTITY.identifier} @ ${IDENTITY.home}`);
  console.log(
    externalSocket
      ? `[electron-spike] 백엔드 소켓(외부 지목): ${externalSocket}`
      : `[electron-spike] 백엔드 소켓: ${IDENTITY.socketPath}`,
  );
});

app.on("window-all-closed", () => app.quit());
// 셸이 내려가면 연결도 놓고, 자기가 띄운 cored도 거둔다. 외부에서 지목한 소켓의 프로세스는
// 남의 것이라 건드리지 않는다. 회수는 값으로 돌려준다 — 거뒀는지 확인할 수 있어야 한다.
app.on("will-quit", () => {
  if (backend) backend.close();
  return ownedCored ? ownedCored.stop() : Promise.resolve();
});
