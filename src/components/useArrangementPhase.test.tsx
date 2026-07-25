// @vitest-environment jsdom
// 배치 위상 — 해가 바뀌면 직전 해를 붙잡아 이동의 출발점을 주고, RAIL_TRAVEL_MS 뒤 착지한다.
// 위상 추적이 하나뿐이라는 것이 계약의 핵심이다: 스위칭과 주행이 한 클릭에 겹쳐도 출발점은 하나다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { redeliverViewFocusIfLost } = vi.hoisted(() => ({
  redeliverViewFocusIfLost: vi.fn(),
}));
vi.mock("../plugins/viewFocus", () => ({ redeliverViewFocusIfLost }));

import type { SplitTree } from "../state/splitTree";
import { solveArrangement, type Arrangement } from "../lib/railArrangement";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";
import { railGeometryScopeId } from "../lib/railMotion";
import { useArrangementPhase } from "./useArrangementPhase";

type G = { id: string };
const leaf = (id: string): SplitTree<G> => ({ type: "leaf", value: { id } });
const twoColumns: SplitTree<G> = {
  type: "split",
  id: "r",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [leaf("a"), leaf("b")],
};
const threeColumns: SplitTree<G> = {
  type: "split",
  id: "r",
  dir: "row",
  sizes: [1 / 3, 1 / 3, 1 / 3],
  children: [leaf("a"), leaf("b"), leaf("c")],
};

const solve = (layout: SplitTree<G>, focusId: string) =>
  solveArrangement<G>({
    layout,
    focusId,
    placement: { mode: "flow" },
    railOpen: true,
  });

function Probe({
  arrangement,
  scopeId,
  onPhase,
}: {
  arrangement: Arrangement<G>;
  scopeId: string;
  onPhase?: (rebase: () => void) => void;
}) {
  const phase = useArrangementPhase(arrangement, scopeId);
  onPhase?.(phase.rebase);
  return (
    <div
      data-testid="p"
      data-traveling={phase.traveling ? "1" : "0"}
      data-moves={phase.moves.map((m) => m.id).join(",")}
    />
  );
}

let host: HTMLElement;
let root: Root;
const scopeOf = (a: Arrangement<G>) => railGeometryScopeId("c1", a.cleanLines);
const el = () => host.querySelector<HTMLElement>("[data-testid=p]")!;

beforeEach(() => {
  vi.useFakeTimers();
  redeliverViewFocusIfLost.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useArrangementPhase", () => {
  it("해가 바뀌면 이동하는 패널만 실어 주행하고 RAIL_TRAVEL_MS 뒤 착지한다", () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    expect(el().dataset.traveling).toBe("0");

    act(() => root.render(<Probe arrangement={to} scopeId={scopeOf(to)} />));
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.moves).toBe("a"); // 레일이 가로지른 패널만
    expect(redeliverViewFocusIfLost).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
    // 재배열이 떨군 입력 포커스는 착지 시점에 1회 재배달한다.
    expect(redeliverViewFocusIfLost).toHaveBeenCalledTimes(1);
  });

  it("같은 해가 다시 렌더돼도 주행하지 않는다(유령 위상 금지)", () => {
    const at = solve(twoColumns, "a");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    act(() =>
      root.render(<Probe arrangement={solve(twoColumns, "a")} scopeId={scopeOf(at)} />),
    );
    expect(el().dataset.traveling).toBe("0");
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(redeliverViewFocusIfLost).not.toHaveBeenCalled();
  });

  it("평면이 바뀌면(분할·병합) 출발 기하를 소비하지 않고 즉시 재정박한다", () => {
    const at = solve(twoColumns, "b");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    // 선 집합이 달라진 새 평면 — 옛 station 을 적용하면 레일이 패널을 관통한다.
    const split = solve(threeColumns, "b");
    act(() => root.render(<Probe arrangement={split} scopeId={scopeOf(split)} />));
    expect(el().dataset.traveling).toBe("0");
  });

  it("rebase 는 주행을 즉시 끝낸다 — 손 드래그 착지는 여정이 아니다", () => {
    const at = solve(twoColumns, "a");
    let rebase = () => {};
    const capture = (fn: () => void) => {
      rebase = fn;
    };
    act(() =>
      root.render(
        <Probe arrangement={at} scopeId={scopeOf(at)} onPhase={capture} />,
      ),
    );
    const to = solve(twoColumns, "b");
    act(() =>
      root.render(
        <Probe arrangement={to} scopeId={scopeOf(to)} onPhase={capture} />,
      ),
    );
    expect(el().dataset.traveling).toBe("1");
    act(() => rebase());
    expect(el().dataset.traveling).toBe("0");
  });
});
