// 테마 스펙 불변식 게이트 — 경계 보장(docs/UI.md §B1: 패널 경계는 무조건 존재).
// 테마 JSON 이 선언하는 토큰 조합이 경계를 소멸시키면 스펙 검증에서 거부한다:
//   paneStyle flat(프레임 무) + divider overlay(휴면 무선) = 패널 사이 경계 0.
// red/green: 이 테스트가 먼저 불변식을 강제하고, 내장 테마가 그에 정합한다.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_RELATION,
  applyThemeToDom,
  parseTheme,
} from "./engine";
import { BUILTIN_THEMES } from "./builtin";

function themeWith(chrome: Record<string, unknown>) {
  return {
    name: "테스트",
    defaultMode: "dark",
    colors: {
      bg: "#111111", card: "#222222", side: "#1a1a1a", inset: "#0d0d0d",
      fg: "#eeeeee", fg2: "#bbbbbb", fg3: "#888888", bd: "#333333",
      acc: "#4488ff", accbg: "#223355", ok: "#33aa66", shadow: "0 0 0 #000",
    },
    chrome: {
      titlebar: "side", tabBar: "side", tabShape: "chip",
      paneStyle: "flat", panePad: "0px", divider: "solid",
      statusBg: "side", font: "system",
      ...chrome,
    },
  };
}

describe("테마 스펙 불변식 — 경계 보장(§B1)", () => {
  it("flat + overlay 는 거부(패널 경계가 소멸하는 조합)", () => {
    const { theme, validation } = parseTheme(
      themeWith({ paneStyle: "flat", divider: "overlay" }),
      "test",
    );
    expect(theme).toBeNull();
    expect(validation.errors.some((e) => e.includes("경계"))).toBe(true);
  });

  it.each([
    ["flat + solid", { paneStyle: "flat", divider: "solid" }],
    ["card + overlay", { paneStyle: "card", divider: "overlay" }],
    ["card + solid", { paneStyle: "card", divider: "solid" }],
    ["floating + overlay", { paneStyle: "floating", divider: "overlay" }],
  ])("%s 는 허용(프레임 또는 상시 seam 이 경계 보장)", (_l, chrome) => {
    const { theme, validation } = parseTheme(themeWith(chrome), "test");
    expect(validation.errors).toEqual([]);
    expect(theme).not.toBeNull();
  });
});

// [성능 RULE] 테마 변경 단일 신호 data-theme-epoch — 플러그인(터미널)이 색 재적용 시점을 이 한 속성으로만
// 알아, ⌘±(--app-font-size 가 style 에 씀) 같은 테마-무관 변이와 분리된다. 적용마다 epoch 가 1 증가한다.
describe("data-theme-epoch — 테마 적용 단일 신호", () => {
  it("applyThemeToDom 매 호출마다 epoch 1 증가(플러그인 디커플링 신호)", () => {
    const { theme } = parseTheme(themeWith({}), "test");
    expect(theme).not.toBeNull();
    delete document.documentElement.dataset.themeEpoch; // 초기화
    applyThemeToDom(theme!, "dark");
    const e1 = Number(document.documentElement.dataset.themeEpoch);
    applyThemeToDom(theme!, "dark");
    const e2 = Number(document.documentElement.dataset.themeEpoch);
    applyThemeToDom(theme!, "light");
    const e3 = Number(document.documentElement.dataset.themeEpoch);
    expect(e1).toBe(1);
    expect(e2).toBe(2); // 같은 테마 재적용도 신호(터미널 측 diff 게이트가 색 무변경이면 no-op 처리)
    expect(e3).toBe(3);
  });

  it("내장 테마 전부가 불변식을 만족한다", () => {
    for (const raw of BUILTIN_THEMES) {
      const { theme, validation } = parseTheme(raw, "builtin");
      expect(validation.errors, `${(raw as { name: string }).name}`).toEqual([]);
      expect(theme).not.toBeNull();
    }
  });
});

describe("테마 relation 표면 계약", () => {
  it("구 테마는 relation 전체 기본값으로 정규화되어 호환된다", () => {
    const { theme, validation } = parseTheme(themeWith({}), "legacy.json");
    expect(validation.errors).toEqual([]);
    expect(theme?.relation).toEqual(DEFAULT_THEME_RELATION);
  });

  it("relation을 선언하면 전 슬롯을 검증하고 DOM 토큰으로 공개한다", () => {
    const raw = {
      ...themeWith({}),
      relation: {
        stroke: "var(--ok)",
        fill: "color-mix(in srgb, var(--ok) 9%, transparent)",
        strokeWidth: 2,
        radius: 13,
        label: "badge",
      },
    };
    const { theme, validation } = parseTheme(raw, "test");
    expect(validation.errors).toEqual([]);
    applyThemeToDom(theme!, "dark");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--relation-stroke")).toBe("var(--ok)");
    expect(root.style.getPropertyValue("--relation-fill")).toContain("var(--ok)");
    expect(root.style.getPropertyValue("--relation-stroke-w")).toBe("2px");
    expect(root.style.getPropertyValue("--relation-radius")).toBe("13px");
    expect(root.dataset.relationLabel).toBe("badge");
  });

  it("toolbar 토큰 — 생략 시 기본값(28/8) 주입, 선언 시 테마 값 주입", () => {
    // 기능 툴바 행 계약: 값(높이·수평 패딩)은 테마가 소유하고 코어가 변수로 주입한다.
    // 툴바는 선택 표면 — 기능이 안 쓰면 생략, 쓰면 이 변수를 소비해야 한다.
    const def = parseTheme(themeWith({}), "def.json");
    expect(def.validation.errors).toEqual([]);
    applyThemeToDom(def.theme!, "light");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--toolbar-h")).toBe("28px");
    expect(root.style.getPropertyValue("--toolbar-pad-x")).toBe("8px");

    const custom = parseTheme(
      { ...themeWith({}), toolbar: { height: 32, padX: 12 } },
      "custom.json",
    );
    expect(custom.validation.errors).toEqual([]);
    applyThemeToDom(custom.theme!, "light");
    expect(root.style.getPropertyValue("--toolbar-h")).toBe("32px");
    expect(root.style.getPropertyValue("--toolbar-pad-x")).toBe("12px");
  });

  it("toolbar 토큰 — 범위 밖 수치는 거부한다", () => {
    const bad = parseTheme(
      { ...themeWith({}), toolbar: { height: 8, padX: 99 } },
      "bad.json",
    );
    expect(bad.theme).toBeNull();
    expect(bad.validation.errors.some((e) => e.includes("toolbar.height"))).toBe(true);
    expect(bad.validation.errors.some((e) => e.includes("toolbar.padX"))).toBe(true);
  });

  it("새 relation 객체는 부분 선언과 범위 밖 수치를 거부한다", () => {
    const partial = parseTheme(
      { ...themeWith({}), relation: { stroke: "var(--acc)" } },
      "partial.json",
    );
    expect(partial.theme).toBeNull();
    expect(partial.validation.errors.some((e) => e.includes("relation.fill"))).toBe(true);

    const invalid = parseTheme(
      {
        ...themeWith({}),
        relation: {
          stroke: "var(--acc)", fill: "transparent", strokeWidth: 8,
          radius: -1, label: "always",
        },
      },
      "invalid.json",
    );
    expect(invalid.theme).toBeNull();
  });

  it("내장 테마는 relation을 명시해 시각 언어를 우연한 폴백에 맡기지 않는다", () => {
    for (const raw of BUILTIN_THEMES as Array<Record<string, unknown>>) {
      expect(raw.relation, String(raw.name)).toBeTruthy();
    }
  });
});
