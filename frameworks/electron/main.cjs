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

const { app, BrowserWindow, Menu, dialog, ipcMain, screen  } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createBackendClient, resolveSocketPath } = require("./backend.cjs");
const {
  frameworkIdentity,
  coredBinary,
  ensureCored,
  coreBuildOf,
} = require("./cored.cjs");
const activity = require("./activity.cjs");
const { createControlHost, CMD_REQUEST } = require("./control.cjs");
const { deliverEvent } = require("./windowEvents.cjs");
const native = require("./native/index.cjs");
const { frameworkError } = native;

const DEV_URL = process.env.SOKSAK_ELECTRON_URL || "http://localhost:1420";

// 이 프레임워크의 정체성 — 홈은 identifier 에서 나오고, 원장도 cored 소켓도 그 홈 안에 산다.
// 홈은 프레임워크의 것이다: cored는 이 값을 부팅 인자로 **받는다**(파생하지 않는다).
const IDENTITY = frameworkIdentity();

// 로그 한 줄이 앱을 죽이지 않는다.
//
// 실사고(2026-07-29): 하니스가 앱을 띄워 두고 빠지자 stdout 파이프가 닫혔고, 다음 console.error
// 가 EPIPE 로 던져 Electron 이 "A JavaScript error occurred in the main process" 로 죽었다.
// 관측하려고 넣은 줄이 관측 대상을 죽인 것이다.
//
// 쓰지 못하는 것은 사실이지 오류가 아니다 — 부모가 없는 프로세스는 정상적으로 그렇다.
// 삼키되 **삼킨다는 것을 여기 적어 둔다**: 사유가 안 보이면 다음 사람이 로그를 의심한다.
function note(line) {
  try {
    console.error(line);
  } catch {
    // 받을 곳이 없다. 앱은 계속 산다.
  }
}

const SPIKE_HOME = IDENTITY.home;
const DEMAND_LOG = path.join(SPIKE_HOME, "invoke-demand.jsonl");

fs.mkdirSync(SPIKE_HOME, { recursive: true });

/** 창 라벨 ↔ BrowserWindow. 라벨은 앱의 정체성 축이므로 프레임워크가 부여하고 지킨다. */
const windows = new Map();
// 종료 중 표식 — before-quit 이 세운다(개별 닫기와 종료를 가른다).
let quitting = false;


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

