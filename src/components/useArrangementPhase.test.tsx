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
  contentKey = "",
  onPhase,
  canGlide,
}: {
  arrangement: Arrangement<G>;
  scopeId: string;
  contentKey?: string;
  onPhase?: (rebase: () => void) => void;
  canGlide?: () => boolean;
}) {
  const phase = useArrangementPhase(arrangement, scopeId, contentKey, canGlide);
  onPhase?.(phase.rebase);
  return (
    <div
      data-testid="p"
      data-traveling={phase.traveling ? "1" : "0"}
      data-moves={phase.moves.map((m) => m.id).join(",")}
      data-station={String(phase.displayed?.station ?? "")}
      data-content={String(phase.displayed === arrangement ? "live" : "stale")}
      data-gen={String(phase.generation)}
      data-glide={phase.glide ? "1" : "0"}
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

  it("세대(레일 key)는 도착이 상주가 되는 순간에만 전진한다 — 닫히는 레일은 서 있던 그것이다", () => {
    // 세대는 레일 레이어의 React key 다. 위상 시작에 전진시키면 출발선 레이어도 새 key 를 받아
    // **서 있던 사이드바가 파괴되고 빠질 자리에 새것이 끼워진다**(그것이 닫힌다). 사용자 규정:
    // 빠지는 자리는 원래 있던 게 닫히면 끝이고, 새것은 생기는 자리에서만 열린다.
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    const standing = el().dataset.gen;

    act(() => root.render(<Probe arrangement={to} scopeId={scopeOf(to)} />));
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.gen).toBe(standing); // 출발선 레이어 = 서 있던 인스턴스

    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(Number(el().dataset.gen)).toBe(Number(standing) + 1); // 도착 레이어가 상주가 된다
  });

  it("내용 변화(뷰 열림·탭 전환)는 세대를 전진시키지 않는다 — 사이드바 재마운트 금지", () => {
    const at = solve(twoColumns, "a");
    act(() =>
      root.render(<Probe arrangement={at} scopeId={scopeOf(at)} contentKey="v1" />),
    );
    const standing = el().dataset.gen;
    act(() =>
      root.render(
        <Probe arrangement={solve(twoColumns, "a")} scopeId={scopeOf(at)} contentKey="v1,v2" />,
      ),
    );
    expect(el().dataset.traveling).toBe("0");
    expect(el().dataset.gen).toBe(standing);
  });

  it("여정 모드(활강 가능)는 시작에 한 번 정해지고 위상 중에 바뀌지 않는다", () => {
    // 모드가 위상 한복판에 바뀌면 레일 표상이 1장(도착선)↔2장(빠질·생길 자리)으로 형태를
    // 바꾼다. 1장 렌더에서 서 있던 사이드바가 새 투영으로 커밋되고, 다음 프레임에 그것이
    // 빠지는 자리로 밀려나 **새 투영을 든 채 닫힌다**(실측 결함).
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    let glide = true;
    const canGlide = () => glide;
    act(() =>
      root.render(<Probe arrangement={at} scopeId={scopeOf(at)} canGlide={canGlide} />),
    );
    act(() =>
      root.render(<Probe arrangement={to} scopeId={scopeOf(to)} canGlide={canGlide} />),
    );
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.glide).toBe("1");

    glide = false; // 위상 중 스냅이 낡거나 뷰가 바뀌어 활강 전제가 깨진다
    act(() =>
      root.render(<Probe arrangement={to} scopeId={scopeOf(to)} canGlide={canGlide} />),
    );
    expect(el().dataset.glide).toBe("1"); // 이 여정의 모드는 이미 정해졌다

    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    const back = solve(twoColumns, "a"); // 같은 평면의 다음 여정
    act(() =>
      root.render(<Probe arrangement={back} scopeId={scopeOf(back)} canGlide={canGlide} />),
    );
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.glide).toBe("0"); // 다음 여정은 그때의 전제로 정해진다
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

  it("주행 중 도착한 해는 표시를 갈아치우지 않고 대기한다 — 달리는 여정은 튀지 않는다", () => {
    // 표시를 즉시 갈면 CSS 변수 갱신으로 달리는 애니메이션의 출발 오프셋이 재해석돼 요소가
    // 남은 진행도만큼 튄다(최대 두 이동량의 합). 대기열은 그 결함을 구조적으로 없앤다.
    const at = solve(threeColumns, "a"); // station 0
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    const toB = solve(threeColumns, "b"); // station 33.33
    act(() => root.render(<Probe arrangement={toB} scopeId={scopeOf(toB)} />));
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.station).toBe(String(toB.station));

    // 여정 한복판에 세 번째 해가 도착한다 — 표시는 여전히 첫 목표다.
    const toC = solve(threeColumns, "c"); // station 66.67
    act(() => root.render(<Probe arrangement={toC} scopeId={scopeOf(toC)} />));
    expect(el().dataset.station).toBe(String(toB.station));

    // 첫 여정이 끝나면 그 자리에서 최신 목표로 다음 여정이 출발한다.
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.station).toBe(String(toC.station));
    expect(el().dataset.traveling).toBe("1");
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
  });

  it("클릭을 몇 번 하든 위상은 최대 둘이다 — 중간 목표는 접힌다", () => {
    const at = solve(threeColumns, "a");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    const toB = solve(threeColumns, "b");
    act(() => root.render(<Probe arrangement={toB} scopeId={scopeOf(toB)} />));
    // 여정 중 b→c→a 로 연달아 바뀐다 — 마지막 하나만 살아남는다.
    for (const id of ["c", "a"]) {
      const next = solve(threeColumns, id);
      act(() => root.render(<Probe arrangement={next} scopeId={scopeOf(next)} />));
    }
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.station).toBe(String(solve(threeColumns, "a").station));
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
  });

  it("기하가 안 바뀌는 변화(뷰 추가·탭 전환)는 표시가 즉시 반영한다", () => {
    // 표시의 주인이 위상이라면, 위상은 '기하'만 붙잡아야 한다. 내용 변화(패널에 뷰가 열림)를
    // 기하 서명으로만 판정하면 표시가 옛 트리에 영구히 머물고 새 뷰가 화면에 나타나지 않는다
    // (라이브 실증: view.open 이 v2 를 만들었는데 패널에 탭조차 없었다).
    const at = solve(twoColumns, "a");
    act(() =>
      root.render(<Probe arrangement={at} scopeId={scopeOf(at)} contentKey="g1:v1|g2:v2" />),
    );
    expect(el().dataset.content).toBe("live");

    // 같은 기하, 다른 내용 — 뷰가 하나 열렸다.
    const same = solve(twoColumns, "a");
    act(() =>
      root.render(
        <Probe arrangement={same} scopeId={scopeOf(same)} contentKey="g1:v1+v3|g2:v2" />,
      ),
    );
    expect(el().dataset.content).toBe("live"); // 즉시 최신 해를 표시한다
    expect(el().dataset.traveling).toBe("0"); // 기하는 안 움직였으니 여정도 없다
  });

  it("rebase 는 다음 해를 여정 없이 받는다 — 손 드래그 착지는 여정이 아니다", () => {
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

    // 손이 옮겨 놓은 자리를 커밋한 해가 뒤이어 도착해도 여정을 열지 않는다(옛 결함: 착지
    // 직후 커밋이 0→실위치 유령 여정을 재개했다).
    const committed = solve(twoColumns, "b");
    act(() =>
      root.render(
        <Probe arrangement={committed} scopeId={scopeOf(committed)} onPhase={capture} />,
      ),
    );
    expect(el().dataset.traveling).toBe("0");
  });
});
