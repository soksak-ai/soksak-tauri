// view.open 이 ok 를 답했다면 그 뷰는 명령을 받을 수 있다.
//
// RED 근거(실측, 2026-07-26): view.open 직후 그 viewId 로 navigate 를 보내니 플러그인이
// NO_VIEW 로 답했다 — 코어는 만들었다는데 쓸 수 없었다. 상태는 즉시 바뀌지만 플러그인 뷰는
// 다음 렌더에 마운트되고, 그 사이를 알려 주는 신호가 없었다. 답이 실물보다 앞서면 호출자는
// 짐작으로 기다리거나(폴링) 실패를 삼키게 된다 — e2e 가 실제로 둘 다 했다.
import { describe, expect, it, vi } from "vitest";
import { awaitViewMounted, registerMountedViewFocus } from "./viewFocus";
import type { PluginViewProvider, PluginViewContext } from "./viewRegistry";

const provider = { mount: () => {} } as unknown as PluginViewProvider;
const ctx = () => ({}) as PluginViewContext;
const mount = (viewId: string) =>
  registerMountedViewFocus(viewId, document.createElement("div"), provider, ctx);

describe("마운트 준비 신호", () => {
  it("이미 마운트돼 있으면 즉시 참", async () => {
    const off = mount("v-ready-now");
    await expect(awaitViewMounted("v-ready-now", 50)).resolves.toBe(true);
    off();
  });

  it("나중에 마운트되면 그때 깨어난다 — 폴링이 아니라 그 지점이 신호다", async () => {
    const p = awaitViewMounted("v-ready-later", 2000);
    const off = mount("v-ready-later");
    await expect(p).resolves.toBe(true);
    off();
  });

  it("끝내 안 오면 거짓 — 매달리지 않는다", async () => {
    vi.useFakeTimers();
    const p = awaitViewMounted("v-never", 100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("다른 뷰의 마운트는 이 기다림을 깨우지 않는다", async () => {
    vi.useFakeTimers();
    const p = awaitViewMounted("v-mine", 100);
    const off = mount("v-other");
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe(false);
    off();
    vi.useRealTimers();
  });
});