function createWindow(label, rect, bootQuery) {
  const win = new BrowserWindow({
    // rect 를 받으면 그대로 놓는다. 만든 뒤 옮기면 첫 프레임이 기본 자리에 한 번 그려져
    // 복원이 화면에서 튄다 — 생성 인자로 주면 그 프레임이 없다.
    ...(rect
      ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
      : { width: 1200, height: 800 }),
    show: false,
    // 보이기 전에도 그린다 — 그러지 않으면 첫 캡처가 빈 이미지다.
    paintWhenInitiallyHidden: true,
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
      // 가려진 창도 계속 그린다. 스로틀이 켜지면 캡처가 **옛 프레임**을 담고, 그 오답은
      // 오류가 아니라 "화면이 안 바뀐다"로 나타난다(window.snapshot 이 이 창을 담는다).
      backgroundThrottling: false,
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
  // 렌더러가 죽거나 던지면 **그 자리에서 남긴다.** 없으면 화면만 비고 사유는 어디에도 없다
  // (실측 2026-07-29: 최대화 뒤 앱 트리가 통째로 사라졌는데 로그에는 Chromium mojo 잡음뿐
  // 이었다 — 무엇이 던졌는지 물을 자리가 없었다). 창을 가진 쪽만 이 사건을 받는다.
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    // 경고 이상만 — 평상시 로그까지 실으면 진짜 오류가 그 안에 묻힌다.
    if (level < 2) return;
    note(`[renderer:${label}] ${message}${sourceId ? ` (${sourceId}:${line})` : ""}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    note(`[renderer:${label}] 렌더러 프로세스 종료: ${JSON.stringify(details)}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    note(`[renderer:${label}] 적재 실패: ${code} ${desc} ${url}`);
  });
  win.webContents.on("unresponsive", () => {
    note(`[renderer:${label}] 응답 없음`);
  });

  win.on("closed", () => {
    windows.delete(label);
    // 이 창 앞으로 남은 자식을 거둔다 — 창은 프레임워크의 사실이라 이 자리가 아는 유일한 곳이다.
    // 안 거두면 창이 닫혀도 그 자식이 살아 남고, 그 고아는 프로세스 목록에만 보인다.
    void callBackend("process_reclaim_by_window", { window: label }).catch((e) => {
      note(`[electron-spike] 창 자식 회수 실패(${label}): ${e.code || e.message}`);
    });
    // 개별 닫기는 그 창의 영속 흔적도 함께 폐기한다. 남기면 다음 부트의 리스폰이 그 slot 을
    // 되살려 닫은 창이 재시작마다 돌아온다 — 닫을수록 늘어난다(실측: 창 15 개 부활).
    // 앱 종료의 창 파괴는 지나가지 않는다: 그때는 세션이 보존되어야 다음 기동에 되살아난다.
    // 무엇이 흔적인지는 코어가 정한다(window_traces) — 여기서 규칙을 다시 적지 않는다.
    if (!quitting) {
      void callBackend("window_traces_prune", { label }).catch((e) => {
        note(`[electron-spike] 창 흔적 폐기 실패(${label}): ${e.code || e.message}`);
      });
    }
    // 사라진 창을 여기서 지우지 않는다 — 살아 있는 목록을 보내면 장부가 스스로 맞춘다(멱등).
    announceWindows();
  });
  announceWindows();
  // 부트 지시는 쿼리로 간다 — 앱이 conf url 에 얹는 그 자리와 같다. 새 창의 프론트가 그것을
  // 읽어 무엇을 열지 정한다(창만 나고 안이 비는 것을 막는 유일한 통로다).
  void win.loadURL(bootQuery ? `${DEV_URL}?${bootQuery}` : DEV_URL);
    // **guest 안의 클릭은 호스트 문서에 아무것도 안 남긴다.**
  //
  // 계측 2026-08-02: 브라우저 페이지 안을 눌렀을 때 호스트에 도착한 사건이 0 이었다
  // (focusin WEBVIEW 한 줄도 없다). 그래서 칸 결합이 안 따라갔고, 호스트 DOM 인 주소창을
  // 눌렀을 때만 옮겨갔다. 형제 프레임워크는 같은 사실을 네이티브 클릭 모니터로 알아내 넘긴다.
  //
  // OS 를 빌리지 않는다(A27). guest 의 입력 사건을 그대로 듣고 **계약의 이름**으로 낸다
  // (spec-content-view ACTIVATED). 알아내는 방법은 프레임워크마다 달라도 이름은 하나다.
  win.webContents.on("did-attach-webview", (_e, guest) => {
    guest.on("input-event", (_ev, input) => {
      if (input && input.type === "mouseDown") {
        deliverEvent(win, "content-view-activated", { id: guest.id });
      }
    });
  });
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

/** 창 사실이 바뀌었다고 알린다. 아직 안 붙었으면 할 일이 없다 — 붙을 때 지금 사실로 등록한다.
 *
 *  창 사건 위에서 부르므로 기다릴 사람이 없다. 대신 **안 선 갱신은 자국을 남긴다** — 갈린
 *  장부는 오류로 보이지 않고, 한참 뒤에 "명령이 엉뚱한 창에서 돌았다"로만 나타난다. */
function announceWindows() {
  void Promise.resolve(controlHost?.windowsChanged()).then((settled) => {
    if (controlHost && settled === false) {
      note("[electron-spike] 창 사실 갱신이 서지 않았다 — cored 의 장부가 이 프로세스와 갈렸다");
    }
  });
}

/** 제어면을 세운다 — 이 소켓의 cored 에게 "창은 내가 갖고 있다"고 등록한다. */
function standUpControl(socketPath) {
  controlHost = createControlHost({
    socketPath,
    // 신고는 이 다리를 지나간다 — 지나갈 때 쥐어 두고, 다시 붙을 때 다시 보낸다.
    ownerAnswered: () => ownerAnsweredNames,
    facts: windowFacts,
    deliver: (label, payload) => deliverEvent(windowFor(label), CMD_REQUEST, payload),
    // 방송은 창을 가리지 않는다 — 활동 부채질과 같은 집합(창 레지스트리 전부).
    broadcast: (event, payload) => {
      let all = true;
      for (const win of windows.values()) {
        if (!deliverEvent(win, event, payload)) all = false;
      }
      return all;
    },
    onLog: (line) => note(`[electron-spike] ${line}`),
  }).start();
  void controlHost.ready.then((ok) => {
    // 붙었는지는 로그로 드러낸다. 안 붙으면 밖에서 부른 명령이 상한으로만 끝나고, 왜 그런지는
    // 이 줄이 유일한 자국이다.
    note(
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
    // 지도가 바뀐 사실을 이 프레임워크의 창 전부에 — 크로스윈도우 반응은 이 신호를 듣는다.
    announce: (event, payload) => { for (const w of windows.values()) deliverEvent(w, event, payload); },
    // 알림 클릭이 실어 온 딥링크를 주인에게 넘긴다 — 딥링크와 같은 길이다(창을 안 거친다).
    deepLink: (url) =>
      callBackend("deeplink_open", { url: String(url ?? "") }).catch((e) =>
        note(`[electron-spike] 알림 클릭 딥링크 실패: ${e.code || e.message}`),
      ),
    // 죽기 전에 남길 자리 — 자기 죽음은 죽은 뒤에 못 적는다.
    note,
    windowFor,
    createWindow,
    // 앱을 전면으로 — 창 하나를 key 로 만드는 것과 다른 일이다. steal 은 다른 앱에서
    // 포커스를 가져온다는 뜻이고, "창을 앞으로"는 그것을 요구한다.
    activateApp: () => app.focus({ steal: true }),
    // 창에 사건을 민다 — 프레임워크만 할 수 있는 일이고, 구독은 그 창의 listen 이 받는다.
    emitToWindow: (win, event, payload) => deliverEvent(win, event, payload),
    screen,
    // 이 홈의 빌드 축 — 원격 업데이트를 볼 채널인지 가른다. 프로세스 환경을 다시 읽지 않는다:
    // 부팅이 확정한 정체성에서 나온다.
    coreBuild: () => coreBuildOf(IDENTITY.identifier),
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

function connectBackend(socketPath, ensureUp) {
  backend = createBackendClient({
    socketPath,
    onDemand: recordDemand,
    // 주인이 사라졌으면 다시 세운다 — 끊긴 연결은 다시 붙으면 되지만, 없어진 주인은 세우지
    // 않으면 이 앱이 남은 수명 내내 저장소를 잃는다. 외부 지목 소켓에는 넣지 않는다: 남의
    // 프로세스를 우리가 세우면 그것에 붙어 있던 다른 프레임워크의 창이 주소를 잃는다.
    ensureUp,
    // 이 연결은 창의 다리다. 밝히지 않으면 cored 가 서빙하지 않는 이름을 창으로 되돌리고,
    // 그 창이 바로 물어본 쪽이라 회신이 오지 않는다 — 이름 대신 상한이 나온다.
    announce: ["control_bridge_attach"],
    // 붙자마자 무엇을 서빙하는지 물어 둔다 — 누가 답하는가는 선언이 정한다(추측 아님).
    declare: "cored.commands",
  });
  return backend;
}

/**
 * cored **프로세스**가 서 있게 한다. 이미 살아 있으면 그것을 채택하고, 없으면 띄운다.
 *
 * 다리는 놓지 않는다. 세우는 일과 붙는 일을 한 함수에 두면, 다시 세우려고 부른 자리가 다리까지
 * 새로 만들어 같은 앱에 다리가 둘이 된다 — 그때부터 어느 다리의 답을 받는지가 우연이 된다.
 */
async function ensureCoredProcess() {
  const binary = // frameworks/electron 은 저장소 루트에서 두 단계다 — 한 단계로 세면 frameworks/ 를 루트로 본다.
    coredBinary({ root: path.join(__dirname, "..", "..") });
  const cored = await ensureCored({
    identity: IDENTITY,
    binary,
    onLog: (line) => note(`[soksak-cored] ${line}`),
  });
  if (cored.origin === "spawned") ownedCored = cored;
  standUpControl(cored.socketPath);
  note(
    `[electron-spike] cored ${cored.origin === "spawned" ? `띄움(pid ${cored.pid})` : "이미 살아 있음"}` +
      `: ${binary} → ${cored.socketPath}`,
  );
  return cored.socketPath;
}

/** cored를 세우고 그 소켓에 다리를 놓는다. 못 세우면 이름을 달고 실패한다(조용한 no-op 아님). */
async function standUpCored() {
  const socketPath = await ensureCoredProcess();
  // 다시 세우는 법은 처음 세운 법과 **같아야 한다** — 여기서 다르게 세우면 재건된 주인이
  // 처음 것과 다른 홈을 열고, 그 어긋남은 "가끔 값이 없다"로만 나타난다.
  return connectBackend(socketPath, ensureCoredProcess);
}

const backendReady = externalSocket
  ? Promise.resolve(connectBackend(externalSocket))
  : standUpCored();

// 외부에서 지목한 소켓에도 창은 우리 것이다 — 그 cored 에도 등록해야 밖에서 온 명령이 닿는다.
if (externalSocket) standUpControl(externalSocket);

// 실패 사유는 기동 때 한 번 드러낸다. 호출은 저마다 이름을 달고 실패하지만, 왜 그렇게 됐는지는
// 첫 호출을 기다리지 않고 알 수 있어야 한다.
backendReady.catch((e) =>
  note(`[electron-spike] 백엔드를 세우지 못했다: ${e.code || "ERROR"} — ${e.message}`),
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
    note(`[electron-spike] 활동 배달이 일부 창에 닿지 못했다 — seq=${entry.seq}`);
  }
}

// ── 스트림 ────────────────────────────────────────────────────────────────────
// 답이 여럿인 명령(터미널 출력·프로세스 stdout)의 되돌아오는 길. 렌더러가 토큰을 만들고
// (preload createStream) 인자에 실어 보내면, 백엔드가 그 토큰으로 프레임을 민다. 이 자리는
// 프레임을 **토큰을 만든 창**으로 넘긴다 — 다른 창으로 보내면 받는 쪽이 자기 토큰이 아니라 버린다.
//
// 토큰의 창은 요청이 온 창이다. 인자를 열어 토큰을 찾는 규칙은 코어의 것과 같은 한 모양이라
// 여기서도 그 모양만 본다(soksak-core stream::TOKEN_KEY).
const STREAM_TOKEN_KEY = "__frameworkStream";
const STREAM_CHANNEL = "framework:stream";

/** 이 인자가 싣고 있는 스트림 토큰들. */
function streamTokens(args) {
  if (!args || typeof args !== "object") return [];
  return Object.values(args)
    .map((v) => (v && typeof v === "object" ? v[STREAM_TOKEN_KEY] : null))
    .filter((t) => typeof t === "string" && t);
}

/** 이 토큰의 프레임을 그 창으로 흘린다. 창이 죽으면 그만 받는다(죽은 창에 계속 쓰지 않는다). */
function pipeStreams(client, args, sender) {
  for (const token of streamTokens(args)) {
    const off = client.onStream(token, (msg) => {
      try {
        if (sender.isDestroyed()) return off();
        sender.send(STREAM_CHANNEL, { id: token, msg });
      } catch {
        off();
      }
    });
  }
}

/** 창이 신고한 "답이 주인의 것인 이름". 다시 붙을 때 다시 선언하려고 쥔다. */
let ownerAnsweredNames = [];

ipcMain.handle("framework:invoke", async (e, { cmd, args }) => {
  if (cmd === "control_owner_answered" && Array.isArray(args?.names)) {
    ownerAnsweredNames = args.names.map(String);
  }
  // 프레임워크의 것이 먼저다 — 창·웹뷰·네이티브 표면은 소켓 너머로 물어볼 수 없다(거기엔 창이 없다).
  // 다만 **백엔드가 서빙한다고 선언한 이름은 백엔드의 것**이다(위 backendServes).
  // 백엔드가 **스스로 선언한** 이름은 백엔드의 것이다(backend.cjs `declare`). 이름 접두사로
  // 가르면 창이 아니라 저장소가 답하는 이름을 프레임워크가 가로챈다.
  if (!backend?.serves(cmd) && native.claims(cmd)) {
    return native.serve(cmd, args, nativeContext(e && e.sender), recordDemand);
  }
  try {
    // 프레임을 받을 자리를 **부르기 전에** 만든다 — 명령이 첫 프레임을 곧바로 밀 수 있고,
    // 그때 자리가 없으면 그 프레임은 조용히 사라진다.
    if (e && e.sender) {
      const client = await backendReady.catch(() => null);
      if (client) pipeStreams(client, args, e.sender);
    }
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

// 이 앱의 이름은 **정체성에서 나온다** — 프레임워크 이름이 아니다.
//
// 안 정하면 프레임워크의 이름이 그대로 앱 이름이 된다: Dock·메뉴바·알림·창 제목이 전부
// "Electron" 이고, 사용자에게는 그것이 앱의 정체다. 게다가 Electron 은 기본 userData 경로를
// 앱 이름에서 파생하므로, 이름을 안 정하면 세상의 모든 미포장 Electron 앱과 같은 폴더를
// 쓴다(실측: ~/Library/Application Support/Electron 이 실제로 채워져 있었다).
//
// 프레임워크는 렌더러일 뿐이고 제품은 하나다 — 그래서 이름도 하나다. "어느 프레임워크인가"는
// 이름이 아니라 런타임 사실이 답한다(framework.provision).
app.setName(IDENTITY.productName);

// 정체성이 다르면 다른 앱이다. Electron 의 단일 인스턴스 잠금은 userData 경로로 갈리므로,
// 그 경로를 이 정체성의 것으로 지목하면 dev·debug·release 가 각자 하나씩 선다. 지목하지 않으면
// 셋이 같은 기본 경로를 공유해 서로를 "이미 도는 자신"으로 오인한다.
//
// 홈이 아니라 홈 **안의 프레임워크 자리**다 — 홈은 프레임워크로 갈리지 않으므로(같은
// 플러그인·프로젝트를 본다) 이 이름이 주인을 말해야 한다.
app.setPath("userData", IDENTITY.frameworkDir);

// 하나만 선다 — 거두는 것이 아니라 애초에 겹치지 않는다.
//
// 두 번째 실행이 두 번째 앱이 되면 실행할 때마다 인스턴스가 쌓이고, 쌓인 것을 죽이는 일이
// 매번 붙는다. 그것은 멱등이 아니다. 잠금을 못 잡으면 이 프로세스는 **아무것도 만들지 않고**
// 물러난다 — 창도, cored 도, 원장도 건드리지 않는다.
if (!app.requestSingleInstanceLock()) {
  note("[electron-spike] 이미 도는 인스턴스가 있다 — 그 창을 앞으로 내고 물러난다");
  app.quit();
} else {
  // 먼저 선 쪽이 두 번째 실행을 받는다. 사용자가 아이콘을 다시 눌렀다는 뜻이므로 자기 창을
  // 앞으로 낸다 — 아무 반응이 없으면 "안 켜진다"로 읽힌다.
  // 딥링크 — OS 가 `soksak://…` 을 이 앱으로 넘긴다(번들 Info.plist 의 URI 스킴 등록).
  //
  // 규칙은 코어의 것이다(soksak-core deeplink.rs: `soksak://run?cmd=…`). 여기서 하는 것은
  // **받아서 창에 나르는 일**뿐이다 — 부수효과이고 창을 아는 자리라 프레임워크의 몫이다.
  //
  // 창이 아직 없을 수 있다(링크가 앱을 깨운 경우). 그때는 들고 있다가 창이 물으면 준다
  // (`deeplink_current`) — 버리면 그 링크는 아무 데도 안 닿고 사용자는 "안 열린다"만 본다.
  app.on("open-url", (e, url) => {
    e.preventDefault();
    // 자국을 남긴다 — 안 남기면 "링크가 안 열린다"에서 어느 홉이 끊겼는지 못 가른다.
    note(`[electron-spike] 딥링크: ${url}`);
    // **주인에게 넘긴다.** 밖에서 온 명령이므로 명령 표면의 주인(cored)이 받고 형식도 거기서
    // 읽는다 — 창에 넘기면 창 없는 곳에 영영 못 닿고, 형식이 프레임워크마다 한 벌이 된다.
    void callBackend("deeplink_open", { url }).catch((err) => {
      note(`[electron-spike] 딥링크를 주인에게 넘기지 못했다: ${err.code || err.message}`);
    });
  });

  app.on("second-instance", () => {
    const first = [...windows.values()].find((w) => !w.isDestroyed());
    if (!first) return;
    if (first.isMinimized()) first.restore();
    first.focus();
  });
  boot();
}

// 앱 메뉴는 제품 이름을 말한다 — macOS 의 앱 메뉴 타이틀은 `app.setName()` 이 아니라 **첫
// 서브메뉴의 label** 에서 온다(미포장 실행에서는 번들의 CFBundleName 이 기본값이라 프레임워크
// 이름이 그대로 노출된다: 실측 2026-07-31 메뉴바가 "Electron" 이었다).
//
// 메뉴를 아예 안 세우면 프레임워크의 기본 메뉴가 뜬다 — 그 메뉴는 이 제품을 모른다. 편집·창
// 역할 메뉴도 함께 세운다: 복사/붙여넣기 단축키는 메뉴가 없으면 동작하지 않는다.
function installApplicationMenu() {
  const appItems = ["about", "-", "services", "-", "hide", "hideOthers", "unhide", "-", "quit"];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.getName(),
        submenu: appItems.map((r) => (r === "-" ? { type: "separator" } : { role: r })),
      },
      ...["editMenu", "viewMenu", "windowMenu"].map((role) => ({ role })),
    ]),
  );
}

function boot() {
  app.whenReady().then(() => {
  // 메뉴는 창을 막지 못한다. 앱 이름을 말하는 일이 실패한다고 창이 안 서면, 사용자는 이름이
  // 틀린 앱이 아니라 **안 켜지는 앱**을 본다(실측 2026-08-01: 이 한 줄이 던져 부팅 창이
  // 통째로 사라졌고, whenReady 안의 예외라 아무 자국도 안 남았다).
  // 삼키되 센다 — 막지 않는 것과 사실을 안 남기는 것은 다르다.
  try {
    installApplicationMenu();
  } catch (e) {
    note(`[electron-spike] 앱 메뉴를 세우지 못했다 — 이름이 프레임워크의 것으로 보인다: ${e}`);
  }
  const label = CONTROL_PLANE_LABEL;
  const win = createWindow(label);
  wireWindowEvents(label, win);
  note(`[electron-spike] 창 ${label} → ${DEV_URL}`);
  note(`[electron-spike] 요구 원장: ${DEMAND_LOG}`);
  // 어느 정체성으로 어느 백엔드에 말을 거는지는 기동 시 드러낸다 — 붙지 않은 채 도는 것과
  // 엉뚱한 소켓에 붙은 것은 로그 없이는 구분되지 않는다.
  note(`[electron-spike] 정체성: ${IDENTITY.identifier} @ ${IDENTITY.home}`);
  note(
    externalSocket
      ? `[electron-spike] 백엔드 소켓(외부 지목): ${externalSocket}`
      : `[electron-spike] 백엔드 소켓: ${IDENTITY.socketPath}`,
  );
});
}

// 종료 중인가 — 종료의 창 파괴는 개별 닫기가 아니다. 세션은 보존되어야 다음 기동에 되살아난다.
// 이 표식이 없으면 앱을 끄는 것만으로 열려 있던 창 전부의 흔적이 지워진다(복원이 죽는다).
app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => app.quit());
// 프레임워크가 내려가면 연결도 놓고, 자기가 띄운 cored도 거둔다. 외부에서 지목한 소켓의 프로세스는
// 남의 것이라 건드리지 않는다. 회수는 값으로 돌려준다 — 거뒀는지 확인할 수 있어야 한다.
app.on("will-quit", () => {
  if (controlHost) controlHost.stop();
  if (backend) backend.close();
  return ownedCored ? ownedCored.stop() : Promise.resolve();
});
