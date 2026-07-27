// UI 정렬 헌법(docs/UI.md) 기계 게이트 — App.css 를 파싱해 규칙 위반 시 실패한다.
// R1(밴드 패딩 계약): 가로 밴드의 항목은 height 를 갖지 않는다(stretch 로 채움).
//   여백은 스트립의 padding-block 변수(--tab-pad/--ws-pad)만이 소유한다.
// R2: 탭류 항목에 위치 보정 핵(음수 오프셋·translateY·scale) 금지.
// 기준을 통과 못 한다고 이 테스트를 약화하지 마라 — 기준이 틀렸으면 docs/UI.md 의
// 규칙을 먼저 정정하라(배신 금지 조항).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";

const css = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");

// 단순 파서: 최상위 "selector { decls }" 단위로 분해(중첩 없음 — App.css 평면 규칙).
// 셀렉터에 붙는 주석은 제거 — 주석 속 쉼표가 셀렉터 분해를 오염시키지 않게.
function rules(): Array<{ selector: string; decls: string }> {
  const out: Array<{ selector: string; decls: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    out.push({ selector, decls: m[2] });
  }
  return out;
}

// 탭류 박스 클래스(밴드 형제 박스 계약 대상). \w- 경계로 .project-tabs/.project-tab-dot 등은 제외.
const BAND_ITEM = /\.(tab|tab-add|space-tab-add|project-tab-add|space-tab|project-tab)(?![\w-])/;

// 계약 밖 예외: 세로 레일(정사각 칩)·세로 리스트 모드 — 가로 밴드가 아니다.
const EXEMPT = /\.project-rail|\.space-tabs\.vertical/;

