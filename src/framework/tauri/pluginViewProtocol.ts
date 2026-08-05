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
  viewId: string | null;
  label: string | null;
  locale: string;
  settings: Record<string, unknown>;
  project: { id: string; root: string | null } | null;
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
}

export interface PluginViewNodeFrame extends PluginViewSlotFrame {
  node: string;
}
