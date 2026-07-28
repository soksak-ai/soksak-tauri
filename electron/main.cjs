// Electron 셸 — 스파이크. Tauri 셸과 **형제**이며 교체가 아니다.
//
// 목적은 셸 층의 질문에만 답하는 것이다: 같은 UI 가 이 셸 위에서 뜨는가, 창 조작·전역
// 이벤트·스트림이 계약대로 도는가, 그리고 UI 가 백엔드에 **무엇을 어떤 순서로** 요구하는가.
// 마지막 것이 러스트 헬퍼 분리(2단계)의 우선순위 입력이다.
//
// 규칙: 백엔드가 아직 없는 명령은 **조용히 성공한 척하지 않는다**. 이름을 달아 실패하고
// 요구 원장에 남긴다 — 가짜 성공은 "돌아간다"는 착시를 만들고, 그 착시가 이식 판단을 망친다.

const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createBackendClient, resolveSocketPath, SOCKET_ENV, SOCKET_ARG } = require("./backend.cjs");

const DEV_URL = process.env.SOKSAK_ELECTRON_URL || "http://localhost:1420";
const SPIKE_HOME = path.join(os.homedir(), ".soksak-electron-spike");
const DEMAND_LOG = path.join(SPIKE_HOME, "invoke-demand.jsonl");

fs.mkdirSync(SPIKE_HOME, { recursive: true });

/** 창 라벨 ↔ BrowserWindow. 라벨은 앱의 정체성 축이므로 셸이 부여하고 지킨다. */
const windows = new Map();
let seq = 0;

/** UI 가 백엔드에 요구한 명령을 순서대로 남긴다 — 2단계 우선순위의 실측 근거.
 *  서빙된 것(served:true)과 못 한 것을 가르고, 못 한 것은 사유(code)까지 남긴다 — "헬퍼가
 *  무엇을 더 져야 하는가"는 요구 목록만으로는 안 나오고 실패 사유가 있어야 갈린다. */
function recordDemand(cmd, served, code) {
  try {
    const entry = { t: Date.now(), cmd, served };
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

// ── 백엔드 다리 ──────────────────────────────────────────────────────────────
// 요청은 소켓 너머로 간다(electron/backend.cjs — 한 줄 JSON, id 상관, 유지 연결).
// 경로는 환경변수나 인자로만 온다: 기본 경로를 지어내면 남의 소켓에 붙어 놓고 "붙었다"고
// 답할 수 있다. 경로가 없으면 오늘과 같은 이름으로 실패한다(BACKEND_NOT_CONNECTED).
const backend = createBackendClient({
  socketPath: resolveSocketPath(),
  onDemand: recordDemand,
});

async function callBackend(cmd, args) {
  return backend.call(cmd, args);
}

ipcMain.handle("shell:invoke", async (_e, { cmd, args }) => {
  try {
    return { ok: true, value: await callBackend(cmd, args) };
  } catch (e) {
    return { ok: false, code: e.code || "ERROR", message: String(e.message || e), command: cmd };
  }
});

// ── 호스트 능력 ──────────────────────────────────────────────────────────────
// 계약의 app/path/dialog. 백엔드 없이 Electron·Node 가 그대로 답하는 것들이라 원장에
// 남기지 않는다 — 원장은 "러스트 헬퍼가 무엇을 져야 하는가"의 목록이다.
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
  // 어느 백엔드에 말을 거는지는 기동 시 한 줄로 드러낸다 — 붙지 않은 채 도는 것과
  // 엉뚱한 소켓에 붙은 것은 로그 없이는 구분되지 않는다.
  console.log(
    backend.socketPath
      ? `[electron-spike] 백엔드 소켓: ${backend.socketPath}`
      : `[electron-spike] 백엔드 소켓 없음 — ${SOCKET_ENV}=<경로> 또는 ${SOCKET_ARG}<경로>`,
  );
});

app.on("window-all-closed", () => app.quit());
// 셸이 내려가면 연결도 놓는다 — 대기 중이던 호출은 이름을 달고 깨어난다.
app.on("will-quit", () => backend.close());
