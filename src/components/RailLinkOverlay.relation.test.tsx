// @vitest-environment jsdom
// 관계면 3안 스위치(railRelation: tint|moment|stroke) 계약 — 비교 실험용 임시 축.
// 결정 시 채택안만 남기고 이 스위치·모드 CSS 갈래와 함께 소거한다.
//  - tint(기본): 모드 클래스 relation-tint, 스트로크·라벨 없이 저농도 액센트 채움만(CSS 갈래).
//  - moment: 결부 정체성(boundViewId/targetRect)이 바뀐 순간만 600ms 플래시 후 페이드아웃.
//  - stroke: 현행 그대로(기준점).
//  - 공통: 레일이 결부 셀에 인접하지 않으면(논리 간격 1%p 초과) 관계면을 아예 렌더하지 않는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom localStorage 비동작 → Map 스텁(settings.test 선례). settings import 전이 계약.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

vi.mock("../state/theme", () => ({
  useTheme: (select: (state: unknown) => unknown) =>
    select({ spec: { relation: { radius: 12, strokeWidth: 1.5 } } }),
}));
vi.mock("../i18n", () => ({ useT: () => () => "LINKED" }));

import { RailLinkOverlay } from "./RailLinkOverlay";
import { useSettings } from "../state/settings";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const adjacentRect = { left: 50, top: 0, width: 25, height: 50 };

function overlayProps(overrides: Partial<{
  boundViewId: string;
  railStation: number;
  targetRect: typeof adjacentRect;
}> = {}) {
  return {
    contentId: "c1",
    boundViewId: overrides.boundViewId ?? "v2",
    boundPanelId: "g2",
    railWidth: 300,
    railStation: overrides.railStation ?? 50,
    targetRect: overrides.targetRect ?? adjacentRect,
  };
}

describe("RailLinkOverlay — railRelation 3안 스위치", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 0, y: 0, left: 0, top: 0, right: 1200,
        bottom: 800, width: 1200, height: 800,
        toJSON: () => ({}),
      }),
    );
    useSettings.setState({ railRelation: "tint" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("기본값은 tint — 루트에 relation-tint 모드 클래스를 붙인다", () => {
    // 설정 축 자체의 기본값도 tint(스토어 DEFAULTS).
    expect(useSettings.getState().railRelation).toBe("tint");
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.classList.contains("relation-tint")).toBe(true);
    expect(overlay.dataset.flash).toBeUndefined();
  });

  it("railRelation 전환이 모드 클래스(relation-moment|relation-stroke)로 반영된다", () => {
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    act(() => useSettings.setState({ railRelation: "stroke" }));
    expect(
      host.querySelector(".rail-link-overlay.relation-stroke"),
    ).not.toBeNull();
    act(() => useSettings.setState({ railRelation: "moment" }));
    expect(
      host.querySelector(".rail-link-overlay.relation-moment"),
    ).not.toBeNull();
    expect(host.querySelectorAll(".rail-link-overlay")).toHaveLength(1);
  });

  it("비인접(간격 1%p 초과)이면 모든 모드에서 관계면을 아예 렌더하지 않는다", () => {
    for (const mode of ["tint", "moment", "stroke"] as const) {
      useSettings.setState({ railRelation: mode });
      act(() =>
        root.render(
          <RailLinkOverlay
            {...overlayProps({ railStation: 0 })}
            key={mode}
          />,
        ),
      );
      expect(host.querySelector(".rail-link-overlay")).toBeNull();
    }
  });

  it("간격 1%p 이하는 부동소수 허용오차 — 관계면 루트는 렌더된다", () => {
    act(() =>
      root.render(<RailLinkOverlay {...overlayProps({ railStation: 49 })} />),
    );
    expect(host.querySelector(".rail-link-overlay")).not.toBeNull();
  });

  it("moment: 결부 정체성 변경 순간만 600ms 플래시 후 꺼진다(fake timer)", () => {
    vi.useFakeTimers();
    useSettings.setState({ railRelation: "moment" });

    // 결부 등장(마운트)도 '바뀐 순간' — 플래시.
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    const flash = () =>
      host.querySelector<HTMLElement>(".rail-link-overlay")!.dataset.flash;
    expect(flash()).toBe("true");

    act(() => vi.advanceTimersByTime(599));
    expect(flash()).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(flash()).toBe("false");

    // 같은 정체성 재렌더는 재점화하지 않는다.
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    expect(flash()).toBe("false");

    // targetRect 정체성 변경 → 재점화.
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({ targetRect: { ...adjacentRect, width: 40 } })}
        />,
      ),
    );
    expect(flash()).toBe("true");
    act(() => vi.advanceTimersByTime(600));
    expect(flash()).toBe("false");

    // boundViewId 변경도 정체성 변경 → 재점화.
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({
            boundViewId: "v3",
            targetRect: { ...adjacentRect, width: 40 },
          })}
        />,
      ),
    );
    expect(flash()).toBe("true");
  });
});

