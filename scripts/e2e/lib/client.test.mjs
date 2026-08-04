import { describe, expect, it } from "vitest";
import { commandRequestEnvelope } from "./client.mjs";

describe("e2e command request envelope", () => {
  it("유한 장기 작업의 공개 timeoutMs를 params가 아닌 소켓 봉투에 싣는다", () => {
    expect(commandRequestEnvelope(7, "ui.input.click", { recordFrames: 48 }, "w-a", {
      timeoutMs: 60_000,
    })).toEqual({
      id: 7,
      method: "ui.input.click",
      params: { recordFrames: 48 },
      window: "w-a",
      timeoutMs: 60_000,
    });
  });
});
