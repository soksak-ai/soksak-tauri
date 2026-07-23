import { describe, expect, it } from "vitest";
import type { SplitTree } from "../state/splitTree";
import { leavesOf } from "../state/splitTree";
import { computeSplitLayout } from "./splitLayout";
import { cleanRailLines, isCleanRailStation } from "./railPlacement";
import { projectFocusedPanelNearRail } from "./railFocusLayout";

type Panel = { id: string };
const leaf = (id: string): SplitTree<Panel> => ({
  type: "leaf",
  value: { id },
});

// [db | col([design | ghostty], terminal) | kanban]
// ghostty의 50% 왼쪽 선은 terminal이 가로지르므로 깨끗하지 않다. 같은 row에서
// design과 자리를 교환하면 ancestor의 33.33% 깨끗한 선에 바로 붙는다.
const fixture = (): SplitTree<Panel> => ({
  type: "split",
  id: "root",
  dir: "row",
  sizes: [1 / 3, 1 / 3, 1 / 3],
  children: [
    leaf("db"),
    {
      type: "split",
      id: "middle",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [leaf("design"), leaf("ghostty")],
        },
        leaf("terminal"),
      ],
    },
    leaf("kanban"),
  ],
});

const order = (tree: SplitTree<Panel>): string[] =>
  leavesOf(tree).map((panel) => panel.id);

