// 실체 id 는 자기 종류를 스스로 말한다 — `<접두>-<base32 6자>`.
//
// (a) 이 게이트가 지키는 규칙
//     발급되는 모든 실체 id 는 /^(pjt|spc|pan|tab|sh)-[a-z2-7]{6}$/ 를 만족한다.
//     접두는 종류와 1:1 이다 — project=pjt / space=spc / pane=pan / tab=tab / 셸 세션=sh.
//     문자열 하나만 봐도 그것이 무엇인지 알 수 있어야 하고, 카운터가 아니어야 전역에서
//     유일하다. 창 라벨(`w-<uuid4>`)은 이 규칙 밖이다 — 이미 전역 유일·불투명이고 개명
//     이득이 0 이다. 배치 트리의 내부 노드(split)도 실체가 아니므로 접두를 받지 않는다 —
//     주소·명령·문서 어디에도 나오지 않기 때문이다.
//
// (b) RED 근거(실측, 2026-07-26)
//     `src/state/sessions.ts` 의 발급기가 카운터다 — `v${nextViewId++}` 꼴이라
//     newIds() 가 `t2`·`v2`·`g2`·`s1`·`c2` 를 낸다. 접두는 이름과 무관하고(프로젝트가 `t`,
//     스페이스가 `c`), 재실행마다 reseed 되어 창을 넘으면 같은 값이 재등장한다.
//     그래서 `{"panel":"g5"}` 는 어느 g5 인지 말하지 못한다.
//
// (c) 그 수를 만든 셸 질의
//     $ grep -nE '`[a-z]\$\{next[A-Za-z]*Id' src/state/sessions.ts | wc -l   # → 10
//       (발급 5: newViewId·newGroupId·newSplitId·newContentId·프로젝트 `t${nextProjectId++}`
//        + 미리보기 5: newIds() 의 project·view·group·split·content)
//     $ npx vitest run src/state/ids.test.ts
//
// 레지스트리·창 없이 세울 수 있는 규칙이므로 앱을 띄우지 않는다. 발급 결과는 newIds() 로
// 읽고(비파괴 미리보기 — 다음에 발급될 값 그대로), 발급기의 모양은 소스를 읽어 센다
// (commandMessages.test 와 같은 방식).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newIds } from "./sessions";

/** 실체 id 형식 — 접두 + base32(RFC4648 소문자) 6자. */
const ENTITY_ID = /^(pjt|spc|pan|tab|sh)-[a-z2-7]{6}$/;
/** 카운터 모양 — `t1`·`g5`·`v7`. 전역 유일하지 않고 종류도 말하지 않는다. */
const COUNTER_ID = /^[a-z]+\d+$/;

/** newIds() 축 → 어휘상 실체와 그 접두. split 은 실체가 아니라 여기 없다. */
const ENTITY_AXIS: { axis: "project" | "content" | "group" | "view"; name: string; prefix: string }[] =
  [
    { axis: "project", name: "project", prefix: "pjt" },
    { axis: "content", name: "space", prefix: "spc" },
    { axis: "group", name: "pane", prefix: "pan" },
    { axis: "view", name: "tab", prefix: "tab" },
  ];

const SRC = readFileSync(join(__dirname, "sessions.ts"), "utf8");
/** `x${nextXId...}` — 카운터를 문자열로 굳히는 자리(발급기와 그 미리보기).
 *  split(`s`)은 예외다 — 내부 노드는 실체가 아니므로(§1-2) 카운터 존치가 표준이고,
 *  아래 "split id 는 실체 접두를 받지 않는다" 잠금과 한 쌍이다. 초판이 s 까지 세어
 *  자기 잠금과 모순됐다(정정 2026-07-26). */
const COUNTER_LITERAL = /`[a-rt-z]\$\{next[A-Za-z]*Id/g;

describe("실체 id 는 자기 종류를 말한다", () => {
  it("세는 대상이 실재한다 — 빈 집합이 통과로 위장하지 않는다", () => {
    const ids = newIds();
    expect(ENTITY_AXIS.map((e) => e.axis).every((a) => typeof ids[a] === "string")).toBe(true);
  });

  for (const { axis, name, prefix } of ENTITY_AXIS) {
    it(`${name} id 는 ${prefix}- 접두에 base32 6자다`, () => {
      const id = newIds()[axis];
      expect(id).toMatch(ENTITY_ID);
      expect(id.startsWith(`${prefix}-`)).toBe(true);
    });
  }

  it("카운터 모양 id 는 하나도 발급되지 않는다 — 창을 넘으면 같은 값이 재등장한다", () => {
    const ids = newIds();
    const counters = ENTITY_AXIS.map((e) => ids[e.axis]).filter((id) => COUNTER_ID.test(id));
    expect(counters).toEqual([]);
  });

  it("접두는 종류마다 다르다 — 접두가 겹치면 문자열만으로 종류를 못 가른다", () => {
    const ids = newIds();
    const prefixes = ENTITY_AXIS.map((e) => ids[e.axis].split("-")[0]);
    expect(new Set(prefixes).size).toBe(ENTITY_AXIS.length);
  });
});

describe("발급기 자체가 카운터를 굳히지 않는다", () => {
  it("소스에 실체 축의 `x${nextXId}` 꼴이 0건이다 — 미리보기만 고치면 발급은 그대로다", () => {
    expect(SRC.match(COUNTER_LITERAL) ?? []).toEqual([]);
  });
});

describe("배치 트리의 내부 노드는 실체가 아니다", () => {
  // 이 절은 지금도 통과한다. 개명하며 내부 노드에 실체 접두를 얹는 것을 막는 잠금이다 —
  // 내부 노드는 이름이 없고, 모든 골은 어떤 pane 의 right/bottom 모서리로 지목된다.
  it("split id 는 실체 접두를 받지 않는다", () => {
    expect(newIds().split).not.toMatch(ENTITY_ID);
  });
});
