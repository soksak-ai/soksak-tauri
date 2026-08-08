// **거절 메시지는 무엇을 하라는 말이어야 한다.**
//
// 사용자가 받은 문장: "이 노드는 다른 realm 의 투영입니다(plugin-view) — 호스트에 꽂은 사건은
// 그 안에 닿지 않습니다: <주소>. 이 명령은 아직 그 realm 으로 가는 길이 없습니다(포인터
// 게스처·채우기는 넘어갑니다)."
//
// 이 문장은 우리 내부 구조를 설명한다 — realm, 투영, 호스트에 꽂은 사건. 받는 쪽은 그 단어의
// 뜻을 모르고, 다 읽어도 **다음에 무엇을 부를지** 모른다. 코드 주석은 구조를 말해야 하지만
// 사람에게 나가는 문장은 다음 행동을 말해야 한다.
//
// 그래서 거절 문장에 두 규칙을 세운다: 내부 어휘를 쓰지 않는다, 그리고 대신 부를 것을 말한다.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 사람에게 나가는 자리에서 쓰지 않는 내부 어휘 — 우리 구조의 이름이지 사용자의 말이 아니다. */
const INTERNAL_WORDS = [
  "realm",
  "투영",
  "꽂은",
  "꽂으면",
  "plugin-view",
  "renderer",
];

/** 이 파일들이 사람에게 문장을 낸다. */
function messageStrings(): { file: string; text: string }[] {
  const dir = join(__dirname);
  const out: { file: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const source = readFileSync(join(dir, name), "utf8");
    // `message:` 한 줄만 보면 이어 붙인 문장의 **뒤쪽이 안 잡힌다** — 조언은 보통 뒤에 붙으므로
    // 그 절반만 재면 이 검사는 통과할 수 없는 규칙이 된다. 표현식 전체를 읽는다: `message:` 부터
    // 괄호 깊이 0 에서 끝나는 쉼표까지.
    for (const m of source.matchAll(/message:\s/g)) {
      let depth = 0;
      let index = m.index! + m[0].length;
      const start = index;
      for (; index < source.length; index += 1) {
        const ch = source[index]!;
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (ch === "," && depth === 0) break;
        else if (ch === "\n" && depth === 0 && /^\s*[a-zA-Z_}]/.test(source.slice(index + 1, index + 40))) {
          // 다음 줄이 새 키로 시작하면 이 표현식은 끝났다.
          if (!/[+\\(]\s*$/.test(source.slice(start, index))) break;
        }
      }
      const text = source.slice(start, index).trim();
      if (text.startsWith("`") || text.startsWith('"')) out.push({ file: name, text });
    }
  }
  return out;
}

describe("거절 문장은 사람의 말로 쓴다", () => {
  it("내부 어휘가 사람에게 나가지 않는다", () => {
    const leaked = messageStrings().filter((row) =>
      INTERNAL_WORDS.some((word) => row.text.includes(word)),
    );
    expect(leaked.map((r) => `${r.file}: ${r.text.slice(0, 90)}`)).toEqual([]);
  });

  // "길이 없습니다" 로 끝나면 받는 쪽은 자기가 틀린 줄 알고 같은 것을 다시 부른다.
  it("할 수 없다고만 말하고 끝내지 않는다 — 대신 부를 것을 말한다", () => {
    const dead = messageStrings().filter(
      (row) =>
        /없습니다|못했습니다|불가/.test(row.text) &&
        !/\$\{/.test(row.text.slice(row.text.indexOf("없습니다"))) &&
        !/(하세요|하십시오|씁니다|쓰세요|부르세요|필요|먼저)/.test(row.text),
    );
    expect(dead.map((r) => `${r.file}: ${r.text.slice(0, 90)}`)).toEqual([]);
  });
});
