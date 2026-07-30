// 못 채운 요구는 **적재를 막는다** — 선언은 답이 되어야 한다.
//
// 실측(2026-07-31): 등급 계약(engineNeeds.unmetNeeds)도 있고 두 프레임워크가 자기 제공
// (engineProvision)도 채워 뒀는데, 그 둘을 **아무도 대조하지 않았다**. 그래서 네이티브 자식
// 표면이 없는 프레임워크에서도 그 표면을 전제한 플러그인이 그대로 적재되고, 화면에는
// "엔진 서피스 생성 실패"만 남았다(Electron 실물 캡처).
//
// 계약을 적어 두고 읽지 않으면 그것은 없는 것과 같다. 다만 **조용히** 막지는 않는다:
// 무엇이 모자라서 빠졌는지 이름으로 남아야 다음 사람이 다시 조사하지 않는다.
import { describe, expect, it } from "vitest";
import { unmetNeeds } from "@soksak-ai/plugin-spec";

const ELECTRON = { chromium: true, nativeChildWebview: false };
const TAURI_MACOS = { chromium: true, nativeChildWebview: true };

describe("엔진 요구 대조", () => {
  it("자식 웹뷰를 전제한 표면은 그 장치가 없는 곳에서 못 채운 요구를 낸다", () => {
    expect(unmetNeeds({ requiresNativeChildWebview: true }, ELECTRON)).toEqual([
      "requiresNativeChildWebview",
    ]);
    expect(unmetNeeds({ requiresNativeChildWebview: true }, TAURI_MACOS)).toEqual([]);
  });

  it("요구가 없으면 어디서나 선다 — 규칙이 남의 표면까지 잡지 않는다", () => {
    expect(unmetNeeds({}, ELECTRON)).toEqual([]);
  });
});

describe("적재 경계가 그 대조를 실제로 건다", () => {
  it("못 채운 요구가 있으면 활성화가 이름을 달고 거절한다", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() =>
      enforceEngineNeeds(
        { id: "demo", requiresNativeChildWebview: true } as never,
        ELECTRON,
      ),
    ).toThrow(/requiresNativeChildWebview/);
  });

  it("채운 곳에서는 통과한다 — 상시 실패하는 게이트는 곧 꺼진다", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() =>
      enforceEngineNeeds(
        { id: "demo", requiresNativeChildWebview: true } as never,
        TAURI_MACOS,
      ),
    ).not.toThrow();
  });
});
