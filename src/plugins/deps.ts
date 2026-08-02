import { CONTENT_VIEW_EVENT } from "../lib/contentViewEvents";
import type { ContentViewEventKey } from "./api";
// 플러그인 API 의 프로덕션 의존성 배선 — api.ts 의 PluginApiDeps 구현.
// (테스트는 가짜 deps 를 주입 — 이 파일은 실제 registry/store/bridge 연결만 담당.)

import { invoke } from "../framework";
import { safeListen } from "../lib/safeListen";
import {
  execute,
  getSpec,
  register,
  unregister,
} from "../commands/registry";
import { useSessions } from "../state/sessions";
import {
  getCwdOfHost,
  subscribeCwd,
  subscribeCommandFinished,
} from "../terminal/ptyBridge";
import { onPluginEvent } from "./hooks";
import { usePlugins } from "../state/plugins";
import { manifestImplements } from "./contractDiscovery";
import type { DataChangeEvent, PluginApiDeps } from "./api";

// 전역 listen 안전 구독 — lib/safeListen 단일 유틸로 통합(손구현 제거).
function subscribe<T>(event: string, onPayload: (payload: T) => void): () => void {
  return safeListen<T>(event, (e) => onPayload(e.payload));
}

/** 짧은 키(플러그인이 부르는 말) → 와이어 이름(정본 표). 키가 늘면 여기가 컴파일로 막는다. */
const WIRE: Record<ContentViewEventKey, string> = {
  nav: CONTENT_VIEW_EVENT.nav,
  title: CONTENT_VIEW_EVENT.title,
  status: CONTENT_VIEW_EVENT.status,
  "open-external": CONTENT_VIEW_EVENT.openExternal,
  loading: CONTENT_VIEW_EVENT.loading,
} as const;

export function defaultPluginDeps(appVersion: string): PluginApiDeps {
  return {
    appVersion,
    invoke: (cmd, args) => invoke(cmd, args),
    execute,
    registerCommand: register,
    unregisterCommand: unregister,
    getCommandDanger: (name) => getSpec(name)?.danger,
    // 대상 플러그인이 선언한 계약(매니페스트 implements). 호출 경계의 계약-핀 판정이 이것만 본다 —
    // 코어는 어느 구현체가 어느 계약을 채우는지 선언에서 읽을 뿐, 이름을 알지 않는다.
    implementsOf: (pluginId) =>
      manifestImplements(usePlugins.getState().plugins[pluginId]?.manifest),
    on: onPluginEvent,
    currentProject: () => {
      const s = useSessions.getState();
      const project = s.projects.find((t) => t.id === s.activeId);
      return project ? { id: project.id, root: project.root ?? null } : null;
    },
    // fs-change(코어 watcher, 폴링 없음) 구독 → 변경된 부모 디렉토리 문자열을 콜백. 반환 = 해지.
    onFsChange: (cb) => subscribe<string>("fs-change", cb),
    // data-change(Rust DbState 변경) 전 창 구독 — app.data.watch 의 크로스윈도우 채널. 전역
    // 전역 listen(프레임워크 경계의 브로드캐스트)이라 어느 창의 변경이든 모든 창이 받는다(같은 프로젝트 일관).
    onDataChange: (cb) => subscribe<DataChangeEvent>("data-change", cb),
    // clipboard-change(코어 네이티브 watcher — Win/X11/Wayland 이벤트, macOS changeCount 폴링)
    // 전 창 구독 → 바뀐 텍스트를 콜백.
    onClipboardChange: (cb) => subscribe<string>("clipboard-change", cb),
    // 터미널 pane cwd 스냅샷/구독 + 명령 종료 구독 — 코어 ptyBridge 브리지(app.terminal 노출).
    getCwd: (paneId) => getCwdOfHost(paneId),
    subscribeCwd: (paneId, cb) => subscribeCwd(paneId, cb),
    subscribeCommandFinished: (paneId, cb) => subscribeCommandFinished(paneId, cb),
    // 콘텐츠 뷰 사건 label 필터 구독 — app.webview.on 노출.
    //
    // **이름을 조립하지 않는다.** 옛 판은 `` `browser-${event}` `` 로 만들었고, 그래서 짧은 키와
    // 와이어 이름이 문자열 산술로 묶여 있었다 — 어느 한쪽만 바뀌면 발행이 아무에게도 안 닿고
    // 그 부재는 오류가 아니라 안 오는 사건이다. 이름은 정본 표에서 고른다(정본은 Rust).
    subscribeWebview: (label, event, cb) =>
      subscribe<{ label: string } & Record<string, unknown>>(WIRE[event], (p) => {
        if (p.label === label) cb(p);
      }),
  };
}
