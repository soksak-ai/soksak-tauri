// Electron 프레임워크 — 스파이크. Tauri 프레임워크와 **형제**이며 교체가 아니다.
//
// 목적은 프레임워크 층의 질문에만 답하는 것이다: 같은 UI 가 이 프레임워크 위에서 뜨는가, 창 조작·전역
// 이벤트·스트림이 계약대로 도는가, 그리고 UI 가 백엔드에 **무엇을 어떤 순서로** 요구하는가.
// 마지막 것이 러스트 cored 분리(2단계)의 우선순위 입력이다.
//
// 규칙: 백엔드가 아직 없는 명령은 **조용히 성공한 척하지 않는다**. 이름을 달아 실패하고
// 요구 원장에 남긴다 — 가짜 성공은 "돌아간다"는 착시를 만들고, 그 착시가 이식 판단을 망친다.
//
// 다만 전부가 백엔드의 것은 아니다. 창·웹뷰·네이티브 표면은 프레임워크가 스스로 답한다 — cored
// 프로세스엔 창이 없어 영영 그리로 못 간다. 그 표는 electron/native/ 가 갈래별로 소유하고,
// 소켓 앞에 선다. 이 파일은 표를 쥐지 않는다 — 배선(창 레지스트리·다리·원장)만 쥔다.

const { app, BrowserWindow, dialog, ipcMain, screen  } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createBackendClient, resolveSocketPath } = require("./backend.cjs");
const { frameworkIdentity, coredBinary, ensureCored } = require("./cored.cjs");
const activity = require("./activity.cjs");
const { createControlHost, CMD_REQUEST } = require("./control.cjs");
const { deliverEvent } = require("./windowEvents.cjs");
const native = require("./native/index.cjs");
const { frameworkError } = native;

const DEV_URL = process.env.SOKSAK_ELECTRON_URL || "http://localhost:1420";

// 이 프레임워크의 정체성 — 홈은 identifier 에서 나오고, 원장도 cored 소켓도 그 홈 안에 산다.
// 홈은 프레임워크의 것이다: cored는 이 값을 부팅 인자로 **받는다**(파생하지 않는다).
const IDENTITY = frameworkIdentity();
const SPIKE_HOME = IDENTITY.home;
const DEMAND_LOG = path.join(SPIKE_HOME, "invoke-demand.jsonl");

fs.mkdirSync(SPIKE_HOME, { recursive: true });

/** 창 라벨 ↔ BrowserWindow. 라벨은 앱의 정체성 축이므로 프레임워크가 부여하고 지킨다. */
const windows = new Map();


/** 부팅 창의 라벨 — 컨트롤 플레인의 예약어다(NAMING 4b). 프론트는 이 이름 하나로 컨트롤 플레인
 *  분기를 타고(src/main.tsx), 거기서만 첫 실행 부트스트랩과 워크스페이스 리스폰이 돈다
 *  (src/state/windowBoot.ts). 다른 이름을 주면 그 분기가 영영 거짓이라 앱이 부팅만 하고 만다.
 *  워크스페이스 창은 이 이름을 쓰지 않는다 — 그쪽은 w-<uuid> 다. */
const CONTROL_PLANE_LABEL = "main";

/** 지금 포커스된 창의 라벨. **사실 하나**다 — "마지막 워크스페이스가 무엇인가"는 규칙이고
 *  코어의 장부가 그것을 안다(soksak-core control::FocusLedger). 여기서 계산하면 두 벌이 된다. */
let focusedLabel = CONTROL_PLANE_LABEL;

