// IME 판정 원장 — 전이만 발행하고, 어느 신호로 판정했는지 남기는가.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  framework: { name: "tauri", invoke: (...a: unknown[]) => invoke(...(a as [])) },
}));

import { __resetImeLedgerForTest, noteImeDecision } from "./imeLedger";
import { isComposingEnter } from "./imeKeys";

beforeEach(() => {
  invoke.mockClear();
  __resetImeLedgerForTest();
});
afterEach(() => vi.restoreAllMocks());

/** 발행된 ime.decision payload 들. */
function published(): Record<string, unknown>[] {
  return invoke.mock.calls
    .filter((c) => (c as unknown[])[0] === "activity_publish")
    .map((c) => ((c as unknown[])[1] as { payload: Record<string, unknown> }).payload);
}

describe("IME 판정 원장", () => {
  it("어느 신호로 판정했는지 남긴다 — isComposing 이 없으면 그 사실이 진단이다", () => {
    noteImeDecision({ isComposing: true, legacy: false, composing: true });
    expect(published()[0]).toMatchObject({ signal: "isComposing", composing: true });

    noteImeDecision({ isComposing: false, legacy: true, composing: true });
    // 엔진이 isComposing 을 안 싣고 레거시로만 잡힌다 = 프레임워크 교체 후 가장 먼저 보이는 신호.
    expect(published()[1]).toMatchObject({ signal: "legacy-229", composing: true });
  });

  it("같은 판정이 이어지면 도배하지 않고, 바뀔 때만 발행한다", () => {
    for (let i = 0; i < 5; i++) {
      noteImeDecision({ isComposing: true, legacy: false, composing: true });
    }
    expect(published()).toHaveLength(1);

    noteImeDecision({ isComposing: false, legacy: false, composing: false });
    const all = published();
    expect(all).toHaveLength(2);
    // 전이가 신호다 — 직전 상태가 몇 번 반복됐는지 함께 실어야 "갑자기 사라졌다"를 읽는다.
    expect(all[1]).toMatchObject({ signal: "none", previousRepeats: 5 });
  });

  it("활성 프레임워크 이름을 싣는다 — 어느 프레임워크에서 난 일인가", () => {
    noteImeDecision({ isComposing: true, legacy: false, composing: true });
    expect(published()[0]).toMatchObject({ framework: "tauri" });
  });

  it("Enter 가 아니면 판정도 발행도 없다", () => {
    const e = { key: "a", nativeEvent: { isComposing: true }, keyCode: 65 } as never;
    expect(isComposingEnter(e)).toBe(false);
    expect(published()).toHaveLength(0);
  });

  it("조합 확정 Enter 는 커밋이 아니다 — 판정과 원장이 함께 간다", () => {
    const e = { key: "Enter", nativeEvent: { isComposing: true }, keyCode: 13 } as never;
    expect(isComposingEnter(e)).toBe(true);
    expect(published()[0]).toMatchObject({ composing: true, signal: "isComposing" });
  });

  it("레거시 229 만 오는 엔진에서도 커밋을 막는다", () => {
    const e = { key: "Enter", nativeEvent: { isComposing: false }, keyCode: 229 } as never;
    expect(isComposingEnter(e)).toBe(true);
    expect(published()[0]).toMatchObject({ signal: "legacy-229" });
  });
});
