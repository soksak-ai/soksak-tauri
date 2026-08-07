// realm 선언 축 — 같은 플러그인 번들이 두 realm 에서 평가되는데 app 표면이 같지 않다.
//
// RED 근거(실측 2026-08-07 · buildId=c437078c, framework=tauri, platform=darwin):
// browser-chromium-offscreen 12칸 전부 blocked. sentinel status =
//   "플러그인 활성 실패(soksak-plugin-browser-chromium-offscreen):
//    app.commands.register is not a function."
// nativeSurface 뷰의 플러그인 본체는 자식 renderer 안에서 한 번 더 활성되고, 그 realm 의 app
// 에는 commands.execute 만 있다. 세 브라우저 플러그인이 이 부재를 각자 다르게 typeof 로
// 더듬었고 — 둘은 통과, 하나는 그 자리에서 죽었다. 더듬기는 답이 아니다.
//
// 계약: realm 은 자기 신원과 그 realm 에서 부를 수 있는 이름을 선언으로 답한다. 선언은 손으로
// 적지 않고 실제 app 객체에서 파생한다 — 적어 둔 목록은 반드시 하나 빠진다.
import { describe, expect, it } from "vitest";
import { declarePluginRealm, pluginRealmCapabilities } from "./realm";

describe("app 객체에서 능력 이름을 파생한다", () => {
  it("중첩된 함수를 점 표기 이름 전수로 낸다", () => {
    const capabilities = pluginRealmCapabilities({
      windowLabel: () => "w-1",
      commands: { execute: async () => {} },
      data: { kv: { get: async () => null, set: async () => {} } },
    });

    expect(capabilities).toEqual([
      "commands.execute",
      "data.kv.get",
      "data.kv.set",
      "windowLabel",
    ]);
  });

  it("함수가 아닌 값은 능력이 아니다", () => {
    const capabilities = pluginRealmCapabilities({
      appVersion: "1.0.0",
      pluginId: "demo",
      capabilities: ["a", "b"],
      nothing: undefined,
      missing: null,
      commands: { execute: () => {} },
    });

    expect(capabilities).toEqual(["commands.execute"]);
  });

  it("접근자는 읽지 않는다 — 세는 행위가 부작용을 내면 안 된다", () => {
    const app: Record<string, unknown> = { commands: { execute: () => {} } };
    let reads = 0;
    Object.defineProperty(app, "trap", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("접근자를 읽었다");
      },
    });

    expect(pluginRealmCapabilities(app)).toEqual(["commands.execute"]);
    expect(reads).toBe(0);
  });
});

describe("realm 은 신원과 능력을 선언으로 답한다", () => {
  it("자식 renderer realm 은 execute 는 있다고, register 는 없다고 답한다", () => {
    const app = declarePluginRealm("view-renderer", {
      commands: { execute: async () => ({ ok: true }) },
      ui: { registerView: () => ({ dispose() {} }) },
    });

    expect(app.realm.id).toBe("view-renderer");
    expect(app.realm.supports("commands.execute")).toBe(true);
    expect(app.realm.supports("ui.registerView")).toBe(true);
    // 이 한 줄이 offscreen 을 죽였다. 이제 부르기 전에 물을 수 있다.
    expect(app.realm.supports("commands.register")).toBe(false);
  });

  it("부를 이름을 그대로 물어라 — 네임스페이스가 있다고 그 안이 다 있는 것은 아니다", () => {
    const app = declarePluginRealm("view-renderer", {
      commands: { execute: async () => ({ ok: true }) },
    });

    expect(app.realm.supports("commands")).toBe(false);
    expect(app.realm.capabilities).toContain("commands.execute");
  });

  it("realm 자신은 능력 목록에 들어가지 않는다 — 답이지 능력이 아니다", () => {
    const app = declarePluginRealm("window", { commands: { execute: () => {} } });

    expect(app.realm.capabilities).toEqual(["commands.execute"]);
    expect(app.realm.supports("realm.supports")).toBe(false);
  });

  it("한 app 은 realm 하나다 — 두 번째 선언은 거절한다", () => {
    const app = declarePluginRealm("window", { commands: { execute: () => {} } });

    expect(() => declarePluginRealm("view-renderer", app)).toThrow();
    expect(app.realm.id).toBe("window");
  });

  it("선언은 바꿔치기할 수 없다 — 능력 목록도 얼어 있다", () => {
    const app = declarePluginRealm("window", { commands: { execute: () => {} } });

    expect(Object.isFrozen(app.realm)).toBe(true);
    expect(Object.isFrozen(app.realm.capabilities)).toBe(true);
  });
});