describe("FLOW 포커스 패널 근접 투영", () => {
  it("옵션이 꺼져 있으면 막힌 ghostty도 원본 트리와 객체 정체성을 유지한다", () => {
    const original = fixture();
    expect(projectFocusedPanelNearRail(original, "ghostty", false)).toBe(original);
  });

  it("막힌 ghostty를 같은 row의 design과 화면에서만 교환해 깨끗한 앞 선에 붙인다", () => {
    const original = fixture();
    const before = structuredClone(original);
    const projected = projectFocusedPanelNearRail(original, "ghostty", true);

    expect(projected).not.toBe(original);
    expect(order(projected)).toEqual(["db", "ghostty", "design", "terminal", "kanban"]);
    expect(original).toEqual(before); // 저장 트리는 절대 변이하지 않는다.

    const layout = computeSplitLayout(projected);
    const target = layout.cells.find((cell) => cell.value.id === "ghostty")!;
    const clean = cleanRailLines(layout.cells.map((cell) => cell.rect));
    expect(isCleanRailStation(clean, target.rect.left)).toBe(true);
  });

  it("이미 깨끗한 design·terminal·kanban 포커스에는 배열을 건드리지 않는다", () => {
    const original = fixture();
    expect(projectFocusedPanelNearRail(original, "design", true)).toBe(original);
    expect(projectFocusedPanelNearRail(original, "terminal", true)).toBe(original);
    expect(projectFocusedPanelNearRail(original, "kanban", true)).toBe(original);
  });

  it("ghostty에서 비영향 패널로 포커스를 옮기면 정본에서 다시 계산되어 원래 배열로 복귀한다", () => {
    const original = fixture();
    const ghosttyProjection = projectFocusedPanelNearRail(original, "ghostty", true);
    expect(order(ghosttyProjection)).toEqual(["db", "ghostty", "design", "terminal", "kanban"]);

    const restored = projectFocusedPanelNearRail(original, "terminal", true);
    expect(restored).toBe(original);
    expect(order(restored)).toEqual(["db", "design", "ghostty", "terminal", "kanban"]);
  });

  it("멀리 있는 포커스는 가장 가까운 왼쪽 형제와만 교환한다 — 전역 재배열 금지(최소 이동)", () => {
    // 신고 재현: 위 [terminal | playbox | astryxTop], 아래 [about | astryxBottom(2/3)].
    // astryxTop의 왼쪽 선 66.67은 astryxBottom이 가로질러 막혀 있다. 맨 앞(0)으로 보내면
    // 레일이 0으로 점프하고 전원이 재배열된다(최대 이동 — 결함). 올바른 투영은 바로 왼쪽
    // 형제 playbox와의 교환 하나 — 포커스 왼쪽 선이 이미 깨끗한 33.33에 닿고, terminal·
    // about·astryxBottom은 제자리다.
    const reported: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [1 / 3, 1 / 3, 1 / 3],
          children: [leaf("terminal"), leaf("playbox"), leaf("astryxTop")],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [1 / 3, 2 / 3],
          children: [leaf("about"), leaf("astryxBottom")],
        },
      ],
    };
    const projected = projectFocusedPanelNearRail(reported, "astryxTop", true);
    expect(order(projected)).toEqual([
      "terminal",
      "astryxTop",
      "playbox",
      "about",
      "astryxBottom",
    ]);
    const layout = computeSplitLayout(projected);
    const target = layout.cells.find((cell) => cell.value.id === "astryxTop")!;
    expect(target.rect.left).toBeCloseTo(100 / 3, 5); // 스테이션 무이동 — 기존 33.33 선에 붙는다
    const terminal = layout.cells.find((cell) => cell.value.id === "terminal")!;
    expect(terminal.rect.left).toBeCloseTo(0, 5); // 비참여 패널은 제자리
  });

  it("폭이 다른 형제도 sizes 를 함께 교환해 연결한다 — 각 폭 보존, 위치만 맞바꿈", () => {
    // 신고 재현: 위 [t1|t2](반반), 아래 [about(1/3)|astryx(2/3)]. astryx 왼쪽 33.3은 위가
    // 가로질러 더럽고, 파트너 about 과 폭이 달라 종전 가드는 교환을 거부했다 — 결과:
    // 활성은 되는데 레일이 영원히 못 붙는다("하단 우측에 포커스가 가지 않는다" 체감).
    // 교환은 children 과 sizes 를 함께 — astryx 는 자기 폭(2/3) 그대로 0에 앉는다(0은 항상 깨끗).
    const reported: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [leaf("t1"), leaf("t2")],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [1 / 3, 2 / 3],
          children: [leaf("about"), leaf("astryx")],
        },
      ],
    };
    const projected = projectFocusedPanelNearRail(reported, "astryx", true);
    expect(order(projected)).toEqual(["t1", "t2", "astryx", "about"]);
    const layout = computeSplitLayout(projected);
    const astryx = layout.cells.find((cell) => cell.value.id === "astryx")!;
    const about = layout.cells.find((cell) => cell.value.id === "about")!;
    expect(astryx.rect.left).toBeCloseTo(0, 5);
    expect(astryx.rect.width).toBeCloseTo(200 / 3, 5); // 폭 보존
    expect(about.rect.width).toBeCloseTo(100 / 3, 5); // 폭 보존
    const t1 = layout.cells.find((cell) => cell.value.id === "t1")!;
    expect(t1.rect.left).toBeCloseTo(0, 5); // 비참여 row 제자리
  });

  it("교환해도 깨끗한 선에 닿지 못하는 구조라면 잘못된 재배치를 적용하지 않는다", () => {
    const original: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.25, 0.75],
          children: [
            leaf("prefix"),
            {
              type: "split",
              id: "nested",
              dir: "row",
              sizes: [0.5, 0.5],
              children: [leaf("a"), leaf("target")],
            },
          ],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [0.4, 0.6],
          children: [leaf("b"), leaf("c")],
        },
      ],
    };
    expect(projectFocusedPanelNearRail(original, "target", true)).toBe(original);
  });

  it("서로 다른 폭의 형제는 sizes 를 함께 교환한다 — 어떤 패널도 늘거나 줄지 않는다", () => {
    const original: SplitTree<Panel> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.3, 0.7],
          children: [leaf("a"), leaf("target")],
        },
        leaf("bottom"),
      ],
    };
    const projected = projectFocusedPanelNearRail(original, "target", true);
    expect(order(projected)).toEqual(["target", "a", "bottom"]);
    const layout = computeSplitLayout(projected);
    const target = layout.cells.find((cell) => cell.value.id === "target")!;
    const a = layout.cells.find((cell) => cell.value.id === "a")!;
    expect(target.rect.left).toBeCloseTo(0, 5);
    expect(target.rect.width).toBeCloseTo(70, 5); // 폭 보존
    expect(a.rect.width).toBeCloseTo(30, 5); // 폭 보존
  });
});
