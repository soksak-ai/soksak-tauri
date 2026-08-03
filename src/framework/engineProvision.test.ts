// @vitest-environment node
// 프레임워크는 자기가 무엇을 제공하는지 **스스로 밝힌다.**
//
// 플러그인은 필요만 적고(requiresEngine·requiresNativeChildWebview) 프레임워크도 OS 도 모른다.
// 그 필요를 채우는 쪽이 여기다. 이 선언이 없으면 코어가 "Tauri 면 이렇고 Electron 이면 저렇다"를
// 알아야 하고, 그 순간 프레임워크 이름이 코어 로직에 박힌다 — 경계가 막으려는 바로 그것이다.
import { describe, expect, it } from "vitest";
import { engineProvision as tauri } from "./tauri";
import { engineProvision as electron } from "./electron";

describe("프레임워크가 자기 제공을 밝힌다", () => {
  // WKWebView 는 chromium 등급이 아니다. 대신 자식 웹뷰를 창에 합성해 얹는 장치가 있다
  // (hole-punch·hitTest 스위즐) — 그래서 승격이 그 장치 위에서 이뤄진다.
  it("Tauri 는 등급 미달이고 자식 웹뷰 합성을 제공한다", () => {
    expect(tauri.chromium).toBe(false);
    expect(tauri.nativeChildWebview).toBe(true);
    expect(tauri.supportsDocumentStart).toBe(true);
    expect(tauri.supportsInputInjection).toBe(false);
  });

  // Electron 은 통째로 Chromium 이라 승격이 no-op 이다. 자식 웹뷰 합성 장치는 없다 —
  // 필요가 없기 때문이다(단일 Chromium 세계에서 뷰를 합성한다).
  it("Electron 은 등급을 갖췄고 자식 웹뷰 합성은 없다", () => {
    expect(electron.chromium).toBe(true);
    expect(electron.nativeChildWebview).toBe(false);
    expect(electron.supportsDocumentStart).toBe(false);
    expect(electron.supportsInputInjection).toBe(true);
  });

  // 두 답이 같으면 이 축은 아무것도 가르지 않는다("0 의 두 얼굴").
  it("두 프레임워크의 답이 실제로 갈린다", () => {
    expect(tauri).not.toEqual(electron);
  });
});