/** UI 가 백엔드에 요구한 명령을 순서대로 남긴다 — 2단계 우선순위의 실측 근거.
 *  서빙된 것(served:true)과 못 한 것을 가르고, 못 한 것은 사유(code)까지 남긴다 — "cored 가
 *  무엇을 더 져야 하는가"는 요구 목록만으로는 안 나오고 실패 사유가 있어야 갈린다.
 *  by="framework" 는 프레임워크가 스스로 답한 줄이다. 순서는 남기되 cored 요구 목록에는 섞이지 않는다 —
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

function createWindow(label, rect) {
  const win = new BrowserWindow({
    // rect 를 받으면 그대로 놓는다. 만든 뒤 옮기면 첫 프레임이 기본 자리에 한 번 그려져
    // 복원이 화면에서 튄다 — 생성 인자로 주면 그 프레임이 없다.
    ...(rect
      ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
      : { width: 1200, height: 800 }),
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // 콘텐츠 뷰는 <webview> 로 DOM 안에 산다(src/lib/contentViews.ts). 이 프레임워크에는
      // 메인 웹뷰 아래 네이티브 형제가 없으므로 콘텐츠도 페이지 트리 안에 있어야 하고,
      // 겹침은 z-index 로 해결된다(scripts/electron/overlay-stacking.test.mjs).
      //
      // 태그를 켜는 것이 격리를 여는 것은 아니다 — 위 둘은 그대로다. 태그가 만드는
      // 게스트는 자기 프로세스에서 돌고 preload 없이는 노드를 보지 못한다.
      webviewTag: true,
      additionalArguments: [`--soksak-window-label=${label}`],
    },
  });
  windows.set(label, win);
  win.once("ready-to-show", () => win.show());
  // 포커스는 사실이고, 그 사실이 바뀌면 cored 가 알아야 한다 — 낡은 사실로 타겟을 고르면
  // 밖에서 온 명령이 사용자가 보고 있지 않은 창에서 돈다.
  win.on("focus", () => {
    focusedLabel = label;
    announceWindows();
  });
  win.on("closed", () => {
    windows.delete(label);
    // 사라진 창을 여기서 지우지 않는다 — 살아 있는 목록을 보내면 장부가 스스로 맞춘다(멱등).
    announceWindows();
  });
  announceWindows();
  void win.loadURL(DEV_URL);
  return win;
}

function windowFor(label) {
  return (label && windows.get(label)) || null;
}

// ── 제어면 ────────────────────────────────────────────────────────────────────
// 밖에서 온 명령(하니스·sok·에이전트)이 창에 닿는 길. cored 가 어느 창인지 정하고, 이 프레임워크는
// **배달만** 한다 — 규칙은 코어의 것이다(soksak-core control). 회신은 여기로 오지 않는다:
// 창의 실행기가 invoke("cmd_result") 를 부르고 그 호출은 여느 명령과 같은 다리로 간다.

/** 살아 있는 창 사실 — 목록과 포커스. 값이 아니라 이 함수가 매번 읽는다(사본은 낡는다). */
function windowFacts() {
  const live = [...windows.entries()].filter(([, w]) => !w.isDestroyed()).map(([l]) => l);
  return { live, focused: focusedLabel };
}

/** 살아 있는 제어면 호스트. cored 소켓이 정해지기 전에는 없다. */
let controlHost = null;

/** 창 사실이 바뀌었다고 알린다. 아직 안 붙었으면 할 일이 없다 — 붙을 때 지금 사실로 등록한다. */
function announceWindows() {
  controlHost?.windowsChanged();
}

/** 제어면을 세운다 — 이 소켓의 cored 에게 "창은 내가 갖고 있다"고 등록한다. */
function standUpControl(socketPath) {
  controlHost = createControlHost({
    socketPath,
    facts: windowFacts,
    deliver: (label, payload) => deliverEvent(windowFor(label), CMD_REQUEST, payload),
    onLog: (line) => console.error(`[electron-spike] ${line}`),
  }).start();
  void controlHost.ready.then((ok) => {
    // 붙었는지는 로그로 드러낸다. 안 붙으면 밖에서 부른 명령이 상한으로만 끝나고, 왜 그런지는
    // 이 줄이 유일한 자국이다.
    console.log(
      ok
        ? `[electron-spike] 제어면: 밖에서 오는 명령이 창으로 온다 — ${socketPath}`
        : `[electron-spike] 제어면: 등록이 서지 않았다 — 밖에서 오는 명령이 닿지 않는다`,
    );
  });
  return controlHost;
}

// ── 프레임워크의 것 — 네이티브 명령 ──────────────────────────────────────────
// 표는 electron/native/ 가 갈래별로 소유한다(window·webview·engine·titlebar). 이 파일이 주는
// 것은 프레임워크만 아는 문맥뿐이다: 부른 창, 그리고 프레임워크가 라벨을 부여한 표면들의 목록.

/** 네이티브 명령이 프레임워크에게 물을 수 있는 것. 표 항목은 이 문맥으로만 프레임워크를 본다. */
function nativeContext(sender) {
  return {
    window: BrowserWindow.fromWebContents(sender),
    surfaces: () => [...windows.keys()],
    // 창 갈래가 필요로 하는 것 — 라벨로 짚기, 만들기, 그리고 화면 사실. 표가 electron 을
    // 직접 require 하지 않게 여기서 넘긴다: 그래야 표를 테스트가 스텁 하나로 몰 수 있다.
    labels: () => [...windows.keys()].filter((l) => !windows.get(l).isDestroyed()),
    // 창 → 라벨 역참조. 점유처럼 "부른 창이 누구인가"가 답의 일부인 명령이 쓴다.
    labelOf: (win) => [...windows.entries()].find(([, w]) => w === win)?.[0] ?? null,
    windowFor,
    createWindow,
    screen,
  };
}

// ── 백엔드 다리 ──────────────────────────────────────────────────────────────
// 요청은 소켓 너머로 간다(electron/backend.cjs — 한 줄 JSON, id 상관, 유지 연결).
//
// 소켓이 오는 길은 둘이다.
//   ① 외부 지목(SOKSAK_SOCKET / --soksak-socket=) — 그 소켓은 남의 것이다. 그대로 붙고,
//      띄우지도 거두지도 않는다.
//   ② 지목이 없으면 프레임워크가 자기 정체성으로 cored를 띄운다(electron/cored.cjs). 기본 경로를
//      지어내 남의 소켓에 붙는 일은 여전히 없다 — 이 소켓은 이 프레임워크의 홈 안에 있다.
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
  standUpControl(cored.socketPath);
  console.log(
    `[electron-spike] cored ${cored.origin === "spawned" ? `띄움(pid ${cored.pid})` : "이미 살아 있음"}` +
      `: ${binary} → ${cored.socketPath}`,
  );
  return connectBackend(cored.socketPath);
}

