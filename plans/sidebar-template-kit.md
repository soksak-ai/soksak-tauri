# 사이드바 템플릿 킷 — 분석·표준화·템플릿화 플랜

상위 결정 기록: `plans/sidebar-projection-spec.md` (§12 레일 공통 양식). 이 문서는 §12를 완성하는
템플릿 킷의 분석 결과와 시행 계획이다. 확정 주체: 사용자 (2026-07-22).

## 1. 문제 판정

좌 레일의 시각 언어가 기능별 제각각이다 — 어디는 흰 바탕, 어디는 테마 바탕. 분할창인지
사이드바인지 모호해지고 뇌가 거부감을 가진다. 원인은 스타일 규율(S6)의 방임이 아니라
**재창조의 허용**이다: 기능마다 사이드바 UI를 자기 손으로 다시 만들었기 때문에 테마가
사이드바를 온전히 컨트롤할 수 없다.

실측 분류 (함대 전수):

| 패턴 | 사례 | 판정 |
|---|---|---|
| 호스트 변수 소비 (`var(--bg, fallback)`) | file-tree | 모범 |
| 플랫폼 변수 **별칭 매핑** (`--surface: var(--card)` …, 자체 팔레트 0) | kanban | 모범 — 킷의 원형 |
| Shadow DOM `:host{all:initial}` + **자기 라이트 팔레트 리터럴** | design-studio | 위반 원흉. `all:initial` 이 상속 변수를 끊고, 인라인 리터럴(#ffffff·#eef1f4·#1b2430 …)이 테마를 무시한다 |
| CEF 오프스크린 페이지(별도 문서) | design-astryx | 별도 축 — 테마 변수를 페이지로 전달하는 배선 필요 |

## 2. 원칙 (사용자 확정 2026-07-22)

1. **테마에 맞는 좌측 사이드바 템플릿이 있다.** 템플릿(양식·프리미티브)의 소유자는 호스트다.
2. **기능은 템플릿을 조합할 뿐, 재창조하지 않는다.** 그래야 테마가 좌 레일을 온전히 컨트롤한다.
3. 기존 사이드바 기능들을 분석·정리·표준화해서 템플릿화한다 (아래 §3 어휘).
4. **동적 재조합**: 기능은 필요에 따라 중간중간 조합을 바꿔 다르게 표현할 수 있다 — 조합은 선언이지 1회성 마크업이 아니다.
5. **상호 정보교환**: 기능(결부 콘텐츠) ↔ 사이드바 조합 사이에 양방향 채널이 있다 — selection 발행/구독(공리 ⑩), 콘텐츠 문맥 변화에 따른 조합 갱신.
6. **상태 저장**: 조합의 상태(펼침·활성 탭·스크롤·검색어)는 저장된다 — 저장이 되어야 복원(R9)도 된다. 채널 = View.state (instanceKey 축).
7. 프레임(헤더)·이동(실주행)·모양(pane|ground)은 §12가 소유 — 킷은 그 본문 안의 어휘다.
8. Shadow DOM 은 격리 수단이지 테마 단절 수단이 아니다 — `:host{all:initial}` 로 테마 변수를 끊는 것 금지. 격리가 필요하면 kanban 패턴(변수 별칭 매핑)으로 한다.

## 3. 표준 어휘 (22개 레일 표면 분석 → 프리미티브)

함대 실표면: 트리(file-tree·kanban.tree·db.navigator·astryx.structure), 목록(git-diff.files·
git-history.commits·workflow.runs·clubhouse.roster·runbook.list·bookmarks.list·dom-picker.selections),
카드/섹션(studio.library·playbox.library), 속성 폼(우측: studio.inspector·db.properties·kanban.detail·
git-review.comments·runbook.editor).

공통 분해:

- `Search` — 검색/필터 입력 (상단 고정)
- `Toolbar` — 아이콘 버튼 행 (추가·새로고침·모드 전환)
- `Tabs` — 소구획 전환 (예: Files|Assets)
- `Section` — 접이식 구획 헤더 (제목 + 카운트)
- `Tree` — 계층 행 (들여쓰기·펼침·아이콘·라벨·뱃지·진행)
- `List` / `Row` — 평평한 행 (아이콘·라벨·메타·뱃지·상태점)
- `CardGrid` — 썸네일 카드 (라이브러리류)
- `Field` / `PropertyGroup` — 우측 인스펙터 폼
- `Empty` — 빈 상태 안내
- `Badge` · `StatusDot` — 상태 표기

전부 **호스트 테마 변수만** 소비한다(팔레트 리터럴 0, kanban 별칭 규율).

## 4. 킷의 형태

- 배포: `@soksak-ai/plugin-api` 의 `sidebar-kit` 모듈 (마크업 규약 + CSS 문자열 + React 래퍼).
  플러그인은 빌드 타임에 조합한다 — 코어 DOM 결합 없음(C1), 렌더 소유는 여전히 플러그인(S2 유지).
- 스타일 계약: 킷 CSS 는 var(--bg/--card/--side/--inset/--fg/--fg2/--fg3/--bd/--bd-soft/--acc/--accbg/--shadow/--app-font) 만 안다.
  테마 전환은 변수 재해석으로 자동(React 재렌더 불필요).
- 동적 재조합: 조합은 컴포넌트 트리(React) 또는 재호출 가능한 빌더 — 기능이 아무 때나 다시 그려도
  프레임·상태 채널은 유지된다.
- 상태: 킷 컨테이너가 View.state 에 {expanded, activeTab, scroll, query} 를 자동 영속하는 헬퍼 제공.
- 교환: selection 은 코어 selection 축(공리 ⑩)으로 발행/구독 — 킷은 그 표준 소비 헬퍼를 제공.

## 5. 이행

1. 킷 v1 구현 (`packages/plugin-api/sidebar-kit`) — §3 프리미티브 + 테스트.
2. **파일럿 = design-studio.library/inspector** (위반 원흉): 조합 재작성 → 라이트·다크 테마 스냅샷으로
   테마 종속 증명.
3. 함대 이행 (트리·목록류부터, CEF(astryx)는 변수 전달 배선 별도).
4. 이행 완료 시 §12-② 강제: 레일 본문의 팔레트 리터럴 = 정합 검사 위반.

상태: 분석·표준화 확정(§1~§4), 시행 = 킷 v1 + 파일럿부터.
