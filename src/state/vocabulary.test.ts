// (a) 이 게이트가 지키는 규칙
//
// `pane` 은 이 저장소에서 두 뜻으로 산다. 옛 뜻은 **탭 인스턴스**(업계 관례와 정반대이고
// `$SOKSAK_PANE`·`data-pane-id`·`command.started {paneId}` 로 가장 바깥까지 샌다), 새 뜻은
// 본래 뜻인 **칸**(`--pane-inset`, `address.ts` 의 `pane/<idx|active>`)이다. 같은 토큰이 두 뜻으로
// 남아 있으므로 **토큰 금지로는 옛 뜻을 셀 수 없다** — 금지집합을 걸면 존치할 새 뜻까지 잡는다.
//
// 그래서 규칙은 금지가 아니라 **판정**이다: `pane`·`panel` 을 품은 식별자는 전부 아래 판정표에
// 뜻이 적혀 있어야 한다. `"tab"` = 옛 뜻(탭 인스턴스) → 개명 대상, `"pane"` = 새 뜻(칸) → 존치.
// 판정표는 빈 상태로 시작한다 — 표를 채우는 절차(전수 추출 → 뜻 판정 → 등재)가 곧 이 게이트다.
// 미판정이 하나라도 남으면 실패한다. 판정을 미룬 식별자는 개명표에 오르지 못하고, 개명표에
// 없으면 뜻이 뒤집힌 채 출시된다.
//
// **토큰 카운트가 아니라 식별자 단위로 센다.** 같은 `pane` 토큰이 두 뜻으로 쓰이므로 토큰을
// 세면 뜻을 가를 수 없다. 판정의 단위는 이름 하나다.
//
// **판정은 스코프별로 한다.** `pty_pane_alive`·`pty_pane_pid` 는 TS 와 Rust 양쪽에 같은 이름으로
// 살아 있고, 개명은 각 언어에서 따로 이뤄진다(둘을 한 항목으로 합치면 한쪽 판정이 다른 쪽의
// 미판정을 가린다). 그래서 합집합 33 이 아니라 스코프별 합 35 가 이 게이트의 수다.
//
// (b) RED 근거 (실측, 2026-07-26)
//
// 미판정 식별자 **65종** = `src/**/*.ts(x)` **59종** + `src-tauri/src/**/*.rs` **6종**.
// 판정표가 비어 있으므로 65 전부가 미판정이다. 표가 다 차면 0 이 된다.
//
// (c) 그 수를 만든 셸 질의
//
//   grep -rhoE "([A-Za-z_][A-Za-z0-9_]*)?([Pp]ane|[Pp]anel)[A-Za-z0-9_]*" src \
//     --include='*.ts' --include='*.tsx' --exclude=vocabulary.test.ts | sort -u | wc -l   # 59
//   grep -rhoE "([A-Za-z_][A-Za-z0-9_]*)?([Pp]ane|[Pp]anel)[A-Za-z0-9_]*" src-tauri/src \
//     --include='*.rs' | sort -u | wc -l                                                  # 6
//
// 이 파일 자신은 스캔에서 뺀다 — 판정표의 문자열 키가 스캔에 다시 잡히면 죽은 항목이 스스로를
// 증명해 (3)번 검사가 무력해진다.
//
// 초판 질의는 `[Pp]ane` 앞에 최소 한 글자를 요구해 접두 없는 `paneId`(312회)·`panelId`·`pane`
// 자체를 0건으로 셌다 — 플랜이 1위 결함으로 지목한 그 이름이 모집단에 없었다. 선두를
// 선택형으로 바꿔 전수로 확장했고(35→65), 플랜 §5 도 같은 정정을 받았다.
//
// 앱을 띄우지 않고 소스를 읽는다(commandMessages.test 와 같은 방식) — 어휘는 실행이 아니라
// 소스에 있다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 옛 뜻 = 탭 인스턴스(개명 대상) / 새 뜻 = 칸(존치). 제3의 값은 판정이 아니다. */
type Verdict = "tab" | "pane";

const SCOPES = ["src", "src-tauri"] as const;
type Scope = (typeof SCOPES)[number];

/** 스캔 뿌리 — 스코프 이름은 실패 메시지에 그대로 실린다. */
const ROOTS: Record<Scope, { dir: string; exts: string[] }> = {
  src: { dir: join(__dirname, ".."), exts: [".ts", ".tsx"] },
  "src-tauri": { dir: join(__dirname, "..", "..", "src-tauri", "src"), exts: [".rs"] },
};

/** 이 게이트 자신 — 판정표가 스스로를 증명하지 못하게 뺀다. */
const SELF = "vocabulary.test.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 판정표 — 빈 상태로 시작한다. 전수 추출 → 뜻 판정 → 여기 등재가 이 게이트의 절차다.
// 등재 형식: [식별자]: "tab" (옛 뜻·개명 대상) | "pane" (새 뜻·존치)
// ─────────────────────────────────────────────────────────────────────────────
const VERDICTS: Record<Scope, Record<string, Verdict>> = {
  src: {},
  "src-tauri": {},
};

const IDENT = /(?:[A-Za-z_][A-Za-z0-9_]*)?(?:[Pp]ane|[Pp]anel)[A-Za-z0-9_]*/g;

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, exts));
    else if (e.name !== SELF && exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** 스코프 하나가 실제로 쓰는 식별자 집합. */
function identifiersIn(scope: Scope): string[] {
  const { dir, exts } = ROOTS[scope];
  const found = new Set<string>();
  for (const f of filesUnder(dir, exts)) {
    for (const m of readFileSync(f, "utf8").matchAll(IDENT)) found.add(m[0]);
  }
  return [...found].sort();
}

const SCANNED: Record<Scope, string[]> = {
  src: identifiersIn("src"),
  "src-tauri": identifiersIn("src-tauri"),
};

/** 실패 메시지는 `<스코프>:<식별자>` — 그대로 판정표 항목이 된다. */
const at = (scope: Scope, id: string) => `${scope}:${id}`;

describe("pane·panel 을 품은 식별자는 전부 뜻이 판정돼 있다", () => {
  it("스캔이 실제로 소스를 읽는다 — 빈 스캔이 통과로 위장하지 않는다", () => {
    for (const scope of SCOPES) {
      expect(filesUnder(ROOTS[scope].dir, ROOTS[scope].exts).length).toBeGreaterThan(0);
      expect(SCANNED[scope].length).toBeGreaterThan(0);
    }
  });

  it("미판정 식별자가 없다 — 판정을 미룬 이름은 개명표에 오르지 못한다", () => {
    const undecided = SCOPES.flatMap((scope) =>
      SCANNED[scope].filter((id) => !(id in VERDICTS[scope])).map((id) => at(scope, id)),
    );
    expect(undecided).toEqual([]);
  });

  it("판정표에 실재하지 않는 식별자를 두지 않는다 — 죽은 항목이 진행을 가장한다", () => {
    const stale = SCOPES.flatMap((scope) =>
      Object.keys(VERDICTS[scope])
        .filter((id) => !SCANNED[scope].includes(id))
        .map((id) => at(scope, id)),
    );
    expect(stale).toEqual([]);
  });

  it("판정은 두 뜻 중 하나다 — 제3의 값은 판정이 아니라 유예다", () => {
    const bad = SCOPES.flatMap((scope) =>
      Object.entries(VERDICTS[scope])
        .filter(([, v]) => v !== "tab" && v !== "pane")
        .map(([id, v]) => `${at(scope, id)}=${String(v)}`),
    );
    expect(bad).toEqual([]);
  });
});
