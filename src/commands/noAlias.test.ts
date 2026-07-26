// 같은 동작에 이름은 하나다 (표준 S6 / 증상 C5).
//
// (a) 이 게이트가 지키는 규칙
//     ① 별명 선언 금지 — description 이 "same as <다른 명령>" 이라고 스스로 말하면 실패.
//        같은 동작에 이름이 둘이면 호출자는 어느 쪽을 쓸지 짐작하고, 고칠 때는 한쪽만 고친다.
//     ② 같은 동사·같은 서명 금지 — 이름의 마지막 마디(동사)가 같고 선언된 (params, returns)
//        서명까지 같으면 밖에서 보는 한 같은 동작이다. 이름만 둘이다.
//     서명은 파라미터 이름·타입·필수 여부 + returns 문자열로 짠다. 설명문은 빼는데, 설명이
//     다르다는 것은 뜻이 다르다는 증거가 아니라 같은 것을 두 번 적었다는 증거일 뿐이다.
//
//     ★ 플랜의 원안(서명만 같으면 위반)은 여기서 정정했다 — 그대로 세면 거짓을 말한다.
//     실측 6쌍 중 셋은 서명만 같고 동작이 반대이거나 다르다:
//       plugin.enable ≡ plugin.disable            (id*) -> { id, status }
//       ui.projection.pin ≡ ui.projection.unpin   (project, ref*, side) -> { pins: {left, right} }
//       media.proxy.stream ≡ media.proxy.playlist (referer, url*, userAgent) -> { url }
//     반의어를 "같은 동작" 이라 판정하는 게이트는 GREEN 이 도달 불가능하고(반의어를 합칠 수는
//     없다), 도달 불가능한 기준은 지켜지지 않는다. 그래서 판정 근거에 동사 동일을 넣었다.
//     대신 이 조임이 게이트를 눈멀게 하지 않는다는 것을 아래 "경계" 테스트가 지킨다.
//     동사가 다른 동의어(view.close ≡ tab.remove 류)는 이 게이트 밖이다 — ① 이 잡는다.
//
// (b) RED 근거(실측, 2026-07-26): 별명 선언 1건 + 중복 쌍 3쌍.
//     - editor.close ≡ view.close (catalog.ts) — description 이 "(same as view.close)" 라고
//       적고 있고 params `{ view* }` · returns `{ activePanelId, activeViewId }` 도 같다.
//       핸들러 본문은 글자까지 같다(locateView → S().closeView).
//     - editor.open ≡ ui.intent.open (catalog.ts / catalogProjection.ts) — params
//       `{ path*, project }` · returns `{ viewId, panelId, existing }` 가 같고 둘 다
//       openFileView 로 끝난다. 파일이 갈려 있어 눈으로는 보이지 않았다.
//     - panel.resize ≡ sidebar.left.resize (catalog.ts) — params `{ project, split*, sizes* }` ·
//       returns `{}` 가 같다. split id 는 타입이 없어 어느 트리의 것인지 서명이 말하지 못한다.
//       (플랜 §5 는 2쌍이라 적었다 — 이 셋째 쌍은 실측으로 추가한다. R-A6)
//
// (c) 그 수를 만든 셸 질의
//     # ① 별명 선언 = 1건 (명령 이름을 지목한 "same as" 만 — 제스처·영역을 가리키는 것은 제외)
//     grep -rnE 'same as [a-z][A-Za-z]*\.[A-Za-z.]+' src/commands/catalog*.ts | grep -v '\.test\.'
//     #   → catalog.ts:2106  editor.close  "Close an editor view (same as view.close)."
//     # ② 서명 충돌 후보 — returns 가 겹치는 것끼리 묶고 그 블록의 params 를 대조한다
//     grep -rhE '^    returns:' src/commands/catalog*.ts | grep -v test | sort | uniq -c | sort -rn
//     grep -rn -B2 -A12 -E 'register\("(editor|view)\.(open|close)"|register\("ui\.intent\.open"' \
//       src/commands/catalog.ts src/commands/catalogProjection.ts
//     grep -rn -A14 -E 'register\("(panel|sidebar\.left)\.resize"' src/commands/catalog.ts
//     #   → 원시 충돌 6쌍, 그중 동사가 같은 것 3쌍 = 이 게이트가 세는 수
//     # ③ 재실행: npx vitest run src/commands/noAlias.test.ts
//
// 레지스트리는 앱 없이 세울 수 없으므로 소스를 읽는다(commandMessages.test 와 같은 방식).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

