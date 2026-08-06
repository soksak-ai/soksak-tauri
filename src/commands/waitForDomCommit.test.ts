// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { waitForDomCommit } from "./waitForDomCommit";

describe("waitForDomCommit", () => {
  it("이미 커밋된 조건은 즉시 끝난다", async () => {
    await expect(waitForDomCommit(() => true)).resolves.toBeUndefined();
  });

  it("DOM mutation 사건에서 조건을 다시 읽고 observer를 종료한다", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    const done = waitForDomCommit(() => node.dataset.open === "1", node);
    node.dataset.open = "1";
    await expect(done).resolves.toBeUndefined();
  });

  it("사건이 없으면 유한 상한으로 RED를 낸다", async () => {
    vi.useFakeTimers();
    const done = waitForDomCommit(() => false, document.documentElement, 25);
    const verdict = expect(done).rejects.toThrow("DOM 커밋 시간 초과(25ms)");
    await vi.advanceTimersByTimeAsync(25);
    await verdict;
    vi.useRealTimers();
  });
});
