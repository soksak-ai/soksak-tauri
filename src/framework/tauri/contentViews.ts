// Tauri 콘텐츠 뷰 구현 — 콘텐츠가 **문서 밖**에 산다.
//
// 콘텐츠는 OS 자식 뷰다. 그래서 명령이 프로세스를 건너고, 자리에 맞추려면 좌표를 써 줘야 하며,
// 그 위의 마우스는 이 문서에 오지 않는다. 홀·스탠드인·레일 클립·네이티브 마우스는 전부 그
// 사정을 갚는 장치이고, 이 프레임워크의 것이다(install.ts).
//
// 이름과 인자는 앱의 것 그대로다. 번역하면 새 드리프트 면이 생긴다.
import type { ContentViewHost } from "../../lib/contentViews";
import { invoke } from "@tauri-apps/api/core";

const call = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  invoke(cmd, args) as Promise<T>;

export const nativeHost: ContentViewHost = {
  open: (label, opts) => call("webview_open", { label, ...opts }),
  close: (label) => call("webview_close", { label }),
  list: () => call("webview_list"),
  alive: (label) => call("webview_alive", { label }),
  navigate: (label, url) => call("webview_navigate", { label, url }),
  bounds: (label, x, y, w, h) => call("webview_bounds", { label, x, y, w, h }),
  visible: (label, visible, focus) => call("webview_visible", { label, visible, focus }),
  history: (label, delta) => call("webview_history", { label, delta }),
  stop: (label) => call("webview_stop", { label }),
  zoom: (label, factor) => call("webview_zoom_view", { label, factor }),
  devtools: (label) => call("webview_devtools", { label }),
  evalJs: (label, js) => call("webview_eval", { label, js }),
  sendInput: async (label) => {
    // **이 구현에는 아직 통로가 없다.** 콘텐츠가 OS 자식 뷰라, 입력을 넣으려면 그 뷰가 사는
    // 창에 좌표를 실은 네이티브 사건을 얹어야 한다 — 이 프로세스의 입력 모니터는 읽기만 하고
    // 쓰는 자리는 없다. 없는 명령을 부르면 유령 공백이 생기므로 이름을 달고 거절한다.
    //
    // 사용자 클릭은 이 구현에서도 이미 앱에 닿는다(모니터가 좌표를 나른다) — 없는 것은
    // **구동**뿐이다. 그 차이를 조용한 성공으로 덮지 않는다.
    throw new Error(`이 콘텐츠 뷰 구현은 입력 주입 통로가 없습니다: ${label}`);
  },
  injectScript: (label, code, phase) => {
    void call("webview_inject_script", { label, code, phase });
    // 네이티브 주입은 해지 통로가 없다 — 없는 것을 있는 척하지 않는다.
    return () => {};
  },
  openWindow: (url) => call("webview_open_window", { url }),
};
