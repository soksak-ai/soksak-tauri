# 정체성 — 실체·이름·id·참조

soksak 에 무엇이 존재하고, 각각을 무엇이라 부르며, 어떻게 식별하고 지칭하는지의 정본이다.
2026-07 정체성 표준화의 **결과**이지 그것을 만든 플랜의 요약이 아니다 — 플랜은 폐기돼도
이 문서는 남는다.

영문 쌍둥이: `IDENTITY.md`. 두 벌은 함께 커밋된다.

## 1. 실체

노출 실체 다섯, 계층 하나:

```
w-<uuid4>            window   — OS 창. 창이 곧 작업공간이다
 └ pjt-xxxxxx        project  — 루트 폴더 하나에 매인 작업
    └ spc-xxxxxx     space    — 프로젝트 안의 pane 배치 한 벌
       ├ pan-xxxxxx  pane     — 탭들이 사는 사각 칸
       │   └ tab-xxxxxx  tab  — 그 안에서 전환하는 인스턴스 하나
       └ pan-xxxxxx
```

| 실체 | 정의 | id | 발급 |
|---|---|---|---|
| window | OS 창 | `w-<uuid4>` (현행 유지) | Rust (`window.rs`) |
| project | 루트 폴더 하나의 작업 | `pjt-<base32·6>` | `src/state/ids.ts` |
| space | pane 배치 한 벌 | `spc-<base32·6>` | `src/state/ids.ts` |
| pane | 탭이 사는 칸 | `pan-<base32·6>` | `src/state/ids.ts` |
| tab | view 의 인스턴스 하나 | `tab-<base32·6>` | `src/state/ids.ts` |

레이아웃 밖의 접두 id 가 하나 더 있다: **셸 세션**(`sh-<base32·6>`). PTY 세션 생성 시
발급되며, 재부착 키를 탭 정체성이 아니라 세션 자신에 묶기 위해 존재한다 — 탭 이름을
어떻게 바꾸든 살아 있는 셸이 고아가 되는 일은 없어야 한다.

**불변식**

- pane 은 **탭 0개 이상**을 담는다. 빈 pane 은 유효하다
  (`emptyPanelContext.test.ts` 가 지킨다 — "강화"라는 이름으로 되돌리지 마라).
- 탭이 사는 곳은 pane **뿐**이다.
- 배치 트리의 내부 노드(행/열 분할)는 **실체가 아니다**: 이름도, 노출 id 도 없고
  주소·명령·응답 어디에도 나오지 않는다. 증명과 근거는 §4.

## 2. 종류·위치·부면 — 나머지 어휘

| 축 | 단어 | 뜻 |
|---|---|---|
| 종류 | **program** | 사람이 (+) 메뉴에서 고르는 것 — `contributes.programs` |
| 종류 | **view** | program 이 여는 표면 종류 — `contributes.views` |
| 위치 | **region** | `left \| content \| right` |
| 위치 | **placement** | `content \| rail \| rail-footer` |
| 위치 | **rail** | 투영 레일. 여기 사는 인스턴스는 탭이 *아니다* |
| 경계 | **gutter** | 형제 사이의 끌 수 있는 골 |
| 부면 | **`-body`** · **`-border`** · **`-title`** · **`-status`** | 부품을 내용대로 부르는 이름 — 부품명은 실체를 가리지 않는다 |

`program → view → tab` 은 고정 사슬이다: program(메뉴 항목)이 view(표면 종류)를 열고,
열린 인스턴스가 tab 이다. 셋 다 홀로 서고 서로 다른 것을 가리킨다.

레일 투영은 자연 키(`project|ref|viewId` 합성)를 쓴다 — 그 정체성은 순수 파생
(`instanceKey`, 해소 때마다 재계산)이므로 id 를 발급하지 않는다.

## 3. 삭제된 단어와 대체표

옛 코드·문서는 한 실체에 이름을 넷까지 썼다. 시행 범위는 정직하게 적는다: CSS 게이트는
`App.css` 이름을, 어휘 게이트는 `pane`/`panel` 식별자를 지킨다. `view`(인스턴스)·`group`
축은 노출 표면(명령·주소·CSS)에서는 개명됐지만 내부 식별자는 NAMING 이행표 아래에서
점진 이행한다 — 아직 어떤 게이트도 그 둘을 세지 않으므로, 이 표를 "게이트가 잔존 0 을
증명한다"로 읽지 마라.

