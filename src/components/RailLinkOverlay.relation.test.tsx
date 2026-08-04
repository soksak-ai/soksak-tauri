// @vitest-environment jsdom
// 관계면 3안 스위치(railRelation: tint|moment|stroke) 계약 — 비교 실험용 임시 축.
// 결정 시 채택안만 남기고 이 스위치·모드 CSS 갈래와 함께 소거한다.
//  - tint(기본): 모드 클래스 relation-tint, 스트로크·라벨 없이 저농도 액센트 채움만(CSS 갈래).
//  - moment: 결부 정체성(boundViewId/targetRect)이 바뀐 순간만 600ms 플래시 후 페이드아웃.
//  - stroke: 현행 그대로(기준점).
//  - 공통: 레일이 결부 셀에 인접하지 않으면(논리 간격 1%p 초과) 관계면을 아예 렌더하지 않는다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { styleSurfaceRules } from "../ui/styleSurface";

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
    boundPaneId: "g2",
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

// CSS 갈래는 jsdom 이 계산하지 않으므로 스타일 표면을 직접 게이트한다(cssContract 선례).
// 이 규칙들도 실험 임시물 — 3안 결정 시 테스트째 소거.
describe("railRelation 모드 CSS 갈래 (스타일 표면)", () => {
  const css = styleSurfaceRules();

  function decls(selector: string): string {
    const escaped = selector.replace(/[.[\]"=]/g, (c) => `\\${c}`);
    const match = css.match(
      new RegExp(`(?:^|,|\\})\\s*(?:[^,{}]+,\\s*)*${escaped}\\s*(?:,[^{}]+)?\\{([^}]*)\\}`),
    );
    expect(match, `스타일 표면에 ${selector} 규칙이 있어야 한다`).not.toBeNull();
    return match![1];
  }

  it("tint: 스트로크 없음 + 저농도 액센트 채움(성공색·relation 토큰 금지)", () => {
    const d = decls(".rail-link-overlay.relation-tint .rail-link-shape");
    expect(d).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*5%,\s*transparent\)/);
    expect(d).toMatch(/stroke:\s*none/);
    expect(d).not.toMatch(/var\(--relation-stroke\)/);
  });

  it("포커스 스포트라이트: 비활성만 가라앉고 활성은 청정(선택만 명확)", () => {
    // 콘텐츠 조상 filter는 DOM/canvas/WebGL 합성 경로를 바꾸므로 금지한다. 전체 어둠과
    // 포커스 aperture는 작업면 밖 SVG 평면 한 벌이 그린다.
    expect(css).not.toMatch(/\.(?:pane|tab-body)\[data-dim\][^{]*\{[^}]*filter\s*:/s);
    expect(decls(".focus-lighting-plane")).toMatch(/pointer-events:\s*none/);
    expect(decls(".focus-lighting-mask")).toMatch(/mask-type:\s*luminance/);
    // 단계 이름으로 갈래친 규칙은 없다 — 갈래가 둘이면 다시 특이성으로 겨룬다.
    expect(css).not.toMatch(/\.(?:pane|tab-body)\[data-dim="/);
  });

  it("railFill 갈래는 두 채움 경로(shape=자연 인접·fill=교체 분리 렌더)를 모두 덮는다", () => {
    // 실측 결함: fill 갈래가 .rail-link-shape 만 겨냥해 교체-인접(B안 .rail-link-fill)만
    // 테마 기본 채움이 들어갔다 — "어디는 들어가고 어디는 안 들어가는" 불일치의 원인.
    for (const mode of ["none", "faint"]) {
      const rule = css.match(
        new RegExp(
          `\\.rail-link-overlay\\.relation-stroke\\.fill-${mode} \\.rail-link-shape,\\s*\\.rail-link-overlay\\.relation-stroke\\.fill-${mode} \\.rail-link-fill\\s*\\{`,
        ),
      );
      expect(rule, `fill-${mode} 두 경로 커버`).not.toBeNull();
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

  it("B안 변 점선 CSS: 분리된 오른쪽 변은 점선, 나머지 열린 외곽선은 실선·무채움", () => {
    const edge = decls(".rail-link-edge");
    expect(edge).toMatch(/stroke:\s*var\(--relation-stroke\)/);
    expect(edge).toMatch(/stroke-dasharray/);
    const rest = decls(".rail-link-rest");
    expect(rest).toMatch(/fill:\s*none/);
    expect(rest).toMatch(/stroke:\s*var\(--relation-stroke\)/);
  });

  it("떠다니는 관계 라벨 금지 — 결부 이름은 호스트 헤더(.projection-bound) 한 곳", () => {
    // 관계 표시 단순화(사용자 결정): "연결됨 · 이름" 배지 폐지. 이름은 사이드바 헤더가
    // 소유한다(ProjectionSlots.frame.test 가 표시를 검증). 라벨 CSS 를 되살리지 마라.
    expect(css).not.toMatch(/rail-link-label/);
    expect(css).toMatch(/\.projection-bound\s*\{/);
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

  it("활강 애니메이션은 실이동 요소(.flip-move)에만 — 델타 0 요소의 레이어 승격 금지", () => {
    // 실사고: 위상 하위 전체 선택이 움직이지 않는 브라우저 슬롯까지 animation +
    // will-change 로 승격시켜, 위상마다 재래스터가 DOM(주소표시줄)을 움찔거렸다.
    expect(css).toMatch(/\.rail-traveling \.tab-body\.flip-move/);
    expect(css).not.toMatch(/\.rail-traveling \.tab-body,/);
  });
});

describe("잰 크기를 스케일에 싣지 않는다", () => {
  // 선언만 본다 — 주석까지 세면 사고를 적어 둔 근거 문장이 위반으로 잡히고, 규칙이 자기
  // 근거를 지우게 만든다(같은 함정을 오늘 두 번째로 만난다).
  const overlaySrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "RailLinkOverlay.tsx"),
    "utf8",
  )
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("SVG 가 viewBox 로 늘어나지 않는다 — 낡은 측정이 그림을 일그러뜨린다", () => {
    // 실사고 2026-08-02: viewBox 에 **관측으로 들어오는** 호스트 크기를 싣고
    // preserveAspectRatio="none" 을 걸어 두었다. ResizeObserver 는 페인트 뒤에 오므로 호스트가
    // 줄거나 늘어난 그 프레임은 옛 크기로 그려지고, 그림 전체가 (새폭/옛폭) 배로 눌리거나
    // 늘어났다. x=0 은 스케일해도 0 이라 바깥 변만 제자리였고 안쪽 변만 안/밖으로 밀렸다 —
    // 사용자가 본 것이 정확히 그것이다(밀 때 안으로, 접을 때 밖으로, 그리고 정확히 복귀).
    //
    // 좌표는 이미 요소의 CSS px 이다. 스케일 축을 두지 않으면 낡은 측정은 "틀린 자리"일 뿐
    // "일그러진 그림"이 될 수 없다 — 실패의 모양이 한 단계 순해진다.
    expect(overlaySrc).not.toMatch(/viewBox=/);
    expect(overlaySrc).not.toMatch(/preserveAspectRatio/);
  });

  it("그리기 전에 잰다 — 관측은 밖에서 오는 변화만 맡는다", () => {
    // 매 렌더 뒤(페인트 전)에 다시 재는 effect 가 있어야 한다. 값이 같으면 no-op 이라
    // 추가 렌더가 없고, 달라진 프레임에서만 페인트 전에 한 번 더 그린다.
    expect(overlaySrc).toMatch(
      /useLayoutEffect\(\(\) => \{[^}]*getBoundingClientRect\(\);\s*commitSize\([^)]*\);\s*\}\);/,
    );
  });
});
