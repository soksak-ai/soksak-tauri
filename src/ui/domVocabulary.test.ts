// @vitest-environment node
// DOM 어휘 게이트(정적) — data-* 속성명이 정체성 표준(docs/IDENTITY.md)을 따르는지 시행한다.
//
// 규칙은 두 겹이고 둘 다 스펙이 소유한다(@soksak-ai/plugin-spec identityVocabulary — 단일진실):
//   ① 삭제어 형태소 금지(bannedDomName) — 열거가 아니라 규칙이라 변형(data-panel-id 류)을 놓치지 않는다.
//   ② 신설 통제 — 모든 data-* 이름은 아래 허용표에 실체·축 명시와 함께 등재돼야 한다.
//
// census 는 "실물 문법"만 센다: 속성 발행(data-x=…)·문자열 키("data-x")·셀렉터([data-x…) —
// 주석 속 서술(개명 역사)은 뒤에 조사·공백이 붙어 자연 제외된다. 실물과 서술을 구분하지
// 못하던 첫 판은 역사 주석을 위반으로 오판했다(어설픈 규칙은 규칙이 아니다).
//
// RED 근거(사용자 실측, 2026-07-26): data-pane-id(탭 인스턴스의 옛 이름)와 data-pane(칸 id)이
//   공존해 한 이름이 두 뜻을 가졌다 — cssVocabulary 는 클래스만 세고 이 축은 아무도 안 셌다.
//
// 측정 질의: grep -rhoE "data-[a-z-]+[=\"'\]\`]" src --include='*.tsx' --include='*.ts' \
//   --exclude='*.test.*' | sed 's/.$//' | sort -u
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bannedDomName } from "@soksak-ai/plugin-spec";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 현존 허용표 — 새 data-* 속성은 여기 등재하며 실체·축을 명시한다(무단 신설 = RED).
 *  이름이 실체 어휘와 다른 항목은 그 사유가 적혀 있어야 한다. */
