// @vitest-environment node
import { describe, expect, it } from "vitest";
import { unmetNeeds, type EngineProvision } from "../src/engineNeeds.js";

/** Tauri × macOS — WKWebView 는 chromium 등급이 아니고, 자식 웹뷰 합성은 있다. */
const TAURI_MACOS: EngineProvision = { chromium: false, nativeChildWebview: true };
/** Tauri × Windows — WebView2 가 곧 Chromium(R4: 승격 no-op). */
const TAURI_WINDOWS: EngineProvision = { chromium: true, nativeChildWebview: true };
/** Electron — 프레임워크 자체가 Chromium. 자식 웹뷰 합성 장치는 필요 없다. */
const ELECTRON: EngineProvision = { chromium: true, nativeChildWebview: false };

describe("표면 × 엔진 등급 — 프레임워크를 이름으로 묻지 않는다", () => {
  it("요구가 없으면 어디서나 선다", () => {
    for (const has of [TAURI_MACOS, TAURI_WINDOWS, ELECTRON]) {
      expect(unmetNeeds({}, has)).toEqual([]);
    }
  });

  // astryx 가 이 자리다. 프레임워크 이름으로 적었다면 Electron 에서 숨겨졌을 표면인데,
  // 실제로는 Electron 이 요구를 **충족**한다 — 축이 반대라는 것을 이 단언이 못박는다.
  it("chromium 등급 요구는 등급을 갖춘 곳에서 no-op 이다", () => {
    expect(unmetNeeds({ requiresEngine: "chromium" }, TAURI_MACOS)).toEqual([
      "requiresEngine=chromium",
    ]);
    expect(unmetNeeds({ requiresEngine: "chromium" }, TAURI_WINDOWS)).toEqual([]);
    expect(unmetNeeds({ requiresEngine: "chromium" }, ELECTRON)).toEqual([]);
  });

  // 반대 방향도 성립해야 축이 산다: Electron 이 모든 요구를 이기는 것이 아니다.
  it("자식 웹뷰를 전제한 표면은 그 장치가 없는 곳에서 빠진다", () => {
    expect(unmetNeeds({ requiresNativeChildWebview: true }, TAURI_MACOS)).toEqual([]);
    expect(unmetNeeds({ requiresNativeChildWebview: true }, ELECTRON)).toEqual([
      "requiresNativeChildWebview",
    ]);
  });

  it("못 채운 요구는 전부 이름으로 온다 — 하나만 알리고 멈추지 않는다", () => {
    expect(
      unmetNeeds({ requiresEngine: "chromium", requiresNativeChildWebview: true }, {
        chromium: false,
        nativeChildWebview: false,
      }),
    ).toEqual(["requiresEngine=chromium", "requiresNativeChildWebview"]);
  });

  it("false 선언은 요구가 아니다 — 적었다는 사실이 요구가 되면 안 된다", () => {
    expect(unmetNeeds({ requiresNativeChildWebview: false }, ELECTRON)).toEqual([]);
  });
});

// ── 매니페스트 검증 ──────────────────────────────────────────────────────────
//
// 필드를 타입에만 두면 오타가 조용히 지나간다. `requiresEngine: "chrome"` 은 요구가 없는
// 것과 같은 값이 되어, 승격이 필요한 표면이 미달 엔진에서 그냥 뜬다 — 거부가 아니라
// **깨진 렌더**로 나타난다.
import { parseManifest } from "../src/spec.js";

const BASE = {
  spec: "soksak-spec-plugin@0.0.1",
  id: "demo",
  name: { en: "Demo" },
  version: "0.0.1",
  description: { en: "d" },
  entry: "main.js",
  runtime: {},
  permissions: [],
};

function parse(extra: Record<string, unknown>) {
  return parseManifest({ ...BASE, ...extra }, "demo");
}

describe("매니페스트 — 요구는 아는 값만 받는다", () => {
  it("미지정이 기본이다", () => {
    const r = parse({});
    expect(r.validation.errors).toEqual([]);
    expect(r.manifest?.requiresEngine).toBeUndefined();
    expect(r.manifest?.requiresNativeChildWebview).toBeUndefined();
  });

  it("아는 등급은 통과한다", () => {
    const r = parse({ requiresEngine: "chromium", requiresNativeChildWebview: true });
    expect(r.validation.errors).toEqual([]);
    expect(r.manifest?.requiresEngine).toBe("chromium");
    expect(r.manifest?.requiresNativeChildWebview).toBe(true);
  });

  it("모르는 등급은 이름을 달고 거부된다 — 오타가 '요구 없음'이 되지 않는다", () => {
    const r = parse({ requiresEngine: "chrome" });
    expect(r.validation.errors.join(" ")).toContain("requiresEngine");
  });

  it("불리언 아닌 자식 웹뷰 요구도 거부된다", () => {
    const r = parse({ requiresNativeChildWebview: "yes" });
    expect(r.validation.errors.join(" ")).toContain("requiresNativeChildWebview");
  });
});

// 엔진 모듈 호스팅은 **자식 뷰와 다른 축**이다.
//
// SIDECARS.md §8 이 두 합성 모드를 적어 뒀다: `windowed` 는 네이티브 자식 뷰를 창에 붙이고,
// `offscreen` 은 엔진이 자기 레이어에 그려 올린다(픽셀은 프로세스 안 GPU 핸들로만 움직인다).
// 자식 뷰가 필요한 것은 앞의 하나뿐이다.
//
// 그러면 둘의 **공통 요구**는 자식 뷰가 아니라 "이 프로세스 안에 엔진 모듈을 적재할 수
// 있는가"다(dlopen + 메인스레드 + 창). 그것으로 안 가르면 offscreen 소비자가 틀린 사유로
// 거절당한다 — 결과는 같아도 사유가 거짓이면 다음 사람이 엉뚱한 것을 고친다.
describe("엔진 모듈 호스팅 축", () => {
  const HOSTS = { chromium: true, nativeChildWebview: true, engineModules: true };
  const NO_HOST = { chromium: true, nativeChildWebview: false, engineModules: false };

  it("호스팅 못 하는 곳에서 엔진 요구는 그 이름으로 온다", () => {
    expect(unmetNeeds({ requiresEngineModules: true }, NO_HOST)).toEqual([
      "requiresEngineModules",
    ]);
  });

  it("호스팅하는 곳에서는 자식 뷰 여부와 무관하게 선다 — offscreen 이 그 경우다", () => {
    expect(
      unmetNeeds({ requiresEngineModules: true }, { ...HOSTS, nativeChildWebview: false }),
    ).toEqual([]);
  });

  it("자식 뷰 요구는 여전히 자기 축으로 잰다 — 두 축을 뭉치지 않는다", () => {
    expect(unmetNeeds({ requiresNativeChildWebview: true }, HOSTS)).toEqual([]);
    expect(unmetNeeds({ requiresNativeChildWebview: true }, NO_HOST)).toEqual([
      "requiresNativeChildWebview",
    ]);
  });
});
