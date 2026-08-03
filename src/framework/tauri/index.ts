import type { EngineProvision } from "@soksak-ai/plugin-spec";
// Tauri 프레임워크 어댑터 — AppFramework 계약의 Tauri 구현.
//
// **벤더 SDK(@tauri-apps/*)를 import 하는 것은 이 파일뿐이다.** 다른 어떤 앱 코드도 프레임워크를
// 알아서는 안 되며, 그 규칙은 frameworkSeam.test.ts 가 정적으로 시행한다. 새 프레임워크(Electron 등)는
// 이 파일과 형제로 어댑터를 하나 더 두는 것으로 끝나야 한다 — 앱 코드는 한 줄도 바뀌지 않는다.
//
// 어댑터는 계약을 "번역"만 한다. 정책·재시도·상태를 여기 두지 않는다(그건 앱의 것이고,
// 프레임워크마다 달라지면 그 자체가 프레임워크 종속이다). 유일한 예외는 프레임워크 SDK 의 결함 흡수이며,
// 흡수할 때는 그 결함을 주석으로 남긴다.

import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
  Window,
} from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getName, getVersion } from "@tauri-apps/api/app";
import type {
  FrameworkEvent,
  AppFramework,
  FrameworkWindowHandle,
  Stream,
  Unlisten,
} from "../contract";

/** Tauri 의 UnlistenFn 은 내부적으로 async — 이미 해제된 리스너의 재해지가 동기 throw 가
 *  아니라 반환 promise 의 reject 로 온다. 계약은 "해지는 멱등"이므로 여기서 흡수한다. */
function safeOff(off: unknown): Unlisten {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      const r = (off as () => unknown)?.();
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        void (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* 이미 해제됨 — 재해지는 no-op */
    }
  };
}

function wrapWindow(win: Window, label: string): FrameworkWindowHandle {
  return {
    label,
    setTitle: (t) => win.setTitle(t),
    setSize: (w, h) => win.setSize(new LogicalSize(w, h)),
    setPosition: (x, y) => win.setPosition(new LogicalPosition(x, y)),
    setFocus: () => win.setFocus(),
    setTheme: (mode) => win.setTheme(mode),
    outerPosition: async () => {
      const p = await win.outerPosition();
      return { x: p.x, y: p.y };
    },
    innerPosition: async () => {
      const p = await win.innerPosition();
      return { x: p.x, y: p.y };
    },
    outerSize: async () => {
      const s = await win.outerSize();
      return { width: s.width, height: s.height };
    },
    scaleFactor: () => win.scaleFactor(),
    setPhysicalPosition: (x, y) => win.setPosition(new PhysicalPosition(x, y)),
    setPhysicalSize: (w, h) => win.setSize(new PhysicalSize(w, h)),
    setAlwaysOnTop: (on) => win.setAlwaysOnTop(on),
    maximize: () => win.maximize(),
    unmaximize: () => win.unmaximize(),
    onResized: async (cb) =>
      safeOff(await win.onResized(({ payload }) => cb({ width: payload.width, height: payload.height }))),
    onMoved: async (cb) => safeOff(await win.onMoved(({ payload }) => cb({ x: payload.x, y: payload.y }))),
    onDragDrop: async (cb) => safeOff(await win.onDragDropEvent((e) => cb(e))),
    listen: async <T,>(event: string, cb: (e: FrameworkEvent<T>) => void) => {
      // 창 타겟 신호는 webviewWindow.listen 만이 격리한다 — 전역 listen 은 emit_to(다른 창)
      // 까지 받아 명령이 두 창에서 중복 실행된다(창별 독립 붕괴).
      const target = label === getCurrentWindow().label ? getCurrentWebviewWindow() : win;
      return safeOff(await target.listen<T>(event, (e) => cb({ payload: e.payload })));
    },
  };
}

