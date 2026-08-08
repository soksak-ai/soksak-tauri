// 골(gutter)로 지목하는 크기 조절 — 명령 표면에 배치 트리 내부 노드 id 가 없다는 불변식
// (IDENTITY §4 · paneInvariant ③)의 실행면 증명.
//
// 규칙: 모든 골은 어떤 pane 의 right/bottom 모서리와 일치하므로, pane.resize·pane.equalize 는
// (pane, edge) 로 골을 지목한다. 내부 노드를 부를 말이 없어도 조작이 완전하다.
//   ① (pane, right) = 그 pane 의 서브트리가 마지막 자식이 아닌 가장 가까운 row 조상의 그 자리 골.
//   ② left/top 은 같은 골의 별명(앞 형제 쪽에서 부른 이름) — 답은 정본(첫 pane 의 right/bottom)을
//      echo 한다.
//   ③ 골 하나는 이웃한 두 자리만 움직인다. 나머지 자리는 불변이고 합은 1 이다.
//   ④ 그 모서리에 골이 없으면(맨 오른쪽 pane 의 right) TARGET_NOT_FOUND — 짐작으로 다른 골을
//      움직이지 않는다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions, type PaneNode, type Project, type Pane } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";

const pane = (id: string): Pane => ({ id, tabs: [], activeTabId: "" });
const leaf = (id: string): PaneNode => ({ type: "leaf", value: pane(id) });

/** row[ A | col[ B / C ] | D ] — 중첩이 있어야 "가장 가까운 축 조상" 규칙이 관찰된다. */
function fixture(): Project {
  return {
    id: "t1",
    title: "P",
    root: "/tmp/pane-gutter",
    sidebarOpen: false,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    spaces: [
      {
        id: "c1",
        title: "1",
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.5, 0.3, 0.2],
          children: [
            leaf("pan-a"),
            {
              type: "split",
              id: "s2",
              dir: "col",
              sizes: [0.6, 0.4],
              children: [leaf("pan-b"), leaf("pan-c")],
            },
            leaf("pan-d"),
          ],
        },
        activePaneId: "pan-b",
      },
    ],
    activeSpaceId: "c1",
  };
}

/** row[ col[ row[ E | F ] / G ] | H ] — 같은 축(row) 조상이 둘이고 둘 다 "마지막 자식 아님" 이다.
 *  "가장 가까운 조상" 규칙이 실제로 지켜지는지는 이 모양에서만 관찰된다(먼 조상을 골랐다면
 *  E 의 right 가 col 과 H 사이의 골로 새어 나간다). */
function nestedRowFixture(): Project {
  const base = fixture();
  return {
    ...base,
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "pan-e",
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.7, 0.3],
          children: [
            {
              type: "split",
              id: "s2",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [
                {
                  type: "split",
                  id: "s3",
                  dir: "row",
                  sizes: [0.4, 0.6],
                  children: [leaf("pan-e"), leaf("pan-f")],
                },
                leaf("pan-g"),
              ],
            },
            leaf("pan-h"),
          ],
        },
      },
    ],
  };
}

registerCatalog();

beforeEach(() => {
  useSessions.setState({ projects: [fixture()], activeId: "t1" });
});

const sizesOf = (): number[] => {
  const layout = useSessions.getState().projects[0].spaces[0].layout;
  if (layout.type !== "split") throw new Error("split 아님");
  return layout.sizes;
};

const innerSizes = (): number[] => {
  const layout = useSessions.getState().projects[0].spaces[0].layout;
  if (layout.type !== "split") throw new Error("split 아님");
  const inner = layout.children[1];
  if (inner.type !== "split") throw new Error("중첩 split 아님");
  return inner.sizes;
};

