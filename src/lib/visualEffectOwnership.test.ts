// @vitest-environment node
// 시각 효과 소유권 게이트(정적) — "간접 사건이 무관 표면에 시각 효과를 준다"는 부류를 봉인한다.
// 실사고 계보: 위상 클래스 하위 전체 선택자가 델타 0 인 슬롯까지 animation + will-change 로
// 합성 레이어에 올렸다 내려, 무관한 탭을 클릭할 때마다 브라우저의 DOM(주소표시줄)이 움찔했다.
// 원칙(NATIVE-SURFACES §2): 표면의 기하도 표현도 직접 조작으로만 변한다 — 위상은 실제로
// 변하는 요소만 대상으로 삼는다. 이 테스트는 그 원칙을 CSS 수준에서 강제한다.
import { describe, expect, it } from "vitest";
import { styleSurface } from "../ui/styleSurface";

// 표면 전체 — 코어와 각 프레임워크의 스타일시트가 함께 문서에 선다(ui/styleSurface).
const css = styleSurface();

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
const PHASE = ["traveling", "dragging", "resizing", "data-dim"];

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

  // 재입법(2026-07-26, 사용자 확정): 명령발 레이아웃 변화는 실제 모션이어야 한다 — 기하
  // 전이를 전면 금지하던 옛 규칙을, 옛 근거(네이티브 표면은 CSS 전이를 못 따라간다)가
  // 실제로 가리키던 좁은 대상으로 정밀화한다. 기하 전이는 허용하되 두 짝이 반드시 함께
  // 있어야 한다: ① 위상 억제(:root.layout-motion-live … transition: none — 드래그·활강은
  // 자체 시스템이 이동을 소유). Tauri 전용 제외는 그 어댑터의 테스트가 소유한다.
  it("슬롯 기하 전이는 위상 억제 짝과 함께만 존재한다(재입법)", () => {
    let geometryTransition = false;
    for (const [sel, body] of rules()) {
      if (!/tab-body/.test(sel) || /layout-motion-live/.test(sel)) continue;
      const tr = /transition:\s*([^;]+)/.exec(body)?.[1] ?? "";
      // 기하 축은 속성명과 등록 변수(--l/--t/--w/--h — @property 로 보간되는 기하) 둘 다다.
      if (/\b(left|top|width|height)\b|--[ltwh]\b/.test(tr)) geometryTransition = true;
      // all 전이는 여전히 전면 금지 — 무엇이 움직이는지 선언하지 않는 전이는 소유자가 없다.
      expect(/\ball\b/.test(tr), `${sel} → transition:all 금지`).toBe(false);
    }
    if (geometryTransition) {
      const suppressed = rules().some(
        ([sel, body]) =>
          sel.includes("layout-motion-live") &&
          /tab-body/.test(sel) &&
          /transition:\s*none/.test(body),
      );
      expect(suppressed, "위상 억제 짝(:root.layout-motion-live … transition:none) 필요").toBe(true);
    }
  });
});
