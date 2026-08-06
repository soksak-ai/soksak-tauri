export const PLUGIN_VIEW_READY = "soksak://plugin-view/ready";

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
