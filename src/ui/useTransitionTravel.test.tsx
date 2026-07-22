// @vitest-environment jsdom
// 주행 신호 — .sidebar 의 left transition 이 도는 동안만 true. 레일 평면이 pane 아래로
// 잠수하는 유일한 근거(§12-④ 창 뒤로 지나간다). 다른 속성 transition 은 신호가 아니다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTransitionTravel } from "./useTransitionTravel";

function Probe() {
  const ref = useRef<HTMLDivElement | null>(null);
  const traveling = useTransitionTravel(ref);
  return <div ref={ref} data-testid="t" data-traveling={traveling ? "1" : "0"} />;
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function fire(type: string, propertyName: string) {
  const el = host.querySelector("[data-testid=t]")!;
  const e = new Event(type, { bubbles: false });
  Object.defineProperty(e, "propertyName", { value: propertyName });
  act(() => void el.dispatchEvent(e));
}

describe("useTransitionTravel — left 주행 동안만 참", () => {
  it("left transitionstart→true, transitionend→false", () => {
    const el = () => host.querySelector<HTMLElement>("[data-testid=t]")!;
    expect(el().dataset.traveling).toBe("0");
    fire("transitionstart", "left");
    expect(el().dataset.traveling).toBe("1");
    fire("transitionend", "left");
    expect(el().dataset.traveling).toBe("0");
  });

  it("left 외 속성 transition 은 신호가 아니다", () => {
    const el = () => host.querySelector<HTMLElement>("[data-testid=t]")!;
    fire("transitionstart", "width");
    expect(el().dataset.traveling).toBe("0");
  });

  it("transitioncancel 도 종료로 취급한다", () => {
    const el = () => host.querySelector<HTMLElement>("[data-testid=t]")!;
    fire("transitionstart", "left");
    fire("transitioncancel", "left");
    expect(el().dataset.traveling).toBe("0");
  });
});
