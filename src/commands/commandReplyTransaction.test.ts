import { describe, expect, it, vi } from "vitest";
import { completeCommandReply } from "./commandReplyTransaction";

describe("command reply transaction", () => {
  it("결과 전달이 끝난 뒤에만 후속 거래를 실행한다", async () => {
    let release!: () => void;
    const reply = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const afterReply = vi.fn();

    const transaction = completeCommandReply(reply, [afterReply], vi.fn());
    await Promise.resolve();
    expect(afterReply).not.toHaveBeenCalled();

    release();
    await expect(transaction).resolves.toBe(true);
    expect(afterReply).toHaveBeenCalledTimes(1);
  });

  it("결과 전달이 실패하면 후속 거래를 실행하지 않아 재시도를 보존한다", async () => {
    const failure = new Error("transport closed");
    const afterReply = vi.fn();
    const onReplyFailure = vi.fn();

    await expect(completeCommandReply(
      () => Promise.reject(failure),
      [afterReply],
      onReplyFailure,
    )).resolves.toBe(false);
    expect(onReplyFailure).toHaveBeenCalledWith(failure);
    expect(afterReply).not.toHaveBeenCalled();
  });
});
