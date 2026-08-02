import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dimAmount, dimLevel, isDimmed } from "./dimLevel";
import { useSettings } from "../state/settings";
import { styleSurfaceRules } from "../ui/styleSurface";

/** 표면 전체 — 코어와 각 프레임워크의 스타일시트가 함께 문서에 선다. 한 파일만 읽으면
 *  규칙이 다른 파일로 옮겨간 순간 검사에서 사라진다(ui/styleSurface). */
const rules = styleSurfaceRules();
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

describe("흐림 세기 — 값은 설정에서 온다", () => {
  it("사용자가 정한 숫자를 단계가 그대로 받는다", () => {
    const amounts = { idle: 0.5, blocked: 0.7 };
    expect(dimAmount("clear", amounts)).toBe(0);
    expect(dimAmount("idle", amounts)).toBe(0.5);
    expect(dimAmount("blocked", amounts)).toBe(0.7);
  });

  it("기본값은 비활성 50% · 낀 판 70%(사용자 확정 2026-08-02)", () => {
    const s = useSettings.getState();
    expect(s.dimIdle).toBeCloseTo(0.5, 3);
    expect(s.dimBlocked).toBeCloseTo(0.7, 3);
    // 낀 것은 비활성보다 짙다 — 같은 값이면 "가려졌다"가 안 보인다.
    expect(s.dimBlocked).toBeGreaterThan(s.dimIdle);
  });

  it("세기는 0..1 밖으로 못 나간다 — 넘으면 brightness 가 뒤집힌다", () => {
    const s = useSettings.getState();
    s.setDimIdle(5);
    expect(useSettings.getState().dimIdle).toBe(1);
    s.setDimBlocked(-2);
    expect(useSettings.getState().dimBlocked).toBe(0);
    s.setDimIdle(0.5);
    s.setDimBlocked(0.7);
  });
});

describe("흐림 단계 — 표면 규칙", () => {
  it("단계는 이름 하나로 나오고 CSS 는 이름당 한 벌만 그린다(사유 셀렉터 금지)", () => {
    // 사유로 겹쳐 칠하던 옛 축은 남아 있으면 안 된다 — 남아 있으면 다시 특이성으로 겨룬다.
    expect(rules).not.toMatch(/data-focus-dim/);
    expect(rules).not.toMatch(/\.rail-blocked/);
    expect(rules).not.toMatch(/\.spot-clear/);
  });

  it("두 매체는 표면이 들고 온 숫자만 읽는다 — CSS 는 세기를 적지 않는다", () => {
    // 검은 베일 alpha a 는 모든 채널에 (1−a)를 곱하므로 정의상 brightness(1−a) 다. 둘이 같은
    // 숫자만 읽으면 정의상 같은 세기가 된다. CSS 가 숫자를 적으면 설정을 바꿔도 안 바뀐다.
    expect(rules).toMatch(/filter: brightness\(calc\(1 - var\(--dim\)\)\)/);
    expect(rules).toMatch(/background-color: rgb\(0 0 0 \/ var\(--dim\)\)/);
    for (const [sel, body] of [...rules.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    )) {
      if (!sel.includes("[data-dim")) continue;
      // 채도 항은 없다 — 베일은 채도를 못 내린다. 두면 같은 단계의 홀 판과 DOM 판이 갈린다.
      expect(body, `${sel.trim()} 에 채도 항이 있다`).not.toMatch(/saturate\(/);
      // 세기 리터럴도 없다 — 값의 자리는 설정 하나다.
      expect(body, `${sel.trim()} 이 세기를 직접 적는다`).not.toMatch(/--dim:\s*[\d.]/);
    }
  });

  it("홀 슬롯은 어느 단계에서도 filter 를 안 받는다 — 흐림 축은 베일 하나다", () => {
    // 문서 밖 콘텐츠는 DOM 필터에 안 닿는다. 스탠드인만 받으면 둘의 흐림이 어긋난다.
    // 그 규칙은 홀을 파는 프레임워크가 자기 스타일시트로 들고 온다 — 표면 전체에서 찾는다.
    expect(rules).toMatch(/\.tab-body\.hole\[data-dim\] \{[^}]*filter: none/);
  });
});

describe("한 상자는 한 해에서 나온다", () => {
  it("낀 판 목록은 화면이 그리는 해에서 온다 — 셀·결부와 같은 자리다", () => {
    // 실측 2026-08-02: phase.displayed 에서 읽었더니, 여행 모드(정의상 아무것도 안 움직임)에서
    // 포커스를 옮겨도 흐림이 영원히 갱신되지 않았다. 명령은 between=[pan-aecvk3,pan-q7lxti]
    // 인데 슬롯은 계속 idle 이었고 기하는 완전히 동일했다.
    const m = appTsx.match(/betweenIds=\{[^}]*\}/);
    expect(m, "betweenIds 배선을 못 찾았다").toBeTruthy();
    // 한 상자는 한 해에서 나온다 — 낀 판도 railCells·결부와 같은 해를 읽는다. 포커스만 바뀐
    // 해를 위상이 즉시 받아들이는 것은 arrangementKey 가 보장한다(그 짝 검사가 따로 있다).
    expect(m?.[0]).toContain("arrangement?.betweenIds");
  });
});
