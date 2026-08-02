// 프레임워크가 자기 스타일을 문서에 거는 자리.
//
// `import "./styles.css"` 로 두면 번들 하나에 두 프레임워크의 CSS 가 다 들어가고, 안 고른
// 쪽의 규칙도 문서에 선다(실측 2026-08-03: `electron.css` 가 Tauri 빌드에도 들어와 있었다).
// 그래서 CSS 를 **문자열로** 받아 install 시점에 건다 — 고른 쪽 것만 문서에 선다.
//
// 셀렉터에 프레임워크 이름을 붙이지 않는다. **파일이 곧 조건**이다: 안 걸리면 그 규칙은
// 애초에 문서에 없다. 이름을 셀렉터에 넣으면 세 번째 프레임워크가 남의 조건을 읽어야 한다.

/** 이 프레임워크의 스타일을 문서에 건다(멱등). 표식은 진단·게이트가 읽는다. */
export function adoptFrameworkStyles(name: string, css: string): void {
  const doc = document;
  const mark = `framework-styles-${name}`;
  if (doc.getElementById(mark)) return;
  const el = doc.createElement("style");
  el.id = mark;
  el.dataset.framework = name;
  el.textContent = css;
  doc.head.appendChild(el);
}
