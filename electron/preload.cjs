// Electron 프리로드 — 렌더러가 프레임워크를 만나는 유일한 창구.
//
// contextIsolation 아래서는 렌더러가 Node 를 못 본다. 그래서 프레임워크 능력은 여기서 **좁게**
// 노출한다: 계약(src/framework/contract.ts)이 요구하는 것만, 그 이상은 없다. 넓게 열면 그 순간
// 렌더러 코드가 프레임워크를 직접 알게 되고 경계가 무의미해진다.

const { contextBridge, ipcRenderer } = require("electron");

// 이 창의 라벨. 프레임워크가 창을 만들 때 주입한다(additionalArguments) — 여기서 짓지 않는다.
//
// 폴백하지 않는 이유: "main" 은 컨트롤 플레인의 예약어다. 주입이 빠진 창이 그 이름으로 살면
// 두 창이 같은 이름을 갖고, 라벨로 지목하는 창 명령이 엉뚱한 창에 닿는다. 주입 부재는 프레임워크의
// 결함이므로 여기서 즉시 드러낸다 — 조용히 이어 가면 그 결함이 창 하나만큼 늦게 보인다.
const LABEL_FLAG = "--soksak-window-label=";
const labelArg = process.argv.find((a) => a.startsWith(LABEL_FLAG));
const label = labelArg ? labelArg.slice(LABEL_FLAG.length) : "";
if (!label) {
  throw new Error(`프레임워크가 창 라벨을 주입하지 않았다 (${LABEL_FLAG}<label>) — 폴백하지 않는다`);
}

/** 전역 이벤트 구독자 — 프레임워크가 밀어 주는 브로드캐스트를 이름별로 나눈다. */
const listeners = new Map();
ipcRenderer.on("framework:event", (_e, { event, payload }) => {
  listeners.get(event)?.forEach((f) => f(payload));
});

/** 창 기하 변화 — 계약의 onResized/onMoved 가 소비한다. */
const windowEventListeners = new Map();
ipcRenderer.on("framework:window-event", (_e, msg) => {
  windowEventListeners.get(msg.name)?.forEach((f) => f(msg));
});

/** 스트림 — 백엔드가 프레임을 밀어 넣는 수신구(터미널 출력·프로세스 stdout 등). */
let streamSeq = 0;
const streams = new Map();
ipcRenderer.on("framework:stream", (_e, { id, msg }) => {
  const sink = streams.get(id);
  if (!sink) return;
  // 바이트는 base64 로 건너온다 — JSON 한 줄에 raw 바이트를 실을 수 없다. 소비자가 받는 것은
  // 앱과 **같은 모양**(ArrayBuffer)이라야 한다: 다르면 프론트에 프레임워크 분기가 생긴다.
  if (msg && typeof msg === "object" && typeof msg.b64 === "string") {
    sink(Buffer.from(msg.b64, "base64").buffer);
    return;
  }
  sink(msg);
});

contextBridge.exposeInMainWorld("__soksakFramework", {
  name: "electron",
  label,
  invoke: (cmd, args) => ipcRenderer.invoke("framework:invoke", { cmd, args }),
  // 프레임워크·Node 가 직접 답하는 능력(앱 이름/버전·임시 경로·경로 결합·디렉터리 선택).
  host: (op, args) => ipcRenderer.invoke("framework:host", { op, args }),
  windowOp: (op, args) => ipcRenderer.invoke("framework:window", { label, op, args }),
  // 라벨로 지목한 창. exact 는 "없으면 실패하라"는 뜻이다 — 발신 창으로 폴백하면
  // 엉뚱한 창을 조작하고도 성공을 돌려주게 된다.
  windowOpAt: (target, op, args) =>
    ipcRenderer.invoke("framework:window", { label: target, op, args, exact: true }),
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
    return { __frameworkStream: id };
  },
});
