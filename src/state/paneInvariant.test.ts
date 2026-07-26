// pane 불변식 게이트 — 배치에서 노출되는 실체는 pane 과 tab 둘뿐이다.
//
// (a) 이 게이트가 지키는 규칙
//   ① 탭이 살 수 있는 곳은 pane 뿐이다. 배치 트리의 내부(split) 노드는 탭을 담지 않는다.
//   ② 빈 pane 은 유효하다. pane 은 탭 0개 이상을 담고, 탭이 없다고 위치가 사라지지 않는다.
//      (이 항은 이미 성립한다 — catalog.ts activeChain 의 "빈 패널도 유효한 위치다" 와
//      emptyPanelContext.test.ts 가 그것을 지킨다. 여기서 함께 못박는 이유는 이 게이트가
//      나중에 "빈 pane 금지" 로 잘못 강화되는 것을 막기 위해서다.)
//   ③ 주소·명령 표면에 배치 트리 내부 노드 id 가 등장하지 않는다.
//      내부 노드는 자료구조로 계속 존재하고 내부 id 도 갖되, 이름이 없다. 모든 gutter 는
//      어떤 pane 의 right/bottom 모서리로 지목되므로 내부 노드를 부를 필요 자체가 없다.
//      이름 없는 것을 호출자에게 건네면 호출자는 그것을 부를 말이 없고, 그 id 는 재시작하면
//      무효가 된다(split id 는 복원 시 재생성된다 — splitTree.ts 직렬화 주석).
//
// (b) RED 근거 (실측 2026-07-26, 작업본 기준). ③ 이 네 축 전부에서 깨져 있다.
//   ③-1 주소면 1건   — GroupArea.tsx:786 `data-node={`divider/${d.splitId}/${d.index}`}`
//   ③-2 입력면 3건   — sidebar.left.resize · panel.resize · panel.equalize 가 split 를
//                      파라미터로 받는다(catalog.ts:1133 · 1549 · 1573)
//   ③-3 응답면 1건   — serializeLayout 이 split 노드 id 를 싣는다(catalog.ts:328).
//                      sidebar.left.tree 는 leftLayout 을 통째로 돌려주므로 같은 값이 샌다
//   ③-4 문서면 4건   — sidebar.left.tree · sidebar.left.resize · panel.resize · panel.equalize
//                      의 설명·예제가 split id 를 호출자에게 지시한다
//   ① ② 는 지금 GREEN 이다. 셋을 한 파일에 두는 이유는 이것이 하나의 불변식이기 때문이다 —
//   "탭은 pane 에만 산다" 와 "pane 밖의 노드는 부를 수 없다" 는 같은 문장의 앞뒤다.
//
// (c) 그 수를 만든 셸 질의 (저장소 루트에서 실행)
//   ③-1  grep -rn 'data-node={`[^`]*\${[^}]*splitId' src --include='*.tsx'
//   ③-2  grep -n 'split: { type: "string"' src/commands/catalog*.ts
//   ③-3  grep -n 'split: { id:' src/commands/catalog*.ts
//   ③-4  grep -niE 'splitId|split (node )?ids?' src/commands/catalog*.ts
//
// 레지스트리는 앱 없이 세울 수 없으므로 명령 표면은 소스를 읽어 센다
// (commandMessages.test.ts · windowAxis.test.ts 와 같은 방식). ① ② 는 순수 자료구조라
// 실제로 트리를 만들어 확인한다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allGroups, allViews, type GroupNode, type View, type ViewGroup } from "./sessions";
import { leavesOf } from "./splitTree";

const SRC_ROOT = join(__dirname, "..");
const CATALOG_DIR = join(SRC_ROOT, "commands");