const backendReady = externalSocket
  ? Promise.resolve(connectBackend(externalSocket))
  : standUpCored();

// 외부에서 지목한 소켓에도 창은 우리 것이다 — 그 cored 에도 등록해야 밖에서 온 명령이 닿는다.
if (externalSocket) standUpControl(externalSocket);

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
// 창은 프레임워크의 것이므로 그 항목을 창에 뿌리는 것은 여기서 한다 — 안 하면 프론트가 반환값을
// 버리므로(void invoke) listen("activity") 구독자가 오류 한 줄 없이 굶는다.
//
// 대상은 이 프레임워크의 창 레지스트리 전부다(코어의 broadcast 와 같다 — 발신 창을 빼지도 더하지도
// 않는다). 규칙과 배달은 activity.cjs 가 진다: 프레임워크를 띄우지 않고도 검증되어야 한다.
function fanOutActivity(entry) {
  if (!activity.isActivityEntry(entry)) {
    // 적재분이 아니면 부채질할 것이 없다. 아닌 것을 밀면 구독자가 조용히 어긋나고,
    // 성공을 돌려주면 뿌린 적 없는 것을 뿌렸다고 답하게 된다.
    throw frameworkError(
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

ipcMain.handle("framework:invoke", async (e, { cmd, args }) => {
  // 프레임워크의 것이 먼저다 — 창·웹뷰·네이티브 표면은 소켓 너머로 물어볼 수 없다(거기엔 창이 없다).
  // 판별은 이름으로 한다: 프레임워크 갈래는 표에 없더라도 소켓으로 새지 않는다.
  if (native.claims(cmd)) {
    return native.serve(cmd, args, nativeContext(e && e.sender), recordDemand);
  }
  try {
    const value = await callBackend(cmd, args);
    // 답을 돌려주기 전에 뿌린다 — 코어도 발행 안에서 창에 먼저 닿고 반환은 그다음이라,
    // 순서를 뒤집으면 같은 창에서 구독자와 호출자가 보는 시점이 프레임워크마다 갈린다.
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
ipcMain.handle("framework:host", async (e, { op, args }) => {
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

ipcMain.handle("framework:window", async (e, { label, op, args, exact }) => {
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

/** 창 기하 변화는 프레임워크가 렌더러로 밀어 준다(계약의 onResized/onMoved). */
function wireWindowEvents(label, win) {
  const send = (name) => () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    win.webContents.send("framework:window-event", { label, name, bounds: b });
  };
  win.on("resize", send("resized"));
  win.on("move", send("moved"));
}

// 정체성이 다르면 다른 앱이다. Electron 의 단일 인스턴스 잠금은 userData 경로로 갈리므로,
// 그 경로를 이 정체성의 홈으로 지목하면 dev·debug·release 가 각자 하나씩 선다. 지목하지 않으면
// 셋이 같은 기본 경로를 공유해 서로를 "이미 도는 자신"으로 오인한다.
app.setPath("userData", path.join(IDENTITY.home, "framework"));

// 하나만 선다 — 거두는 것이 아니라 애초에 겹치지 않는다.
//
// 두 번째 실행이 두 번째 앱이 되면 실행할 때마다 인스턴스가 쌓이고, 쌓인 것을 죽이는 일이
// 매번 붙는다. 그것은 멱등이 아니다. 잠금을 못 잡으면 이 프로세스는 **아무것도 만들지 않고**
// 물러난다 — 창도, cored 도, 원장도 건드리지 않는다.
if (!app.requestSingleInstanceLock()) {
  console.log("[electron-spike] 이미 도는 인스턴스가 있다 — 그 창을 앞으로 내고 물러난다");
  app.quit();
} else {
  // 먼저 선 쪽이 두 번째 실행을 받는다. 사용자가 아이콘을 다시 눌렀다는 뜻이므로 자기 창을
  // 앞으로 낸다 — 아무 반응이 없으면 "안 켜진다"로 읽힌다.
  app.on("second-instance", () => {
    const first = [...windows.values()].find((w) => !w.isDestroyed());
    if (!first) return;
    if (first.isMinimized()) first.restore();
    first.focus();
  });
  boot();
}

function boot() {
  app.whenReady().then(() => {
  const label = CONTROL_PLANE_LABEL;
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
}

app.on("window-all-closed", () => app.quit());
// 프레임워크가 내려가면 연결도 놓고, 자기가 띄운 cored도 거둔다. 외부에서 지목한 소켓의 프로세스는
// 남의 것이라 건드리지 않는다. 회수는 값으로 돌려준다 — 거뒀는지 확인할 수 있어야 한다.
app.on("will-quit", () => {
  if (controlHost) controlHost.stop();
  if (backend) backend.close();
  return ownedCored ? ownedCored.stop() : Promise.resolve();
});
