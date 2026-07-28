// Electron 셸 어댑터 — AppFramework 계약의 Electron 구현(스파이크).
//
// Tauri 어댑터와 형제다. 앱 코드는 어느 쪽이 밑에 있는지 모르며, 이 파일이 늘어나도
// 앱 코드는 한 줄도 바뀌지 않는다 — 그것이 경계가 있는 이유다.
//
// 벤더 SDK 를 직접 import 하지 않는다: contextIsolation 아래서 렌더러는 Node 를 못 보고,
// 셸 능력은 프리로드(electron/preload.cjs)가 좁게 노출한 창구 하나로만 온다.
//
// 미구현은 **이름을 달고 실패한다**. 조용히 no-op 을 돌려주면 "돌아간다"는 착시가 생기고
// 그 착시가 이식 판단을 망친다(스파이크의 목적은 정확히 그 판단이다).

import type {
  ShellEvent,
  AppFramework,
  ShellWindowHandle,
  Stream,
  Unlisten,
} from "./host";

/** 창구가 돌려주는 봉투 — 실패는 값이 아니라 코드로 온다. */
interface OpResult {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

interface ShellBridge {
  name: string;
  label: string;
  invoke(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<OpResult & { command?: string }>;
  /** 셸·Node 가 직접 답하는 능력(app/path/dialog) — 백엔드를 거치지 않는다. */
  host(op: string, args?: Record<string, unknown>): Promise<OpResult>;
  windowOp(op: string, args?: Record<string, unknown>): Promise<OpResult>;
  /** 라벨로 지목한 창의 조작 — 그 창이 없으면 실패한다(발신 창으로 폴백하지 않는다). */
  windowOpAt(label: string, op: string, args?: Record<string, unknown>): Promise<OpResult>;
  onEvent(event: string, cb: (payload: unknown) => void): Unlisten;
  onWindowEvent(name: string, cb: (msg: unknown) => void): Unlisten;
  createStream(onMessage: (msg: unknown) => void): { __shellStream: string };
}

function bridge(): ShellBridge {
  const b = (globalThis as { __soksakShell?: ShellBridge }).__soksakShell;
  if (!b) {
    throw new Error(
      "Electron 셸 창구가 없다 — preload 가 붙지 않았다(electron/preload.cjs)",
    );
  }
  return b;
}

function unimplemented(what: string): never {
  throw new Error(`Electron 어댑터 미구현: ${what}`);
}

function unwrap<T>(r: OpResult, what: string): T {
  if (!r.ok) throw new Error(`${r.code ?? "ERROR"}: ${r.message ?? what}`);
  return r.value as T;
}

async function hostOp<T>(op: string, args?: Record<string, unknown>): Promise<T> {
  return unwrap<T>(await bridge().host(op, args), op);
}

/** target 이 null 이면 현재 창, 아니면 라벨로 지목한 창. */
async function windowOp<T>(
  target: string | null,
  op: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const b = bridge();
  const r = target === null ? await b.windowOp(op, args) : await b.windowOpAt(target, op, args);
  return unwrap<T>(r, op);
}

/** 창 조작면에서 셸이 창을 직접 만져 답하는 부분 — 현재 창이든 지목한 창이든 같다. */
function windowOps(
  label: string,
  target: string | null,
): Omit<ShellWindowHandle, "onResized" | "onMoved" | "onDragDrop" | "listen"> {
  return {
    label,
    setTitle: (title) => windowOp(target, "setTitle", { title }),
    setSize: (width, height) => windowOp(target, "setSize", { width, height }),
    setPosition: (x, y) => windowOp(target, "setPosition", { x, y }),
    setFocus: () => windowOp(target, "setFocus"),
    setTheme: (mode) => windowOp(target, "setTheme", { mode }),
    setAlwaysOnTop: (on) => windowOp(target, "setAlwaysOnTop", { on }),
    maximize: () => windowOp(target, "maximize"),
    unmaximize: () => windowOp(target, "unmaximize"),
    outerPosition: () => windowOp(target, "outerPosition"),
    innerPosition: () => windowOp(target, "innerPosition"),
    outerSize: () => windowOp(target, "outerSize"),
    scaleFactor: () => windowOp(target, "scaleFactor"),
    setPhysicalPosition: (x, y) => windowOp(target, "setPhysicalPosition", { x, y }),
    setPhysicalSize: (width, height) => windowOp(target, "setPhysicalSize", { width, height }),
  };
}

function currentWindowHandle(): ShellWindowHandle {
  return {
    ...windowOps(bridge().label, null),
    onResized: async (cb) =>
      bridge().onWindowEvent("resized", (m) => {
        const b = (m as { bounds: { width: number; height: number } }).bounds;
        cb({ width: b.width, height: b.height });
      }),
    onMoved: async (cb) =>
      bridge().onWindowEvent("moved", (m) => {
        const b = (m as { bounds: { x: number; y: number } }).bounds;
        cb({ x: b.x, y: b.y });
      }),
    // 네이티브 파일 드래그드롭은 셸 층 작업이 남아 있다 — 조용히 no-op 하지 않는다.
    onDragDrop: async () => unimplemented("창 드래그드롭(onDragDrop)"),
    listen: async <T,>(event: string, cb: (e: ShellEvent<T>) => void) =>
      bridge().onEvent(event, (payload) => cb({ payload: payload as T })),
  };
}

/** 다른 창의 핸들 — 조작은 셸이 대신 하고, 구독은 이 렌더러에 오지 않는다. */
function labeledWindowHandle(label: string): ShellWindowHandle {
  return {
    ...windowOps(label, label),
    // 셸은 창 기하 변화·타겟 이벤트를 각 창의 웹콘텐츠로만 민다. 다른 창 몫은 이 렌더러에
    // 도착하지 않으므로, 구독을 받아 두고 영영 안 부르는 것은 조용한 no-op 이다.
    onResized: async () => unimplemented("다른 창의 크기 변화 구독(onResized)"),
    onMoved: async () => unimplemented("다른 창의 이동 구독(onMoved)"),
    onDragDrop: async () => unimplemented("다른 창의 드래그드롭 구독(onDragDrop)"),
    listen: async () => unimplemented("다른 창의 타겟 이벤트 구독(listen)"),
  };
}

export const electronHost: AppFramework = {
  name: "electron",

  invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const r = await bridge().invoke(cmd, args);
    if (!r.ok) {
      const e = new Error(r.message ?? `명령 실패: ${cmd}`);
      (e as { code?: string }).code = r.code;
      throw e;
    }
    return r.value as T;
  },

