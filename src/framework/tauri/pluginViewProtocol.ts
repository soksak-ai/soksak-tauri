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
  /** 앱 루트가 든 테마 커스텀 속성 — 이 realm 에는 앱 스타일시트가 없으므로 값으로 건넨다. */
  theme: Record<string, string>;
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
  /**
   * 실패 시점까지 이 renderer 가 등록한 뷰의 수. 활성 실패는 사유이지 준비의 부재가 아니다 —
   * 뷰를 하나라도 등록했다면 그 뷰는 온다. 0 일 때만 준비가 거절된다.
   */
  registeredViews: number;
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

/**
 * 호스트가 native member surface 에 **실제로 적용한** 프레임. 측정이 아니라 적용의 사실이다.
 *
 * 배치는 PaneSurfaceHost 가 소유하므로 그 자리에 사는 표면은 자기 프레임을 스스로 모른다.
 * 그 표면이 다시 재면 같은 자리를 두 기준으로 재게 되고, 늦은 쪽이 어긋난 채 굳는다.
 */
export interface PluginViewPlacementFrame {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 이 적용의 근거가 된 child renderer 측정 번호. 늦게 도착한 옛 적용을 가른다. */
  revision: number;
}

export interface PluginViewNodeFrame extends PluginViewSlotFrame {
  node: string;
  /** 이 노드가 **사는** realm — renderer 문서다.
   *
   * `label` 은 그 뷰의 콘텐츠 표면이고 노드는 거기 살지 않는다. 주인을 아는 쪽이 이름을 대야
   * 주소 하나로 관측도 조작도 같은 문서에 닿는다(실측 2026-08-08: 콘텐츠 표면 이름으로 지은
   * 주소가 가리킨 문서에는 `[data-node]` 가 하나도 없었다). */
  realm: string;
  /** 이 노드가 그 realm 의 활성 요소인가. */
  focused: boolean;
  /** 그 realm 의 문서가 키보드를 받는가(`document.hasFocus`).
   *
   * 호스트만 보면 이 사실이 안 보인다 — 자식 문서는 따로 포커스를 갖는다. 안 보이면 "글자가
   * 안 들어간다" 를 눈으로만 말하게 된다. */
  realmFocused: boolean;
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
