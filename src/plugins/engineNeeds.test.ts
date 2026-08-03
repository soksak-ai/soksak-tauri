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

const ELECTRON = {
  chromium: true,
  nativeChildWebview: false,
  engineModules: false,
  supportsDocumentStart: false,
  supportsInputInjection: true,
};
const TAURI_MACOS = {
  chromium: true,
  nativeChildWebview: true,
  engineModules: true,
  supportsDocumentStart: true,
  supportsInputInjection: false,
};

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

// 엔진 모델의 **정의**가 곧 표면 요구다 — docs/SIDECARS.md §1 이 그 표에 적어 뒀다:
// engine = "renders into pane surfaces (NSView)", in-process dylib.
//
// 그러면 플러그인이 `requiresNativeChildWebview: true` 를 손으로 또 적게 하는 것은 **두 벌**이다.
// 두 벌은 갈리는 순간까지 조용하다: 실측(2026-07-31) 실측된 한 브라우저 플러그인은 엔진
// 사이드카를 소비하면서 아무 요구도 안 적었고, 그래서 Electron 에서 그대로 적재되어 화면에
// "엔진 서피스 생성 실패"만 남았다.
//
// 저자에게 기억을 요구하지 않는다. 요구는 **소비에서 파생된다** — 엔진을 쓴다고 적는 것이 곧
// 표면이 필요하다고 적는 것이다.
describe("엔진 모델 소비는 그 자체가 표면 요구다", () => {
  const engineManifest = {
    id: "demo",
    permissions: ["sidecar"],
    sidecars: [{ name: "browser-chromium", interface: { id: "soksak-spec-sidecar-browser", range: ">=0.0.1" } }],
  };

  it("선언을 안 적어도 엔진 사이드카 소비가 요구를 세운다", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() => enforceEngineNeeds(engineManifest as never, ELECTRON)).toThrow(
      /requiresEngineModules/,
    );
  });

  it("그 장치가 있는 곳에서는 그대로 선다", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() => enforceEngineNeeds(engineManifest as never, TAURI_MACOS)).not.toThrow();
  });

  it("service 모델(process 권한)은 표면을 요구하지 않는다 — 헤드리스다", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    const svc = { ...engineManifest, permissions: ["process"] };
    expect(() => enforceEngineNeeds(svc as never, ELECTRON)).not.toThrow();
  });

  // 실측(2026-07-31): 권한을 사용 증거로 읽으면 **과잉이다.** 실측된 한 플러그인은
  // `sidecar` 권한을 과선언했지만 실제로는 app.process 만 쓰는 서비스 모델이고, 규칙이 그것을
  // 잡아 헤드리스 플러그인 하나를 Electron 에서 통째로 떨궜다.
  //
  // 권한은 **열어 둔 문**이지 지나간 자국이 아니다. 서비스 모델의 증거는 `service` 선언이다 —
  // spec 이 그 자리를 그 뜻으로 이미 두고 있다(service: { sidecar, interface }).
  it("service 를 선언했으면 sidecar 권한이 있어도 엔진으로 읽지 않는다", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    const both = {
      ...engineManifest,
      permissions: ["sidecar", "process"],
      service: { sidecar: "wf", interface: { id: "soksak-spec-service", range: ">=0.0.1" } },
    };
    expect(() => enforceEngineNeeds(both as never, ELECTRON)).not.toThrow();
  });
});
