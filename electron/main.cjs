// Electron 셸 — 스파이크. Tauri 셸과 **형제**이며 교체가 아니다.
//
// 목적은 셸 층의 질문에만 답하는 것이다: 같은 UI 가 이 셸 위에서 뜨는가, 창 조작·전역
// 이벤트·스트림이 계약대로 도는가, 그리고 UI 가 백엔드에 **무엇을 어떤 순서로** 요구하는가.
// 마지막 것이 러스트 헬퍼 분리(2단계)의 우선순위 입력이다.
//
// 규칙: 백엔드가 아직 없는 명령은 **조용히 성공한 척하지 않는다**. 이름을 달아 실패하고
// 요구 원장에 남긴다 — 가짜 성공은 "돌아간다"는 착시를 만들고, 그 착시가 이식 판단을 망친다.

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const DEV_URL = process.env.SOKSAK_ELECTRON_URL || "http://localhost:1420";
const SPIKE_HOME = path.join(os.homedir(), ".soksak-electron-spike");
const DEMAND_LOG = path.join(SPIKE_HOME, "invoke-demand.jsonl");

fs.mkdirSync(SPIKE_HOME, { recursive: true });

/** 창 라벨 ↔ BrowserWindow. 라벨은 앱의 정체성 축이므로 셸이 부여하고 지킨다. */
const windows = new Map();
let seq = 0;

/** UI 가 백엔드에 요구한 명령을 순서대로 남긴다 — 2단계 우선순위의 실측 근거. */
function recordDemand(cmd, served) {
  try {
    fs.appendFileSync(
      DEMAND_LOG,
      JSON.stringify({ t: Date.now(), cmd, served }) + "\n",
    );
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
// 오늘은 백엔드가 없다. 2단계(러스트 헬퍼)가 서면 이 함수가 그 소켓으로 간다.
// 그 전까지는 요구를 원장에 남기고 이름을 단 실패를 돌려준다.
async function callBackend(cmd, args) {
  recordDemand(cmd, false);
  const err = new Error(
    `백엔드 미연결: "${cmd}" — 러스트 헬퍼(2단계)가 서면 이 호출이 그리로 간다`,
  );
  err.code = "BACKEND_NOT_CONNECTED";
  err.command = cmd;
  throw err;
}

ipcMain.handle("shell:invoke", async (_e, { cmd, args }) => {
  try {
    return { ok: true, value: await callBackend(cmd, args) };
  } catch (e) {
    return { ok: false, code: e.code || "ERROR", message: String(e.message || e), command: cmd };
  }
});

ipcMain.handle("shell:window", async (e, { label, op, args }) => {
  const win = windowFor(label) || BrowserWindow.fromWebContents(e.sender);
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
});

app.on("window-all-closed", () => app.quit());
