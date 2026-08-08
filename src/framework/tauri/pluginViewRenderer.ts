import { emitTo, listen } from "@tauri-apps/api/event";
import { applyTheme } from "./pluginViewTheme";
import type {
  PluginViewInit,
  PluginViewNodeFrame,
  PluginViewPlacementFrame,
  PluginViewRpcRequest,
  PluginViewRpcResponse,
  PluginViewSlotFrame,
} from "./pluginViewProtocol";
import { nodeControlState } from "./pluginViewProtocol";
import { PluginViewPlacementRegistry } from "./pluginViewPlacements";
import { activatePluginInViewRenderer } from "./pluginViewActivation";
import { declarePluginRealm } from "../../plugins/realm";

const params = new URLSearchParams(location.search);
const parent = params.get("parent");
const renderer = params.get("renderer");
if (!parent || !renderer) throw new Error("plugin view renderer 주소에 parent/renderer가 없습니다");
const event = (name: string) => `soksak://plugin-view/${renderer}/${name}`;

let sequence = 0;
let layoutRevision = 0;
let activeLabel: string | null = null;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
const listeners = new Map<string, (payload: unknown) => void>();

await listen<PluginViewRpcResponse>(event("response"), ({ payload }) => {
  const waiter = pending.get(payload.id);
  if (!waiter) return;
  pending.delete(payload.id);
  if (payload.ok) waiter.resolve(payload.value);
  else waiter.reject(new Error(payload.error ?? "plugin view RPC 실패"));
});
await listen<{ subscription: string; payload: unknown }>(event("subscription"), ({ payload }) => {
  listeners.get(payload.subscription)?.(payload.payload);
});
// 배치의 소유자가 적용한 프레임. 플러그인이 살아나기 전부터 듣는다 — 표면을 만드는 거래 안에서
// 일어난 첫 적용이 그 표면의 첫 프레임이고, 그 하나를 놓치면 표면은 자기 자리를 영영 모른다.
const placements = new PluginViewPlacementRegistry();
await listen<PluginViewPlacementFrame>(event("placement"), ({ payload }) => placements.commit(payload));

function request(kind: PluginViewRpcRequest["kind"], body: Omit<PluginViewRpcRequest, "id" | "kind">): Promise<any> {
  const id = ++sequence;
  const message = { id, kind, ...body } as PluginViewRpcRequest;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  void emitTo(parent!, event("rpc"), message);
  return result;
}

const call = (path: string, ...args: unknown[]) => request("call", { path, args });
function subscribe(path: string, args: unknown[], callback: (payload: any) => void) {
  const subscription = `s${++sequence}`;
  listeners.set(subscription, callback);
  void request("subscribe", { path, args, subscription });
  return { dispose() {
    listeners.delete(subscription);
    void request("unsubscribe", { subscription });
  } };
}

function reportSlots(): void {
  const revision = ++layoutRevision;
  const reportedAtUnixMs = Date.now();
  for (const element of document.querySelectorAll<HTMLElement>("[data-content-view-body]")) {
    const label = element.getAttribute("data-content-view-body");
    if (!label) continue;
    const rect = element.getBoundingClientRect();
    const frame: PluginViewSlotFrame = {
      label,
      x: Math.round(rect.left), y: Math.round(rect.top),
      w: Math.max(1, Math.round(rect.right) - Math.round(rect.left)),
      h: Math.max(1, Math.round(rect.bottom) - Math.round(rect.top)),
      rootW: window.innerWidth,
      rootH: window.innerHeight,
      revision,
      reportedAtUnixMs,
    };
    void emitTo(parent!, event("slot"), frame);
  }
  if (activeLabel) {
    for (const element of document.querySelectorAll<HTMLElement>("[data-node]")) {
      const node = element.dataset.node;
      if (!node || node === "surface") continue;
      const rect = element.getBoundingClientRect();
      const frame: PluginViewNodeFrame = {
        label: activeLabel, node,
        // 노드는 이 문서에 산다 — 콘텐츠 표면이 아니라 여기가 주인이다. 위에서 이름 없이는
        // 시작하지 못하므로(throw) 여기서는 값이 있다.
        realm: renderer as string,
        control: nodeControlState(element),
        x: Math.round(rect.left), y: Math.round(rect.top),
        w: Math.max(1, Math.round(rect.right) - Math.round(rect.left)),
        h: Math.max(1, Math.round(rect.bottom) - Math.round(rect.top)),
        rootW: window.innerWidth,
        rootH: window.innerHeight,
        revision,
        reportedAtUnixMs,
      };
      void emitTo(parent!, event("node"), frame);
    }
  }
}

