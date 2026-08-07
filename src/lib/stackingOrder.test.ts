import { describe, expect, it } from "vitest";
import { declaredLayer, establishesStackingContext, stackingPathOf } from "./stackingOrder";

const style = (over: Record<string, string> = {}) => ({
  position: "static",
  zIndex: "auto",
  opacity: "1",
  transform: "none",
  filter: "none",
  backdropFilter: "none",
  perspective: "none",
  clipPath: "none",
  maskImage: "none",
  isolation: "auto",
  mixBlendMode: "normal",
  willChange: "auto",
  contain: "none",
  display: "block",
  ...over,
});

describe("칠하는 순서를 정하는 조상 사슬", () => {
  it("auto 는 층을 선언하지 않은 것이다 — 0 이 아니다", () => {
    expect(declaredLayer("7")).toBe(7);
    expect(declaredLayer("-1")).toBe(-1);
    expect(declaredLayer("auto")).toBeNull();
    expect(declaredLayer(undefined)).toBeNull();
  });

  it("문맥을 만드는 선언을 알아본다", () => {
    expect(establishesStackingContext(style(), { isRoot: true })).toBe(true);
    expect(establishesStackingContext(style())).toBe(false);
    expect(establishesStackingContext(style({ position: "absolute", zIndex: "1" }))).toBe(true);
    // 배치만 하고 층을 선언하지 않으면 자손을 가두지 않는다.
    expect(establishesStackingContext(style({ position: "absolute" }))).toBe(false);
    expect(establishesStackingContext(style({ position: "fixed" }))).toBe(true);
    expect(establishesStackingContext(style({ opacity: "0.9" }))).toBe(true);
    expect(establishesStackingContext(style({ filter: "blur(2px)" }))).toBe(true);
    expect(establishesStackingContext(style({ transform: "translateX(1px)" }))).toBe(true);
    expect(establishesStackingContext(style({ isolation: "isolate" }))).toBe(true);
    expect(establishesStackingContext(style({ mixBlendMode: "multiply" }))).toBe(true);
    expect(establishesStackingContext(style({ willChange: "transform" }))).toBe(true);
    expect(establishesStackingContext(style({ contain: "paint" }))).toBe(true);
    // flex/grid 항목은 배치되지 않아도 z 를 선언하면 문맥을 만든다.
    expect(establishesStackingContext(style({ zIndex: "2" }), { parentDisplay: "flex" })).toBe(true);
    expect(establishesStackingContext(style({ zIndex: "2" }), { parentDisplay: "block" })).toBe(false);
  });

  // 실사고: 레일 평면(7)과 포커스 베일(6)은 같은 stacking context 에 없다. 사이의
  // .space-plane(1)이 자기 문맥을 만들어 베일을 가둔다 — 두 z 를 직접 빼는 판정은 그 날을 못 본다.
  it("문맥을 만드는 조상과 배치된 조상만 싣고, 순서 무관한 조상은 뺀다", () => {
    const document_ = new DOMParser().parseFromString(
      `<div id="root">
         <div id="plain"><div id="space"><div id="veil"></div></div></div>
       </div>`,
      "text/html",
    );
    const styles = new Map<string, Record<string, string>>([
      ["root", style({ position: "relative" })],
      ["plain", style()],
      ["space", style({ position: "absolute", zIndex: "1" })],
      ["veil", style({ position: "absolute", zIndex: "6" })],
    ]);
    const veil = document_.getElementById("veil")!;
    const path = stackingPathOf(veil, {
      getStyle: (node) => styles.get(node.id) ?? style(),
      identify: (node) => node.id,
    });

    // html·body 는 흐름 안 상자라 순서를 바꾸지 않는다. 실린 것은 뿌리·문맥·배치·자기 자신뿐.
    expect(path.map((entry) => entry.identity)).toEqual(["", "root", "space", "veil"]);
    const last = path[path.length - 1];
    expect(last).toMatchObject({ identity: "veil", zIndex: 6, positioned: true });
    expect(path[2]).toMatchObject({ identity: "space", zIndex: 1 });
    // 뿌리부터의 자식 순번 사슬 — 층이 같은 자리는 문서 순서가 가른다.
    expect(last.order.length).toBeGreaterThan(path[2].order.length);
  });

  it("층을 선언하지 않은 배치 상자도 사슬에 실린다", () => {
    const document_ = new DOMParser().parseFromString(
      `<div id="a"><div id="b"></div></div>`,
      "text/html",
    );
    const styles = new Map<string, Record<string, string>>([
      ["a", style({ position: "relative" })],
      ["b", style()],
    ]);
    const path = stackingPathOf(document_.getElementById("b")!, {
      getStyle: (node) => styles.get(node.id) ?? style(),
      identify: (node) => node.id,
    });
    expect(path.find((entry) => entry.identity === "a"))
      .toMatchObject({ zIndex: null, positioned: true });
  });
});