/**
 * 이 프레임워크가 제공하는 것 — 플러그인의 요구(requiresEngine 등)를 채우는 쪽의 사실.
 *
 * WKWebView 는 chromium 등급이 아니다. 대신 자식 웹뷰를 창에 합성해 얹는 장치가 있어
 * (hole-punch·hitTest 스위즐, webview.rs) 등급이 필요한 표면은 그 장치 위에서 Chromium
 * 사이드카로 승격된다.
 *
 * macOS 기준이다. 같은 Tauri 라도 Windows 는 WebView2 가 곧 Chromium 이라 chromium: true 이며
 * 승격이 no-op 이다(R4). 그 갈래는 OS 를 알게 되는 자리라 이 값을 실행 중에 정하도록 바꿀 때
 * 함께 들어온다 — 지금은 이 저장소가 실제로 검증하는 조합만 적는다.
 */
/** Tauri 는 웹뷰가 이 속성을 가로채 창 드래그를 시작한다. */
export const dragRegion: Record<string, unknown> = { "data-tauri-drag-region": true };

export const engineProvision: EngineProvision = {
  chromium: false,
  nativeChildWebview: true,
  // 엔진 모듈을 이 프로세스에 적재한다 — 백엔드가 Rust 라 dlopen 이 있고, 메인스레드와 창도
  // 이 프로세스의 것이다. 그래서 두 합성 모드(SIDECARS.md §8) 가 다 여기서 선다.
  engineModules: true,
  supportsDocumentStart: true,
  supportsInputInjection: false,
};

export const tauriFramework: AppFramework = {
  // Tauri 는 자기 통로가 있다 — 현재 창으로 보내면 그 창의 listen 이 받는다.
  emitLocal: (event, payload) => {
    void getCurrentWebviewWindow().emit(event, payload);
  },
  dragRegion,
  engineProvision,
  name: "tauri",
  // 거는 코드는 그때 가져온다 — 이 파일은 벤더를 번역하는 잎으로 남는다(contract.install).
  install: () => import("./install").then((m) => m.installTauri()),

  invoke: <T,>(cmd: string, args?: Record<string, unknown>) => tauriInvoke<T>(cmd, args),

  createStream: <T,>(): Stream<T> => new Channel<T>() as unknown as Stream<T>,

  listen: async <T,>(event: string, cb: (e: FrameworkEvent<T>) => void) =>
    safeOff(await tauriListen<T>(event, (e) => cb({ payload: e.payload }))),

  currentWindow: () => {
    const win = getCurrentWindow();
    return wrapWindow(win, win.label);
  },

  windowByLabel: async (label) => {
    const win = await Window.getByLabel(label);
    return win ? wrapWindow(win, label) : null;
  },

  app: { name: () => getName(), version: () => getVersion() },

  path: {
    tempDir: async () => (await import("@tauri-apps/api/path")).tempDir(),
    join: async (...parts) => (await import("@tauri-apps/api/path")).join(...parts),
  },

  dialog: {
    openDirectory: async (options) => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, ...options });
      return typeof picked === "string" ? picked : null;
    },
  },

  notification: {
    isPermissionGranted: async () =>
      (await import("@tauri-apps/plugin-notification")).isPermissionGranted(),
    requestPermission: async () =>
      (await import("@tauri-apps/plugin-notification")).requestPermission(),
    send: (options) => {
      void import("@tauri-apps/plugin-notification").then((m) => m.sendNotification(options));
    },
    onAction: async (cb) => {
      const m = await import("@tauri-apps/plugin-notification");
      return safeOff(
        await m.onAction((a) => cb({ extra: (a as { extra?: Record<string, unknown> }).extra })),
      );
    },
  },

  deepLink: {
    onOpenUrl: async (cb) => {
      const m = await import("@tauri-apps/plugin-deep-link");
      return safeOff(await m.onOpenUrl(cb));
    },
    current: async () => (await import("@tauri-apps/plugin-deep-link")).getCurrent(),
  },
};