| 삭제 | 옛 뜻 | 지금 |
|---|---|---|
| `panel` | 탭이 사는 칸 | **pane** |
| `group` / `egroup` | 같은 칸(state/CSS 층) | **pane** |
| `content`(실체로서) | 스페이스 | **space** (region enum 값 `content` 는 존치) |
| `pane` *(옛 뜻)* | 탭 인스턴스 | **tab** — 이제 `pane`은 터미널 칸 하나를 뜻한다 |
| `cell` | pane 의 렌더 별명 | `.pane` |
| `slot`(탭 감싸개로서) | 탭 본문 요소 | `.tab-body` — `slot` 은 레일 투영의 *파생 키 개념*(`instanceKey`)으로만 살고, 어떤 DOM 이름에서도 금지(§5-1) |
| `grid` | space 의 렌더 별명 | `.space` |
| `bodywrap` | space 본문 | `.space-body` |
| `divider` | 골 | **gutter** |
| `view` *(인스턴스 뜻)* | 탭 | **tab** (`view` 는 *종류*로 존치) |

식별자 이행표(`paneId`→`tabId` 대상 축 vs `callerTab` 호출자 문맥 축,
`$SOKSAK_PANE`→`$SOKSAK_CALLER_TAB`, …)는 `docs/NAMING.md` 에 있다.

## 4. 내부 노드에 이름이 없는 이유

배치 트리는 `leaf | { dir: row|col, sizes, children }` 이다. 내부 노드에 이름을 주려는
시도가 세 번 있었고(`split`·`container`·`frame`) 전부 명명 규칙(§5)에서 기각됐다:
`split` 은 홀로 서지 못하고(*split __view__*, *split __pane__*) 영어에서 넷을 뜻하며,
`container` 는 모든 것이 무언가를 담는 이 제품에서 "무엇을 담는?"이 남고, `frame` 은
이 저장소 전역에서 렌더 프레임을 뜻한다.

그리고 필요 자체가 반증됐다:

> **정리.** 모든 gutter 는 어떤 pane 의 right/bottom 모서리와 일치한다.
> **증명.** 노드 N(축 A)의 자식 cᵢ 와 cᵢ₊₁ 사이의 골을 잡는다. 그것은 cᵢ 의 진행방향
> 끝면과 일치한다. cᵢ 서브트리에는 그 면에 닿는 leaf 가 항상 있다: cᵢ 의 축이 A 와 같으면
> 마지막 자식으로, 수직이면 아무 자식으로 재귀하고, 재귀는 유한하다. ∎

그래서 모든 골은 `gutter/<pan-id>/<right|bottom>` 으로 지목된다(정본: 그 골에 닿는
**문서순 첫 pane**. 다른 pane 모서리는 별칭이고 응답은 항상 정본으로 에코한다.
`left|top` 도 별칭으로 받는다). 역방향은 유일하다: pane 의 서브트리가 마지막 자식이 아닌
가장 가까운 row/col 조상. 내부 노드는 내부 id(`s<n>`, 지역 카운터, 복원 시 재생성)를
유지하되 자료구조 밖 어디에도 나오지 않는다.

region 골(사이드바·레일 리사이저)도 gutter 다. 소유 축으로 지목한다:
`win/<l>/gutter/rail`(창 소유, px) · `win/<l>/proj/<id>/gutter/<left|right>`(프로젝트
소유, px). pane 골은 ratio 값이고 space 소유다 — 조작 계약이 다르고, 다르다고 말한다.

## 5. 명명 규칙

1. **노출 실체가 맨 이름을 갖는다.** 부품은 내용대로(`-body`·`-border`·`-title`·`-status`)
   또는 실체 어휘에서(`-gutter`·`-tabs`) 파생한다. **감싸개 역할 명사는 금지다** — 실체를
   별명으로 가리는 단어들: slot · cell · grid · frame · container · leaf · host · handle ·
   group · panel. (정정 2026-07-26: 초판은 접미 둘만 허용했는데 그것은 실재 부품을
   과소열거한 것이었다 — 제목 줄과 상태 줄은 감싸개가 아니라 부품이다.)
2. **이름은 홀로 서야 한다.** 복합어(*view split*)로만 완성되면 실체 이름이 될 수 없다.
   반대로, 이미 분명한 이름에 굳이 자격을 붙이지도 않는다.
3. **포함 문맥이 해소하면 자격이 불필요하다.** 주소·타입 필드는 부모를 반복하지 않고
   (`Pane.tabs` — `Pane.paneTabs` 아님), 평면 이름공간(CSS 클래스)은 자격을 붙인다
   (`.tab-body`).
4. **CSS 클래스·커스텀 프로퍼티도 스타일 대상 실체와 같은 어휘를 쓴다.** pane 요소가
   `content-*` 클래스를 달 수 없다.
5. **의미론적 정확이 익숙함을 이긴다.** `pane` 은 뒤집혀 있었다(여기서는 "탭 인스턴스",
   다른 모든 곳에서는 "칸"). 뒤집힌 채 사는 대신 본뜻을 되찾고 옛 용법을 게이트로
   강제 개명했다.

## 6. id 와 참조

- 형식: `<접두>-<base32·6>` (`[a-z2-7]`, RFC 4648 소문자). 접두 표와 유일한 발급 지점:
  `src/state/ids.ts` (`ID_PREFIX`, `issueId`).
