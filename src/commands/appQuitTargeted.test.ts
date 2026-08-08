// @vitest-environment jsdom
// 끄기는 지목해야 한다 — 같은 홈의 다른 프레임워크까지 끄지 않는다.
//
// `app.quit` 의 설명은 처음부터 "The other framework on the same home keeps running" 이라고
// 적혀 있었다. 그런데 두 프레임워크의 오케스트레이터 창은 둘 다 `main` 이고, 라벨을 고를 수
// 없는 부름은 그 라벨을 든 **전부**에게 간다 — 그 규칙 자체는 옳다(한때 겹치면 거절했더니
// 두 앱을 함께 켠 순간 어느 쪽도 밖에서 못 불렀다). 그래서 적어 둔 계약만 거짓이 되었다.
//
// 실측 2026-08-08: 한쪽을 재기동하려고 부른 `app.quit` 이 사용자가 띄워 둔 다른 프레임워크의
// 창까지 껐다. 부작용이 비가역인 명령은 "누구를 끄는가" 를 인자로 받아야 한다.
import { describe, expect, it, vi } from "vitest";

const quitNative = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: quitNative.invoke,
  frameworkName: "tauri",
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import type { CommandContext } from "./registry";

registerCatalog();

const ctx = () => {
  const tasks: (() => unknown)[] = [];
  return {
    ctx: { afterReply: (t: () => unknown) => tasks.push(t) } as unknown as CommandContext,
    run: async () => {
      for (const t of tasks) await t();
    },
  };
};

describe("app.quit — 지목한 프레임워크만 끈다", () => {
  it("다른 프레임워크를 지목하면 이 프로세스는 살아 있는다", async () => {
    quitNative.invoke.mockClear();
    const { ctx: c, run } = ctx();
    const out = await execute("app.quit", { framework: "electron" }, c);
    await run();
    expect(out.ok).toBe(true);
    expect(out.data?.quit, "남의 이름을 대고 부른 종료에 내가 죽었다").toBe(false);
    expect(quitNative.invoke).not.toHaveBeenCalled();
  });

  it("자기를 지목하면 끈다", async () => {
    quitNative.invoke.mockClear();
    const { ctx: c, run } = ctx();
    const out = await execute("app.quit", { framework: "tauri" }, c);
    await run();
    expect(out.data?.quit).toBe(true);
    expect(quitNative.invoke).toHaveBeenCalledWith("app_quit");
  });

  // 지목이 없으면 받은 쪽이 끈다 — 예전 부름을 깨지 않는다.
  it("지목이 없으면 받은 쪽이 끈다", async () => {
    quitNative.invoke.mockClear();
    const { ctx: c, run } = ctx();
    const out = await execute("app.quit", {}, c);
    await run();
    expect(out.data?.quit).toBe(true);
    expect(quitNative.invoke).toHaveBeenCalledWith("app_quit");
  });

  it("누가 답했는지 이름으로 낸다 — 답이 여럿일 때 어느 쪽인지 가려야 한다", async () => {
    const { ctx: c } = ctx();
    const out = await execute("app.quit", { framework: "electron" }, c);
    expect(out.data?.framework).toBe("tauri");
  });
});
