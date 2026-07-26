// id 범위 게이트 — 접두 id 는 레이아웃 실체와 셸 세션에만 쓴다.
//
// (a) 이 게이트가 지키는 규칙 (표준 §1-4d 범위 규칙)
//     id 형식 표준(`<접두>-<base32 6>`)의 적용 대상은 **레이아웃 실체 + 셸 세션**뿐이다.
//       레이아웃 실체 : project(`pjt-`) · space(`spc-`) · pane(`pan-`) · tab(`tab-`)
//       셸 세션       : pty.session(`sh-`)
//     창(window)은 이 표에 없다 — `w-<uuid4>` 를 현행 유지하고 Rust 가 발급한다(§1-1).
//     그 밖의 축(schedule · secret · data.kv · data.encrypt · registry · daemon · theme ·
//     settings · sidecar · webview · process · ui.projection · ai.session)은 **자연 키를
//     유지한다**. 자연 키가 이미 의미를 갖는 자리에 불투명 접두 id 를 씌우는 것은 C2 위반이다.
//     따라서 범위 밖 축에서 접두 id 를 발급하면 이 게이트는 실패한다.
//
//     범위는 표로 코드에 있어야 한다. 표가 없으면 "이 축이 범위 안인가"를 물을 곳이 없고,
//     물을 곳이 없으면 발급은 매번 그 자리의 판단이 된다 — 지금이 정확히 그 상태다.
//
// (b) RED 근거(실측, 2026-07-26)
//     · 발급기가 없다. `src/state/ids.ts` 부재 — 범위 표를 들고 있는 단일 진실이 없다.
//     · 접두 id 발급 지점 0곳. 현행 발급은 `sessions.ts:396-399,936` 의 `v${n}`·`g${n}`·
//       `s${n}`·`c${n}`·`t${n}` — 접두가 아니라 한 글자 이니셜이고, 범위 개념이 없다.
//     · 그래서 이 게이트의 RED 는 "범위 밖 발급이 있다"가 아니라 "범위를 물을 표가 없다"다.
//       범위 밖 발급 0건은 지금도 참이지만, 그것만 세면 발급기가 생기는 순간 무력해진다.
//       발급 앵커(발급기 안 발급 지점 ≥ 1)를 같이 세어 빈 집합이 통과로 위장하지 못하게 한다.
//
// (c) 그 수를 만든 셸 질의 (repo 루트에서)
//     ls src/state/ids.ts
//       → No such file or directory                                       (발급기 0)
//     grep -rnE '`(pjt|spc|pan|tab|sh)-\$\{' src/state src/commands | wc -l
//       → 0                                                               (접두 발급 0곳)
//     grep -rnE '`[a-z]{1,5}-\$\{' src/state src/commands | grep -v '\.test\.' | wc -l
//       → 0                                                       (프로덕션 접두 발급 전무)
//     grep -nE 'const new[A-Za-z]+Id = ' src/state/sessions.ts
//       → `v${nextViewId++}` · `g${...}` · `s${...}` · `c${...}`   (현행 발급 = 이니셜)
//
// 레지스트리·스토어는 앱 없이 세울 수 없고 발급기는 아직 존재하지도 않으므로 소스를 읽는다
// (commandMessages.test.ts · windowAxis.test.ts 와 같은 방식).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 발급기(단일 진실) — 범위 표와 발급 함수가 여기 산다. */
const ISSUER = join(__dirname, "ids.ts");

/** 소스를 읽는 두 축 — 상태(발급이 사는 곳)와 명령(발급을 부르는 곳). */
const SCANNED_DIRS = [__dirname, join(__dirname, "..", "commands")];

/** §1-4d ① 이 표준의 대상 — 레이아웃 실체 넷 + 셸 세션 하나. */
const IN_SCOPE: Record<string, string> = {
  project: "pjt-",
  space: "spc-",
  pane: "pan-",
  tab: "tab-",
  shellSession: "sh-",
};

/** §1-4d ② 자연 키를 유지하는 축 — 여기서 접두 id 를 발급하면 위반이다. */
const NATURAL_KEY_AXES = [
  "ai.session",
  "daemon",
  "data.encrypt",
  "data.kv",
  "process",
  "registry",
  "schedule",
  "secret",
  "settings",
  "sidecar",
  "theme",
  "ui.projection",
  "webview",
];

/**
 * 발급이 아닌 파생 라벨의 접두 — 위반으로 세지 않는다.
 *   w = 창 라벨(`w-<uuid4>`, Rust 소유·현행 유지, §1-1)
 *   b = 웹뷰 라벨(`b-<win>-<tab>`, 창·탭에서 파생, §1-4d ②)
 * 둘 다 새 정체성을 발급하지 않는다 — 이미 있는 것을 가리킬 뿐이다.
 */
