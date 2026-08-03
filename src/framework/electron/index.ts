// 드래그 영역을 주는 쪽이 그 되돌림(no-drag)도 진다 — 앱 CSS 에 두면 종속이 샌다.
import { moduleState } from "../../lib/moduleState";
import type { EngineProvision } from "@soksak-ai/plugin-spec";
// Electron 프레임워크 어댑터 — AppFramework 계약의 Electron 구현(스파이크).
//
// Tauri 어댑터와 형제다. 앱 코드는 어느 쪽이 밑에 있는지 모르며, 이 파일이 늘어나도
// 앱 코드는 한 줄도 바뀌지 않는다 — 그것이 경계가 있는 이유다.
//
// 벤더 SDK 를 직접 import 하지 않는다: contextIsolation 아래서 렌더러는 Node 를 못 보고,
// 프레임워크 능력은 프리로드(electron/preload.cjs)가 좁게 노출한 창구 하나로만 온다.
//
// 미구현은 **이름을 달고 실패한다**. 조용히 no-op 을 돌려주면 "돌아간다"는 착시가 생기고
// 그 착시가 이식 판단을 망친다(스파이크의 목적은 정확히 그 판단이다).

import type {
  FrameworkEvent,
  AppFramework,
  FrameworkWindowHandle,
  Stream,
  Unlisten,
} from "../contract";

