// 명령 소유 게이트의 기준.
//
// 이 게이트가 없던 동안 "다 됐다"고 말할 수 있었다 — 앱이 부르는 이름 중 64 개가 이 프레임워크
// 에서 아무도 답하지 않는데, 그 사실을 세는 자리가 없었기 때문이다. 그러니 이 게이트가 스스로
// 무너지지 않는 것이 곧 그 수의 신뢰다.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { survey, verify } from "./command-ownership.mjs";

function ledgerAt(doc) {
  const dir = mkdtempSync(join(tmpdir(), "cmd-own-"));
  const p = join(dir, "ledger.json");
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

describe("명령 소유 실측", () => {
  const { rows } = survey();

  /** 오라클 생존 — 이름을 하나도 못 읽으면 이 게이트는 아무것도 안 지키면서 통과한다. */
  it("앱이 부르는 이름을 실제로 읽는다", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.some((r) => r.name === "window_list")).toBe(true);
  });

  it("소유는 넷 중 하나로만 판정된다", () => {
    for (const r of rows) {
      expect(["core", "framework", "renderer", "gap"]).toContain(r.owner);
    }
  });
});

describe("장부 대조", () => {
  it("이 저장소는 통과한다 — 모든 공백이 사유와 갈 자리를 달고 있다", () => {
    const { problems } = verify();
    expect(problems).toEqual([]);
  });

  /** 선언 없는 공백은 통과하지 못한다 — 그것이 이 게이트의 존재 이유다. */
  it("선언되지 않은 공백은 실패한다", () => {
    const { problems } = verify(undefined, ledgerAt({ cap: 999, gaps: {} }));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/장부에 없다/);
  });

  /** 사유만 있고 갈 자리가 없으면 부채가 어디로 갚히는지 아무도 모른다. */
  it("갈 자리 없는 선언은 실패한다", () => {
    const { gaps } = verify();
    const one = gaps[0].name;
    const doc = { cap: 999, gaps: {} };
    for (const g of gaps) doc.gaps[g.name] = { why: "사유가 충분히 길다", to: "core" };
    delete doc.gaps[one].to;
    const { problems } = verify(undefined, ledgerAt(doc));
    expect(problems.join("\n")).toMatch(new RegExp(`${one}: 갈 자리`));
  });

  /** 고친 것을 장부가 계속 부채로 들면 그 수가 거짓이 된다. */
  it("이미 답하는 이름이 장부에 남아 있으면 실패한다", () => {
    const { gaps } = verify();
    const doc = { cap: 999, gaps: { window_list: { why: "이미 답한다 — 남아 있으면 안 된다", to: "core" } } };
    for (const g of gaps) doc.gaps[g.name] = { why: "사유가 충분히 길다", to: "core" };
    const { problems } = verify(undefined, ledgerAt(doc));
    expect(problems.join("\n")).toMatch(/window_list: 이제 누군가 답한다/);
  });

  /** 래칫 — 이식 없이 표면을 늘리지 못한다. */
  it("공백이 상한을 넘으면 실패한다", () => {
    const { gaps } = verify();
    const doc = { cap: gaps.length - 1, gaps: {} };
    for (const g of gaps) doc.gaps[g.name] = { why: "사유가 충분히 길다", to: "core" };
    const { problems } = verify(undefined, ledgerAt(doc));
    expect(problems.join("\n")).toMatch(/상한/);
  });
});
