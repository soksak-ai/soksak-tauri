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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSettings } from "../state/settings";

registerCatalog();

beforeEach(() => {
  useSettings.setState({ railRelation: "stroke" });
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
