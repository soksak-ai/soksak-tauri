// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ADAPTER_ALPHA_BASES,
  adapterAlphaBasis,
  filterTransmission,
  readAdapterAlpha,
} from "./browser-gate-b06-adapter.mjs";

describe("B06 어댑터 투과율", () => {
  // 근거는 프레임워크 이름이 아니라 선언된 능력 × 엔진의 합성 축이 정한다.
  it("장부 이름은 선언된 능력과 합성 축이 정한다", () => {
    expect(adapterAlphaBasis({ nativeChildWebview: true, surface: "framework-native" }))
      .toBe("pane-host");
    expect(adapterAlphaBasis({ nativeChildWebview: true, surface: "engine-windowed" }))
      .toBe("pane-host");
    expect(adapterAlphaBasis({ nativeChildWebview: true, surface: "engine-offscreen" }))
      .toBe("engine-surface");
    expect(adapterAlphaBasis({ nativeChildWebview: false, surface: "framework-native" }))
      .toBe("content-view-dom");
    // 선언이 없으면 어느 장부인지 모른다 — 아무 장부나 고르지 않는다.
    expect(adapterAlphaBasis({ surface: "framework-native" })).toBeNull();
    expect(adapterAlphaBasis({ nativeChildWebview: true, surface: "" })).toBeNull();
    expect(adapterAlphaBasis({ nativeChildWebview: true, surface: "engine-unknown" })).toBeNull();
    expect(ADAPTER_ALPHA_BASES).toEqual(["pane-host", "engine-surface", "content-view-dom"]);
  });

  it("필터가 통과시키는 빛 — 모르는 함수가 하나라도 있으면 null", () => {
    expect(filterTransmission("none")).toBe(1);
    expect(filterTransmission("brightness(0.5)")).toBe(0.5);
    expect(filterTransmission("brightness(50%)")).toBe(0.5);
    expect(filterTransmission("brightness(0.5) opacity(0.5)")).toBe(0.25);
    expect(filterTransmission("grayscale(1)")).toBe(1);
    // 흐림이 아닌 필터를 1 로 읽으면 판정이 거짓이 된다.
    expect(filterTransmission("blur(2px)")).toBeNull();
    expect(filterTransmission("url(#veil)")).toBeNull();
    expect(filterTransmission("")).toBeNull();
    expect(filterTransmission(undefined)).toBeNull();
  });

  it("pane host 장부에서 읽는다", () => {
    const paneComposition = {
      matches: [{ alpha: 1, memberMatches: [{ label: "b-1" }] }],
    };
    expect(readAdapterAlpha({ basis: "pane-host", label: "b-1", paneComposition })).toBe(1);
    expect(readAdapterAlpha({ basis: "pane-host", label: "b-2", paneComposition })).toBeNull();
    expect(readAdapterAlpha({ basis: "pane-host", label: "b-1", paneComposition: null }))
      .toBeNull();
    expect(readAdapterAlpha({
      basis: "pane-host",
      label: "b-1",
      paneComposition: { matches: [{ alpha: 0.5, memberMatches: [{ label: "b-1" }] }] },
    })).toBe(0.5);
  });

  it("엔진 표면 장부에서는 조상까지 곱한 값이 화면의 사실이다", () => {
    const surfaces = {
      engine: { surfaces: [{ label: "b-1", alpha: 1, effectiveAlpha: 0.5 }] },
    };
    expect(readAdapterAlpha({ basis: "engine-surface", label: "b-1", surfaces })).toBe(0.5);
    // 그 칸이 없는 실행물은 못 읽은 것이다 — 자기 선언(alpha)으로 대신하지 않는다.
    expect(readAdapterAlpha({
      basis: "engine-surface",
      label: "b-1",
      surfaces: { engine: { surfaces: [{ label: "b-1", alpha: 1 }] } },
    })).toBeNull();
  });

  it("문서 안 표면은 opacity × filter 가 통과시키는 빛이다", () => {
    const surfaces = {
      contentViews: { dom: [{ label: "b-1", opacity: "0.5", filter: "brightness(0.5)" }] },
    };
    expect(readAdapterAlpha({ basis: "content-view-dom", label: "b-1", surfaces })).toBe(0.25);
    expect(readAdapterAlpha({
      basis: "content-view-dom",
      label: "b-1",
      surfaces: { contentViews: { dom: [{ label: "b-1", opacity: "1", filter: "none" }] } },
    })).toBe(1);
    // 물을 자리가 없으면 null 이다 — 상수 1 을 쓰면 이 축은 무엇이 걸려 있어도 통과한다.
    expect(readAdapterAlpha({
      basis: "content-view-dom",
      label: "b-1",
      surfaces: { contentViews: { dom: [{ label: "b-1" }] } },
    })).toBeNull();
  });

  it("장부·이름·값 중 하나라도 없으면 null 이다", () => {
    expect(readAdapterAlpha({ basis: null, label: "b-1" })).toBeNull();
    expect(readAdapterAlpha({ basis: "pane-host", label: "" })).toBeNull();
    expect(readAdapterAlpha({ basis: "png-pixels", label: "b-1" })).toBeNull();
  });
});