/** 코어 명령이 등록되는 파일들 — 테스트 파일은 뺀다. */
function catalogFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => /^catalog.*\.ts$/.test(f) && !f.endsWith(".test.ts"))
    .sort();
}

/** `{` 위치에서 시작해 짝이 맞는 `}` 앞까지. 문자열·주석 안의 괄호는 세지 않는다. */
function balanced(src: string, open: number): string {
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    i += 1;
  }
  return src.slice(open + 1, i - 1);
}

/** 깊이 0 의 쉼표로만 가른다 — 중첩 객체·배열 안의 쉼표는 항목 경계가 아니다. */
function topLevelEntries(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < inner.length && inner[i] !== quote) {
        if (inner[i] === "\\") i += 1;
        i += 1;
      }
    } else if ("{[(".includes(c)) depth += 1;
    else if ("}])".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.filter((e) => e.trim().length > 0);
}

type Param = { name: string; type: string; required: boolean };
type Command = {
  name: string;
  file: string;
  description: string;
  params: Param[];
  returns: string;
};

/** 파일이 자기 안에 둔 공용 파라미터표(P) — `P.view` 같은 참조의 타입을 여기서 푼다. */
function paramTable(src: string): Record<string, string> {
  const m = /\nconst P = \{/.exec(src);
  if (!m) return {};
  const table: Record<string, string> = {};
  for (const entry of topLevelEntries(balanced(src, src.indexOf("{", m.index)))) {
    const key = /([A-Za-z_]\w*)\s*:/.exec(entry);
    const type = /type:\s*"([^"]+)"/.exec(entry);
    if (key) table[key[1]] = type ? type[1] : "unknown";
  }
  return table;
}

