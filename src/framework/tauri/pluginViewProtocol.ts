import type { PluginRealmId } from "../../plugins/realm";

export const PLUGIN_VIEW_READY = "soksak://plugin-view/ready";

/**
 * view-renderer realm 이 부모에게 부를 수 있는 경로 전수. 이 표가 그 realm 의 RPC 능력이다.
 *
 * 부모의 게이트와 자식의 shim 이 각자 목록을 적으면 반드시 갈리고, 갈린 쪽은 조용히 죽는다.
 * 표는 여기 하나만 있고 양쪽이 이것을 읽는다(짝 테스트 pluginViewRealm.test.ts 가 자식이
 * 실제로 부르는 경로 전수와 이 표가 같은지 본다).
 */
export const VIEW_RENDERER_CALL_PATHS = [
  "commands.execute",
  "webview.open", "webview.navigate", "webview.zoom", "webview.openWindow", "webview.history",
  "webview.present",
  "webview.stop", "webview.devtools", "webview.eval", "webview.sendInput",
  "webview.wheel", "webview.captureFull", "webview.typeText", "webview.list", "webview.close",
  "data.kv.get", "data.kv.set", "data.kv.delete", "data.kv.keys",
  "sidecar.open", "sidecar.send", "sidecar.close",
  "bus.emit",
  "context.setBadge", "context.setStatus", "context.setTitle", "context.setIcon",
  "context.setRestoreState",
] as const;

export const VIEW_RENDERER_SUBSCRIBE_PATHS = [
  "events.on", "webview.on", "data.kv.watch", "bus.on", "settings.onChange",
  "sidecar.on",
  "context.onVisibilityChange",
] as const;

const CALL_PATHS: ReadonlySet<string> = new Set(VIEW_RENDERER_CALL_PATHS);
const SUBSCRIBE_PATHS: ReadonlySet<string> = new Set(VIEW_RENDERER_SUBSCRIBE_PATHS);

export function isPluginViewCallExposed(path: string): boolean {
  return CALL_PATHS.has(path);
}

export function isPluginViewSubscribeExposed(path: string): boolean {
  return SUBSCRIBE_PATHS.has(path);
}

export type PluginViewRpcRequest =
  | { id: number; kind: "call"; path: string; args: unknown[] }
  | { id: number; kind: "subscribe"; path: string; args: unknown[]; subscription: string }
  | { id: number; kind: "unsubscribe"; subscription: string };

export interface PluginViewRpcResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface PluginViewInit {
  source: string;
  pluginId: string;
  /** main renderer와 동일한 공개 workspace window 주소. */
  windowLabel: string;
  viewId: string | null;
  label: string | null;
  locale: string;
  settings: Record<string, unknown>;
  project: { id: string; root: string | null } | null;
  sidecarAvailable: boolean;
  webviewCapabilities: Record<string, boolean> | null;
  context: {
    projectId: string;
    root: string | null;
    paneId: string | null;
    viewId: string | null;
    boundViewId: string | null;
    command: string | null;
    restore: { cwd: string | null; state: unknown } | null;
    visible: boolean;
  };
}

/**
 * 자식 renderer 가 플러그인을 못 살렸다는 사실. 실패는 침묵으로 표현될 수 없으므로
 * 준비 신호와 같은 채널로 부모에게 올라오고, 부모는 이 사유로 준비를 거절한다.
 */
export interface PluginViewFailure {
  pluginId: string;
  reason: string;
  /** 어느 realm 에서 죽었는가. 같은 번들이 두 realm 에서 도니 사유만으로는 자리를 못 가른다. */
  realm: PluginRealmId;
}

export interface PluginViewSlotFrame {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** child renderer viewport at the same measurement epoch. */
  rootW: number;
  rootH: number;
  /** child renderer가 같은 viewport에서 만든 단조 증가 측정 번호. */
  revision: number;
  /** child renderer 측정 시각. 부모 수신/창 resize와의 지연을 수치화한다. */
  reportedAtUnixMs: number;
}

export interface PluginViewNodeFrame extends PluginViewSlotFrame {
  node: string;
  /** 노출된 form node의 실제 child-renderer 현재 상태. 좌표 projection이 값을 지어내지 않는다. */
  control: { kind: "input" | "textarea" | "select"; value: string } | null;
}

export function nodeControlState(
  element: Element,
): PluginViewNodeFrame["control"] {
  const kind = element.localName;
  if (kind !== "input" && kind !== "textarea" && kind !== "select") return null;
  const value = Reflect.get(element, "value");
  return { kind, value: typeof value === "string" ? value : String(value ?? "") };
}
