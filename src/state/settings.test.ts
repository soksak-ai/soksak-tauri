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

// 포커스 스포트라이트 실험 — 전체를 가라앉히고 선택만 명확하게(결정 시 소거).
describe("settings.focusDim", () => {
  it("기본값은 off", () => {
    expect(useSettings.getState().focusDim).toBe(false);
  });
  it("setFocusDim 으로 on/off", () => {
    useSettings.getState().setFocusDim(true);
    expect(useSettings.getState().focusDim).toBe(true);
    useSettings.getState().setFocusDim(false);
    expect(useSettings.getState().focusDim).toBe(false);
  });
});

// 결부 바탕 2안 비교 스위치(사용자 요청: ① 빼기 ② 아주 옅게) — 결정 시 채택안만 남기고 소거.
describe("settings.railFill", () => {
  it("기본값은 none(바탕 없음 — 1안 선행)", () => {
    expect(useSettings.getState().railFill).toBe("none");
  });

  it("setRailFill 로 none|faint 전환·복원", () => {
    useSettings.getState().setRailFill("faint");
    expect(useSettings.getState().railFill).toBe("faint");
    useSettings.getState().setRailFill("none");
    expect(useSettings.getState().railFill).toBe("none");
  });
});

// 관계면 3안 비교 스위치 — 비교 실험용 임시 축(결정 시 채택안만 남기고 소거).
describe("settings.railRelation", () => {
  it("기본값은 stroke(보더+라벨 — 사용자 확정)", () => {
    expect(useSettings.getState().railRelation).toBe("stroke");
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
