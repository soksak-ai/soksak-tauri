// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layoutTransactionVerdict } from "./layout-transaction-verdict.mjs";

describe("layout transition machine verdict", () => {
  it("녹화가 없어도 닫힌 layout 거래 하나를 GREEN으로 판정한다", () => {
    const verdict = layoutTransactionVerdict([{
      transactionId: "layout-4", sequence: 4, phase: "committed", mode: "snap",
      preparedAtUnixMs: 100, closedAtUnixMs: 101,
      moves: [{ viewId: "iana", dx: 322 }],
    }], { afterSequence: 3, expectedMode: "snap", candidateViewIds: ["iana", "other"] });
    expect(verdict).toMatchObject({ ok: true, transaction: { transactionId: "layout-4" } });
  });

  it("안 닫힌 거래·중복 거래·빈 이동을 RED로 만든다", () => {
    const entry = {
      transactionId: "layout-2", sequence: 2, phase: "prepared", mode: "glide",
      preparedAtUnixMs: 100, moves: [],
    };
    const verdict = layoutTransactionVerdict([entry, { ...entry, sequence: 3 }], {
      afterSequence: 1, expectedMode: "snap", candidateViewIds: ["iana"],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(expect.arrayContaining([
      "transactions=2/1", "phase=prepared/committed", "mode=glide/snap", "moves=0",
    ]));
  });
});
