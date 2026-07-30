// 플러그인 호스트 초기화 — 앱 시작 시 1회(main.tsx).
// 순서: 이벤트 훅 구독 → 앱 버전 확정(minAppVersion 검사 기준) → 스캔+재활성화.

import { appInfo, invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { startPluginHooks } from "./hooks";
import { wireNativeRegistryInstall } from "./registryInstallRuntimeNative";
import { usePlugins } from "../state/plugins";
import { useRegistry } from "../state/registry";

export async function initPluginHost(): Promise<void> {
  // 이 창의 플러그인 런타임이 새로 서는 자리. 앞선 런타임(창은 살아 있는데 프론트만 다시 뜬
  // 경우 — 웹뷰 리로드·개발 중 HMR·크래시 복구)이 스폰한 자식은 소유자가 사라진 채 남는다:
  // 창 파괴 회수는 창이 죽어야 도는데 창은 죽지 않았다. 지금 스폰한 것이 하나도 없는 이 시점에
  // 이 창 앞으로 등록된 자식은 정의상 전부 앞선 런타임의 고아다(detached 사이드카는 제외된다).
  // **라벨을 실어 보낸다.** 창을 프레임워크가 주입해 주기를 기대하면 이 회수는 창을 가진
  // 프로세스에서만 설 수 있고, 그러면 같은 일을 프레임워크마다 다시 구현해야 한다. 라벨을
  // 받는 이름은 이미 있다(process_reclaim_by_window) — 능력이 아니라 부르는 모양의 문제였다.
  // 라벨을 모르면 부르지 않는다: 빈 라벨로 부르면 남의 창 자식을 거둘 수 있다.
  const label = currentWindowLabel();
  if (label) {
    try {
      await invoke("process_reclaim_by_window", { window: label });
    } catch (e) {
      console.warn("이전 런타임 자식 회수 실패:", e);
    }
  }
  startPluginHooks();
  // Install the certified archive-extraction handler so plugin.install resolves a
  // real native installer instead of INSTALL_RUNTIME_UNAVAILABLE.
  wireNativeRegistryInstall();
  try {
    // core build identity — 앱 updater 채널 판정용. plugin 개발 가능 여부와는 독립이다.
    usePlugins.setState({ release: await invoke<boolean>("app_is_release") });
  } catch (e) {
    console.warn("release 판정 조회 실패(false 유지):", e);
  }
  try {
    usePlugins.setState({ appVersion: await appInfo.version() });
  } catch (e) {
    // 버전 미확인이면 minAppVersion 검사를 생략(경고) — reload 쪽에서 로그.
    console.warn("앱 버전 조회 실패:", e);
  }
  try {
    await usePlugins.getState().reload();
  } catch (e) {
    console.error("플러그인 초기 로드 실패:", e);
  }
  // 설치 가능 목록 세션 1회 원격 갱신(실패해도 스냅샷으로 동작 — 막지 않음).
  void useRegistry.getState().refresh();
}
