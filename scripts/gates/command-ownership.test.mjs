// 명령 소유 게이트의 기준.
//
// 이 게이트가 없던 동안 "다 됐다"고 말할 수 있었다 — 앱이 부르는 이름 중 64 개가 이 프레임워크
// 에서 아무도 답하지 않는데, 그 사실을 세는 자리가 없었기 때문이다. 그러니 이 게이트가 스스로
// 무너지지 않는 것이 곧 그 수의 신뢰다.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { duplicateProblems, frameworkTable, survey, verify } from "./command-ownership.mjs";

function ledgerAt(doc) {
  const dir = mkdtempSync(join(tmpdir(), "cmd-own-"));
  const p = join(dir, "ledger.json");
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

/** 심은 표 하나를 파일로 세운다 — 실제 트리를 건드리지 않고 판정 규칙만 잰다. */
function tableAt(files) {
  const root = mkdtempSync(join(tmpdir(), "cmd-own-tbl-"));
  mkdirSync(join(root, "t"), { recursive: true });
  for (const [name, src] of Object.entries(files)) writeFileSync(join(root, "t", name), src);
  return root;
}

/** 표 항목 한 벌 — 실제 표와 같은 들여쓰기(2칸)여야 파서가 본다. */
const entry = (name, kind) =>
  `  ${name}: {\n    concept: "심은 것",\n    ${kind}: "심은 사유",\n  },\n`;

describe("명령 소유 실측", () => {
  const { rows } = survey();

  /** 오라클 생존 — 이름을 하나도 못 읽으면 이 게이트는 아무것도 안 지키면서 통과한다. */
  it("앱이 부르는 이름을 실제로 읽는다", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.some((r) => r.name === "window_list")).toBe(true);
  });

  it("소유는 여섯 중 하나로만 판정된다", () => {
    for (const r of rows) {
      expect(["core", "framework", "renderer", "absent", "refused", "gap"]).toContain(r.owner);
    }
  });

  /**
   * **absent 는 framework 가 아니다.**
   *
   * absent 는 "이 프레임워크엔 그 개념이 없다"는 선언이고, 그 이름을 부른 쪽이 받는 것은
   * FRAMEWORK_CONCEPT_ABSENT 다. framework 로 세면 이 프레임워크가 답하는 표면이 부풀려진다 —
   * 실측(2026-07-29): framework 로 세던 24 중 10 이 absent 선언이었고, 갈라 센 뒤 그 24 는
   * framework 15 · absent 9 가 된다(열 중 하나였던 webview_emit_native 는 지운 중복이라
   * answer 로 돌아갔다).
   */
  it("absent 항목의 owner 는 framework 가 아니다", () => {
    const { owners } = frameworkTable();
    const absent = [...owners].filter(([, k]) => k === "absent").map(([n]) => n);
    // 오라클 생존 — absent 를 하나도 못 읽으면 아래 루프는 아무것도 안 지킨다.
    expect(absent.length).toBeGreaterThan(0);
    for (const name of absent) {
      const row = rows.find((r) => r.name === name);
      if (!row) continue; // 앱이 안 부르는 이름은 이 장부의 대상이 아니다
      expect(row.owner).toBe("absent");
    }
  });

  /** 게이트 자격 — 심은 표로 세 갈래가 실제로 갈리는지 본다. 안 갈리면 위 검사는 헛것이다. */
  it("answer·delegated·absent 가 갈린다", () => {
    const root = tableAt({
      "a.cjs":
        "module.exports = {\n" +
        "  x_one: {\n    concept: \"답한다\",\n    answer: () => 1,\n  },\n" +
        entry("x_two", "delegated") +
        entry("x_three", "absent") +
        "};\n",
    });
    const { owners, duplicates } = frameworkTable(root, "t");
    expect(owners.get("x_one")).toBe("framework");
    expect(owners.get("x_two")).toBe("renderer");
    expect(owners.get("x_three")).toBe("absent");
    expect(duplicates).toEqual([]);
  });

  /**
   * 사유를 달고 거절한 것은 서빙이 아니다 — 갈라 세지 않으면 **정직하게 적을수록 공백이
   * 줄어든다.** 실측(2026-07-29): `name:` 을 통째로 긁어 Arg 이름 48 개와 UNSERVED 19 개까지
   * 서빙으로 세고 있었다(130 vs 실제 Command 63).
   */
  it("cored 의 거절은 서빙으로 세지 않는다", () => {
    const refused = rows.filter((r) => r.owner === "refused");
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) expect(r.why && r.why.length).toBeGreaterThan(10);
    // Arg 이름은 명령이 아니다 — 하나라도 core 로 세어지면 계측이 다시 거짓이 된다.
    for (const bad of ["host", "port", "entries", "root"]) {
      expect(rows.some((r) => r.name === bad && r.owner === "core")).toBe(false);
    }
  });
});

describe("표의 중복 선언", () => {
  /**
   * **한 파일 안의 중복**은 적재가 원리상 못 본다 — `Object.entries` 는 이미 접힌 객체를
   * 받는다. 텍스트에서만 둘 다 보인다. 실측: `webview_emit_native` 가 answer 와 absent 로
   * 두 번 선언되어 그 명령이 항상 거절됐는데 적재도 표도 조용했다.
   */
  it("같은 파일 안의 중복 선언을 잡는다", () => {
    const root = tableAt({
      "a.cjs":
        "module.exports = {\n" +
        "  x_dup: {\n    concept: \"답한다\",\n    answer: () => 1,\n  },\n" +
        entry("x_dup", "absent") +
        "};\n",
    });
    const { duplicates } = frameworkTable(root, "t");
    expect(duplicates.map((d) => d.name)).toEqual(["x_dup"]);
  });

  /** 파일 사이의 중복도 같은 자리에서 잡는다 — 적재는 이쪽만 볼 수 있다. */
  it("파일 사이의 중복 선언을 잡는다", () => {
    const root = tableAt({
      "a.cjs": "module.exports = {\n" + entry("x_dup", "absent") + "};\n",
      "b.cjs": "module.exports = {\n" + entry("x_dup", "absent") + "};\n",
    });
    const { duplicates } = frameworkTable(root, "t");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].first).not.toBe(duplicates[0].again);
  });

  /** 이 트리에는 중복이 없다 — 규칙 검사만 하면 "실제로는 있다"가 조용히 남는다. */
  it("이 저장소의 표에는 중복이 없다", () => {
    expect(frameworkTable().duplicates).toEqual([]);
  });

  /** 중복은 게이트를 **실패시킨다** — 잡기만 하고 통과시키면 아무것도 막지 않는다. */
  it("중복은 문제로 올라간다", () => {
    const root = tableAt({
      "a.cjs": "module.exports = {\n" + entry("x_dup", "absent") + "};\n",
      "b.cjs": "module.exports = {\n" + entry("x_dup", "absent") + "};\n",
    });
    const { duplicates } = frameworkTable(root, "t");
    const problems = duplicateProblems(duplicates);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/x_dup: 표에 두 번 선언됐다/);
    // 중복이 없으면 문제도 없다 — 상시 실패하는 게이트는 곧 꺼진다.
    expect(duplicateProblems([])).toEqual([]);
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
