// @vitest-environment jsdom
// 줌 인텐트 라우팅(플랜 golden-swinging-lynx §1단계) — "포커스가 범위를 정한다".
// 뷰에 DOM 포커스가 있으면 그 뷰의 줌(뷰가 자기 관례로 응답), 없으면(프레임 선택 =
// 크롬 클릭으로 포커스가 body) 창 전체 줌. 새 상태 없이 DOM 포커스가 곧 범위다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrimaryModifier, routeZoom, ZOOM_STEP, clampWindowZoom } from "./zoomIntent";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mountView(viewId: string): HTMLElement {
  const c = document.createElement("div");
  c.className = "plugin-view-container";
  c.dataset.viewAddr = "content/view/test.v";
  c.dataset.paneId = viewId;
  const input = document.createElement("textarea");
  c.appendChild(input);
  document.body.appendChild(c);
  input.focus();
  return c;
}

describe("routeZoom — 포커스가 범위를 정한다", () => {
  it("뷰에 포커스가 있으면 그 뷰로 라우팅한다(창 줌 불변)", () => {
    mountView("v7");
    const view = vi.fn(() => true);
    const win = vi.fn();
    routeZoom("in", { zoomView: view, stepWindow: win });
    expect(view).toHaveBeenCalledWith("v7", "in");
    expect(win).not.toHaveBeenCalled();
  });

  it("뷰 포커스가 없으면(프레임 선택 = body) 창 줌으로 간다", () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const view = vi.fn(() => true);
    const win = vi.fn();
    routeZoom("out", { zoomView: view, stepWindow: win });
    expect(view).not.toHaveBeenCalled();
    expect(win).toHaveBeenCalledWith("out");
  });

  it("포커스 뷰가 줌 미구현이면 범용 폴백 — 컨테이너 --view-font-size 스텝(창 줌으로 새지 않음)", () => {
    const c = mountView("v8");
    const view = vi.fn(() => false); // 훅 없음
    const win = vi.fn();
    routeZoom("in", { zoomView: view, stepWindow: win });
    expect(win).not.toHaveBeenCalled();
    expect(c.style.getPropertyValue("--view-font-size")).toBe("14px");
    routeZoom("reset", { zoomView: view, stepWindow: win });
    expect(c.style.getPropertyValue("--view-font-size")).toBe("13px");
  });
});

describe("창 줌 수치 계약", () => {
  it("스텝 0.1, 배율 0.5..2.0 클램프, 리셋 1.0", () => {
    expect(ZOOM_STEP).toBe(0.1);
    expect(clampWindowZoom(0.2)).toBe(0.5);
    expect(clampWindowZoom(3)).toBe(2);
    expect(clampWindowZoom(1.3000000001)).toBeCloseTo(1.3, 5);
  });

  it("주 수정자 — mac=⌘, 그 외=Ctrl (3플랫폼 공통 문법)", () => {
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "Linux x86_64")).toBe(true);
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, "Win32")).toBe(false);
  });
});
