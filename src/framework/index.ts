// 활성 프레임워크 해소 — 앱이 프레임워크를 만나는 유일한 문.
//
// 앱 코드는 여기서만 가져온다: `import { invoke } from "../framework"`. 어느 셸이 뒤에
// 있는지는 여기 한 곳이 정하고, 나머지 전부는 계약(host.ts)만 본다.
//
// 해소 규칙: 빌드 시 주입된 프레임워크 이름이 있으면 그것, 없으면 tauri(현 정본). 새 프레임워크를 붙이는
// 일은 어댑터 파일 하나 + 이 표에 한 줄이며, 앱 코드는 한 줄도 바뀌지 않는다.

import type { AppFramework } from "./contract";
import type { EngineProvision } from "@soksak-ai/plugin-spec";
import { electronHost } from "./electron";
import { tauriHost } from "./tauri";

export type {
  ShellEvent,
  AppFramework,
  ShellNotification,
  ShellWindowHandle,
  Stream,
  Unlisten,
} from "./contract";

const ADAPTERS: Record<string, AppFramework> = {
  tauri: tauriHost,
  electron: electronHost,
};

function resolveHost(): AppFramework {
  // 빌드 주입(vite define) 또는 런타임 표식. 없으면 정본.
  // 셸은 자기가 붙인 창구로 자신을 밝힌다 — 빌드 주입보다 런타임 사실이 앞선다.
  const bridged = (globalThis as { __soksakShell?: { name?: string } }).__soksakShell?.name;
  const declared =
    bridged ?? (globalThis as { __SOKSAK_SHELL__?: string }).__SOKSAK_SHELL__ ?? "tauri";
  const host = ADAPTERS[declared];
  if (!host) {
    // 침묵 폴백 금지 — 모르는 셸을 조용히 tauri 로 취급하면 잘못된 셸에서 도는 것을
    // 아무도 모른다. 알리고 정본으로 간다.
    console.error(`[platform] 알 수 없는 셸 "${declared}" — tauri 로 진행한다`);
    return tauriHost;
  }
  return host;
}

/** 활성 셸. 진단·원장에 이름을 실을 때 쓴다. */
export const shell: AppFramework = resolveHost();

// ── 이름 있는 재수출 — 호출부는 셸을 모른 채 이것만 쓴다 ─────────────────────
export const invoke: AppFramework["invoke"] = (cmd, args) => shell.invoke(cmd, args);
export const createStream: AppFramework["createStream"] = () => shell.createStream();
export const listen: AppFramework["listen"] = (event, cb) => shell.listen(event, cb);
export const currentWindow: AppFramework["currentWindow"] = () => shell.currentWindow();
export const windowByLabel: AppFramework["windowByLabel"] = (label) => shell.windowByLabel(label);
export const appInfo = shell.app;
export const shellPath = shell.path;
export const dialog = shell.dialog;
export const notification = shell.notification;
export const deepLink = shell.deepLink;

/**
 * 활성 프레임워크가 제공하는 것 — 앱이 "무엇을 할 수 있는가"를 벤더 이름 없이 묻는 자리.
 *
 * 앱 코드가 `if (framework === "electron")` 을 쓰기 시작하면 경계가 그 줄에서 샌다. 대신
 * 능력을 묻는다: 네이티브 자식 층이 있는가, 엔진이 chromium 등급인가. 같은 축을 플러그인은
 * 매니페스트에 요구로 적는다(engineNeeds.ts) — 여기는 그 요구를 채우는 쪽의 사실이다.
 */
export const engineProvision: EngineProvision = shell.engineProvision;
