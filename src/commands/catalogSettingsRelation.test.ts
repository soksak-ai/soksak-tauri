// 관계면 3안 스위치(railRelation)의 명령 표면 — sok CLI 로 즉시 전환 가능해야 한다.
// settings.set 은 SETTING_KEYS 화이트리스트 + per-key 검증이라 두 배선(enum 등재,
// switch case) 중 하나만 빠져도 INVALID_PARAMS 또는 무적용 거짓 성공이 된다.
// 비교 실험용 임시 축 — 3안 결정 시 설정 축과 함께 소거.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", () => ({ invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { serialize, useSettings } from "../state/settings";

registerCatalog();

beforeEach(() => {
  useSettings.setState({ railRelation: "stroke" });
});

describe("settings.windowZoom 명령 표면", () => {
  it("get 반환(기본 1) + set 클램프 적용, appFontSize 키는 거부", async () => {
    const g = await execute("settings.get", {}, {});
    expect((g.data as { windowZoom: number }).windowZoom).toBe(1);
    const on = await execute("settings.set", { key: "windowZoom", value: 1.5 }, {});
    expect(on.ok).toBe(true);
    expect(useSettings.getState().windowZoom).toBe(1.5);
    const dead = await execute("settings.set", { key: "appFontSize", value: 14 }, {});
    expect(dead.ok).toBe(false);
    await execute("settings.set", { key: "windowZoom", value: 1 }, {});
  });
});

describe("settings.focusDim 명령 표면", () => {
  it("settings.get 반환(기본 false) + set 으로 토글, 비불리언 거부", async () => {
    const g = await execute("settings.get", {}, {});
    expect((g.data as { focusDim: boolean }).focusDim).toBe(true);
    const off = await execute("settings.set", { key: "focusDim", value: false }, {});
    expect(off.ok).toBe(true);
    expect(useSettings.getState().focusDim).toBe(false);
    const bad = await execute("settings.set", { key: "focusDim", value: "yes" }, {});
    expect(bad.ok).toBe(false);
    await execute("settings.set", { key: "focusDim", value: true }, {});
  });
});

describe("settings.railSeamStyle 명령 표면", () => {
  it("get 반환(기본 edge) + set seam|edge, 그 외 거부", async () => {
    const g = await execute("settings.get", {}, {});
    expect((g.data as { railSeamStyle: string }).railSeamStyle).toBe("edge");
    const on = await execute("settings.set", { key: "railSeamStyle", value: "edge" }, {});
    expect(on.ok).toBe(true);
    expect(useSettings.getState().railSeamStyle).toBe("edge");
    const bad = await execute("settings.set", { key: "railSeamStyle", value: "dotted" }, {});
    expect(bad.ok).toBe(false);
    await execute("settings.set", { key: "railSeamStyle", value: "edge" }, {});
  });
});

describe("settings.railFill 명령 표면", () => {
  it("settings.get 이 railFill 을 반환한다(기본 none)", async () => {
    const result = await execute("settings.get", {}, {});
    expect(result.ok).toBe(true);
    expect((result.data as { railFill: string }).railFill).toBe("none");
  });

  it("settings.set 으로 none|faint 전환, 그 외 값은 거부", async () => {
    const on = await execute("settings.set", { key: "railFill", value: "faint" }, {});
    expect(on.ok).toBe(true);
    expect(useSettings.getState().railFill).toBe("faint");
    const off = await execute("settings.set", { key: "railFill", value: "none" }, {});
    expect(off.ok).toBe(true);
    expect(useSettings.getState().railFill).toBe("none");
    const bad = await execute("settings.set", { key: "railFill", value: "heavy" }, {});
    expect(bad.ok).toBe(false);
  });
});

describe("settings.railRelation 명령 표면", () => {
  it("settings.get 이 railRelation 을 반환한다(기본 stroke)", async () => {
    const result = await execute("settings.get", {}, {});
    expect(result.ok).toBe(true);
    expect((result.data as { railRelation: string }).railRelation).toBe("stroke");
  });

  it("settings.set 으로 3안을 즉시 전환한다", async () => {
    for (const mode of ["moment", "tint", "stroke"] as const) {
      const result = await execute(
        "settings.set",
        { key: "railRelation", value: mode },
        {},
      );
      expect(result.ok).toBe(true);
      expect(useSettings.getState().railRelation).toBe(mode);
    }
  });

  it("3안 밖의 값은 INVALID_PARAMS 로 거부하고 적용하지 않는다", async () => {
    const result = await execute(
      "settings.set",
      { key: "railRelation", value: "badge" },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(useSettings.getState().railRelation).toBe("stroke");
  });
});

describe("설정 읽기 표면", () => {
  it("저장되는 설정은 전부 읽힌다 — 못 읽는 값은 진단할 수 없다", async () => {
    // 실사고 2026-08-02: railLook 은 저장되는데 읽을 자리도 바꿀 자리도 없었다. 그래서
    // 사용자 화면의 조건이 무엇인지 물어볼 수조차 없었고, 재현이 "안 된다"로 끝났다.
    // 쓰기는 좁아도 된다(전용 명령이 자기 검증을 진다). 읽기는 좁으면 안 된다.
    const persisted = Object.keys(serialize(useSettings.getState()));
    const got = await execute("settings.get", {}, {});
    expect(got.ok).toBe(true);
    const data = got.data as Record<string, unknown>;
    const missing = persisted.filter((k) => !(k in data));
    expect(missing).toEqual([]);
  });
});
