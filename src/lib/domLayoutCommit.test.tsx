// @vitest-environment jsdom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { commitDomLayout } from "./domLayoutCommit";

describe("commitDomLayout — 종료 사건의 DOM 선행 계약", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("함수가 돌아오면 React 상태뿐 아니라 슬롯 DOM도 최종 기하를 가진다", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let setWidth!: Dispatch<SetStateAction<number>>;
    const Fixture = () => {
      const [width, update] = useState(212);
      setWidth = update;
      return <div data-slot style={{ width }} />;
    };
    act(() => root!.render(<Fixture />));

    commitDomLayout(() => setWidth(332));

    expect(host.querySelector<HTMLElement>("[data-slot]")?.style.width).toBe("332px");
  });
});
