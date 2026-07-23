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
  it("기본은 근접 배치 on(사용자 확정 — 현행이 기본)이며 켜고 끌 수 있다", () => {
    expect(useSettings.getState().railFocusNear).toBe(true);
    useSettings.getState().setRailFocusNear(true);
    expect(useSettings.getState().railFocusNear).toBe(true);
    useSettings.getState().setRailFocusNear(false);
    expect(useSettings.getState().railFocusNear).toBe(false);
  });
});

// 포커스 스포트라이트(정식 설정, 기본 on) — 전체를 가라앉히고 선택만 명확하게.
describe("settings.focusDim", () => {
  it("기본값은 on(사용자 확정 — 현행이 기본)", () => {
    expect(useSettings.getState().focusDim).toBe(true);
  });
  it("setFocusDim 으로 on/off", () => {
    useSettings.getState().setFocusDim(true);
    expect(useSettings.getState().focusDim).toBe(true);
    useSettings.getState().setFocusDim(false);
    expect(useSettings.getState().focusDim).toBe(false);
  });
});

// 교체-인접 표시 — 정식 설정(기본 edge=사용자 채택, seam 은 선택지로 유지).
describe("settings.railSeamStyle", () => {
  it("기본값은 edge(바깥 변 점선 — 사용자 채택)", () => {
    expect(useSettings.getState().railSeamStyle).toBe("edge");
  });
  it("setRailSeamStyle 로 seam|edge 전환", () => {
    useSettings.getState().setRailSeamStyle("edge");
    expect(useSettings.getState().railSeamStyle).toBe("edge");
    useSettings.getState().setRailSeamStyle("seam");
    expect(useSettings.getState().railSeamStyle).toBe("seam");
  });
});

// 결부 패널 바탕(정식 설정, 기본 none — 사용자 확정).
describe("settings.railFill", () => {
  it("기본값은 none(바탕 없음 — 사용자 확정)", () => {
    expect(useSettings.getState().railFill).toBe("none");
  });

  it("setRailFill 로 none|faint 전환·복원", () => {
    useSettings.getState().setRailFill("faint");
    expect(useSettings.getState().railFill).toBe("faint");
    useSettings.getState().setRailFill("none");
    expect(useSettings.getState().railFill).toBe("none");
  });
});

// 관계면 표현(정식 설정) — stroke 기본.
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
