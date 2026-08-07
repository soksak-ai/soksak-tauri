// renderer realm 과 부모 사이의 실패 채널 배선. 계약은 pluginViewActivation.test.ts 가
// 동작으로 세우고, 이 파일은 그 계약이 실제 두 자리에 배선되어 있는지만 본다.
//
// RED 근거(실측, 2026-08-07): browser-chromium-offscreen 의 activate 가 renderer 에서
// 죽었는데 부모는 그것을 들을 채널이 없었다. ready 는 영원히 pending, tab.open 은 이유 없는
// mounted:false, 화면에는 12칸 뒤 navigate 의 NO_VIEW 만 남았다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");

describe("renderer ↔ 부모 실패 채널", () => {
  it("renderer 는 activate 를 보고 경계로 감싸 부모에게 실패를 발행한다", () => {
    const source = read("pluginViewRenderer.ts");
    expect(source).toContain("activatePluginInViewRenderer");
    expect(source).toContain('event("failure")');
    // 날 activate 직접 호출이 남으면 보고 경계를 우회하는 두 번째 길이 생긴다.
    expect(source).not.toContain("plugin.activate(");
  });

  it("부모는 renderer 실패를 듣고 그 사유로 준비를 거절한다", () => {
    const source = read("pluginViewPresentation.ts");
    expect(source).toContain('event(renderer, "failure")');
    expect(source).toContain("createPluginViewReadySignal");
    expect(source).toContain("markFailed");
  });

  it("실패 사유는 status 축으로도 나간다 — 화면 카드와 별개 채널", () => {
    const source = read("pluginViewPresentation.ts");
    const mount = source.split("const host: PluginViewPresentationHost")[1] ?? "";
    expect(mount).toContain("markFailed");
    expect(mount).toContain("setStatus");
  });

  it("실패 payload 는 프로토콜이 이름 붙인 모양이다 — 자리마다 다시 지어내지 않는다", () => {
    const protocol = read("pluginViewProtocol.ts");
    expect(protocol).toContain("PluginViewFailure");
    expect(protocol).toContain("pluginId");
    expect(protocol).toContain("reason");
  });
});

// 래칫(RED→GREEN 아님): 자식 renderer 는 command registrar 가 아니다. 플러그인은 이 사실을
// `typeof app.commands?.register === "function"` 으로 재고, 그 모양이 조용히 바뀌면 세 브라우저
// 플러그인의 판정이 한꺼번에 뒤집힌다. 모양을 여기 고정한다.
describe("renderer realm 의 command 표면", () => {
  it("execute 만 있고 register 는 없다 — 등록은 창 realm 의 일이다", () => {
    const source = read("pluginViewRenderer.ts");
    const shim = source.split("commands: {")[1]?.split("}")[0] ?? "";
    expect(shim).toContain('call("commands.execute"');
    expect(shim).not.toContain("register");
  });
});