// ── 픽스처: 배치 트리 ────────────────────────────────────────────────────────
const tab = (id: string): View => ({
  id,
  kind: "plugin",
  title: id,
  pluginId: "p",
  view: "content",
});
const pane = (id: string, views: View[]): ViewGroup => ({
  id,
  views,
  activeViewId: views[0]?.id ?? "",
});
const leaf = (v: ViewGroup): GroupNode => ({ type: "leaf", value: v });
const split = (id: string, children: GroupNode[]): GroupNode => ({
  type: "split",
  id,
  dir: "row",
  sizes: children.map(() => 1 / children.length),
  children,
});

/** 탭을 담은 노드를 트리 전체에서 긁는다 — leaf 만 나와야 한다. */
function nodesHoldingTabs(node: unknown, acc: object[] = []): object[] {
  if (Array.isArray(node)) {
    for (const item of node) nodesHoldingTabs(item, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    if (Array.isArray((node as { views?: unknown }).views)) acc.push(node as object);
    for (const v of Object.values(node)) nodesHoldingTabs(v, acc);
  }
  return acc;
}

// ── 소스 스캔 ────────────────────────────────────────────────────────────────
function filesUnder(dir: string, re: RegExp, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, re, acc);
    else if (re.test(e.name) && !e.name.includes(".test.")) acc.push(p);
  }
  return acc;
}

const rel = (p: string) => p.slice(SRC_ROOT.length - "src".length);
const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