const ALLOWED = new Set([
  "data-node", // 노출 노드 주소 조각(주소 공리) — ui.tree 스캔 축
  "data-framework", // 이 스타일시트를 들고 온 프레임워크(framework/styles) — 값=어댑터 이름
  "data-content-view-body", // 콘텐츠 뷰 본문 선언(값=label) — 프레임워크가 각자 읽는다
  "data-external-surface", // 문서 밖 가시 표면 소유 슬롯(값=제공자의 안정적 표면 identity)
  // ── 합성 참가자 선언(lib/compositionParticipants — 코어가 모양을 정하고 프레임워크가 찍는다) ──
  "data-composition-kind", // 참가자 종류(slot|renderer) — 표면은 DOM 종류가 아니라 호스트 영수증
  "data-view-id", // 이 참가자가 그리는 뷰(값=탭 인스턴스 id)
  "data-topology-path", // 같은 뷰의 참가자 전원이 공유하는 위상 주소
  "data-visible", // 지금 실제로 합성에 참여하는가(결과 — 요청이 아니다)
  // ── 자식 renderer 폼 컨트롤 투영(framework/tauri/pluginViewPresentation) ──
  "data-form-control", // 투영된 폼 컨트롤 종류
  "data-form-value", // 투영된 폼 컨트롤의 현재 값
  "data-change", // 파일트리 git 상태 축
  "data-view-addr", // 노드 스캔 baseAddress(절대 주소) — view 는 종류 축(생존 어휘)
  "data-tab-id", // 탭 인스턴스 역참조 앵커(정본 — viewHostAnchors)
  "data-testid", // 테스트 관례(외부 표준 이름)
  "data-rail", // 결부 보더의 레일 상자(호스트 상대 px "x,y,w,h") — 판 상자와 다른 것
  "data-box", // 결부 보더가 실제로 그린 상자(호스트 상대 px "x,y,w,h") — 관측면
  "data-dim", // 흐림 단계(clear|idle|blocked) — 사유가 아니라 결과(lib/dimLevel)
  "data-project-plane", // 프로젝트 평면 표식
  "data-gutter-key", // 골 정본 주소 키(gutter 확정 어휘)
  "data-gutter", // 테마 seam 토큰 스탬프(theme.chrome.gutter — 옛 data-divider 의 정본)
  "data-traveling", // 활강 위상
  "data-theme-epoch", // 테마 epoch(perf 축)
  "data-pane-style", // 칸 외형 설정 축(pane 확정 어휘)
  "data-native-drag", // 네이티브 드래그 브리지
  "data-projection", // 레일 투영 축
  "data-projected", // 레일 투영 축
  "data-pane", // 칸 id(pane 확정 어휘 — 슬롯이 사는 칸)
  "data-flash", // 하이라이트 위상
  "data-station", // 레일 station 값
  "data-rail-role", // 레일 역할 축
  "data-rail-clip", // 레일 홀-클립 상태 축(cut|none — 그리기 속성 대신 이 채널이 관측을 진다)
  "data-bv-open", // 브라우저 뷰 open 상태 스탬프(browser-view)
  "data-bound-tab", // 레일 결부 대상 탭 id(RailLinkOverlay 진단 — 값=탭)
  "data-bound-pane", // 레일 결부 대상 칸 id(진단)
  "data-connected", // 레일 결부 경로 존재 여부(진단)
  "data-relation-id", // 유효 레일-탭 관계의 결정적 정체성(state.tree와 DOM 대조 축)
  "data-border-mode", // 실제 관계 보더 분기(union|independent|none)
  "data-path-count", // 실제 관계 보더 경로 수(1|2|0)
  "data-focused-pane", // 스페이스의 활성 칸 id(값=칸)
  "data-maximized-tab", // 최대화 탭 id(값=탭)
  "data-project-active", // 활성 프로젝트 표식
  "data-project-id", // 슬롯 소속 프로젝트 id
  "data-hover", // 골 hover 위상
  "data-k", // 테마 토큰 키(제품 DOM 계약이 유지하는 [data-k] 토큰)
  "data-motion-hold", // 모션 정지 위상(motionDebug)
  // ── 테마 크롬 토큰 스탬프(theme/engine — chrome.* 슬롯을 루트에 새긴다) ──
  "data-icon-box", // 아이콘 상자 토큰
  "data-focus-ind", // 포커스 표시 토큰
  "data-theme-mode", // 라이트/다크 모드
  "data-tab-shape", // 탭 모양 토큰
  "data-titlebar", // 타이틀바 토큰
  "data-tab-bar", // 탭바 토큰
  "data-status-bg", // 상태바 배경 토큰
  "data-chrome-font", // 크롬 폰트 토큰
  // ── 진단·관측 표식 ──
  "data-relation-label", // 레일 결부 관계 라벨(RailLinkOverlay 진단)
  "data-capture-calibration-anchor", // DOM/스냅샷 좌표계 배율을 판정하는 고정 합성 자
  "data-capture-motion-anchor", // 노출 슬롯과 외부 표면의 프레임별 궤적을 비교하는 합성 자
  "data-capture-motion-restore-position", // 관측 자 제거 뒤 원래 position 값을 복원하는 수명주기 표식
  // ── slot-freeze 관측 계약(이동-동결의 판정 표식 — slot-freeze 하니스가 소비) ──
  "data-freeze", // 동결 위상(0/1)
  "data-freeze-glide", // 활강 판정
  "data-freeze-scope", // 동결 범위
  "data-freeze-sender", // 위상 발신자(진단)
  "data-freeze-pending", // 선캡처 대기
  "data-freeze-snap-at", // 스냅 시각
  "data-freeze-snap-size", // 스냅 크기
  "data-freeze-snap-try", // 스냅 시도 수
  "data-freeze-snap-skip", // 스냅 스킵 사유
  "data-freeze-snap-fail", // 스냅 실패 사유
]);

const GREP_ARGS = [
  SRC,
  "--include=*.tsx",
  "--include=*.ts",
  "--exclude=*.test.ts",
  "--exclude=*.test.tsx",
];

