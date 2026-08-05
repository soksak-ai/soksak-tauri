import { tmsg } from "../i18n";
import { useBootPhase } from "../state/bootPhase";
import { awaitBootReady } from "../state/bootReady";
import { register } from "./registry";

export function registerBootCatalog(): void {
  register("app.boot.status", {
    description: "Read the current workspace boot phase. | 앱 부트 준비 상태 위상",
    triggers: { ko: "앱 부트 준비 상태 위상" },
    params: {},
    returns: "{ phase: 'restoring'|'activating'|'ready' }",
    message: (data) => tmsg("msg.app.boot.status", { phase: String(data.phase) }),
    handler: async () => ({ phase: useBootPhase.getState().phase }),
  });
  register("app.boot.wait", {
    description:
      "Wait for the workspace boot phase to become ready through the state subscription event; no polling. | 앱 부트 준비 대기 사건",
    triggers: { ko: "앱 부트 준비 대기 사건" },
    params: { timeoutMs: { type: "number", description: "Finite timeout in milliseconds (default 30000)" } },
    returns: "{ phase: 'ready' }",
    message: () => tmsg("msg.app.boot.wait"),
    handler: async (params) => awaitBootReady(Number(params.timeoutMs ?? 30_000)),
  });
}