- **범위 규칙**: 접두 id 는 레이아웃 실체 + 셸 세션에만 쓴다. 자연 키가 이미 의미를 갖는
  축은 그것을 유지한다 — `schedule`(사용자 이름), `secret`/`data.kv`(`(ns,key)`),
  `daemon`/`theme`(name), `registry`, `webview`(`b-<win>-<tab>` 파생 라벨),
  `process`(pid), `ai.session`(다른 "세션" — AI 계보). 게이트: `src/state/idScope.test.ts`.
- **참조**: 전체 경로가 원칙이고, 단일 id 도 허용한다.
  ```
  w-<uuid>/pjt-x/spc-x/pan-x/tab-x   # 원칙
  pan-x                              # 허용 — 전역 유일
  ```
  자격 경로는 해소가 아니라 **검증**이다: 불일치 → `TARGET_MISMATCH`.
  단일 id 가 둘 이상으로 풀리면 → 기존 `AMBIGUOUS` + 후보 전체 경로를
  `data.candidates` 로. 세 번째 에러 코드는 만들지 않는다.
- **답은 해소된 대상을 말한다.** 봉투가 명령이 해소한 축만큼
  `target: { window, project, space, pane, tab }` 을 싣는다. 호출에서 축의 생략은
  `target:"active"` 라는 **발화**로만 허용된다 — 침묵은 기본값이 아니다(R-B2).

## 7. 소유 경계

**좌표는 코어, 자원은 플러그인.** "이 명령의 대상 탭이 무엇인가"는 코어가 해소한다
(`ctx.tab`, 명령 단위 옵트인 `target:"tab"`) — 탭↔플러그인 귀속·활성·마운트가 코어의
자기 사실이기 때문이다. 플러그인은 그 좌표를 자기 자원(라벨·엔진 child·세션)으로
바꾼다 — 그것은 코어가 떠맡으면 안 되는 플러그인 기능이다. 헤드리스 플러그인 명령은
`target:"none"`(기본)을 선언하고 탭 해소에 막히지 않는다.

## 8. 기각된 후보 (재론 금지)

| 후보 | 기각 사유 |
|---|---|
| `win-` 접두 | 소각된 세대 — ba7c23fb 로 폐기, 재등재는 테스트가 막고(`window.rs`) capability glob 이 `w-*` 를 전제한다 |
| `wsp-`(workspace) | 창이 곧 작업공간이다. 1:1 개념에 이름을 둘 주면 모호함이 되돌아온다 |
| `split`·`container`·`frame`(실체 이름) | §4 |
| `slt-`(레일 slot id) | `instanceKey` 는 발급되지 않는 순수 파생이고 `degraded` 는 키 자체가 없다 |
| `div-` | 골의 축약으로 읽히고 HTML `div` 와 충돌한다 |
| 축별 접두 id(schedule 등) | 자연 키가 의미를 갖는다 — 불투명 id 는 후퇴다(C2) |

## 9. 시행

게이트 여덟이 이 표준을 지킨다(각 파일 머리말에 규칙·RED 근거·수를 만든 질의가 있다):

`src/state/ids.test.ts` · `src/state/idScope.test.ts` ·
`src/state/vocabulary.test.ts` · `src/state/paneInvariant.test.ts` ·
`src/ui/cssVocabulary.test.ts` · `src/ui/domVocabulary.test.ts` ·
`src/commands/targetEcho.test.ts` ·
`src/commands/noArbitraryWait.test.ts` · `src/commands/noAlias.test.ts`

금지 형태소 목록의 소유자는 `@soksak-ai/plugin-spec`(`identityVocabulary.ts` —
`BANNED_DOM_MORPHEMES`·`bannedDomName`)이다: §3+§5-1 전량을 토큰 판정으로 시행해
변형이 빠져나가지 못한다. 코어 게이트가 이것을 소비하고, 발행 게이트(doctor)와
플러그인 conformance 가 같은 함수를 소비한다 — 코어가 정리한 것을 플러그인이 다시
오염시키지 못한다(목록이 아니라 규칙).

외부 코드가 소유한 이름은 이 어휘의 대상이 아니다. 라이브러리가 스스로 발행하는
DOM 이름(Tailwind 의 `grid`/`grid-cols-N` 유틸리티, cmdk 의 `cmdk-*` 클래스,
shadcn/ui 의 `data-slot`)은 우리가 개명할 수 없고, 이름을 금지하면 그 생태계를
통째로 금지하는 것이 된다. 같은 스펙 모듈의 `EXTERNAL_DOM_NAMES` 가 정확히 그
이름들만 기록한다 — 소유자를 명시하고, 패턴은 그 라이브러리의 실물 문법만 덮는다
(넓은 접두사 개방 금지). 이 표는 면제 창구가 아니라 소유권 기록이다: 우리 실체의
별칭이 되는 이름은 누가 발행하든 등재될 수 없다(§8 — 재론 금지).