describe("pane.resize — 골은 pane 의 모서리로 지목된다", () => {
  it("① 첫 pane 의 right 골은 바로 그 row 자리의 골이다 — 두 자리만 움직이고 나머지는 불변", async () => {
    const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    // 인접 두 자리(0.5+0.3=0.8)를 0.25 : 0.75 로 — 셋째 자리(0.2)는 손대지 않는다.
    expect(sizesOf()).toEqual([0.2, 0.6000000000000001, 0.2]);
    expect(sizesOf().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(r.data).toMatchObject({
      paneId: "pan-a",
      gutter: { pane: "pan-a", edge: "right" },
    });
  });

  it("② 중첩 pane 의 right 는 가장 가까운 row 조상의 골 — 정본은 문서 순서상 첫 pane 이다", async () => {
    // pan-b 는 col 안에 있고 그 col 서브트리는 row 의 마지막 자식이 아니다 → row 의 1번 골.
    const r = await execute("pane.resize", { pane: "pan-b", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(true);
    expect(sizesOf()).toEqual([0.5, 0.25, 0.25]);
    // 그 골에 닿는 첫 pane = col 서브트리의 첫 자식(수직이므로 전부 닿는다).
    expect(r.data).toMatchObject({ paneId: "pan-b", gutter: { pane: "pan-b", edge: "right" } });
  });

  it("② left 는 같은 골의 별명 — 정본 pane 을 되돌려주고 비율은 부른 pane 쪽에 준다", async () => {
    const r = await execute("pane.resize", { pane: "pan-d", edge: "left", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    // pan-d 는 뒤쪽 자리(0.2). 앞 자리와의 합 0.5 를 0.375 : 0.125 로 = pan-d 가 0.25.
    expect(sizesOf()).toEqual([0.5, 0.375, 0.125]);
    // 정본은 그 골에 닿는 문서 순서상 첫 pane — 앞 형제(col)의 마지막 자식이 아니라
    // 수직 축이라 첫 자식(pan-b)이다.
    expect(r.data).toMatchObject({
      paneId: "pan-d",
      gutter: { pane: "pan-b", edge: "right" },
    });
  });

  it("③ bottom 은 col 축의 골이다 — 같은 pane 이 축마다 다른 골을 가진다", async () => {
    const r = await execute("pane.resize", { pane: "pan-b", edge: "bottom", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    expect(innerSizes()).toEqual([0.25, 0.75]);
    expect(sizesOf()).toEqual([0.5, 0.3, 0.2]); // 바깥 row 는 불변
    expect(r.data).toMatchObject({ gutter: { pane: "pan-b", edge: "bottom" } });
  });

  it("④ 그 모서리에 골이 없으면 TARGET_NOT_FOUND — 다른 골을 짐작해 움직이지 않는다", async () => {
    const before = sizesOf();
    const r = await execute("pane.resize", { pane: "pan-d", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
    expect(sizesOf()).toEqual(before);
  });

  it("ratio 는 0 과 1 사이여야 한다 — 경계값은 자리를 없앤다", async () => {
    for (const ratio of [0, 1, -0.5, 1.5]) {
      const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio }, {});
      expect(r.ok).toBe(false);
      expect(r.code).toBe("INVALID_PARAMS");
    }
  });

  it("응답에 내부 노드 id 가 없다 — 호출자가 부를 수 없는 이름은 건네지 않는다", async () => {
    const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio: 0.4 }, {});
    const text = JSON.stringify(r);
    expect(text).not.toContain("s1");
    expect(text).not.toContain("s2");
  });
});

describe("pane.equalize — 골 기준 균등", () => {
  it("기본은 그 골이 가른 두 자리를 반반으로 — 나머지는 불변", async () => {
    const r = await execute("pane.equalize", { pane: "pan-a", edge: "right" }, {});
    expect(r.ok).toBe(true);
    expect(sizesOf()).toEqual([0.4, 0.4, 0.2]);
    expect(r.data).toMatchObject({ paneId: "pan-a", gutter: { pane: "pan-a", edge: "right" } });
  });

  it("all:true 는 그 축의 모든 자리를 같게 한다", async () => {
    const r = await execute("pane.equalize", { pane: "pan-a", edge: "right", all: true }, {});
    expect(r.ok).toBe(true);
    expect(sizesOf()).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("골이 없는 모서리는 TARGET_NOT_FOUND", async () => {
    const r = await execute("pane.equalize", { pane: "pan-d", edge: "right" }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("가장 가까운 축 조상 — 같은 축 조상이 둘일 때", () => {
  beforeEach(() => {
    useSessions.setState({ projects: [nestedRowFixture()], activeId: "t1" });
  });

  it("안쪽 row 의 골을 움직인다 — 바깥 row 로 새지 않는다", async () => {
    const r = await execute("pane.resize", { pane: "pan-e", edge: "right", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    const outer = useSessions.getState().projects[0].spaces[0].layout;
    if (outer.type !== "split") throw new Error("split 아님");
    // 바깥 row(col | H)는 불변이어야 한다 — 먼 조상을 골랐다면 여기가 바뀐다.
    expect(outer.sizes).toEqual([0.7, 0.3]);
    const col = outer.children[0];
    if (col.type !== "split") throw new Error("col 아님");
    const innerRow = col.children[0];
    if (innerRow.type !== "split") throw new Error("inner row 아님");
    expect(innerRow.sizes).toEqual([0.25, 0.75]);
    expect(r.data).toMatchObject({ gutter: { pane: "pan-e", edge: "right" } });
  });

  it("바깥 row 의 골은 그 골에 닿는 pane 의 모서리로 부른다 — F 의 right 가 그 자리다", async () => {
    // pan-f 는 안쪽 row 의 마지막 자식이므로 그 축에서는 골이 없고, 한 단계 더 올라간 col 은
    // 축이 달라 건너뛰며, 바깥 row 에서 col 서브트리가 마지막이 아니라 그 골이 잡힌다.
    const r = await execute("pane.resize", { pane: "pan-f", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(true);
    const outer = useSessions.getState().projects[0].spaces[0].layout;
    if (outer.type !== "split") throw new Error("split 아님");
    expect(outer.sizes).toEqual([0.5, 0.5]);
    // 정본 = 그 골에 닿는 문서 순서상 첫 pane: col(수직) → 첫 자식 → 안쪽 row(같은 축) →
    // 마지막 자식 = pan-f.
    expect(r.data).toMatchObject({ gutter: { pane: "pan-f", edge: "right" } });
  });
});

describe("생략 = 호출자 컨텍스트의 pane", () => {
  it("pane 을 생략하면 활성 pane 의 골을 움직이고, 답이 그 pane 을 지목한다", async () => {
    const r = await execute("pane.resize", { edge: "bottom", ratio: 0.75 }, {});
    expect(r.ok).toBe(true);
    // 활성 pane = pan-b(픽스처의 activePaneId).
    expect(r.data).toMatchObject({ paneId: "pan-b" });
    expect(innerSizes()).toEqual([0.75, 0.25]);
  });
});
