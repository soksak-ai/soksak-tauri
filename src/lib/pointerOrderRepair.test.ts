// @vitest-environment jsdom
// 실측(포커스 trace): macOS 창 활성화 클릭이 mouseup 을 유실·선행시키면(6104ms mousedown →
// 다음 up 2.7s 뒤) 터미널들은 버튼이 눌린 줄 알고 이후 물리 이동을 드래그 선택으로 그린다
// (클릭만 했는데 거대 선택). 코어 입력 경계가 유령 홀드를 감지해 mouseup 을 합성해 닫는다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPointerOrderRepair } from "./pointerOrderRepair";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
});

describe("포인터 순서 복구 — 유령 홀드 닫기", () => {
  it("mousedown 후 buttons=0 인 mousemove 가 오면 그 대상에 mouseup 을 합성한다", () => {
    stop = startPointerOrderRepair();
    const el = document.createElement("div");
    document.body.append(el);
    const ups: number[] = [];
    el.addEventListener("mouseup", (e) => ups.push(e.clientX));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    el.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons: 0, clientX: 77 }),
    );
    expect(ups).toEqual([77]); // 유령 홀드 즉시 종결 — 드래그 선택 발동 불가
  });

  it("정상 드래그(buttons=1 이동)와 정상 종결(실 mouseup) 은 건드리지 않는다", () => {
    stop = startPointerOrderRepair();
    const el = document.createElement("div");
    document.body.append(el);
    const synth = vi.fn();
    el.addEventListener("mouseup", synth);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1 }));
    expect(synth).not.toHaveBeenCalled();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons: 0, clientX: 9 }),
    );
    expect(synth).toHaveBeenCalledTimes(1); // 실 up 1회뿐 — 합성 추가 없음
  });
});
