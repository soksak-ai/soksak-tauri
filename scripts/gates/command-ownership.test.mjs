// 명령 소유 게이트의 기준.
//
// 이 게이트가 없던 동안 "다 됐다"고 말할 수 있었다 — 앱이 부르는 이름 중 64 개가 이 프레임워크
// 에서 아무도 답하지 않는데, 그 사실을 세는 자리가 없었기 때문이다. 그러니 이 게이트가 스스로
// 무너지지 않는 것이 곧 그 수의 신뢰다.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { duplicateProblems, frameworkTable, survey, verify } from "./command-ownership.mjs";

/** 실제 장부 — 상한만 바꿔 심을 때 나머지 항목을 그대로 쓴다. */
const LEDGER_PATH = join(process.cwd(), "scripts/gates/command-ownership.json");

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

describe("기계 출력", () => {
  // `--json` 은 기계가 읽는 자리다. 사람 줄이 한 줄이라도 섞이면 파싱이 통째로 죽고,
  // 그러면 이 인구조사를 다른 도구와 붙일 수 없다(실측: 판정 줄 하나가 JSON 뒤에 붙었다).
  it("--json 은 JSON 만 낸다", async () => {
    const { spawnSync } = await import("node:child_process");
    const gate = join(process.cwd(), "scripts/gates/command-ownership.mjs");
    const r = spawnSync(process.execPath, [gate, "--json"], { encoding: "utf8" });
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("답하지 않는 이름의 래칫", () => {
  // 사유를 적는 것은 진전이지만 **답이 아니다.** 부른 쪽에서 "선언거절"과 "미선언공백"은
  // 같은 사실이다 — 값을 못 받는다. 래칫이 미선언만 세면 사유를 적는 순간 그 이름은 세는
  // 자리에서 사라지고, 영원히 안 답해도 게이트는 통과한다.
  //
  // 실측(2026-07-30): sidecar_open 이 "선언거절"에 앉아 게이트를 통과하는 동안, 두 번째
  // 프레임워크의 렌더러는 그 이름을 139번 부르고 139번 NOT_SERVED_HERE 를 받았다. 브라우저
  // 엔진이 뜨지 못했고 사용자 화면에는 "엔진 서피스 생성 실패"만 남았다.
  it("선언거절도 답하지 않는 수에 든다", () => {
    const v = verify();
    const refused = v.rows.filter((r) => r.owner === "refused").length;
    expect(refused).toBeGreaterThan(0);
    expect(v.unanswered.length).toBe(refused + v.gaps.length);
  });

  it("답하지 않는 수가 상한을 넘으면 실패한다", () => {
    const doc = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    const tight = ledgerAt({ ...doc, unansweredCap: 0 });
    const v = verify(undefined, tight);
    expect(v.problems.some((p) => p.includes("답하지 않는"))).toBe(true);
  });

  // 상한이 실측보다 크면 그것은 다음 사람이 채워도 되는 빈자리다 — 래칫이 아니다.
  it("상한이 실측보다 크면 줄이라고 말한다", () => {
    const doc = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    const loose = ledgerAt({ ...doc, unansweredCap: 9999 });
    const v = verify(undefined, loose);
    expect(v.problems.some((p) => p.includes("상한을 줄여라"))).toBe(true);
  });
});

describe("두 장부는 한 벌이다", () => {
  // 프레임워크 갈래를 두 곳이 선언한다: 이식 장부(cored_ledger.rs FRAMEWORK_FAMILIES)가
  // "이 접두는 영영 안 옮긴다"고 세고, 프레임워크 표(native/index.cjs BRANCHES)가 "이 접두는
  // 내가 받는다"고 고른다. 갈라지면 그 사이 이름은 **어느 쪽에도 안 잡힌다** — 장부는 옮길
  // 것에서 빼고, 표는 안 받아 소켓으로 새고, cored 는 안 서빙한다.
  //
  // index.cjs 는 이 위험을 주석으로 적어 뒀지만 지키는 자리가 없었다. 여기가 그 자리다.
  it("프레임워크 갈래 선언이 양쪽에서 같다", () => {
    const list = (src, re) => [...src.matchAll(re)].map((m) => m[1]).sort();
    const js = readFileSync(join(process.cwd(), "frameworks/electron/native/index.cjs"), "utf8");
    const rs = readFileSync(join(process.cwd(), "frameworks/tauri/src/cored_ledger.rs"), "utf8");
    const branches = list(
      js.match(/const BRANCHES = \[([^\]]*)\]/)?.[1] ?? "",
      /"([a-z_]+)"/g,
    );
    const families = list(
      rs.match(/const FRAMEWORK_FAMILIES: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? "",
      /"([a-z_]+)"/g,
    );
    // 오라클 생존 — 한쪽이라도 못 읽으면 빈 배열끼리 같아져 통과로 위장한다.
    expect(branches.length).toBeGreaterThan(0);
    expect(families).toEqual(branches);
  });
});

describe("표를 읽는 눈", () => {
  // 주석 한 줄이 계측을 바꾸면 안 된다. `Command {` 와 `name:` 사이에 사유를 적는 것은
  // 이 저장소의 평범한 습관인데, 그 습관이 서빙하는 명령을 **공백으로 둔갑**시켰다
  // (실측 2026-07-30: download_verify 를 서빙하면서 게이트는 "어디서도 답하지 않는다"고 했다).
  it("선언 사이의 주석이 명령을 숨기지 못한다", async () => {
    const { coredServesIn } = await import("./command-ownership.mjs");
    const src = [
      "pub const COMMANDS: &[Command] = &[",
      "    Command {",
      "        name: \"plain_one\",",
      "    },",
      "    Command {",
      "        // 사유를 여기 적는다 — 그래도 이 이름은 서빙된다.",
      "        name: \"commented_one\",",
      "    },",
      "];",
    ].join("\n");
    const served = coredServesIn(src);
    expect([...served].sort()).toEqual(["commented_one", "plain_one"]);
  });

  // 거절 표(Unserved)를 서빙으로 세면 정직하게 적을수록 공백이 줄어든다 — 이미 한 번 겪은 함정이다.
  it("거절 표는 서빙으로 세지 않는다", async () => {
    const { coredServesIn } = await import("./command-ownership.mjs");
    const src = "Unserved {\n    // 사유\n    name: \"refused_one\",\n    blocked_by: \"x\",\n},";
    expect([...coredServesIn(src)]).toEqual([]);
  });
});

describe("계측은 파일 배치에 기대지 않는다", () => {
  // 표를 어느 파일에 두는지는 사람의 정리 문제이고, 무엇을 서빙/거절하는지는 사실이다.
  // 파일 이름을 못 박으면 그 둘이 묶여서, **코드를 옮기는 것만으로 인구조사가 바뀐다.**
  // 실측(2026-07-30): 거절 표 35건을 registry.rs 에서 unserved.rs 로 옮기자 공백이 27 → 62 로
  // 뛰었다. 아무것도 안 잃었는데 게이트는 이식이 35건 후퇴했다고 답했다.
  it("cored 의 표는 크레이트 전체에서 읽는다", () => {
    const { cored, refused } = survey();
    expect(cored.has("download_verify")).toBe(true);
    // 거절 표가 registry.rs 밖에 살아도 읽힌다.
    expect(refused.size).toBeGreaterThan(20);
    expect(refused.has("sidecar_open")).toBe(true);
  });
});
