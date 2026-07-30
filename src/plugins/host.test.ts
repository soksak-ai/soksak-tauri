// 플러그인 호스트 초기화의 기준.
//
// 여기서 재는 것은 **회수가 이름과 인자로 완결되는가**다. 창을 프레임워크가 주입해 주기를
// 기대하면 그 명령은 창을 가진 프로세스에서만 설 수 있고, 그러면 앞선 런타임의 고아를
// 거두는 일이 프레임워크마다 다시 구현되어야 한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, unknown][] = [];

vi.mock("../framework", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "app_is_release") return Promise.resolve(false);
    return Promise.resolve(undefined);
  },
  appInfo: { version: () => Promise.resolve("0.0.1") },
}));
vi.mock("./hooks", () => ({ startPluginHooks: () => {} }));
vi.mock("./registryInstallRuntimeNative", () => ({ wireNativeRegistryInstall: () => {} }));
vi.mock("../state/plugins", () => ({
  usePlugins: { setState: () => {}, getState: () => ({ reload: async () => {} }) },
}));
vi.mock("../state/registry", () => ({
  useRegistry: { setState: () => {}, getState: () => ({ refresh: async () => {} }) },
}));
vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "w-test" }));

describe("앞선 런타임의 자식 회수", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
  });

  /**
   * **라벨을 실어 보낸다.**
   *
   * 인자 없이 부르면 창을 프레임워크가 주입해야 하고, 그러면 창 없는 프로세스는 그 이름을
   * 서빙할 수 없다 — 같은 이름으로 라벨을 받게 하면 인자 없이 부른 옛 호출자가
   * INVALID_PARAMS 를 받고, 그 실패는 "회수가 안 된다"가 아니라 "명령이 깨졌다"로 보인다.
   * 그래서 라벨을 받는 이름(process_reclaim_by_window)을 부른다 — 능력은 이미 그쪽에 있다.
   *
   * 실측(2026-07-30): 두 번째 프레임워크에서 process_reclaim_window 가 39번 거절됐다.
   */
  it("라벨을 받는 이름으로 부른다", async () => {
    const { initPluginHost } = await import("./host");
    await initPluginHost();
    const reclaim = calls.filter(([c]) => c.startsWith("process_reclaim"));
    expect(reclaim).toHaveLength(1);
    expect(reclaim[0][0]).toBe("process_reclaim_by_window");
    expect(reclaim[0][1]).toEqual({ window: "w-test" });
  });

  /** 창 라벨을 모르면 아무 창의 자식도 거두지 않는다 — 빈 라벨로 부르면 남의 것을 거둔다. */
  it("라벨을 모르면 부르지 않는다", async () => {
    vi.doMock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "" }));
    const { initPluginHost } = await import("./host");
    await initPluginHost();
    expect(calls.filter(([c]) => c.startsWith("process_reclaim"))).toEqual([]);
  });
});
