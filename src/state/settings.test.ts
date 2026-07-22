import { describe, expect, it, vi } from "vitest";

// jsdom localStorage 가 이 환경에선 비동작 스텁 → Map 기반 목으로 대체(pluginSettings.test 선례).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { useSettings } from "./settings";

// 탭 닫기 확인 정책(R6) — warn=위험 시 경고(기본), off=무조건 닫기.
describe("settings.tabCloseConfirm", () => {
  it("기본값은 warn(위험 시 경고)", () => {
    expect(useSettings.getState().tabCloseConfirm).toBe("warn");
  });

  it("setTabCloseConfirm 으로 off(무조건 닫기) 전환·복원", () => {
    useSettings.getState().setTabCloseConfirm("off");
    expect(useSettings.getState().tabCloseConfirm).toBe("off");
    useSettings.getState().setTabCloseConfirm("warn");
    expect(useSettings.getState().tabCloseConfirm).toBe("warn");
  });
});

describe("settings.railFocusNear", () => {
  it("기본은 원본 배열 유지이며 사용자가 근접 배치를 켜고 끌 수 있다", () => {
    expect(useSettings.getState().railFocusNear).toBe(false);
    useSettings.getState().setRailFocusNear(true);
    expect(useSettings.getState().railFocusNear).toBe(true);
    useSettings.getState().setRailFocusNear(false);
    expect(useSettings.getState().railFocusNear).toBe(false);
  });
});

// 관계면 3안 비교 스위치 — 비교 실험용 임시 축(결정 시 채택안만 남기고 소거).
describe("settings.railRelation", () => {
  it("기본값은 tint(스트로크·라벨 없는 저농도 채움)", () => {
    expect(useSettings.getState().railRelation).toBe("tint");
  });

  it("setRailRelation 으로 3안(tint|moment|stroke) 전환·복원", () => {
    useSettings.getState().setRailRelation("moment");
    expect(useSettings.getState().railRelation).toBe("moment");
    useSettings.getState().setRailRelation("stroke");
    expect(useSettings.getState().railRelation).toBe("stroke");
    useSettings.getState().setRailRelation("tint");
    expect(useSettings.getState().railRelation).toBe("tint");
  });
});