// CSS 갈래는 jsdom 이 계산하지 않으므로 App.css 를 직접 게이트한다(cssContract 선례).
// 이 규칙들도 실험 임시물 — 3안 결정 시 테스트째 소거.
describe("railRelation 모드 CSS 갈래 (App.css)", () => {
  // 주석 제거 후 매칭 — 규칙 사이·안의 설명 주석이 셀렉터 탐색을 오염시키지 않게.
  const css = readFileSync(join(process.cwd(), "src", "App.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  function decls(selector: string): string {
    const escaped = selector.replace(/[.[\]"=]/g, (c) => `\\${c}`);
    const match = css.match(
      new RegExp(`(?:^|,|\\})\\s*(?:[^,{}]+,\\s*)*${escaped}\\s*(?:,[^{}]+)?\\{([^}]*)\\}`),
    );
    expect(match, `App.css 에 ${selector} 규칙이 있어야 한다`).not.toBeNull();
    return match![1];
  }

  it("tint: 스트로크 없음 + 저농도 액센트 채움(성공색·relation 토큰 금지)", () => {
    const d = decls(".rail-link-overlay.relation-tint .rail-link-shape");
    expect(d).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*5%,\s*transparent\)/);
    expect(d).toMatch(/stroke:\s*none/);
    expect(d).not.toMatch(/var\(--relation-stroke\)/);
  });

  it("포커스 스포트라이트: 전체 dim + 활성만 filter 해제(선택만 명확)", () => {
    // 사용자 개념: "전체를 흐리게 하고 선택된 것만 명확하게". blur 는 텍스트를 뭉개므로
    // 밝기·채도 하강만 쓴다. 전이가 있어 활성 이동 시 어둠이 옮겨간다.
    for (const part of [".egroup-cell", ".egroup-body-slot"]) {
      const dim = decls(`.egroup-area[data-focus-dim] ${part}`);
      expect(dim).toMatch(/filter:\s*brightness\(0\.93\)\s*saturate\(0\.85\)/);
      expect(dim).toMatch(/transition:[^;]*filter/);
      const clear = decls(`.egroup-area[data-focus-dim] ${part}.spot-clear`);
      expect(clear).toMatch(/filter:\s*none/);
    }
    // 네이티브 표면 셰이드 — 이 앱의 레이어 역전(DOM 최상위, 엔진·child 웹뷰는 투명 홀로
    // 아래에서 비침) 때문에 CSS filter 는 네이티브 콘텐츠에 닿지 않는다. 슬롯의 반투명
    // 배경이 홀 위에 깔려 아래의 모든 네이티브 표면(CEF·웹뷰 child)을 균일하게 어둡힌다.
    expect(css).toMatch(
      /\.egroup-area\[data-focus-dim\] \.egroup-body-slot \{[^}]*background-color: color-mix\(in srgb, #000 7%, transparent\);[^}]*transition:[^;}]*background-color/,
    );
    expect(css).toMatch(
      /\.egroup-area\[data-focus-dim\] \.egroup-body-slot\.spot-clear \{[^}]*background-color: transparent/,
    );
    // 홀 규칙(:has(.browser-view) background:transparent — 고특이성)이 베일을 이겨 브라우저만
    // 안 어두워졌던 실측 결함. 축 충돌의 자리(홀 규칙 옆)에 예외를 명시한다: 스포트라이트
    // 베일은 반투명이라 홀을 막지 않으면서 아래 네이티브를 어둡힌다.
    for (const pane of ["card", "floating"]) {
      expect(css).toMatch(
        new RegExp(
          `:root\\[data-pane-style="${pane}"\\] \\.egroup-area\\[data-focus-dim\\] \\.egroup-body-slot:not\\(\\.spot-clear\\):has\\(\\.browser-view\\)`,
        ),
      );
    }
  });

  it("결부 바탕 스위치: fill-none=바탕 제거, fill-faint=아주 옅은 틴트", () => {
    // 사용자 비교 실험(① 빼기 ② 아주 옅게) — stroke 안의 fill 만 갈래친다.
    const none = decls(".rail-link-overlay.relation-stroke.fill-none .rail-link-shape");
    expect(none).toMatch(/fill:\s*none/);
    const faint = decls(".rail-link-overlay.relation-stroke.fill-faint .rail-link-shape");
    expect(faint).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*1%,\s*transparent\)/);
  });

  it("봉합선 CSS: 관계 스트로크와 같은 두께의 점선", () => {
    const d = decls(".rail-link-seam");
    expect(d).toMatch(/stroke:\s*var\(--relation-stroke\)/);
    expect(d).toMatch(/stroke-width:\s*var\(--relation-stroke-w\)/);
    expect(d).toMatch(/stroke-dasharray/);
  });

  it("떠다니는 관계 라벨 금지 — 결부 이름은 호스트 헤더(.proj-frame-bound) 한 곳", () => {
    // 관계 표시 단순화(사용자 결정): "연결됨 · 이름" 배지 폐지. 이름은 사이드바 헤더가
    // 소유한다(ProjectionSlots.frame.test 가 표시를 검증). 라벨 CSS 를 되살리지 마라.
    expect(css).not.toMatch(/rail-link-label/);
    expect(css).toMatch(/\.proj-frame-bound\s*\{/);
  });

  it("moment: 평시 tint 동일 + 플래시 때만 relation 토큰, 해제 시 페이드아웃", () => {
    const rest = decls(".rail-link-overlay.relation-moment .rail-link-shape");
    expect(rest).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*5%,\s*transparent\)/);
    expect(rest).toMatch(/transition:[^;]*stroke/);
    const flashing = decls(
      '.rail-link-overlay.relation-moment[data-flash="true"] .rail-link-shape',
    );
    expect(flashing).toMatch(/stroke:\s*var\(--relation-stroke\)/);
    expect(flashing).toMatch(/fill:\s*var\(--relation-fill\)/);
  });
});
