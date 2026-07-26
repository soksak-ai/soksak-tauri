// @vitest-environment node
// 시각 효과 소유권 게이트(정적) — "간접 사건이 무관 표면에 시각 효과를 준다"는 부류를 봉인한다.
// 실사고 계보: 위상 클래스 하위 전체 선택자가 델타 0 인 슬롯까지 animation + will-change 로
// 합성 레이어에 올렸다 내려, 무관한 탭을 클릭할 때마다 브라우저의 DOM(주소표시줄)이 움찔했다.
// 원칙(NATIVE-SURFACES §2): 표면의 기하도 표현도 직접 조작으로만 변한다 — 위상은 실제로
// 변하는 요소만 대상으로 삼는다. 이 테스트는 그 원칙을 CSS 수준에서 강제한다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");

/** 규칙 목록: [셀렉터, 선언부] — 주석은 제거하고 파싱한다. */
function rules(): [string, string][] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
    (m) => [m[1].replace(/\s+/g, " ").trim(), m[2]] as [string, string],
  );
}

// 합성 레이어 승격·재래스터를 유발하는 속성 — 무관 표면에 걸리면 위상마다 움찔한다.
const PROMOTING = ["animation", "will-change", "transform", "filter", "backdrop-filter"];
// 위상·상태를 나타내는 클래스(이 하위에서 전체 선택은 곧 "무관 요소까지 포함"이다).
const PHASE = ["traveling", "dragging", "resizing", "data-focus-dim"];

describe("시각 효과 소유권 — 위상 하위 전체 선택 금지", () => {
  it("위상 클래스 하위에서 슬롯·셀의 레이어 승격 속성을 애니메이션·전이하지 않는다", () => {
    // 정밀 계약: 상시 승격(예: focusDim 동안의 filter)은 무해하다 — 승격/해제나 값 변경이
    // 위상마다 반복되는 것이 유해하다. 그래서 금지 대상은 "전체 선택 + 승격 속성의
    // animation/transition"이다(실사고 둘: travel animation 전체 적용, dim filter 전이).
    const offenders: string[] = [];
    for (const [sel, body] of rules()) {
      if (!PHASE.some((p) => sel.includes(p))) continue;
      const decls = body
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean);
      const animates = decls.some((d) => {
        const [k, v = ""] = d.split(":").map((s) => s.trim());
        if (k === "animation" || k === "animation-name") return true;
        if (k === "will-change") return PROMOTING.some((p) => v.includes(p));
        if (k === "transition" || k === "transition-property")
          return PROMOTING.some((p) => v.includes(p)) || /\ball\b/.test(v);
        return false;
      });
      if (!animates) continue;
      const props = decls.map((d) => d.split(":")[0]?.trim()).filter(Boolean) as string[];
      // 각 셀렉터 갈래를 따로 본다 — 갈래 하나라도 한정자 없이 슬롯/셀에서 끝나면 위반.
      for (const branch of sel.split(",").map((s) => s.trim())) {
        const last = branch.split(/\s+/).pop() ?? "";
        const bare =
          /^\.tab-body$/.test(last) || /^\.pane$/.test(last);
        if (bare) offenders.push(`${branch} → ${props.join(",")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("홀 슬롯은 filter 축에서 제외된다(스탠드인과 네이티브의 dim 강도 일치)", () => {
    expect(css).toMatch(
      /\.space\[data-focus-dim\] \.tab-body\.tab-body-hole \{[^}]*filter: none/,
    );
  });

  it("슬롯 기하(left/top/width/height)에는 transition 을 걸지 않는다(네이티브 추종 불가)", () => {
    const offenders: string[] = [];
    for (const [sel, body] of rules()) {
      if (!/tab-body/.test(sel)) continue;
      const tr = /transition:\s*([^;]+)/.exec(body)?.[1] ?? "";
      if (/\b(left|top|width|height|all)\b/.test(tr)) offenders.push(`${sel} → ${tr}`);
    }
    expect(offenders).toEqual([]);
  });
});
