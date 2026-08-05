import { moduleState } from "../lib/moduleState";
import type { PluginViewContext, PluginViewProvider, RegisteredView } from "./viewRegistry";

export interface PresentedPluginView {
  /** renderer와 최초 native member가 실제 명령 가능한 시점에만 완료된다. */
  readonly ready: Promise<void>;
  update(context: PluginViewContext): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * 문서 밖 renderer를 요구하는 프레임워크가 플러그인 뷰를 장착하는 공개 경계다.
 * 코어와 플러그인은 프레임워크 이름을 판정하지 않는다. 구현이 등록돼 있으면 그 구현이
 * presentation owner를 만들고, 없으면 일반 DOM provider mount가 유일한 경로다.
 */
export interface PluginViewPresentationHost {
  mount(input: {
    container: HTMLElement;
    registration: RegisteredView;
    provider: PluginViewProvider;
    context: PluginViewContext;
  }): PresentedPluginView;
}

const state = moduleState("plugins/viewPresentationHost#registered", () => ({
  host: null as PluginViewPresentationHost | null,
}));

export function registerPluginViewPresentationHost(host: PluginViewPresentationHost): void {
  if (state.host && state.host !== host) {
    throw new Error("플러그인 view presentation host가 이미 등록되어 있습니다");
  }
  state.host = host;
}

export function pluginViewPresentationHost(): PluginViewPresentationHost | null {
  return state.host;
}

export function __resetPluginViewPresentationHostForTest(): void {
  state.host = null;
}