  createStream: <T,>(): Stream<T> => {
    let sink: (msg: T) => void = () => {};
    const token = bridge().createStream((m) => sink(m as T));
    // 계약상 앱은 onmessage 만 안다. 백엔드로는 토큰이 직렬화돼 건너간다.
    return Object.assign(token, {
      set onmessage(fn: (msg: T) => void) {
        sink = fn;
      },
      get onmessage() {
        return sink;
      },
    }) as unknown as Stream<T>;
  },

  listen: async <T,>(event: string, cb: (e: ShellEvent<T>) => void) =>
    bridge().onEvent(event, (payload) => cb({ payload: payload as T })),

  currentWindow: () => currentWindowHandle(),

  windowByLabel: async (label) => {
    // 자기 자신이면 현재 창 핸들 그대로 — 구독까지 온전한 쪽을 준다.
    if (label === bridge().label) return currentWindowHandle();
    // 창 레지스트리는 셸이 갖는다. 없는 라벨은 null 이며, 그 뒤 조작이 다른 창으로
    // 새지 않도록 지목 경로는 셸에서 폴백을 끈다.
    return (await windowOp<boolean>(label, "exists")) ? labeledWindowHandle(label) : null;
  },

  app: {
    name: () => hostOp("appName"),
    version: () => hostOp("appVersion"),
  },
  path: {
    // 경로 계산은 Node 의 것이다 — 렌더러는 Node 를 못 보므로 셸이 대신 답한다.
    tempDir: () => hostOp("tempDir"),
    join: (...parts) => hostOp("join", { parts }),
  },
  dialog: {
    openDirectory: (options) => hostOp("openDirectory", { ...options }),
  },
  notification: {
    isPermissionGranted: async () => unimplemented("notification.isPermissionGranted"),
    requestPermission: async () => unimplemented("notification.requestPermission"),
    send: () => unimplemented("notification.send"),
    onAction: async () => unimplemented("notification.onAction"),
  },
  deepLink: {
    onOpenUrl: async () => unimplemented("deepLink.onOpenUrl"),
    current: async () => unimplemented("deepLink.current"),
  },
};
