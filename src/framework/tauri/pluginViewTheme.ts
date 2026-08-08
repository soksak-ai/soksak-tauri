// 테마 변수를 자식 realm 으로 건네는 한 자리.
//
// 콘텐츠가 네이티브 자식 웹뷰로 사는 뷰는 자기 문서에서 돈다 — 앱의 스타일시트가 없으니
// `:root` 의 테마 변수도 없다. 그 realm 이 그리는 것(공용 툴바 등)은 `var(--fg)` 로 색을
// 정하므로, 변수가 안 건너가면 값이 없다.
//
// 실측 2026-08-08: 브라우저 세 종이 같은 kit 을 쓰는데 하나만 글자가 검정이었다. 변수는 세
// realm 어디에도 없었고 색은 각 플러그인이 자기 스타일시트에 넣은 폴백에서 나오고 있었다 —
// 값 하나가 세 자리에 흩어져 있었고 한 자리가 비어 있었다. 흩어진 사본이 아니라 **건너가지
// 않는 것**이 결함이다.
//
// 이름을 손으로 적지 않는다. 루트에 실제로 걸린 커스텀 속성을 그대로 모은다 — 목록을 적으면
// 테마에 변수가 하나 늘 때마다 그 목록이 조용히 뒤처진다.

/**
 * 이 문서의 루트가 든 커스텀 속성 전부(`--*`).
 *
 * @throws 문서를 못 읽으면 던진다 — 빈 목록으로 답하면 받는 쪽은 "테마가 없다" 로 읽고 자기
 * 색을 지어낸다. 못 읽음과 없음은 다른 사실이다.
 */
export function themeCustomProperties(doc: Document): Record<string, string> {
  const root = doc.documentElement;
  const computed = doc.defaultView?.getComputedStyle(root) ?? null;
  if (computed === null) {
    throw new Error("테마를 읽을 문서가 없습니다 — 빈 테마는 답이 아닙니다");
  }
  const out: Record<string, string> = {};
  // CSSStyleDeclaration 순회는 커스텀 속성도 낸다. 인라인으로만 걸린 것도 놓치지 않게 둘 다 본다.
  for (const source of [computed, root.style]) {
    for (let i = 0; i < source.length; i += 1) {
      const name = source.item(i);
      if (!name.startsWith("--")) continue;
      const value = computed.getPropertyValue(name).trim() || source.getPropertyValue(name).trim();
      if (value !== "") out[name] = value;
    }
  }
  return out;
}

/** 받은 테마를 이 문서의 루트에 건다 — realm 안의 `var(--*)` 가 그때부터 값을 얻는다. */
export function applyTheme(doc: Document, theme: Record<string, string>): void {
  for (const [name, value] of Object.entries(theme)) {
    doc.documentElement.style.setProperty(name, value);
  }
}
