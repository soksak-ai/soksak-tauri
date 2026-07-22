// @vitest-environment jsdom
// 근접 투영 FLIP 위상 — 위상이 끝나는 순간 layout.reflow 를 발화해야 한다. 네이티브 웹뷰
// (브라우저)는 rAF 측정이라 FLIP 시작 프레임(옛 좌표)을 읽고 눌러앉는데, 종료 신호가 없으면
// 옛 자리에서 클릭을 삼켜 포커스·스왑이 죽는다(신고: "앞쪽을 클릭하면 포커스가 오지 않는다").
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { emitPluginEvent } = vi.hoisted(() => ({ emitPluginEvent: vi.fn() }));
vi.mock("../plugins/hooks", () => ({ emitPluginEvent }));

import type { SplitTree } from "../state/splitTree";
import { useFocusLayoutPhase } from "./useFocusLayoutPhase";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";

type G = { id: string };
const leaf = (id: string): SplitTree<G> => ({ type: "leaf", value: { id } });
// FLIP 조건(같은 크기, x 교환만)을 만족하는 두 배열 — a/b 스왑.
const before: SplitTree<G> = {
  type: "split", id: "r", dir: "row", sizes: [0.5, 0.5],
  children: [leaf("a"), leaf("b")],
};
const after: SplitTree<G> = {
  type: "split", id: "r", dir: "row", sizes: [0.5, 0.5],
  children: [leaf("b"), leaf("a")],
};

function Probe({ layout }: { layout: SplitTree<G> }) {
  const { traveling } = useFocusLayoutPhase(layout, "c1");
  return <div data-testid="p" data-traveling={traveling ? "1" : "0"} />;
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  emitPluginEvent.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useFocusLayoutPhase — FLIP 종료 재스냅 신호", () => {
  it("위상 종료(RAIL_TRAVEL_MS)에 layout.reflow 를 1회 발화한다", () => {
    act(() => root.render(<Probe layout={before} />));
    expect(emitPluginEvent).not.toHaveBeenCalled();
    act(() => root.render(<Probe layout={after} />)); // 스왑 → FLIP 위상 시작
    const el = () => host.querySelector<HTMLElement>("[data-testid=p]")!;
    expect(el().dataset.traveling).toBe("1");
    expect(emitPluginEvent).not.toHaveBeenCalled(); // 시작 신호는 ProjectPane 소유 — 여기선 종료만
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
    expect(emitPluginEvent).toHaveBeenCalledTimes(1);
    expect(emitPluginEvent).toHaveBeenCalledWith("layout.reflow", { activeSpaceId: "c1" });
  });

  it("FLIP 조건 미달(즉시 스냅) 전환은 종료 발화가 없다 — 시작 경로가 이미 커버", () => {
    const resized: SplitTree<G> = {
      type: "split", id: "r", dir: "row", sizes: [0.3, 0.7],
      children: [leaf("a"), leaf("b")],
    };
    act(() => root.render(<Probe layout={before} />));
    act(() => root.render(<Probe layout={resized} />));
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(emitPluginEvent).not.toHaveBeenCalled();
  });
});
