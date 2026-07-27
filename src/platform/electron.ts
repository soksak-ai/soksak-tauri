// Electron 셸 어댑터 — ShellHost 계약의 Electron 구현(스파이크).
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
  ShellHost,
  ShellWindowHandle,
  Stream,
  Unlisten,
} from "./host";

interface ShellBridge {
  name: string;
  label: string;
  invoke(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string; command?: string }>;
  windowOp(
    op: string,
    args?: Record<string, unknown>,
  ): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;
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

async function windowOp<T>(op: string, args?: Record<string, unknown>): Promise<T> {
  const r = await bridge().windowOp(op, args);
  if (!r.ok) throw new Error(`${r.code ?? "ERROR"}: ${r.message ?? op}`);
  return r.value as T;
}

function currentWindowHandle(): ShellWindowHandle {
  return {
    label: bridge().label,
    setTitle: (title) => windowOp("setTitle", { title }),
    setSize: (width, height) => windowOp("setSize", { width, height }),
    setPosition: (x, y) => windowOp("setPosition", { x, y }),
    setFocus: () => windowOp("setFocus"),
    setTheme: (mode) => windowOp("setTheme", { mode }),
    setAlwaysOnTop: (on) => windowOp("setAlwaysOnTop", { on }),
    maximize: () => windowOp("maximize"),
    unmaximize: () => windowOp("unmaximize"),
    outerPosition: () => windowOp("outerPosition"),
    innerPosition: () => windowOp("innerPosition"),
    outerSize: () => windowOp("outerSize"),
    scaleFactor: () => windowOp("scaleFactor"),
    setPhysicalPosition: (x, y) => windowOp("setPhysicalPosition", { x, y }),
    setPhysicalSize: (width, height) => windowOp("setPhysicalSize", { width, height }),
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

export const electronHost: ShellHost = {
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

  // 다른 창을 라벨로 잡는 것은 셸 층 작업이 남아 있다(창 레지스트리 노출).
  windowByLabel: async () => unimplemented("라벨로 창 찾기(windowByLabel)"),

  app: {
    name: async () => unimplemented("app.name"),
    version: async () => unimplemented("app.version"),
  },
  path: {
    tempDir: async () => unimplemented("path.tempDir"),
    join: async () => unimplemented("path.join"),
  },
  dialog: {
    openDirectory: async () => unimplemented("dialog.openDirectory"),
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