const DERIVED_LABEL_PREFIXES = new Set(["w", "b"]);

interface Site {
  file: string;
  line: number;
  prefix: string;
}

/** 프로덕션 소스 파일들 — 테스트는 스스로를 세지 않는다. */
function sourceFiles(): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || f.includes(".test.")) continue;
      out.push({ path: join(dir, f), rel: f });
    }
  }
  return out;
}

/**
 * id 발급 지점 — `` `<접두>-${...}` `` 또는 `"<접두>-" + ...` 꼴.
 * 접두 자리에 오는 소문자 1~5자만 본다(`<접두>-<base32 6>` 표준형의 앞머리).
 */
function issuanceSites(): Site[] {
  const sites: Site[] = [];
  const patterns = [/`([a-z]{1,5})-\$\{/g, /"([a-z]{1,5})-"\s*\+/g];
  for (const { path, rel } of sourceFiles()) {
    const src = readFileSync(path, "utf8");
    const lines = src.split("\n");
    lines.forEach((text, i) => {
      for (const re of patterns) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          sites.push({ file: rel, line: i + 1, prefix: m[1] });
        }
      }
    });
  }
  return sites;
}

const at = (s: Site) => `${s.file}:${s.line} (${s.prefix}-)`;

/** 발급기 소스 — 없으면 빈 문자열(그 사실 자체가 RED 다). */
function issuerSource(): string {
  return existsSync(ISSUER) ? readFileSync(ISSUER, "utf8") : "";
}

/** `export const ID_PREFIX = { project: "pjt-", ... }` 에서 실체→접두 표를 읽는다. */
function declaredPrefixTable(): Record<string, string> {
  const src = issuerSource();
  const block = /export const ID_PREFIX[^{]*\{([\s\S]*?)\}/.exec(src);
  if (!block) return {};
  const table: Record<string, string> = {};
  for (const m of block[1].matchAll(/(\w+)\s*:\s*"([a-z]{1,5}-)"/g)) table[m[1]] = m[2];
  return table;
}

/** `export const NATURAL_KEY_AXES = [ ... ]` 에서 범위 밖 축 목록을 읽는다. */
function declaredNaturalAxes(): string[] {
  const src = issuerSource();
  const block = /export const NATURAL_KEY_AXES[^[]*\[([\s\S]*?)\]/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

describe("id 범위 — 접두 id 는 레이아웃 실체와 셸 세션에만 쓴다", () => {
  it("범위 표를 들고 있는 발급기가 하나 있다", () => {
    expect({ issuer: "src/state/ids.ts", exists: existsSync(ISSUER) }).toEqual({
      issuer: "src/state/ids.ts",
      exists: true,
    });
  });

  it("발급기의 접두 표가 레이아웃 실체 넷과 셸 세션 하나다 — 창은 표에 없다", () => {
    expect(declaredPrefixTable()).toEqual(IN_SCOPE);
  });

  it("발급기가 자연 키 축을 표로 갖는다 — 범위 밖을 물을 곳이 있다", () => {
    expect(declaredNaturalAxes()).toEqual([...NATURAL_KEY_AXES].sort());
  });

  it("자연 키 축은 접두 표에 등장하지 않는다 — 한 축이 양쪽에 서지 않는다", () => {
    const both = Object.keys(declaredPrefixTable()).filter((k) =>
      declaredNaturalAxes().some((axis) => axis.split(".").pop() === k),
    );
    expect(both).toEqual([]);
  });

  it("접두 id 발급은 발급기 안에서만 일어난다", () => {
    const sites = issuanceSites();
    const inScope = new Set(Object.values(IN_SCOPE).map((p) => p.slice(0, -1)));
    const outside = sites
      .filter((s) => s.file !== "ids.ts" && inScope.has(s.prefix))
      .map(at);
    const inside = sites.filter((s) => s.file === "ids.ts" && inScope.has(s.prefix));
    // inside 앵커 — 발급이 0곳이면 "밖에서 발급 0건"은 아무것도 세지 않은 것이다.
    expect({ outside, issued: inside.length >= 1 }).toEqual({ outside: [], issued: true });
  });

  it("범위 밖 축에서 접두 id 를 발급하지 않는다", () => {
    const inScope = new Set(Object.values(IN_SCOPE).map((p) => p.slice(0, -1)));
    const offenders = issuanceSites()
      .filter((s) => !inScope.has(s.prefix) && !DERIVED_LABEL_PREFIXES.has(s.prefix))
      .map(at);
    expect(offenders).toEqual([]);
  });
});
