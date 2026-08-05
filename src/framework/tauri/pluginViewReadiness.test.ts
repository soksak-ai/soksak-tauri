import { describe, expect, it } from "vitest";
import { PluginViewReadiness } from "./pluginViewReadiness";

describe("plugin view presentation readiness", () => {
  it("필요한 grouped 수가 이미 충족되면 즉시 답한다", async () => {
    const readiness = new PluginViewReadiness();
    readiness.set("p1", true);
    await expect(readiness.wait(1, 50)).resolves.toEqual({ total: 1, grouped: 1, pending: [] });
  });

  it("grouped 상태 변경 사건을 기다린다", async () => {
    const readiness = new PluginViewReadiness();
    readiness.set("p1", false);
    const waiting = readiness.wait(1, 100);
    queueMicrotask(() => readiness.set("p1", true));
    await expect(waiting).resolves.toEqual({ total: 1, grouped: 1, pending: [] });
  });

  it("필요한 grouped 수를 못 채우면 유한 시간 뒤 실패한다", async () => {
    const readiness = new PluginViewReadiness();
    readiness.set("p1", false);
    await expect(readiness.wait(1, 5)).rejects.toThrow("presentation ready 시간 초과");
  });
});