/** src/**\/*.tsx 의 data-node 주소 전부 — `파일:줄 값` 형태. */
function domAddresses(): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = [];
  for (const f of filesUnder(SRC_ROOT, /\.tsx$/)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/data-node=(?:\{`([^`]*)`\}|"([^"]*)")/g)) {
      out.push({
        where: `${rel(f)}:${lineOf(src, m.index ?? 0)}`,
        value: m[1] ?? m[2] ?? "",
      });
    }
  }
  return out;
}

const catalogFiles = () => filesUnder(CATALOG_DIR, /^catalog.*\.ts$/);

/** register("<이름>", { ... }) 블록 — 다음 register 앞까지(windowAxis.test.ts 와 동일 절단). */
function blocks(): { name: string; body: string; where: string }[] {
  const out: { name: string; body: string; where: string }[] = [];
  for (const f of catalogFiles()) {
    const src = readFileSync(f, "utf8");
    const marks = [...src.matchAll(/ {2}register\("([^"]+)", \{/g)];
    marks.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      out.push({
        name: m[1],
        body: src.slice(start, end),
        where: `${rel(f)}:${lineOf(src, start)}`,
      });
    });
  }
  return out;
}

/** 선언된 파라미터 구간만 — 반환 서술이나 핸들러 본문을 파라미터로 오인하지 않는다. */
function paramsOf(body: string): string {
  const i = body.indexOf("params:");
  if (i < 0) return "";
  const j = body.indexOf("returns:", i);
  return body.slice(i, j < 0 ? body.length : j);
}

/** 설명·파라미터 설명·예제 = 호출자가 읽는 문서면. 핸들러 본문은 뺀다. */
function docSurfaceOf(body: string): string {
  const i = body.indexOf("description:");
  if (i < 0) return "";
  const j = body.indexOf("handler:", i);
  return body.slice(i, j < 0 ? body.length : j);
}

// 내부 노드 id 를 가리키는 말 — splitId / split id / split ids / split node id.
const INNER_NODE_ID = /splitId|split\s+(?:node\s+)?ids?\b/i;

// ── ① 탭은 pane 에만 산다 ────────────────────────────────────────────────────
describe("① 탭이 살 수 있는 곳은 pane 뿐이다", () => {
  const a = pane("pan-a", [tab("tab-1"), tab("tab-2")]);
  const b = pane("pan-b", [tab("tab-3")]);
  const tree = split("s1", [leaf(a), split("s2", [leaf(b), leaf(pane("pan-c", []))])]);

  it("탭을 담은 노드는 전부 leaf 값(pane)이다 — 내부 노드는 하나도 없다", () => {
    expect(nodesHoldingTabs(tree)).toEqual(leavesOf(tree));
  });

  it("내부 노드에는 탭을 담을 자리 자체가 없다", () => {
    const inner = (n: GroupNode, acc: object[] = []): object[] => {
      if (n.type === "leaf") return acc;
      acc.push(n);
      for (const c of n.children) inner(c, acc);
      return acc;
    };
    const offenders = inner(tree).filter((n) => "views" in n || "value" in n);
    expect(offenders).toEqual([]);
  });

  it("배치 안의 탭 전체는 pane 이 담은 탭의 합집합과 정확히 같다", () => {
    expect(allViews(tree)).toEqual(allGroups(tree).flatMap((g) => g.views));
    expect(allViews(tree).map((v) => v.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
  });
});

// ── ② 빈 pane 은 유효하다 ───────────────────────────────────────────────────
describe("② 빈 pane 은 유효하다 — 탭 0개 이상", () => {
  it("탭 0개인 pane 도 pane 으로 수집된다", () => {
    const empty = pane("pan-empty", []);
    const tree = split("s1", [leaf(pane("pan-a", [tab("tab-1")])), leaf(empty)]);
    expect(allGroups(tree).map((g) => g.id)).toEqual(["pan-a", "pan-empty"]);
    expect(allViews(tree).map((v) => v.id)).toEqual(["tab-1"]);
  });

  it("탭이 하나도 없는 배치도 배치다", () => {
    const tree = leaf(pane("pan-empty", []));
    expect(allGroups(tree).map((g) => g.id)).toEqual(["pan-empty"]);
    expect(allViews(tree)).toEqual([]);
  });

  it("활성 체인은 탭 부재로 위치를 버리지 않는다 — 끊는 곳은 pane 까지다", () => {
    const src = readFileSync(join(CATALOG_DIR, "catalog.ts"), "utf8");
    const i = src.indexOf("function activeChain(");
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf("\nfunction ", i + 1);
    const body = src.slice(i, j < 0 ? src.length : j);
    // pane 이 없으면 위치가 없다(끊는다). 탭이 없는 것은 정상이므로 끊지 않는다.
    expect(/if \(!group\) return null;/.test(body)).toBe(true);
    expect(/if \(!view\) return null;/.test(body)).toBe(false);
  });
});

// ── ③ 주소·명령 표면에 내부 노드 id 가 없다 ─────────────────────────────────
describe("③ 주소·명령 표면에 배치 트리 내부 노드 id 가 등장하지 않는다", () => {
  it("스캔이 실제로 무언가를 읽는다 — 빈 집합이 통과로 위장하지 않는다", () => {
    expect(domAddresses().length).toBeGreaterThan(50);
    expect(blocks().length).toBeGreaterThan(50);
  });

  it("③-1 DOM 주소가 내부 노드 id 를 싣지 않는다", () => {
    const offenders = domAddresses()
      .filter((a) => INNER_NODE_ID.test(a.value))
      .map((a) => `${a.where} ${a.value}`);
    expect(offenders).toEqual([]);
  });

  it("③-2 명령이 내부 노드 id 를 파라미터로 받지 않는다", () => {
    const offenders = blocks()
      .filter((b) => /\bsplit:\s*\{/.test(paramsOf(b.body)))
      .map((b) => `${b.name} (${b.where})`);
    expect(offenders).toEqual([]);
  });

  it("③-3 명령 응답이 내부 노드 id 를 싣지 않는다", () => {
    const offenders: string[] = [];
    for (const f of catalogFiles()) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bsplit:\s*\{\s*id:/g)) {
        offenders.push(`${rel(f)}:${lineOf(src, m.index ?? 0)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("③-4 명령 설명·예제가 내부 노드 id 를 호출자에게 지시하지 않는다", () => {
    const offenders = blocks()
      .filter((b) => INNER_NODE_ID.test(docSurfaceOf(b.body)))
      .map((b) => `${b.name} (${b.where})`);
    expect(offenders).toEqual([]);
  });
});
