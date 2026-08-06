import { emitTo, listen } from "@tauri-apps/api/event";
import type {
  PluginViewInit,
  PluginViewNodeFrame,
  PluginViewRpcRequest,
  PluginViewRpcResponse,
  PluginViewSlotFrame,
} from "./pluginViewProtocol";

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

await listen<PluginViewInit>(event("init"), async ({ payload: init }) => {
  activeLabel = init.label;
  const subscriptions: { dispose(): void }[] = [];
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
  const noRegistration = () => ({ dispose() {} });
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
      register: noRegistration,
      execute: (name: string, args?: unknown) => call("commands.execute", name, args),
    },
    events: { on: (name: string, cb: (value: unknown) => void) => subscribe("events.on", [name], cb) },
    bus: {
      emit: (name: string, value: unknown) => void call("bus.emit", name, value),
      on: (name: string, cb: (value: unknown) => void) => subscribe("bus.on", [name], cb),
    },
    ui: {
      registerView(_id: string, provider: any) {
        provider.mount(document.getElementById("root")!, context);
        subscriptions.push({ dispose: () => provider.unmount?.(document.getElementById("root")!) });
        queueMicrotask(observeSlots);
        return subscriptions[subscriptions.length - 1]!;
      },
      registerFileViewer: noRegistration,
    },
    data: { kv: {
      get: (key: string) => call("data.kv.get", key),
      set: (key: string, value: unknown) => call("data.kv.set", key, value),
      delete: (key: string) => call("data.kv.delete", key),
      keys: (prefix?: string) => call("data.kv.keys", prefix),
      watch: (cb: (value: unknown) => void) => subscribe("data.kv.watch", [], cb),
    } },
  };
  if (init.webviewCapabilities && init.label) {
    const asyncMethod = (name: string) => (...args: unknown[]) => call(`webview.${name}`, ...args);
    app.webview = {
      capabilities: init.webviewCapabilities,
      label: (_viewId: string) => init.label,
      open: asyncMethod("open"), navigate: asyncMethod("navigate"), zoom: asyncMethod("zoom"),
      openWindow: asyncMethod("openWindow"), history: asyncMethod("history"), stop: asyncMethod("stop"),
      devtools: asyncMethod("devtools"), eval: asyncMethod("eval"), sendInput: asyncMethod("sendInput"),
      wheel: asyncMethod("wheel"), captureFull: asyncMethod("captureFull"), typeText: asyncMethod("typeText"),
      list: asyncMethod("list"), close: asyncMethod("close"),
      on: (label: string, name: string, cb: (value: unknown) => void) =>
        subscribe("webview.on", [label, name], cb),
    };
  }
  const moduleUrl = URL.createObjectURL(new Blob([init.source], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ moduleUrl);
    const plugin = mod.default ?? mod;
    plugin.activate({ app, manifest: {}, dir: "", subscriptions });
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