// 크롬 행 band(타이틀바 아래 가로줄의 탭/헤더 스트립). 높이는 테마 표준 변수만 소유(--chrome-row-h=탭행,
// --header-h=타이틀바/뷰 탭행). 하드코딩 px 금지. \.project-tabs 는 .space-tabs/.tabs 를 매치하지 않는다.
const CHROME_ROW = /\.(ft-header|plugin-side-head|sidebar-left-tabs|space-tabs|project-tabs)(?![\w-])/;
// 허용 표준 변수(둘 다 테마 소유) — 크롬 행 높이는 이 중 하나의 var() 만.
// 공인 행 높이 토큰 — chrome-row(밴드 1행)·header(패널/레일 헤더)·toolbar(2행 공동 그리드,
// 테마 소유). 이 셋 밖의 행 높이 발명 금지.
const CHROME_HEIGHT_OK = /height\s*:\s*var\(--(chrome-row|header|toolbar)-h/;

describe("UI 정렬 헌법 게이트 (docs/UI.md)", () => {
  it("R1: 밴드 항목은 height 금지(auto 만 허용) — 여백은 스트립 패딩이 소유", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!BAND_ITEM.test(selector) || EXEMPT.test(selector)) continue;
      const heights = decls.match(/(?:^|;)\s*height\s*:\s*([^;]+)/g) ?? [];
      for (const h of heights) {
        if (!/height\s*:\s*auto/.test(h)) {
          violations.push(`${selector} → ${h.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("R1c: 레일 프레임 헤더는 pane 그리드 행 계약을 따른다 — 높이 --header-h·상단 --pane-inset", () => {
    // 레일은 pane 그리드 안의 가구다 — 이웃은 크롬 행(37px)이 아니라 pane 그룹 헤더다.
    // 높이·상단 오프셋이 테마 변수(--header-h/--pane-inset)를 따라야 어떤 테마에서도
    // 상하 그리드가 정확히 맞는다(하드코딩·크롬행 변수 금지).
    const header = rules().find((r) => r.selector === ".projection-header");
    expect(header?.decls).toMatch(/height\s*:\s*var\(--header-h/);
    const host = rules().find((r) => r.selector === ".sidebar-left");
    expect(host?.decls).toMatch(/padding-top\s*:\s*var\(--pane-inset/);
  });

  it("§12-④ 주행 동조: railGap 소비자는 레이아웃 보간 없이 같은 FLIP transform을 쓴다", () => {
    // left/width 보간은 패널마다 독립 레이아웃·페인트를 유발해 중간 프레임을 찢는다.
    // 최종 레이아웃을 먼저 확정하고, 모든 railGap 소비자는 같은 compositor translate로 복귀한다.
    const consumers = new Set(
      rules()
        .filter((r) => /var\(--rail-dx/.test(r.decls))
        .map((r) => r.selector.split(",")[0].trim().split(" ").pop() as string),
    );
    consumers.add(".pane-gutter"); // 인라인 스타일 소비자(GroupArea)
    const sync = rules().find(
      (r) =>
        r.selector.startsWith(".space-body.rail-traveling") &&
        r.selector.includes(".pane"),
    );
    expect(sync).toBeTruthy();
    for (const sel of consumers) {
      expect(sync!.selector).toContain(sel);
    }
    expect(sync!.decls).not.toMatch(/transition\s*:/);
    expect(RAIL_TRAVEL_MS).toBe(340);
    expect(sync!.decls).toMatch(/animation:\s*rail-flip-x var\(--rail-travel-ms\) cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
    // 이동량 합성은 한 변수(--flip-x)에서 끝난다 — 두 축을 CSS 에서 더하면 배열 교환과 주행이
    // 겹치는 위상에서 어긋난다(해결기가 px 로 접어 준다).
    expect(css).toMatch(/@keyframes rail-flip-x\s*\{[\s\S]*from\s*\{\s*translate:\s*var\(--flip-x/);
    expect(css).not.toMatch(/--rail-flip-x/);
    expect(css).not.toMatch(/--focus-flip-x/);
    // 프레임도 실이동 요소만 활강한다 — 델타 0 요소를 위상마다 합성 레이어로 올렸다 내리는
    // 승격 churn 이 "무관한 표면이 움찔하는" 실사고의 기제였다(§2 시각효과 소유권).
    expect(sync!.selector).toContain(".pane-border.flip-move");
    expect(sync!.selector).not.toMatch(/\.pane-border,/);
    // 장식 span 도 같은 규칙 — 실제로 이동하는 것만 승격한다.
    expect(sync!.selector).toContain(".pane-gutter.flip-move");
    expect(sync!.selector).toContain(".drop-ind-wrap.flip-move");
    expect(sync!.selector).not.toMatch(/\.pane-gutter\s*\{/);
    // pane 만 FLIP 한다. 레일은 이동 물체가 아니라 빠질 자리와 생길 자리이고, 패널이 덮고
    // 드러내는 것이 곧 닫힘·열림이다. 레일에 평행이동을 얹으면 두 자리 규칙과 겹쳐 이중
    // 이동이 된다. 어느 레일 표상도 활강 애니메이션을 받지 않는다.
    expect(sync!.selector).not.toMatch(/\.sidebar/);
  });

  it("§5.1-F7 위상 클래스는 하나뿐이다 — 스위칭도 주행과 같은 한 위상이다", () => {
    // 위상 추적이 둘이면(레일 주행 · 패널 교환) 한 클릭에 둘이 겹칠 때 서로 다른 출발점을
    // 보고 어긋난다. 배치 해결기가 두 축을 한 해로 풀므로 클래스도 하나다.
    expect(css).not.toMatch(/focus-layout-traveling/);
  });

  it("§12-④ 영역 인계는 페이드나 레일 오버레이 없이 pane의 수축·확장이 드러낸다", () => {
    expect(css).not.toMatch(/@keyframes proj-slot-(in|out)/);
    expect(css).not.toMatch(/\.projection\.(entering|leaving)/);
    const rail = rules().find((r) => r.selector === ".sidebar");
    expect(rail?.decls).not.toMatch(/opacity\s*:/);
    const restingPlane = rules().find((r) => r.selector === ".left-rail-plane");
    expect(restingPlane?.decls).toMatch(/z-index\s*:\s*0/);
    // 출발·도착 레일은 둘 다 바닥에 있어 pane이 자연스럽게 가리고 드러낸다.
    expect(css).not.toMatch(/\.space-body\.rail-traveling \.left-rail-plane\s*\{/);
  });

  it("§12-④ 개정: 주행 중에도 입력은 열려 있다 — 셀·슬롯·디바이더 히트 차단 금지", () => {
    // 실측(포커스 trace): 주행 중 불활성(전면이든 이동요소 한정이든 — 레일 주행은 스테이션
    // 뒤 전 셀을 밀므로 사실상 전면)은 주행 중 도착하는 실클릭을 space-body 로 떨어뜨려
    // 죽였고, 재배달이 직전/첫 페인으로 가서 "클릭한 곳에 포커스가 안 간다"가 됐다.
    // straddle 방지는 히트 차단이 아니라 활성화 귀속이 담당한다(armSlotActivation —
    // 활성화는 게스처 완결 시점에, 게스처를 시작한 슬롯에 귀속). 그러므로 어떤 주행
    // 위상도 입력면을 차단하지 않는다.
    for (const scope of [".space-body.rail-traveling"]) {
      const blocking = rules().filter(
        (r) =>
          r.selector.includes(scope) &&
          /pointer-events\s*:\s*none/.test(r.decls) &&
          /(pane|tab-body|pane-gutter)/.test(r.selector),
      );
      expect(blocking.map((b) => b.selector), scope + " 입력 차단 금지").toEqual([]);
    }
  });

  it("툴바 행 계약: 코어 툴바(.fv-toolbar)는 테마 토큰을 소비한다 — 자체 치수 재창조 금지", () => {
    // 기능 상단 바가 저마다 치수를 발명해 그리드가 어긋났다(실측: 브라우저·에디터·칸반
    // 3행 전부 상이). 계약: 툴바는 선택 표면이되, 존재하면 var(--toolbar-h)/
    // var(--toolbar-pad-x)를 소비한다. 코어 내장 표면(파일 뷰어)이 1호 준수자다.
    const rule = rules().find((r) => r.selector.split(",").some((s2) => s2.trim() === ".fv-toolbar"));
    expect(rule).toBeTruthy();
    expect(rule!.decls).toMatch(/height:\s*var\(--toolbar-h\)/);
    expect(rule!.decls).toMatch(/padding:\s*0\s*var\(--toolbar-pad-x\)/);
    expect(rule!.decls).not.toMatch(/height:\s*\d/);
  });

  it("R1: 죽은 변수(--tab-h/--ws-tab-h) 잔재 금지 — 계약 변수는 패딩뿐", () => {
    expect(css).not.toMatch(/--tab-h\b|--ws-tab-h\b/);
  });

  it("R2: 탭류 항목에 위치 보정 핵 금지(음수 오프셋·translateY·scale)", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!BAND_ITEM.test(selector) || EXEMPT.test(selector)) continue;
      if (/(?:^|;)\s*(top|right|bottom|left)\s*:\s*-/.test(decls)) {
        violations.push(`${selector} → 음수 오프셋`);
      }
      if (/transform\s*:\s*[^;]*(translateY|scale)/.test(decls)) {
        violations.push(`${selector} → transform 미세조정`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("R1 계약 규칙 존재: 스트립이 패딩 변수를, 항목이 stretch 를 소비한다", () => {
    // 각 밴드 스트립은 자신의 패딩 변수를 소비한다.
    expect(css).toMatch(/\.tabs \{[^}]*padding: var\(--tab-pad/);
    expect(css).toMatch(/\.space-tabs \{[^}]*padding: var\(--ws-pad/);
    expect(css).toMatch(/\.project-tabs \{[^}]*padding-block: var\(--ws-pad/);
    // 항목 일괄 stretch 계약 블록.
    expect(css).toMatch(
      /\.tabs \.tab,\s*\.tabs \.tab-add,\s*\.project-tab,\s*\.space-tab,\s*\.project-tab-add,\s*\.space-tab-add \{[^}]*align-self: stretch/,
    );
  });

  // ── R3/R4: 크롬 행 높이 표준 — 좌측 사이드바 탭 band 와 컨텐츠 탭 band 가 같은 가로줄·같은 높이가 되도록
  //    모든 최상단 위치 band 가 단일 변수 --chrome-row-h 를 소유한다(테마가 그 값을 소유 = 테마별 기준).
  //    기준 미달이라고 이 테스트를 약화하지 마라 — 어긋난 band 의 CSS 를 표준에 맞춰라(배신 금지). ──
  it("R3: 크롬 행 band 높이는 표준 var(--chrome-row-h) 만 — 하드코딩 px 금지", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!CHROME_ROW.test(selector) || EXEMPT.test(selector)) continue;
      // 주석 제거 — ';'/'height' 가 주석 속에 있으면 (?:^|;) 앵커가 깨져 오탐/누락된다.
      const clean = decls.replace(/\/\*[\s\S]*?\*\//g, "");
      const heights = clean.match(/(?:^|;)\s*height\s*:\s*([^;]+)/g) ?? [];
      for (const h of heights) {
        if (!CHROME_HEIGHT_OK.test(h)) {
          violations.push(`${selector.replace(/\s+/g, " ")} → ${h.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("R4: 패널 크롬 높이 변수 정의 존재 — --chrome-row-h·--header-h·--status-h (미정의 → var() 무너짐)", () => {
    const missing: string[] = [];
    for (const v of ["--chrome-row-h", "--header-h", "--status-h"]) {
      if (!new RegExp(`${v}\\s*:`).test(css)) missing.push(v);
    }
    expect(missing).toEqual([]);
  });

  it("B4: 보더 선언에 직색(rgba/hex) 금지 — 토큰(var(--bd*))/transparent 만", () => {
    // 소유권 헌법(docs/UI.md §B4): 구조선 색은 --bd/--bd-soft 두 토큰뿐.
    // outline/box-shadow 가 아닌 border* 선언만 대상(강조 표면은 --accbg 토큰).
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      const borders =
        decls.match(/(?:^|;)\s*border[^:;]*:\s*[^;]+/g) ?? [];
      for (const b of borders) {
        if (/rgba?\(|#[0-9a-fA-F]{3}/.test(b)) {
          violations.push(`${selector} → ${b.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("B4: --bd-soft 파생 토큰 정의 존재(내부선 톤의 단일 출처)", () => {
    expect(css).toMatch(/--bd-soft:\s*color-mix\(/);
  });

  // ── §B8 계약 전수성: 스펙이 모르는 경계면은 스펙이 못 잡는다 — 그래서
  //    "CSS 의 구조 보더 ↔ 계약 테이블" 양방향 동기화를 게이트로 강제한다.
  //    구조 보더(--bd/--bd-soft)를 긋는 셀렉터는 반드시 계약에 등재되거나,
  //    경계면이 아닌 "위젯 윤곽"으로 명시 분류돼야 한다. ──

  // 위젯 윤곽(비경계면) 허용 목록 — 입력/카드/배지/스와치 등 폐곡선 윤곽.
  // 경계면(두 영역의 분리선)이 아니므로 소유권 계약 대상이 아니다.
  const WIDGET_OUTLINE = [
    ".plugin-input",
    ".plugin-row",
    ".plugin-badge",
    ".settings-input", // 설정 입력 박스(number/text) — 폐곡선 윤곽
    ".settings-select", // 설정 드롭다운 — 폐곡선 윤곽
    ".settings-list-add", // 설정 리스트 추가 버튼 — 폐곡선 윤곽
    ".settings-list-remove", // 설정 리스트 삭제 버튼 — 폐곡선 윤곽
    ".plugin-consent-item",
    ".plugin-consent-notice",
    ".dremote-confirm-notice", // 원격 confirm 자동거부 안내 박스 — 폐곡선 윤곽(경계면 아님)
    ".plugin-consent-cmd", // 명령 원문 코드 박스 — 폐곡선 윤곽
    ".plugin-contrib-chip", // 역할 칩 — 폐곡선 윤곽
    ".pane-status-item", // 상태바 플러그인 항목 칩(claude-GUI 의 "gui" 등) — 폐곡선 윤곽
    ".notify-banner", // 인앱 알림 배너 카드 + 액션 버튼(-action) — 폐곡선 윤곽
    ".webview-health-badge", // webview 복구 소진 배지 카드 + 버튼 — 폐곡선 윤곽(notify-banner 동형)
    ".boot-phase", // 부트 위상 배지(복원·플러그인 준비 진행 표시) — 폐곡선 pill 윤곽(webview-health-badge 동형)
    ".root-missing-banner", // root 부재 격하 배너(B1) — 배너 카드 윤곽(notify-banner 동형)
    ".motion-debug", // 모션 관측 패널 카드(개발 전용) — 폐곡선 윤곽(경계면 아님)
    ".motion-debug button", // 그 패널의 배속·정지 버튼 — 폐곡선 윤곽
    ".orch-win", // 오케스트레이터 창맵 항목 카드(A3) — 폐곡선 윤곽
    ".orch-console input", // 오케스트레이터 콘솔 입력 — 폐곡선 윤곽
    ".orch-console button", // 오케스트레이터 실행 버튼 — 폐곡선 윤곽
    ".orch-feed-all", // 피드 전체-필터 해제 버튼 — 폐곡선 윤곽
    ".left-rail-controls", // FLOW/PIN 그립·핀을 감싸는 폐곡선 컨트롤 팔레트

    ".dctl",
    ".dstepper",
    ".th-item",
    ".th-swatch",
    ".color-swatch",
    ".rail-add",
    ".plugin-rejected",
    ".space-tab-rename",
    ".project-tab-rename",
    ".rail-rename",
    ".bv-url",
    ".cmf-input",
    ".cmf-field",
    ".icon-btn",
    ".drop-ind",
    ".tab", // 칩 윤곽(테마 변형) — 칩 자체의 폐곡선
    ".project-tab",
    ".space-tab",
    ".dbtn",
    ".rail-chip",
  ];

  it("B8: 구조 보더 셀렉터는 계약 등재 또는 위젯 윤곽 분류 — 미지의 경계면 금지", async () => {
    const { BORDER_RULES } = await import("./borderContract");
    const contractSelectors = BORDER_RULES.flatMap((r) =>
      r.selector.split(",").map((s) => s.trim()),
    );
    const inContract = (selector: string) =>
      contractSelectors.some((cs) => {
        const head = cs.split(":")[0]; // ".space-tabs:not(...)" → ".space-tabs"
        return selector.includes(head);
      });
    const isWidget = (selector: string) =>
      WIDGET_OUTLINE.some((w) => selector.includes(w));

    const unknown: string[] = [];
    for (const { selector, decls } of rules()) {
      const borders = decls.match(/(?:^|;)\s*border[^:;]*:\s*[^;]+/g) ?? [];
      const structural = borders.filter((b) => /var\(--bd(-soft)?\)/.test(b));
      if (structural.length === 0) continue;
      for (const single of selector.split(",").map((s) => s.trim())) {
        if (!inContract(single) && !isWidget(single)) {
          unknown.push(`${single} → ${structural[0].trim()}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("B8 전수성: 조건부 표면은 상태 공간을 빈틈·모순 없이 커버한다", async () => {
    // "존재해야 하는 상태"만 단언하고 반대 상태를 비워두면, 존재하면 안 되는
    // 선이 있어도 RED 가 없다 — 조건부(when) 규칙이 있는 (selector, edge/seam)
    // 단위는 paneStyle×gutter 전 조합이 정확히 1개 규칙에 커버돼야 한다.
    const { BORDER_RULES } = await import("./borderContract");
    const PANE = ["flat", "card", "floating"];
    const DIV = ["overlay", "solid"];
    type Key = string; // `${selector}|${edge}`
    const targets = new Map<Key, { rule: string; when?: { paneStyle?: readonly string[]; gutter?: readonly string[] } }[]>();
    for (const r of BORDER_RULES) {
      const edges = r.kind === "seam" ? ["seam"] : Object.keys(r.edges ?? {});
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        for (const e of edges) {
          const k = `${sel}|${e}`;
          if (!targets.has(k)) targets.set(k, []);
          targets.get(k)!.push({ rule: r.id, when: r.when });
        }
      }
    }
    const problems: string[] = [];
    for (const [key, rs] of targets) {
      // 무조건 규칙만 있으면 전 상태 커버 — 통과.
      if (rs.every((r) => !r.when)) {
        if (rs.length > 1) problems.push(`${key}: 무조건 규칙 중복(${rs.map((r) => r.rule)})`);
        continue;
      }
      for (const p of PANE) {
        for (const d of DIV) {
          const hits = rs.filter(
            (r) =>
              (!r.when?.paneStyle || r.when.paneStyle.includes(p)) &&
              (!r.when?.gutter || r.when.gutter.includes(d)),
          );
          if (hits.length === 0) {
            problems.push(`${key}: 상태 공백 paneStyle=${p},gutter=${d}`);
          } else if (hits.length > 1) {
            problems.push(
              `${key}: 상태 모순 paneStyle=${p},gutter=${d} → ${hits.map((h) => h.rule).join(",")}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("B8: 계약의 edges 규칙은 CSS 에 대응 선언 존재(공허한 규칙 금지)", async () => {
    const { BORDER_RULES } = await import("./borderContract");
    const empty: string[] = [];
    for (const r of BORDER_RULES) {
      if (r.kind !== "edges" || !r.edges) continue;
      const tokens = Object.values(r.edges).filter((v) => v !== "none");
      if (tokens.length === 0) continue; // none 단언은 선언 부재가 정답
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        // 셀렉터는 정규식이 아니다 — 통째로 이스케이프한다. 앞의 점만 이스케이프하던 판은
        // 속성 셀렉터([data-station="0"])를 문자 클래스로 읽어 대응 선언을 못 찾았다.
        const head = sel.split(":")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`${head}[^{]*\\{[^}]*border[^:;]*:[^;]*var\\(--bd`);
        if (!re.test(css)) empty.push(`${r.id} (${sel})`);
      }
    }
    expect(empty).toEqual([]);
  });
});