/** register 블록 하나의 필드 하나 — 다음 필드(4칸 들여쓴 키) 앞까지. */
function field(block: string, key: string): string {
  const m = new RegExp(`\\n {4}${key}:`).exec(block);
  if (!m) return "";
  const rest = block.slice(m.index + m[0].length);
  const next = /\n {4}[A-Za-z_]\w*:/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** 이어 붙인 문자열 리터럴을 한 줄로 — 줄바꿈으로 갈린 설명문도 그대로 읽는다. */
function literalText(raw: string): string {
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .join(" ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseParams(block: string, table: Record<string, string>): Param[] {
  const m = /\n {4}params:\s*\{/.exec(block);
  if (!m) return [];
  const inner = balanced(block, block.indexOf("{", m.index + m[0].length - 1));
  const out: Param[] = [];
  for (const entry of topLevelEntries(inner)) {
    const key = /([A-Za-z_]\w*)\s*:/.exec(entry);
    if (!key) continue;
    const value = entry.slice(entry.indexOf(":", key.index) + 1);
    const inline = /type:\s*"([^"]+)"/.exec(value);
    const ref = /P\.([A-Za-z_]\w*)/.exec(value);
    out.push({
      name: key[1],
      type: inline ? inline[1] : ref ? (table[ref[1]] ?? "unknown") : "unknown",
      required: /required:\s*true/.test(value),
    });
  }
  return out;
}

function commands(): Command[] {
  const out: Command[] = [];
  for (const file of catalogFiles()) {
    const src = readFileSync(join(DIR, file), "utf8");
    const table = paramTable(src);
    const marks = [...src.matchAll(/\n {2}register\("([^"]+)", \{/g)];
    marks.forEach((mark, i) => {
      const start = mark.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      const block = src.slice(start, end);
      out.push({
        name: mark[1],
        file,
        description: literalText(field(block, "description")),
        params: parseParams(block, table),
        returns: literalText(field(block, "returns")),
      });
    });
  }
  return out;
}

const ALL = commands();
const NAMES = new Set(ALL.map((c) => c.name));

/** 파라미터 이름·타입·필수 여부 + 답의 모양. 설명문은 서명이 아니다. */
function signature(c: Command): string {
  const params = c.params
    .map((p) => `${p.name}:${p.type}${p.required ? "!" : ""}`)
    .sort()
    .join(",");
  return `(${params}) -> ${c.returns}`;
}

/** 이름의 마지막 마디 — 그 명령이 하는 일(동사). */
function verb(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** 서명이 같은 명령들의 묶음 — 원시 충돌(동사 대조 이전). */
function collisions(): Command[][] {
  const bySig = new Map<string, Command[]>();
  for (const c of ALL) {
    // 아무것도 안 받고 아무것도 안 돌려주는 명령끼리는 서명이 같아도 같은 동작의 증거가
    // 되지 못한다 — 구별할 것 자체를 선언하지 않았을 뿐이다.
    if (c.params.length === 0 && !/[A-Za-z]/.test(c.returns)) continue;
    const sig = signature(c);
    bySig.set(sig, [...(bySig.get(sig) ?? []), c]);
  }
  return [...bySig.values()].filter((group) => group.length > 1);
}

describe("게이트 자신이 무엇을 세는지 먼저 못 박는다", () => {
  it("명령을 실제로 읽어냈다 — 빈 집합이 통과로 위장하지 않는다", () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(NAMES.has("view.close")).toBe(true);
    expect(NAMES.has("ui.intent.open")).toBe(true);
  });

  it("서명을 실제로 읽어냈다 — 파싱이 조용히 비면 중복이 0 으로 보인다", () => {
    const view = ALL.find((c) => c.name === "view.close");
    expect(signature(view!)).toBe("(view:string!) -> { activePanelId, activeViewId }");
    const resize = ALL.find((c) => c.name === "panel.resize");
    expect(signature(resize!)).toBe("(project:string,sizes:number[]!,split:string!) -> {}");
  });
});

describe("같은 동작에 이름은 하나다", () => {
  it("어떤 명령도 자기 설명에서 다른 명령의 별명이라고 말하지 않는다", () => {
    const aliases = ALL.flatMap((c) =>
      [...c.description.matchAll(/same as ([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)/g)]
        .map((m) => m[1].replace(/\.$/, ""))
        .filter((target) => NAMES.has(target) && target !== c.name)
        .map((target) => `${c.name} → ${target} (${c.file})`),
    ).sort();
    expect(aliases).toEqual([]);
  });

  it("같은 동사에 같은 서명을 가진 명령 쌍이 없다", () => {
    const pairs = collisions()
      .flatMap((group) => {
        const byVerb = new Map<string, Command[]>();
        for (const c of group) byVerb.set(verb(c.name), [...(byVerb.get(verb(c.name)) ?? []), c]);
        return [...byVerb.values()]
          .filter((same) => same.length > 1)
          .map(
            (same) =>
              `${same.map((c) => c.name).sort().join(" ≡ ")}  ${signature(same[0])}`,
          );
      })
      .sort();
    expect(pairs).toEqual([]);
  });
});

describe("경계 — 동사 대조가 게이트를 눈멀게 하지 않는다", () => {
  // 동사 동일을 판정에 넣은 대가를 여기서 눈에 보이게 둔다. 아래 쌍들은 서명이 같지만
  // 동작이 반대이거나 다르다 — 합칠 수 없는 것을 위반이라 부르지 않기 위한 경계이지,
  // 서명 대조를 무르게 하려는 예외가 아니다. 이 목록이 늘어난다면 그때는 서명 자체가
  // 대상을 말하지 못한다는 뜻이므로 §5 로 되돌아가 기준을 다시 세운다.
  it("서명이 같은 반의어 쌍은 실재한다 — 그것까지 위반이면 GREEN 은 도달 불가다", () => {
    const raw = collisions().map((group) => group.map((c) => c.name).sort().join(" ≡ ")).sort();
    expect(raw).toContain("plugin.disable ≡ plugin.enable");
    expect(raw).toContain("ui.projection.pin ≡ ui.projection.unpin");
  });

  it("동사가 같은 쌍은 그 반의어 목록에 숨지 못한다", () => {
    expect(verb("plugin.enable")).not.toBe(verb("plugin.disable"));
    expect(verb("panel.resize")).toBe(verb("sidebar.left.resize"));
    expect(verb("editor.open")).toBe(verb("ui.intent.open"));
  });
});