/** 창구가 돌려주는 봉투 — 실패는 값이 아니라 코드로 온다. */
interface OpResult {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

interface FrameworkBridge {
  name: string;
  label: string;
  invoke(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<OpResult & { command?: string }>;
  /** 프레임워크·Node 가 직접 답하는 능력(app/path/dialog) — 백엔드를 거치지 않는다. */
  host(op: string, args?: Record<string, unknown>): Promise<OpResult>;
  windowOp(op: string, args?: Record<string, unknown>): Promise<OpResult>;
  /** 라벨로 지목한 창의 조작 — 그 창이 없으면 실패한다(발신 창으로 폴백하지 않는다). */
  windowOpAt(label: string, op: string, args?: Record<string, unknown>): Promise<OpResult>;
  onEvent(event: string, cb: (payload: unknown) => void): Unlisten;
  onWindowEvent(name: string, cb: (msg: unknown) => void): Unlisten;
  createStream(onMessage: (msg: unknown) => void): { __frameworkStream: string };
}

function bridge(): FrameworkBridge {
  const b = (globalThis as { __soksakFramework?: FrameworkBridge }).__soksakFramework;
  if (!b) {
    throw new Error(
      "Electron 프레임워크 창구가 없다 — preload 가 붙지 않았다(electron/preload.cjs)",
    );
  }
  return b;
}

/**
 * 창으로 떨어진 파일 — Tauri 는 네이티브 창 이벤트로 받지만 이 프레임워크는 그럴 필요가 없다.
 * 파일 드롭이 DOM 으로 그대로 오고, 항목이 경로를 갖는다.
 *
 * 페이로드 모양은 앱의 것 그대로다({ payload: { type, paths } }) — 번역하면 소비자가
 * 프레임워크마다 다른 것을 보고, 그 차이는 오류가 아니라 "이쪽에서는 드롭이 안 됨"이 된다.
 *
 * 기본 동작을 막는 것이 필수다. 안 막으면 브라우저가 그 파일을 창에 **열어 버려** 앱이
 * 사라진다. dragover 를 막아야 drop 이 아예 발생한다는 것도 같은 이유로 함께 건다.
 */
function attachDragDrop(cb: (event: unknown) => void): () => void {
  const allow = (e: Event) => e.preventDefault();
  const onDrop = (e: Event) => {
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    const paths = [...(dt?.files ?? [])]
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    // 경로 없는 드롭(텍스트·이미지 등)은 보내지 않는다 — 빈 배열은 소비자에게 뜻이 없고,
    // 보내면 "드롭했는데 아무 일도 안 일어남"이 정상 경로처럼 흐른다.
    if (paths.length === 0) return;
    cb({ payload: { type: "drop", paths } });
  };
  document.addEventListener("dragover", allow);
  document.addEventListener("drop", onDrop);
  return () => {
    document.removeEventListener("dragover", allow);
    document.removeEventListener("drop", onDrop);
  };
}

/**
 * 지역 사건 버스 — 이 창 안에서 난 일을 이 창의 구독자에게 배달한다.
 *
 * 프레임워크가 미는 사건(preload 창구)과 **같은 이름 공간**을 쓴다. 구독자는 어느 쪽에서
 * 왔는지 모르고, 알 필요도 없다 — 그것이 계약이다.
 */
// 갈아끼우기 경계 밖 — 이 표가 새것이 되면 채운 쪽은 이미 채웠다고 알아 다시 채우지 않는다.
const localBus = moduleState("framework/electron#localBus", () => new Map<string, Set<(payload: unknown) => void>>());
function onLocal(event: string, cb: (payload: unknown) => void): () => void {
  let set = localBus.get(event);
  if (!set) localBus.set(event, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) localBus.delete(event);
  };
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

/** 창 조작면에서 프레임워크가 창을 직접 만져 답하는 부분 — 현재 창이든 지목한 창이든 같다. */
function windowOps(
  label: string,
  target: string | null,
): Omit<FrameworkWindowHandle, "onResized" | "onMoved" | "onDragDrop" | "listen"> {
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

function currentWindowHandle(): FrameworkWindowHandle {
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
    // 네이티브 파일 드래그드롭은 프레임워크 층 작업이 남아 있다 — 조용히 no-op 하지 않는다.
    onDragDrop: async (cb) => attachDragDrop(cb),
    listen: async <T,>(event: string, cb: (e: FrameworkEvent<T>) => void) => {
      // 두 출처를 한 구독으로 받는다 — 프레임워크가 미는 것과 이 창이 뿌리는 것. 나뉘면
      // 호출자가 어느 쪽인지 알아야 하고, 아는 순간 경계가 샌다.
      const offBridge = bridge().onEvent(event, (payload) => cb({ payload: payload as T }));
      const offLocal = onLocal(event, (payload) => cb({ payload: payload as T }));
      return () => {
        offBridge();
        offLocal();
      };
    },
  };
}

/** 다른 창의 핸들 — 조작은 프레임워크가 대신 하고, 구독은 이 렌더러에 오지 않는다. */
function labeledWindowHandle(label: string): FrameworkWindowHandle {
  return {
    ...windowOps(label, label),
    // 프레임워크는 창 기하 변화·타겟 이벤트를 각 창의 웹콘텐츠로만 민다. 다른 창 몫은 이 렌더러에
    // 도착하지 않으므로, 구독을 받아 두고 영영 안 부르는 것은 조용한 no-op 이다.
    onResized: async () => unimplemented("다른 창의 크기 변화 구독(onResized)"),
    onMoved: async () => unimplemented("다른 창의 이동 구독(onMoved)"),
    onDragDrop: async () => unimplemented("다른 창의 드래그드롭 구독(onDragDrop)"),
    listen: async () => unimplemented("다른 창의 타겟 이벤트 구독(listen)"),
  };
}

/**
 * 이 프레임워크가 제공하는 것.
 *
 * Electron 은 통째로 Chromium 이라 등급 요구가 전부 no-op 이다 — 승격할 것이 없다.
 * 자식 웹뷰 합성 장치는 **없다**. 못 하는 것이 아니라 필요가 없다: 단일 Chromium 세계에서
 * UI 뷰와 콘텐츠 뷰를 같은 컴포지터가 합성한다(WebContentsView). 그래서 그 장치를 전제한
 * 표면만 여기서 빠지고, 등급만 필요한 표면은 오히려 사이드카 없이 그냥 선다.
 */
/**
 * Electron 은 CSS 로 본다 — `-webkit-app-region: drag` 인 영역을 끌면 창이 움직인다.
 *
 * 자식에 버튼이 있으면 그 버튼도 드래그 영역이 되어 클릭이 안 먹는다. 그래서 클릭 가능한
 * 자식은 `no-drag` 로 되돌려야 하고, 그 규칙은 CSS 가 소유한다(App.css).
 */
export const dragRegion: Record<string, unknown> = {
  style: { WebkitAppRegion: "drag" } as React.CSSProperties,
};

export const engineProvision: EngineProvision = {
  chromium: true,
  nativeChildWebview: false,
  // 엔진 모듈을 적재하지 못한다 — 이 프레임워크의 메인 프로세스는 JS 이고 dlopen 이 없다
  // (네이티브 애드온을 붙이면 달라지는 값이라, 못 하는 것이 아니라 **아직 안 붙인** 것이다).
  // 자식 뷰 축과 뭉치지 않는다: offscreen 은 자식 뷰를 안 쓰고도 이 축이 필요하다.
  engineModules: false,
  supportsDocumentStart: false,
  supportsInputInjection: true,
};

export const electronFramework: AppFramework = {
  emitLocal: (event, payload) => {
    for (const cb of localBus.get(event) ?? []) cb(payload);
  },
  dragRegion,
  engineProvision,
  name: "electron",
  // 거는 코드는 그때 가져온다 — 이 파일은 창구를 번역하는 잎으로 남는다(contract.install).
  install: () => import("./install").then((m) => m.installElectron()),

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
    // 계약상 앱은 onmessage 만 안다. 백엔드로는 이 객체가 **그대로 직렬화돼** 건너간다.
    //
    // 그래서 onmessage 는 **열거되지 않아야 한다.** 구조화 복제는 열거 가능한 자기 속성만
    // 읽는데, 접근자를 열거 가능하게 두면 그 getter 가 함수를 돌려주고 함수는 복제되지 않는다
    // — invoke 가 경계에서 "An object could not be cloned" 로 죽는다(실측: 그래서
    // spawn_terminal 이 한 번도 서버에 닿지 못했고, 증상은 "터미널이 안 뜬다"였다).
    Object.defineProperty(token, "onmessage", {
      enumerable: false,
      configurable: true,
      get: () => sink,
      set: (fn: (msg: T) => void) => {
        sink = fn;
      },
    });
    return token as unknown as Stream<T>;
  },