// ResizeObserver/window.resize는 비전면 WKWebView에서 지연될 수 있다. 부모의 최종 합성
// 거래는 같은 측정 함수를 사건으로 호출하며, 별도 좌표 경로나 타이머를 만들지 않는다.
await listen(event("measure"), reportSlots);

let slotResize: ResizeObserver | null = null;
function observeSlots(): void {
  slotResize?.disconnect();
  slotResize = new ResizeObserver(reportSlots);
  for (const element of document.querySelectorAll<HTMLElement>("[data-content-view-body]"))
    slotResize.observe(element);
  for (const element of document.querySelectorAll<HTMLElement>("[data-node]"))
    slotResize.observe(element);
  reportSlots();
}
new MutationObserver(observeSlots).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("resize", reportSlots);
// 사용자 입력은 layout을 바꾸지 않아 ResizeObserver가 발행하지 않는다. 공개 node 상태는
// 실제 input/change 사건에서 같은 reporter로 즉시 갱신한다(폴링 없음).
document.addEventListener("input", reportSlots, true);
document.addEventListener("change", reportSlots, true);

await listen<PluginViewInit>(event("init"), async ({ payload: init }) => {
  // 이 문서에는 앱 스타일시트가 없다 — 테마 변수를 먼저 걸어야 이 안에서 그리는 것이 값을
  // 얻는다. 그리기 전에 건다: 뒤에 걸면 첫 프레임이 값 없는 색으로 나간다.
  applyTheme(document, init.theme);
  activeLabel = init.label;
  const subscriptions: { dispose(): void }[] = [];
  // 활성 실패가 준비의 부재인지 아닌지는 이 수가 정한다 — 등록을 마친 뒤 죽은 플러그인의
  // 뷰는 이미 오고 있다. 부모가 이 사실 없이 실패만 보면 살아 있는 뷰를 거절한다.
  let registeredViews = 0;
  let visible = init.context.visible;
  const context = {
    ...init.context,
    isVisible: () => visible,
    onVisibilityChange: (cb: (value: boolean) => void) => subscribe("context.onVisibilityChange", [], cb),
    setBadge: (value: unknown) => void call("context.setBadge", value),
    setStatus: (value: unknown) => void call("context.setStatus", value),
    setTitle: (value: string) => void call("context.setTitle", value),
    setIcon: (value: string) => void call("context.setIcon", value),
    setRestoreState: (value: unknown) => void call("context.setRestoreState", value),
  };
  const noViewRegistration = () => ({ dispose() {} });
  const app: Record<string, any> = {
    pluginId: init.pluginId,
    windowLabel: () => init.windowLabel,
    locale: () => init.locale,
    settings: {
      get: (key: string) => init.settings[key],
      all: () => ({ ...init.settings }),
      onChange: (cb: (value: unknown) => void) => subscribe("settings.onChange", [], cb),
    },
    project: { current: () => init.project },
    commands: {
      execute: (name: string, args?: unknown) => call("commands.execute", name, args),
    },
    events: { on: (name: string, cb: (value: unknown) => void) => subscribe("events.on", [name], cb) },
    bus: {
      emit: (name: string, value: unknown) => void call("bus.emit", name, value),
      on: (name: string, cb: (value: unknown) => void) => subscribe("bus.on", [name], cb),
    },
    ui: {
      registerView(_id: string, provider: any) {
        registeredViews += 1;
        provider.mount(document.getElementById("root")!, context);
        subscriptions.push({ dispose: () => provider.unmount?.(document.getElementById("root")!) });
        queueMicrotask(observeSlots);
        return subscriptions[subscriptions.length - 1]!;
      },
      registerFileViewer: noViewRegistration,
    },
    data: { kv: {
      get: (key: string) => call("data.kv.get", key),
      set: (key: string, value: unknown) => call("data.kv.set", key, value),
      delete: (key: string) => call("data.kv.delete", key),
      keys: (prefix?: string) => call("data.kv.keys", prefix),
      watch: (cb: (value: unknown) => void) => subscribe("data.kv.watch", [], cb),
    } },
  };
  if (init.sidecarAvailable) {
    app.sidecar = {
      open: async (name: string) => {
        const handle = await call("sidecar.open", name) as string;
        return {
          send: (message: Record<string, unknown>) => call("sidecar.send", handle, message),
          on: (eventName: string, cb: (value: unknown) => void) =>
            subscribe("sidecar.on", [handle, eventName], cb),
          close: () => call("sidecar.close", handle),
        };
      },
    };
  }
  if (init.webviewCapabilities && init.label) {
    const asyncMethod = (name: string) => (...args: unknown[]) => call(`webview.${name}`, ...args);
    app.webview = {
      capabilities: init.webviewCapabilities,
      label: (_viewId: string) => init.label,
      present: asyncMethod("present"),
      open: asyncMethod("open"), navigate: asyncMethod("navigate"), zoom: asyncMethod("zoom"),
      openWindow: asyncMethod("openWindow"), history: asyncMethod("history"), stop: asyncMethod("stop"),
      devtools: asyncMethod("devtools"), eval: asyncMethod("eval"), sendInput: asyncMethod("sendInput"),
      wheel: asyncMethod("wheel"), captureFull: asyncMethod("captureFull"), typeText: asyncMethod("typeText"),
      list: asyncMethod("list"), close: asyncMethod("close"),
      on: (label: string, name: string, cb: (value: unknown) => void) =>
        subscribe("webview.on", [label, name], cb),
      // 이 표면에 호스트가 실제로 적용한 프레임. RPC 가 아니라 이 realm 이 이미 받아 둔 사실이라
      // 구독 왕복이 없다 — 늦게 구독해도 마지막 적용을 먼저 받는다.
      onPlacement: (label: string, cb: (frame: PluginViewPlacementFrame) => void) =>
        placements.subscribe(label, cb),
    };
  }
  // 이 realm 의 표면은 창 realm 과 같지 않다(등록부는 창이 소유하고 여기는 실행만 소비한다).
  // 그 차이를 플러그인이 typeof 로 더듬게 두지 않는다 — 다 지은 객체에서 파생해 선언한다.
  declarePluginRealm("view-renderer", app);
  const moduleUrl = URL.createObjectURL(new Blob([init.source], { type: "text/javascript" }));
  try {
    // 활성 실패는 이 renderer 안에서 끝나면 안 된다 — 부모는 이 뷰를 기다리고 있고, 침묵은
    // 이유 없는 mounted:false 와 한참 뒤 엉뚱한 명령의 오류로만 드러난다.
    await activatePluginInViewRenderer({
      pluginId: init.pluginId,
      load: () => import(/* @vite-ignore */ moduleUrl),
      context: { app, manifest: {}, dir: "", subscriptions },
      report: (failure) => void emitTo(parent!, event("failure"), {
        ...failure,
        registeredViews,
        realm: app.realm.id,
      }),
    });
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  await listen<{ visible: boolean }>(event("visibility"), ({ payload }) => {
    visible = payload.visible;
  });
  await listen(event("shutdown"), () => {
    for (const subscription of subscriptions.splice(0).reverse()) subscription.dispose();
    document.getElementById("root")?.replaceChildren();
  });
});

await emitTo(parent, event("ready"), { renderer });
