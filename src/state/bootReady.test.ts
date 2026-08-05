import { afterEach, describe, expect, it } from "vitest";
import { useBootPhase } from "./bootPhase";
import { awaitBootReady } from "./bootReady";

afterEach(() => useBootPhase.getState().setPhase("ready"));

describe("boot ready event barrier", () => {
  it("이미 ready면 즉시 끝난다", async () => {
    useBootPhase.getState().setPhase("ready");
    await expect(awaitBootReady(50)).resolves.toEqual({ phase: "ready" });
  });

  it("activating→ready 상태 사건을 기다린다", async () => {
    useBootPhase.getState().setPhase("activating");
    const waiting = awaitBootReady(100);
    queueMicrotask(() => useBootPhase.getState().setPhase("ready"));
    await expect(waiting).resolves.toEqual({ phase: "ready" });
  });

  it("ready 사건이 없으면 유한 시간 뒤 실패한다", async () => {
    useBootPhase.getState().setPhase("restoring");
    await expect(awaitBootReady(5)).rejects.toThrow("boot ready 시간 초과");
  });
});