  // 창-스코프 구독과 **같은 법**이다: 두 출처를 한 구독으로 받는다. 프레임워크가 미는 것과
  // 이 창이 뿌리는 것(emitLocal). 전역만 로컬 버스를 빼면, 이 창 안에서 나는 사실을 전역으로
  // 구독하는 쪽이 영영 안 불린다 — 그 침묵은 오류가 아니라 "페이지는 렌더됐는데 주소창이
  // about:blank 에 멈춘다"로 나타난다(실측 2026-07-28: 플러그인이 browser-nav 를 못 받았다).
  listen: async <T,>(event: string, cb: (e: FrameworkEvent<T>) => void) => {
    const offBridge = bridge().onEvent(event, (payload) => cb({ payload: payload as T }));
    const offLocal = onLocal(event, (payload) => cb({ payload: payload as T }));
    return () => {
      offBridge();
      offLocal();
    };
  },

  currentWindow: () => currentWindowHandle(),

  windowByLabel: async (label) => {
    // 자기 자신이면 현재 창 핸들 그대로 — 구독까지 온전한 쪽을 준다.
    if (label === bridge().label) return currentWindowHandle();
    // 창 레지스트리는 프레임워크가 갖는다. 없는 라벨은 null 이며, 그 뒤 조작이 다른 창으로
    // 새지 않도록 지목 경로는 프레임워크에서 폴백을 끈다.
    return (await windowOp<boolean>(label, "exists")) ? labeledWindowHandle(label) : null;
  },

  app: {
    name: () => hostOp("appName"),
    version: () => hostOp("appVersion"),
  },
  path: {
    // 경로 계산은 Node 의 것이다 — 렌더러는 Node 를 못 보므로 프레임워크가 대신 답한다.
    tempDir: () => hostOp("tempDir"),
    join: (...parts) => hostOp("join", { parts }),
  },
  dialog: {
    openDirectory: (options) => hostOp("openDirectory", { ...options }),
  },
  notification: {
    // 이 프레임워크는 **권한을 따로 묻지 않는다** — OS 가 앱 단위로 정하고 앱은 그것을 물을 수
    // 있을 뿐이다. 지원 여부(`notify_show` 가 아는 사실)를 그대로 답한다: 지원하면 띄울 수 있고,
    // 아니면 이름을 달고 거절한다. "권한 없음"을 지어내지 않는다 — 없는 절차를 있는 척하면
    // 부른 쪽이 그 위에 흐름을 세운다.
    isPermissionGranted: async () =>
      unwrap<boolean>(await bridge().invoke("notify_supported"), "notify_supported"),
    // 물을 절차가 없으므로 **지금 사실**을 그대로 돌린다. 조용히 true 를 답하지 않는다.
    requestPermission: async () =>
      (unwrap<boolean>(await bridge().invoke("notify_supported"), "notify_supported")
        ? "granted"
        : "denied") as NotificationPermission,
    // 띄우기는 이미 프레임워크가 답하는 이름이다(notify_show). 여기서 다시 짓지 않는다 —
    // 두 자리가 같은 일을 하면 한쪽만 고쳐진다.
    send: (options) => {
      void bridge().invoke("notify_show", { ...options });
    },
    // **클릭은 이 창으로 오지 않는다.** 알림이 실어 온 딥링크를 프레임워크가 명령 표면의
    // 주인에게 그대로 넘긴다(딥링크와 같은 길) — 창에 넘기면 그 창이 닫혔을 때 클릭이 유실되고,
    // 형식이 프레임워크마다 한 벌이 된다.
    //
    // 계약을 지우지 않고 **없다고 말한다**: 조용히 성공하면 부른 쪽이 오지 않을 사건을 기다린다.
    onAction: async () => unimplemented("notification.onAction — 클릭은 주인이 받는다"),
  },
  deepLink: {
    // **딥링크는 이 창으로 오지 않는다.** 밖에서 온 명령이므로 명령 표면의 주인(cored)이 받고
    // 형식도 거기서 읽는다(soksak-core deeplink.rs) — 창에 넘기면 창 없는 곳에 영영 못 닿고,
    // 형식이 프레임워크마다 한 벌이 된다(실측 2026-08-01: 실제로 두 벌이었고 갈려 있었다).
    //
    // 계약을 지우지 않고 **없다고 말한다**: 조용히 성공하면 부른 쪽이 오지 않을 사건을 기다린다.
    onOpenUrl: async () => unimplemented("deepLink.onOpenUrl — 딥링크는 주인이 받는다"),
    current: async () => unimplemented("deepLink.current — 딥링크는 주인이 받는다"),
  },
};