function grepLines(pattern: string): string[] {
  try {
    return execFileSync("grep", ["-rhE", pattern, ...GREP_ARGS], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // 매치 0 = grep exit 1 — census 죽음은 아래 하한 단언이 잡는다
  }
}

/** 줄에서 주석부를 절단하고 패턴 실물만 추출 — 개명 역사 주석은 기록이지 실물이 아니다. */
function extract(lines: string[], re: RegExp, map: (m: string) => string): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const code = raw.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    for (const m of code.matchAll(re)) out.push(map(m[0]));
  }
  return out;
}

function census(): string[] {
  // ① 리터럴 문법: data-x= / "data-x" / 'data-x' / [data-x
  const literal = extract(
    grepLines(`data-[a-z-]+[="'\\]]`),
    /data-[a-z-]+[="'\]]/g,
    (s) => s.slice(0, -1),
  );
  // ② dataset 접근: el.dataset.tabId → data-tab-id (camel→kebab). 발행·판독 둘 다 실물이다.
  const dataset = extract(
    grepLines(`dataset\\.[a-zA-Z]+`),
    /dataset\.[a-zA-Z]+/g,
    (s) => "data-" + s.slice("dataset.".length).replace(/([A-Z])/g, "-$1").toLowerCase(),
  );
  return [...new Set([...literal, ...dataset])];
}

// ── 이름 전수 census: CSS 클래스·커스텀 프로퍼티 ──────────────────────────────
// 사용자 확정(2026-07-27): "css class name, html attribute, property 모두 대상". 클래스·
// 프로퍼티는 종류가 수백이라 허용표 나열 대신 형태소 규칙만 시행한다(신설 통제는 계약면인
// data-* 만). CSS 원천 = App.css 셀렉터·--x 선언 + 컴포넌트 className/setProperty 리터럴.
function cssNameCensus(): string[] {
  const names = new Set<string>();
  // App.css: 클래스 셀렉터 + 커스텀 프로퍼티 선언
  const css = execFileSync("cat", [join(SRC, "App.css")], { encoding: "utf8" })
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9-]*)/g)) names.add(m[1]);
  for (const m of css.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) names.add("--" + m[1]);
  // 컴포넌트: className 문자열 리터럴 토큰 + setProperty/스타일 변수 리터럴
  for (const line of grepLines(`className|setProperty|--[a-z-]+`)) {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(/className=\{?[\`"']([^\`"']+)/g))
      for (const tok of m[1].split(/\s+/))
        if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tok)) names.add(tok);
    for (const m of code.matchAll(/["'\`](--[a-zA-Z][a-zA-Z0-9-]*)["'\`]/g)) names.add(m[1]);
  }
  return [...names];
}

describe("이름 전수 — CSS 클래스·커스텀 프로퍼티의 삭제어 시행(스펙 규칙)", () => {
  it("삭제어 형태소가 없다", () => {
    const hits = cssNameCensus()
      .map((n) => ({ n, why: bannedDomName(n) }))
      .filter((x) => x.why !== null);
    expect(hits.map((h) => h.why)).toEqual([]);
  });
});

describe("DOM 어휘 — data-* 속성명 정체성 시행", () => {
  const names = census();

  it("실물이 세어진다 — census 가 비면 게이트는 죽은 것이다", () => {
    expect(names.length).toBeGreaterThan(10);
  });

  it("삭제어 형태소가 없다(스펙 규칙 — 변형 포함)", () => {
    const hits = names
      .map((n) => ({ n, why: bannedDomName(n) }))
      .filter((x) => x.why !== null);
    expect(hits.map((h) => h.why)).toEqual([]);
  });

  it("모든 data-* 속성이 허용표에 등재돼 있다(신설 = 표에 실체·축 명시 후)", () => {
    const unknown = names.filter((n) => !ALLOWED.has(n));
    expect(unknown, `허용표 미등재: ${unknown.join(", ")}`).toEqual([]);
  });
});
