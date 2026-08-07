// 준비의 기준은 "뷰가 등록됐는가"이지 "activate 가 예외 없이 끝났는가"가 아니다.
//
// RED 근거(실측, 2026-08-07): soksak-plugin-browser-native 의 activate 는 registerView 를
// 먼저 하고 그 뒤 renderer realm 에 없는 app.commands.register 를 부른다. 그 예외를 부모가
// 준비 거절로 옮기자 이미 등록된 뷰가 mounted:false 가 됐다 — 병합 전 빌드에서 같은 픽스처가
// B01/B03 green 이었고 48프레임 두 방향이 렌더됐다. 활성 실패는 사유이지 준비의 부재가 아니다.
//
// 부재는 여전히 이름으로 드러나야 한다: 뷰를 한 번도 등록하지 못한 renderer 는 준비되지 않는다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginViewReadySignal } from "./pluginViewActivation";

describe("준비 신호의 기준", () => {
  it("등록을 마친 뒤 온 활성 실패는 준비를 뒤집지 못한다", async () => {
    const signal = createPluginViewReadySignal();
    expect(signal.markReady()).toBe(true);
    expect(signal.markFailed("플러그인 활성 실패(browser-native): register is not a function")).toBe(false);
    await expect(signal.ready).resolves.toBeUndefined();
  });

  it("등록 전에 온 활성 실패는 사유와 함께 준비를 거절한다", async () => {
    const signal = createPluginViewReadySignal();
    expect(signal.markFailed("플러그인 활성 실패(offscreen): register is not a function")).toBe(true);
    await expect(signal.ready).rejects.toThrow(/offscreen/);
    expect(signal.markReady()).toBe(false);
  });
});

describe("부모의 실패 처리 배선", () => {
  const read = (name: string) => readFileSync(resolve(import.meta.dirname, name), "utf8");

  it("활성 실패는 준비를 거절하기 전에 등록 사실을 본다", () => {
    const listener = read("pluginViewPresentation.ts")
      .split("listen<PluginViewFailure>")[1]?.slice(0, 400) ?? "";
    // 자식이 낸 실패를 그대로 준비 거절로 옮기면 이미 등록된 뷰가 죽는다.
    expect(listener).toContain("reportActivationFailure");
    expect(listener).not.toMatch(/markFailed\(`플러그인 활성 실패/);
  });

  it("등록된 뷰가 있으면 사유만 남기고 준비는 뷰가 정한다", () => {
    const decision = read("pluginViewPresentation.ts")
      .split("const reportActivationFailure")[1]?.slice(0, 400) ?? "";
    expect(decision).toContain("registeredViews > 0");
    expect(decision).toContain("setStatus");
    expect(decision).toContain("markFailed");
  });

  it("renderer 는 등록한 뷰의 수를 실패와 함께 보낸다", () => {
    const source = read("pluginViewRenderer.ts");
    expect(source).toContain("registeredViews += 1");
    expect(source).toContain("registeredViews }");
    expect(read("pluginViewProtocol.ts")).toContain("registeredViews");
  });
});
