// @vitest-environment jsdom
// §12-④ 개정 근거 — 실측(포커스 trace): 활성화가 mousedown 에서 즉시 투영 이동을 시작하면
// 이동막이 게스처와 후속 클릭의 이벤트를 캡처해 죽이고, 재배달이 직전/첫 페인으로 가서
// "클릭한 곳에 포커스가 안 간다"가 된다. 정답은 순서: 클릭을 먼저 확인(게스처 완결)하고,
// 이동은 그 다음에 시작한다. 활성화는 언제나 게스처를 시작한 슬롯에 귀속된다.
import { describe, expect, it, vi } from "vitest";
import { armSlotActivation } from "./slotGesture";

describe("슬롯 게스처 귀속 — 클릭 확인 후 이동", () => {
  it("활성화는 mousedown 이 아니라 게스처 완결(mouseup) 시점에 실행된다", () => {
    const activate = vi.fn();
    armSlotActivation(activate);
    expect(activate).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(activate).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new MouseEvent("mouseup")); // 1회성 — 다음 게스처와 무관
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("mouseup 이 다른 요소 위에 떨어져도 시작 슬롯의 활성화가 실행된다(straddle 귀속)", () => {
    const activate = vi.fn();
    armSlotActivation(activate);
    const other = document.createElement("div");
    document.body.append(other);
    other.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(activate).toHaveBeenCalledTimes(1);
    other.remove();
  });
});
