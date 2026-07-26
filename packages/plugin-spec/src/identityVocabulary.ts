// 정체성 어휘 규칙(단일진실) — DOM 에 노출되는 모든 이름(CSS 클래스·data-* 속성)의 삭제어 판정.
//
// 규칙(docs/IDENTITY.md §3·§5): 한 실체 한 이름. 삭제어는 코어든 플러그인이든 어떤 DOM
// 이름에도 형태소로 들어갈 수 없다. 이 목록과 판정은 여기 한 곳에만 있다 — 코어 게이트
// (domVocabulary·cssVocabulary)와 발행 게이트(doctor)·플러그인 conformance 가 같은 함수를
// 소비한다. 목록을 복제한 사본은 곧 어긋난다(실사고: 코어만 세고 플러그인이 오염).
//
// 왜 형태소인가: 정확일치 금지표는 변형(data-panel-id, .my-divider-line)을 놓친다 — 이름을
// 하이픈·캐멀 경계로 토큰화해 금지 형태소가 하나라도 있으면 위반이다. 열거가 아니라 규칙.

/** DOM 이름에서 금지되는 형태소 — IDENTITY §3 삭제어 + §5-1 래퍼 역할 명사 전량(재론 금지).
 *  부분 채택은 어설픈 규칙이다 — 문서의 금지 목록과 이 표는 항상 완전 일치한다. */
export const BANNED_DOM_MORPHEMES: readonly { morpheme: string; canonical: string }[] = [
  // §3 삭제어
  { morpheme: "panel", canonical: "pane" },
  { morpheme: "egroup", canonical: "pane" },
  { morpheme: "group", canonical: "pane" },
  { morpheme: "divider", canonical: "gutter" },
  { morpheme: "bodywrap", canonical: "space-body" },
  // §5-1 래퍼 역할 명사 — 실체를 별칭 뒤에 숨긴다
  { morpheme: "slot", canonical: "(실체 이름 + -body 등 부품 파생)" },
  { morpheme: "cell", canonical: "pane" },
  { morpheme: "grid", canonical: "space" },
  { morpheme: "frame", canonical: "(실체 이름 — frame 은 렌더 프레임과 충돌)" },
  { morpheme: "container", canonical: "(실체 이름 + -body)" },
  { morpheme: "leaf", canonical: "pane" },
  { morpheme: "host", canonical: "(실체 이름 + -body)" },
  { morpheme: "handle", canonical: "gutter(끌기) 또는 실체 부품명" },
];

/** 이름을 형태소로 나눈다 — 하이픈·언더스코어·캐멀 경계. "data-panel-id" → [data,panel,id]. */
export function domNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * DOM 이름(클래스 또는 data-* 속성명)의 삭제어 판정.
 * 위반이면 사유 문자열, 아니면 null. egroup 처럼 다른 금지어를 포함하는 형태소는
 * 긴 것부터 대조한다(부분 매칭 오판 방지 — 토큰 단위라 실제로는 정확일치).
 */
export function bannedDomName(name: string): string | null {
  const tokens = domNameTokens(name);
  for (const { morpheme, canonical } of BANNED_DOM_MORPHEMES) {
    if (tokens.includes(morpheme)) {
      return `"${name}" 은 삭제어 형태소 "${morpheme}" 를 포함 — 정본 어휘: ${canonical}`;
    }
  }
  return null;
}
