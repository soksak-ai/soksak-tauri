import { moduleState } from "./moduleState";

export type WindowResizeProbe = () => Promise<unknown> | unknown;

const state = moduleState("lib/windowResizeProbe", () => ({ probe: null as WindowResizeProbe | null }));

/** 활성 프레임워크가 창 resize 직후 공개해야 하는 수치 사실을 연결한다. */
export function registerWindowResizeProbe(probe: WindowResizeProbe | null): void {
  state.probe = probe;
}

/** probe가 없는 DOM-only 프레임워크는 빈 사실을 답한다. */
export async function sampleWindowResizeProbe(): Promise<unknown | null> {
  return state.probe ? await state.probe() : null;
}
