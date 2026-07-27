// Electron 프리로드 — 렌더러가 셸을 만나는 유일한 창구.
//
// contextIsolation 아래서는 렌더러가 Node 를 못 본다. 그래서 셸 능력은 여기서 **좁게**
// 노출한다: 계약(src/platform/host.ts)이 요구하는 것만, 그 이상은 없다. 넓게 열면 그 순간
// 렌더러 코드가 셸을 직접 알게 되고 경계가 무의미해진다.

const { contextBridge, ipcRenderer } = require("electron");

const labelArg = process.argv.find((a) => a.startsWith("--soksak-window-label="));
const label = labelArg ? labelArg.split("=")[1] : "main";

/** 전역 이벤트 구독자 — 셸이 밀어 주는 브로드캐스트를 이름별로 나눈다. */
const listeners = new Map();
ipcRenderer.on("shell:event", (_e, { event, payload }) => {
  listeners.get(event)?.forEach((f) => f(payload));
});

/** 창 기하 변화 — 계약의 onResized/onMoved 가 소비한다. */
const windowEventListeners = new Map();
ipcRenderer.on("shell:window-event", (_e, msg) => {
  windowEventListeners.get(msg.name)?.forEach((f) => f(msg));
});

/** 스트림 — 백엔드가 프레임을 밀어 넣는 수신구(터미널 출력·프로세스 stdout 등). */
let streamSeq = 0;
const streams = new Map();
ipcRenderer.on("shell:stream", (_e, { id, msg }) => {
  streams.get(id)?.(msg);
});

contextBridge.exposeInMainWorld("__soksakShell", {
  name: "electron",
  label,
  invoke: (cmd, args) => ipcRenderer.invoke("shell:invoke", { cmd, args }),
  windowOp: (op, args) => ipcRenderer.invoke("shell:window", { label, op, args }),
  onEvent: (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event)?.delete(cb);
  },
  onWindowEvent: (name, cb) => {
    if (!windowEventListeners.has(name)) windowEventListeners.set(name, new Set());
    windowEventListeners.get(name).add(cb);
    return () => windowEventListeners.get(name)?.delete(cb);
  },
  createStream: (onMessage) => {
    const id = `s${++streamSeq}`;
    streams.set(id, onMessage);
    // 백엔드에는 토큰만 건넨다 — 함수는 프로세스 경계를 못 넘는다.
    return { __shellStream: id };
  },
});
