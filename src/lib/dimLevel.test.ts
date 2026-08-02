import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dimLevel, isDimmed, type DimLevel } from "./dimLevel";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "App.css"),
  "utf8",
);
/** 선언만 — 규칙은 **칠하는 것**을 검사한다. 주석까지 세면 사고를 적어 둔 근거 문장이
 *  위반으로 잡히고, 규칙이 자기 근거를 지우게 만든다. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const appTsx = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"),
  "utf8",
);

describe("흐림 단계 — 사유 여럿, 값 하나", () => {
  it("포커스는 무엇에도 안 흐려진다", () => {
    expect(dimLevel({ active: true, focusDim: true, blocked: false })).toBe("clear");
    // 낀 것으로 잘못 표시돼도 포커스가 이긴다 — 보라고 고른 것을 가리지 않는다.
    expect(dimLevel({ active: true, focusDim: true, blocked: true })).toBe("clear");
  });

  it("비활성은 설정이 켜졌을 때만 가라앉는다", () => {
    expect(dimLevel({ active: false, focusDim: true, blocked: false })).toBe("idle");
    expect(dimLevel({ active: false, focusDim: false, blocked: false })).toBe("clear");
  });

  it("낀 판은 흐림 설정과 무관하게 흐리다 — 가려진 것은 레일 축의 사실이다", () => {
    expect(dimLevel({ active: false, focusDim: false, blocked: true })).toBe("blocked");
    expect(dimLevel({ active: false, focusDim: true, blocked: true })).toBe("blocked");
  });

  it("isDimmed 는 clear 만 아니라고 답한다", () => {
    expect(isDimmed("clear")).toBe(false);
    expect(isDimmed("idle")).toBe(true);
    expect(isDimmed("blocked")).toBe(true);
  });
});

/** 단계별 셀렉터의 클래스/속성 개수 — 특이성 비교용(모두 요소 0, id 0). */
function weight(sel: string): number {
  return (sel.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;
}

/** 그 단계를 칠하는 규칙들의 셀렉터. */
function selectorsFor(level: DimLevel, part: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = m[2] ?? "";
    if (!/filter:|background-color:/.test(body)) continue;
    for (const branch of (m[1] ?? "").split(",").map((s) => s.trim())) {
      if (!branch.includes(`[data-dim="${level}"]`)) continue;
      if (!branch.includes(part)) continue;
      out.push(branch);
    }
  }
  return out;
}

describe("흐림 단계 — 표면 규칙", () => {
  it("단계는 이름 하나로 나오고 CSS 는 이름당 한 벌만 그린다(사유 셀렉터 금지)", () => {
    // 사유로 겹쳐 칠하던 옛 축은 남아 있으면 안 된다 — 남아 있으면 다시 특이성으로 겨룬다.
    expect(rules).not.toMatch(/data-focus-dim/);
    expect(rules).not.toMatch(/\.rail-blocked/);
    expect(rules).not.toMatch(/\.spot-clear/);
  });

  it("짙은 단계가 옅은 단계에 특이성으로 지지 않는다(실사고 2026-08-02)", () => {
    // 낀 판의 베일이 22% 여야 하는데 focusDim 규칙(클래스 4)이 이겨 7% 로 칠해졌다.
    // 같은 픽셀을 칠하는 두 단계는 무게가 같아야 한다 — 그래야 순서만이 정하고, 순서는 없다.
    for (const part of [".pane", ".tab-body.hole", ".tab-body"]) {
      const idle = selectorsFor("idle", part).map(weight);
      const blocked = selectorsFor("blocked", part).map(weight);
      if (!idle.length || !blocked.length) continue;
      expect(Math.max(...blocked)).toBe(Math.max(...idle));
    }
  });

  it("세기는 단계마다 숫자 하나다 — 매체가 각자 적으면 같은 단계가 갈린다", () => {
    // 실측 2026-08-02: 낀 단계가 베일 22% 인데 filter 는 brightness(0.7)=30% 어둠이었다.
    // 세기를 올리면 그 어긋남이 뒤집힌다(70% 베일 vs brightness(0.7)=30% 어둠).
    const amount = (level: DimLevel) => {
      const re = new RegExp(`\\[data-dim="${level}"\\][^{]*\\{[^}]*--dim: ([\\d.]+);`);
      const m = rules.match(re);
      expect(m, `${level} 세기 선언이 없다`).toBeTruthy();
      return Number(m?.[1]);
    };
    expect(amount("idle")).toBeGreaterThan(0);
    // 사용자 확정: 가려진 판은 거의 70% 가라앉는다.
    expect(amount("blocked")).toBeCloseTo(0.7, 2);
    expect(amount("blocked")).toBeGreaterThan(amount("idle"));
  });

  it("두 매체는 그 숫자만 읽는다 — 세기를 직접 적는 자리는 단계 선언뿐이다", () => {
    // 검은 베일 alpha a 는 모든 채널에 (1−a)를 곱하므로 정의상 brightness(1−a) 다.
    // 그래서 둘은 같은 숫자만 읽으면 정의상 같은 세기가 된다.
    expect(rules).toMatch(/filter: brightness\(calc\(1 - var\(--dim\)\)\)/);
    expect(rules).toMatch(/background-color: rgb\(0 0 0 \/ var\(--dim\)\)/);
    // 채도 항은 없다 — 베일은 채도를 못 내린다. 두면 같은 단계의 홀 판과 DOM 판이 갈린다.
    for (const [sel, body] of [...rules.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    )) {
      if (!sel.includes("[data-dim=")) continue;
      expect(body, `${sel.trim()} 에 채도 항이 있다`).not.toMatch(/saturate\(/);
    }
  });

  it("홀 슬롯은 어느 단계에서도 filter 를 안 받는다 — 흐림 축은 베일 하나다", () => {
    // 네이티브/게스트 콘텐츠는 DOM 필터에 안 닿는다. 스탠드인만 받으면 둘의 흐림이 어긋난다.
    expect(css).toMatch(/\.tab-body\.hole\[data-dim\] \{[^}]*filter: none/);
  });
});

describe("흐림은 기하가 아니라 포커스의 사실이다", () => {
  it("낀 판 목록은 방금 푼 해에서 온다 — 위상은 움직임이 있을 때만 다음 해를 받는다", () => {
    // 실측 2026-08-02: phase.displayed 에서 읽었더니, 여행 모드(정의상 아무것도 안 움직임)에서
    // 포커스를 옮겨도 흐림이 영원히 갱신되지 않았다. 명령은 between=[pan-aecvk3,pan-q7lxti]
    // 인데 슬롯은 계속 idle 이었고 기하는 완전히 동일했다.
    const m = appTsx.match(/betweenIds=\{[^}]*\}/);
    expect(m, "betweenIds 배선을 못 찾았다").toBeTruthy();
    expect(m?.[0]).toContain("solved?.betweenIds");
    expect(m?.[0]).not.toContain("arrangement?.betweenIds");
  });
});
