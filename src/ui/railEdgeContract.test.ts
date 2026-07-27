// 레일 세로 경계 — 계약과 구현의 전수 대조.
//
// 같은 법을 두 곳이 독립적으로 말한다: 계약표(borderContract 의 rail-ground-*/rail-pane-*)와
// 구현(railEdges.railEdgeWidths). 둘 중 하나만 고치면 조용히 어긋나므로 상태 공간을 전수로
// 맞대어 본다 — railLook × open × station × paneStyle.
//
// RED 근거(실측 2026-07-27): 옛 규칙은 `.sidebar` right 를 무조건 1px 로 단언해 살아있는 창에서
// 상시 위반을 냈다. 상시 위반은 아무도 읽지 않는 경보가 되고, 그러면 진짜 위반이 묻힌다.
// (그 위반 자체는 진짜였다 — 위임 대상인 레일 카드가 선을 소유하지 않았다.)
//
// 셀렉터 의미는 흉내내지 않는다: 진짜 DOM 에 진짜 querySelectorAll 을 쓴다. 손으로 매칭을
// 재현하면 계약이 아니라 내 해석을 검증하게 된다.
import { beforeEach, describe, expect, it } from "vitest";
import { BORDER_RULES } from "./borderContract";
import { evaluateRules, type ElementProbe, type ValidateEnv } from "./borderValidate";
import { railEdgeWidths } from "./railEdges";

const BD = "rgb(58, 58, 58)";
const RAIL_RULES = BORDER_RULES.filter(
  (r) => r.id.startsWith("rail-ground") || r.id.startsWith("rail-pane"),
);

type Look = "pane" | "ground";
type PaneStyle = "flat" | "card" | "floating";

const LOOKS: Look[] = ["pane", "ground"];
const STATIONS = [0, 0.5, 33.333333, 50, 99.5, 100];
const STYLES: PaneStyle[] = ["flat", "card", "floating"];

/** 인라인 폭만 읽는 프로브 — 실제 검증기의 probeElement 와 같은 축(폭/스타일/색). */
function probe(el: HTMLElement, open: boolean): ElementProbe {
  const edge = (w: number) =>
    w > 0
      ? { width: "1px", style: "solid", color: BD }
      : { width: "0px", style: "none", color: "rgba(0, 0, 0, 0)" };
  const l = Number(el.dataset.borderLeft);
  const r = Number(el.dataset.borderRight);
  return {
    edges: {
      top: edge(0),
      bottom: edge(0),
      left: edge(l),
      right: edge(r),
    },
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    // 닫힌 레일은 폭 0 — 칠할 픽셀이 없으므로 판정 대상이 아니다(검증기와 같은 규칙).
    visible: open,
  };
}

function mount(look: Look, station: number, widths: { left: number; right: number }) {
  document.body.innerHTML = "";
  const el = document.createElement("div");
  el.className = `sidebar rail-${look}`;
  el.dataset.station = String(station);
  el.dataset.borderLeft = String(widths.left);
  el.dataset.borderRight = String(widths.right);
  document.body.appendChild(el);
  return el;
}

function env(open: boolean, paneStyle: PaneStyle): ValidateEnv {
  return {
    queryAll: (sel) =>
      [...document.querySelectorAll<HTMLElement>(sel)].map((el) => probe(el, open)),
    dataset: (name) => (name === "paneStyle" ? paneStyle : undefined),
    resolveToken: () => BD,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("레일 세로 경계 — 계약 ≡ 구현", () => {
  it("규칙이 실재한다(계약표에서 사라지면 이 스위트는 아무것도 지키지 않는다)", () => {
    expect(RAIL_RULES.map((r) => r.id).sort()).toEqual([
      "rail-ground-delegates",
      "rail-ground-owns-flat",
      "rail-pane-station-end",
      "rail-pane-station-inner",
      "rail-pane-station-start",
    ]);
  });

  const cases: Array<[Look, number, PaneStyle]> = [];
  for (const look of LOOKS)
    for (const station of STATIONS) for (const style of STYLES) cases.push([look, station, style]);

  it.each(cases)(
    "열린 레일 look=%s station=%s paneStyle=%s — 구현 폭이 계약을 만족한다",
    (look, station, style) => {
      const widths = railEdgeWidths(look, true, station, style);
      mount(look, station, widths);
      const r = evaluateRules(RAIL_RULES, env(true, style));
      expect(r.violations).toEqual([]);
      // 빈틈 없음(§B8): 어떤 상태든 이 요소를 판정하는 규칙이 적어도 하나 있어야 한다.
      expect(r.elementsChecked).toBeGreaterThan(0);
    },
  );

  it.each(cases)(
    "닫힌 레일 look=%s station=%s paneStyle=%s — 폭 0 면적이라 판정 대상이 아니다",
    (look, station, style) => {
      const widths = railEdgeWidths(look, false, station, style);
      expect(widths).toEqual({ left: 0, right: 0 });
      mount(look, station, widths);
      const r = evaluateRules(RAIL_RULES, env(false, style));
      expect(r.violations).toEqual([]);
      expect(r.elementsChecked).toBe(0);
    },
  );

  // 대조군: 이 스위트가 위반을 실제로 잡는지(가짜 GREEN 방지).
  it.each([
    ["ground+card 에 선을 그으면 이중선 위반", "ground" as Look, 50, "card" as PaneStyle, { left: 1, right: 1 }],
    ["pane+station 0 의 바깥 변에 선을 그으면 위반", "pane" as Look, 0, "card" as PaneStyle, { left: 1, right: 1 }],
    ["pane 내부 스테이션에서 선을 빼면 위반", "pane" as Look, 50, "card" as PaneStyle, { left: 0, right: 0 }],
  ])("%s", (_label, look, station, style, wrong) => {
    mount(look, station, wrong as { left: number; right: number });
    const r = evaluateRules(RAIL_RULES, env(true, style));
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
