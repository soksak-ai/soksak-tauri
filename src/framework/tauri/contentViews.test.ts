// 이 프레임워크의 콘텐츠 뷰 구현 — 콘텐츠가 **문서 밖**에 산다.
//
// 이름과 인자를 번역하지 않는 것이 이 구현의 전부다. 번역하면 새 드리프트 면이 생기고,
// 그 드리프트는 "이 프레임워크에서만 안 되는 기능"으로 나타난다.
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

async function load() {
  vi.resetModules();
  invoke.mockClear();
  return import("./contentViews");
}

describe("네이티브 자식 뷰 구현", () => {
  it("이름과 인자를 번역하지 않는다", async () => {
    const { nativeHost } = await load();
    await nativeHost.open("b-1", { url: "https://x" });
    expect(invoke).toHaveBeenCalledWith("webview_open", { label: "b-1", url: "https://x" });
    await nativeHost.bounds("b-1", 1, 2, 3, 4);
    expect(invoke).toHaveBeenCalledWith("webview_bounds", { label: "b-1", x: 1, y: 2, w: 3, h: 4 });
  });

  // 없는 것을 있는 척하지 않는다 — 조용한 성공은 부른 쪽이 눌렀다고 믿게 만든다.
  it("입력 주입은 통로가 없음을 이름을 달고 밝힌다", async () => {
    const { nativeHost } = await load();
    await expect(nativeHost.sendInput("b-1", 1, 2)).rejects.toThrow("입력 주입 통로가 없습니다");
  });

  it("주입 해지가 no-op 임을 스스로 밝힌다", async () => {
    const { nativeHost } = await load();
    const off = nativeHost.injectScript("b-1", "1", "document-start");
    expect(invoke).toHaveBeenCalledWith("webview_inject_script", {
      label: "b-1",
      code: "1",
      phase: "document-start",
    });
    expect(() => off()).not.toThrow();
  });
});
