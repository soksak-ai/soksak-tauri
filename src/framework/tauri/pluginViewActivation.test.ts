// 플러그인 뷰 renderer 의 활성 실패는 조용히 사라질 수 없다.
//
// RED 근거(실측, 2026-08-07 · runId=slot-freeze-*, buildId=72f0b918, framework=tauri):
// browser-chromium-offscreen 12칸 전부 blocked. 그 플러그인은 renderer realm 에서
// `app.commands.register` 를 부른다 — renderer shim 의 commands 에는 execute 만 있어
// activate 가 그 자리에서 죽는다. 그러면 뒤에 오는 app.ui.registerView 가 영영 실행되지
// 않아 뷰가 아예 만들어지지 않는다. 그런데 부모는 아무것도 듣지 못했다: renderer 의
// listen 콜백 안에서 던져진 예외는 자식 webview 의 unhandled rejection 으로 끝나고,
// 부모의 presentation ready 는 영원히 pending 이며, tab.open 은 이유 없는 mounted:false 를
// 답한다. 화면에는 12칸 뒤의 navigate NO_VIEW 만 남는다 — 증상이 소유자를 가렸다.
//
// 계약: renderer 가 플러그인을 못 살리면 그 사실을 부모에게 이름과 함께 보고하고,
// 부모는 매달리는 대신 그 사유로 준비를 거절한다.
import { describe, expect, it } from "vitest";

describe("renderer 활성 실패 보고", () => {
  it("activate 가 던지면 실패를 보고하고 거짓을 돌려준다", async () => {
    const { activatePluginInViewRenderer } = await import("./pluginViewActivation");
    const reported: { pluginId: string; reason: string }[] = [];
    const ok = await activatePluginInViewRenderer({
      pluginId: "soksak-plugin-browser-chromium-offscreen",
      load: async () => ({
        default: {
          activate() {
            throw new TypeError("app.commands.register is not a function");
          },
        },
      }),
      context: { app: {}, manifest: {}, dir: "", subscriptions: [] },
      report: (failure) => reported.push(failure),
    });
    expect(ok).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.pluginId).toBe("soksak-plugin-browser-chromium-offscreen");
    expect(reported[0]!.reason).toContain("app.commands.register is not a function");
  });

  it("activate 가 비동기로 깨져도 같은 사실을 보고한다", async () => {
    const { activatePluginInViewRenderer } = await import("./pluginViewActivation");
    const reported: { pluginId: string; reason: string }[] = [];
    const ok = await activatePluginInViewRenderer({
      pluginId: "p",
      load: async () => ({ activate: async () => { throw new Error("late boom"); } }),
      context: { app: {}, manifest: {}, dir: "", subscriptions: [] },
      report: (failure) => reported.push(failure),
    });
    expect(ok).toBe(false);
    expect(reported[0]!.reason).toContain("late boom");
  });

  it("모듈 적재 자체가 실패해도 침묵하지 않는다", async () => {
    const { activatePluginInViewRenderer } = await import("./pluginViewActivation");
    const reported: { pluginId: string; reason: string }[] = [];
    const ok = await activatePluginInViewRenderer({
      pluginId: "p",
      load: async () => { throw new Error("import failed"); },
      context: { app: {}, manifest: {}, dir: "", subscriptions: [] },
      report: (failure) => reported.push(failure),
    });
    expect(ok).toBe(false);
    expect(reported[0]!.reason).toContain("import failed");
  });

  it("activate 가 없는 모듈은 성공이 아니다 — 0 은 두 얼굴이 아니다", async () => {
    const { activatePluginInViewRenderer } = await import("./pluginViewActivation");
    const reported: { pluginId: string; reason: string }[] = [];
    const ok = await activatePluginInViewRenderer({
      pluginId: "p",
      load: async () => ({ default: {} }),
      context: { app: {}, manifest: {}, dir: "", subscriptions: [] },
      report: (failure) => reported.push(failure),
    });
    expect(ok).toBe(false);
    expect(reported[0]!.reason).toContain("activate");
  });

  it("정상 활성은 보고하지 않고 참을 돌려준다", async () => {
    const { activatePluginInViewRenderer } = await import("./pluginViewActivation");
    const reported: unknown[] = [];
    const seen: unknown[] = [];
    const context = { app: { id: "app" }, manifest: {}, dir: "", subscriptions: [] };
    const ok = await activatePluginInViewRenderer({
      pluginId: "p",
      load: async () => ({ default: { activate: (c: unknown) => seen.push(c) } }),
      context,
      report: (failure) => reported.push(failure),
    });
    expect(ok).toBe(true);
    expect(reported).toEqual([]);
    expect(seen).toEqual([context]);
  });
});

describe("준비 신호 — 실패는 매달림이 아니라 거절이다", () => {
  it("markFailed 는 ready 를 그 사유로 거절한다", async () => {
    const { createPluginViewReadySignal } = await import("./pluginViewActivation");
    const signal = createPluginViewReadySignal();
    expect(signal.markFailed("플러그인 활성 실패(p): boom")).toBe(true);
    await expect(signal.ready).rejects.toThrow("플러그인 활성 실패(p): boom");
  });

  it("먼저 준비되면 뒤늦은 실패가 그 준비를 뒤집지 않는다", async () => {
    const { createPluginViewReadySignal } = await import("./pluginViewActivation");
    const signal = createPluginViewReadySignal();
    expect(signal.markReady()).toBe(true);
    expect(signal.markFailed("늦은 실패")).toBe(false);
    await expect(signal.ready).resolves.toBeUndefined();
  });

  it("첫 실패만 정착한다 — 두 번째 사유가 첫 사유를 덮지 않는다", async () => {
    const { createPluginViewReadySignal } = await import("./pluginViewActivation");
    const signal = createPluginViewReadySignal();
    expect(signal.markFailed("첫 사유")).toBe(true);
    expect(signal.markFailed("둘째 사유")).toBe(false);
    expect(signal.markReady()).toBe(false);
    await expect(signal.ready).rejects.toThrow("첫 사유");
  });
});
