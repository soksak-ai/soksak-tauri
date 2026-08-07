// 레일이 포커스 베일 위에 서는 이유를 CSS 텍스트에서 법으로 세운다.
//
// 옛 법은 z(.left-rail-plane) > z(.focus-lighting-plane), 즉 7 > 6 하나였다. 그 비교는 두 수가
// 같은 stacking context 에 있다고 전제하는데 실제 DOM 은 그렇지 않다: 베일은 .space-plane(z:1)
// 안에 살고 그 판이 자기 문맥을 만들어 베일을 가둔다. 레일이 위에 오는 진짜 이유는 7>6 이
// 아니라 7>1 이고, 누가 .space-plane 을 8 로 올리면 옛 법은 그대로 통과하는데 화면에서는 베일이
// 레일을 덮는다.
//
// 그래서 법을 두 줄로 다시 세운다. 이 둘이면 어느 평면이 어느 평면을 품든 결론이 같다:
//   ① 레일 평면은 작업면의 **모든** 평면보다 위다.
//   ② 층을 선언한 평면은 배치도 선언해 자기 문맥을 만든다 — 안 그러면 내용이 판 밖으로 샌다.
// 그리고 관계선은 레일 위에 남는다(같은 문맥의 형제라 이 비교는 성립한다).

interface CssRule {
  selector: string;
  decls: string;
}

/** 최상위 "selector { decls }" 단위 분해. 셀렉터에 붙은 주석은 제거한다. */
function rulesOf(css: string): CssRule[] {
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    out.push({
      selector: match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
      decls: match[2].replace(/\/\*[\s\S]*?\*\//g, ""),
    });
  }
  return out;
}

const PLANE = /^\.[a-z0-9-]+-plane$/;

interface PlaneFact {
  selector: string;
  zIndex: number | null;
  positioned: boolean;
}

function declared(decls: string, property: string): string | null {
  const found = decls.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  return found ? found[1].trim() : null;
}

/** 단일 클래스 셀렉터로 선언된 평면들 — 상태 셀렉터가 붙은 규칙은 기본 선언이 아니다. */
export function planeFacts(css: string): PlaneFact[] {
  const bySelector = new Map<string, PlaneFact>();
  for (const { selector, decls } of rulesOf(css)) {
    for (const single of selector.split(",").map((part) => part.trim())) {
      if (!PLANE.test(single)) continue;
      const fact = bySelector.get(single) ?? { selector: single, zIndex: null, positioned: false };
      const zIndex = declared(decls, "z-index");
      if (zIndex !== null && zIndex !== "auto") {
        const order = Number.parseInt(zIndex, 10);
        fact.zIndex = Number.isFinite(order) ? order : fact.zIndex;
      }
      const position = declared(decls, "position");
      if (position !== null && position !== "static") fact.positioned = true;
      bySelector.set(single, fact);
    }
  }
  return [...bySelector.values()];
}

function layerOf(css: string, selector: string): number | null {
  for (const rule of rulesOf(css)) {
    if (rule.selector.split(",").map((part) => part.trim()).includes(selector)) {
      const zIndex = declared(rule.decls, "z-index");
      if (zIndex === null || zIndex === "auto") continue;
      const order = Number.parseInt(zIndex, 10);
      if (Number.isFinite(order)) return order;
    }
  }
  return null;
}

const RAIL_PLANE = ".left-rail-plane";
const VEIL_PLANE = ".focus-lighting-plane";
const RELATION_OVERLAY = ".rail-link-overlay";

/** 위반 목록. 빈 배열이 통과다 — 오라클이 죽으면(평면을 하나도 못 찾으면) 그것도 위반이다. */
export function focusVeilStackingViolations(css: string): string[] {
  const violations: string[] = [];
  const planes = planeFacts(css);
  const rail = planes.find((plane) => plane.selector === RAIL_PLANE);
  const veil = planes.find((plane) => plane.selector === VEIL_PLANE);

  if (!rail || rail.zIndex === null) {
    violations.push(`${RAIL_PLANE}: 층 선언 없음 — 법의 기준이 사라졌다`);
  }
  if (!veil || veil.zIndex === null) {
    violations.push(`${VEIL_PLANE}: 층 선언 없음 — 법의 대상이 사라졌다`);
  }
  if (!rail || rail.zIndex === null) return violations;

  for (const plane of planes) {
    if (plane.zIndex === null) continue;
    if (!plane.positioned) {
      violations.push(`${plane.selector}: z-index ${plane.zIndex} 을 선언하고 배치는 안 했다 — 내용이 판 밖으로 샌다`);
    }
    if (plane.selector === RAIL_PLANE) continue;
    if (plane.zIndex >= rail.zIndex) {
      violations.push(
        `${plane.selector}: z-index ${plane.zIndex} >= ${RAIL_PLANE} ${rail.zIndex} — 그 판 안의 베일이 레일을 덮는다`,
      );
    }
  }

  const relation = layerOf(css, RELATION_OVERLAY);
  if (relation === null || relation <= rail.zIndex) {
    violations.push(`${RELATION_OVERLAY}: z-index ${String(relation)} <= ${RAIL_PLANE} ${rail.zIndex}`);
  }
  return violations;
}
