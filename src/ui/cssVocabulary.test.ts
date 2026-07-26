// CSS 이름공간 어휘 게이트 — App.css 의 클래스·커스텀 프로퍼티 이름은 삭제된 단어를 담지 않는다.
//
// (a) 지키는 규칙 — 금지집합의 단일 진실은 어휘 표준 §1-5 하나다:
//     panel · group · egroup · content-(클래스 접두) · pane(옛 뜻 = 탭 인스턴스) ·
//     cell · grid · bodywrap · divider · view(인스턴스 뜻).
//     존치는 목록에 아예 넣지 않는다(§1-5 "예외 문단은 두지 않는다") —
//     content(공개 enum 값) · slot(레일 자연 키) · container(`.tab-container` 같은 자격형).
//     같은 이름 안의 위반이 둘이면 둘 다 적는다(`.pane-panel` = pane + panel).
//
// (b) RED 근거(실측, 2026-07-26) — 클래스 430종·프로퍼티 52종 중 클래스 48종이 위반이다.
//     `.egroup-*` 9 · `.view-*` 12 · `.plugin-view-*` 7 · `.pane-*`(옛 뜻) 5 · `.content-*` 3 ·
//     `.th-cell` `.th-grid` `.left-host-cell` `.left-host-grid` `.settings-*-cell` 등.
//     한 이름 안에 죽은 단어가 둘인 것이 셋이다: `.pane-panel` · `.pane-group` · `.content-pane`.
//     커스텀 프로퍼티는 0종이다 — App.css 에 남은 것은 `--pane-inset` 하나뿐이고 그것은
//     지금도 칸을 뜻한다(§1-4b: 새 뜻 그대로 유효). 프로퍼티 축은 지금 GREEN 이며,
//     그 축을 세는 것은 나중에 죽은 단어가 프로퍼티로 되돌아오는 것을 막기 위함이다.
//
// (c) 그 수를 만든 셸 질의:
//     grep -oE "\.[a-zA-Z][a-zA-Z0-9_-]*" src/App.css | sort -u | wc -l          # 430
//     grep -oE "\-\-[a-zA-Z][a-zA-Z0-9_-]*" src/App.css | sort -u | wc -l        # 52
//     위 질의는 주석 속 문장까지 센다(`SKIN.pane` 의 `.pane`, `.tsx`, `.md` 등 13종). 이 게이트는
//     주석을 걷고 세므로 클래스 분모가 417 이다 — 430 과의 차 13 은 주석 노이즈다. 분모를 정확히
//     하는 것은 기준을 낮추는 것이 아니다: 주석 속 단어는 이름이 아니므로 고칠 대상도 아니다.
//
// 뜻이 갈리는 두 단어의 판별 기준(토큰 금지만으로는 뜻을 못 가른다 — §2-2 가 그 주장을 철회했다):
//   pane  — 새 뜻(칸)으로 살아 있다. 판정은 접미의 성격이다(IDENTITY §5 정정 2026-07-26):
//           실체 파생(`-gutter`·`-tabs`)과 부품을 내용대로 부르는 이름(`-body`·`-border`·
//           `-title`·`-status`)은 허용 — 부품명은 실체를 가리지 않는다. 금지는 **감싸개 역할
//           명사**다: 실체를 별명으로 가리는 slot·cell·grid·frame·container·leaf·host·
//           handle·group·panel. 초판이 허용을 4개 화이트리스트로 좁혔는데 그것은 게이트가
//           표준을 앞지른 것이었다 — 정본(IDENTITY §5)과 함께 정정했다.
//           프로퍼티는 요소가 아니라 값을 부르므로 이 규칙 밖이고, `--pane-inset` 만 허용한다.
//   view  — 종류(플러그인이 선언하는 `contributes.views`)로 살아 있다. 그러나 CSS 는 화면 위의
//           실체를 칠하므로 CSS 이름의 `view` 는 종류일 수 없다 — 전부 인스턴스 뜻이고 전부 위반이다.
//
// 세그먼트 정확 일치로만 판정한다 — `webview`(§1-4d ② 다른 축) · `viewer` · `viewport` · `2pane` 은
// 다른 토큰이므로 잡지 않는다. `.hole-slot` 도 위반이 아니다: `slot` 도 `hole` 도 §1-5 목록에 없다.
// 목록에 없는 단어를 여기서 보태지 마라 — 게이트가 표준을 앞지르면 표준이 둘이 된다.
// 반대로 통과 못 한다고 목록에서 단어를 빼지도 마라. 고칠 것은 App.css 다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 주석은 이름이 아니다 — 걷고 센다. */
const CSS = readFileSync(join(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const classNames = () => uniq([...CSS.matchAll(/\.[a-zA-Z][a-zA-Z0-9_-]*/g)].map((m) => m[0]));
const propNames = () => uniq([...CSS.matchAll(/--[a-zA-Z][a-zA-Z0-9_-]*/g)].map((m) => m[0]));

/** §1-5 목록 중 세그먼트 정확 일치만으로 판정되는 것들. */
const DEAD = ["panel", "group", "egroup", "cell", "grid", "bodywrap", "divider"];
/** pane 세그먼트와 결합이 금지되는 감싸개 역할 명사 — 실체를 별명으로 가리는 단어들.
 *  부품명(-body·-border·-title·-status)과 실체 파생(-gutter·-tabs·-hole 수정자)은 허용이다. */
const WRAPPER_ROLE_NOUNS = new Set([
  "slot", "cell", "grid", "frame", "container", "leaf", "host", "handle", "group", "panel",
]);
const paneNameViolates = (name: string): boolean => {
  const segs = name.slice(1).split("-");
  if (!segs.includes("pane")) return false;
  return segs.some((sg) => WRAPPER_ROLE_NOUNS.has(sg));
};
/** 새 뜻으로 살아 있는 프로퍼티 — §1-4b. */
const PANE_PROP_ALIVE = new Set(["--pane-inset"]);

/** 이 이름이 담은 죽은 단어들. 비면 위반이 아니다. */
function deadWordsIn(name: string, kind: "class" | "prop"): string[] {
  const segs = name.replace(/^(\.|--)/, "").split("-");
  const hit = DEAD.filter((w) => segs.includes(w));
  if (kind === "class" && segs[0] === "content" && segs.length > 1) hit.push("content-");
  if (segs.includes("pane")) {
    // 클래스: 감싸개 역할 명사와의 결합만 위반(부품명·실체 파생은 허용 — 머리말 판별 기준).
    // 프로퍼티: 값을 부르는 축이라 --pane-inset 만 허용(기존 그대로).
    const violates =
      kind === "class" ? paneNameViolates(name) : !PANE_PROP_ALIVE.has(name);
    if (violates) hit.push("pane");
  }
  if (segs.includes("view")) hit.push("view");
  return hit;
}

/** 실패 메시지에 그대로 실릴 줄 — 이름과 그 이름이 담은 죽은 단어. */
const offenders = (names: string[], kind: "class" | "prop") =>
  names
    .map((n) => ({ name: n, dead: deadWordsIn(n, kind) }))
    .filter((x) => x.dead.length > 0)
    .map((x) => `${x.name} <- ${x.dead.join(",")}`);

describe("App.css 이름공간은 살아 있는 어휘만 쓴다", () => {
  it("이름을 실제로 훑었다 — 빈 스캔이 통과로 위장하지 않는다", () => {
    // 실측(2026-07-26): 클래스 417종(주석 포함 질의로는 430) · 프로퍼티 52종.
    // 개명 중에는 종수가 움직이므로 하한만 못박는다. 0종을 훑고 "위반 없음" 이라 말하는 것만 막는다.
    expect({
      classes: classNames().length >= 300,
      props: propNames().length >= 40,
    }).toEqual({ classes: true, props: true });
  });

  it("클래스 이름에 삭제된 단어가 없다", () => {
    expect(offenders(classNames(), "class")).toEqual([]);
  });

  it("커스텀 프로퍼티 이름에 삭제된 단어가 없다", () => {
    expect(offenders(propNames(), "prop")).toEqual([]);
  });
});

describe("판정 기준 자체를 못박는다 — 게이트가 표준을 앞지르거나 놓치지 않는다", () => {
  it("존치 단어는 위반이 아니다 — content(enum) · slot(자연 키) · container(자격형)", () => {
    const kept = [".content", ".hole-slot", ".tab-container", ".tab-body", ".pane-gutter"];
    expect(kept.filter((n) => deadWordsIn(n, "class").length > 0)).toEqual([]);
  });

  it("다른 토큰을 죽은 단어로 오인하지 않는다 — webview · viewer · viewport", () => {
    const other = [".webview-health-badge", ".file-viewer", ".xterm-viewport"];
    expect(other.filter((n) => deadWordsIn(n, "class").length > 0)).toEqual([]);
  });

  it("한 이름에 죽은 단어가 둘이면 둘 다 적는다", () => {
    expect(deadWordsIn(".pane-panel", "class").sort()).toEqual(["pane", "panel"]);
    expect(deadWordsIn(".content-pane", "class").sort()).toEqual(["content-", "pane"]);
  });

  it("pane 은 새 뜻만 살아 있다 — 역할 단어를 새로 만든 것은 위반", () => {
    expect(deadWordsIn(".pane", "class")).toEqual([]);
    expect(deadWordsIn(".pane-body", "class")).toEqual([]);
    expect(deadWordsIn("--pane-inset", "prop")).toEqual([]);
    expect(deadWordsIn(".pane-leaf", "class")).toEqual(["pane"]);
    expect(deadWordsIn(".pane-resize-handle", "class")).toEqual(["pane"]);
  });

  it("CSS 의 view 는 전부 인스턴스 뜻이다 — 종류는 화면에 칠해지지 않는다", () => {
    expect(deadWordsIn(".view-tab", "class")).toEqual(["view"]);
    expect(deadWordsIn(".plugin-view-container", "class")).toEqual(["view"]);
  });
});
