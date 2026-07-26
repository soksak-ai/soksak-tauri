// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailLinkOverlay } from "./RailLinkOverlay";
import { useSettings } from "../state/settings";

vi.mock("../state/theme", () => ({
  useTheme: (select: (state: unknown) => unknown) =>
    select({ spec: { relation: { radius: 12, strokeWidth: 1.5 } } }),
}));
vi.mock("../i18n", () => ({ useT: () => () => "LINKED" }));

let observed: ((entries: Array<{ contentRect: DOMRect }>) => void) | undefined;
class ResizeObserverMock {
  constructor(callback: typeof observed) {
    observed = callback;
  }
  observe() {}
  disconnect() {}
}

let hostSize = { width: 1200, height: 800 };

describe("RailLinkOverlay — 실시간 그리드 추종", () => {
  beforeEach(() => {
    observed = undefined;
    hostSize = { width: 1200, height: 800 };
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 0, y: 0, left: 0, top: 0, right: hostSize.width,
        bottom: hostSize.height, width: hostSize.width, height: hostSize.height,
        toJSON: () => ({}),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("resize·분할비 변경에 path 하나만 즉시 다시 계산하고 DOM 상태를 노출한다", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (width: number) => (
      <RailLinkOverlay
        contentId="c1"
        boundViewId="v2"
        boundPaneId="g2"
        railWidth={300}
        railStation={50}
        targetRect={{ left: 50, top: 0, width, height: 50 }}
      />
    );

    act(() => root.render(render(25)));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    const first = host.querySelector<SVGPathElement>(".rail-link-shape")!.getAttribute("d");
    expect(overlay.dataset).toMatchObject({
      node: "relation/rail/c1",
      boundView: "v2",
      boundPane: "g2",
      connected: "true",
    });
    expect(host.querySelectorAll(".rail-link-shape")).toHaveLength(1);

    act(() => root.render(render(40)));
    const splitResize = host.querySelector<SVGPathElement>(".rail-link-shape")!.getAttribute("d");
    expect(splitResize).not.toBe(first);

    hostSize = { width: 1000, height: 700 };
    act(() => observed?.([{ contentRect: {
      ...hostSize, x: 0, y: 0, left: 0, top: 0,
      right: 1000, bottom: 700, toJSON: () => ({}),
    } as DOMRect }]));
    const windowResize = host.querySelector<SVGPathElement>(".rail-link-shape")!.getAttribute("d");
    expect(windowResize).not.toBe(splitResize);

    act(() => root.unmount());
  });

  it("PIN 등으로 사이에 다른 패널이 끼면 관계면을 아예 렌더하지 않는다", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(
      <RailLinkOverlay
        contentId="c1" boundViewId="v2" boundPaneId="g2"
        railWidth={300} railStation={0}
        targetRect={{ left: 50, top: 0, width: 50, height: 100 }}
      />,
    ));
    // 비인접(간격 1%p 초과) 억제 — 억지 원거리 연결은 빈 오버레이 DOM 도 남기지 않는다.
    expect(host.querySelector(".rail-link-overlay")).toBeNull();
    act(() => root.unmount());
  });

// 상위 describe 의 beforeEach(ResizeObserver·rect 목)를 상속한다 — 중첩 의도.
describe("교체-인접 표시", () => {
  const renderProps = (projected: boolean) => (
    <RailLinkOverlay
      contentId="c1"
      boundViewId="v2"
      boundPaneId="g2"
      railWidth={300}
      railStation={50}
      targetRect={{ left: 50, top: 0, width: 25, height: 50 }}
      projected={projected}
    />
  );

  it("기본(edge): projected=true 면 바깥 변 점선 분리 렌더 + data-projected 노출", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(renderProps(true)));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.dataset.projected).toBe("true");
    expect(host.querySelector(".rail-link-edge")).not.toBeNull();
    expect(host.querySelector(".rail-link-rest")).not.toBeNull();
    expect(host.querySelector(".rail-link-seam")).toBeNull();
  });

  it("seam 옵션: 내부 공유변 점선을 그린다(정식 선택지)", () => {
    useSettings.setState({ railSeamStyle: "seam" });
    try {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => root.render(renderProps(true)));
      expect(host.querySelector(".rail-link-seam")).not.toBeNull();
      expect(host.querySelector(".rail-link-edge")).toBeNull();
    } finally {
      useSettings.setState({ railSeamStyle: "edge" });
    }
  });

  it("자연 인접(projected=false)은 어떤 표시도 없다 — 한 몸", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(renderProps(false)));
    expect(host.querySelector(".rail-link-seam")).toBeNull();
    expect(host.querySelector(".rail-link-edge")).toBeNull();
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.dataset.projected).toBeUndefined();
  });
});
});
