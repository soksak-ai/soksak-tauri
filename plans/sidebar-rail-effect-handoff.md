# 좌 레일 이동 효과 — 핸드오프 (2026-07-22)

**상태: 미완.** 사용자 최종 판정 = "전혀 자연스럽지 않음". 이 문서는 다음 세션이 이어받기 위한
전체 상태 기록이다. 상위 결정 기록: `plans/sidebar-projection-spec.md` §12, 킷 플랜:
`plans/sidebar-template-kit.md`.

## 1. 목표 (사용자 확정 스펙)

**디자인 정본** = claude.ai/design 프로젝트 "AI 시대 IDE 혁신 설계"
(projectId `9e4c45db-c1f6-4c79-b625-34cd24154186`)의 **`SOKSAK Reorganized.dc.html`** —
DesignSync 도구(`get_file`)로 읽는다. 목업이 곧 기준이다.

핵심 요구(사용자 문장 그대로의 취지):
1. 사이드바 = 책상 바닥의 크롬(SIDEBAR=CHROME). 카드가 아니다. 패널들만 흰 카드로 떠 있다.
2. 이동은 hide→show 연출이 아니라 **실좌표 주행**이다. A→B로 실제로 이동하는 걸 눈으로 본다.
3. 이동 중 사이드바는 **카드 아래로** 지나간다(위로 뜨면 안 됨).
4. 이동 중 **절대 사라지지 않는다** — 복도(pane 그리드)가 함께 미끄러져 이동 내내 보인다.
5. 내용 교체는 **출발할 때부터** 자연스럽게(스르륵) 진행된다. 지연 후 교체 금지.
   (이전 지시 "반을 지날 때 변경"은 "출발부터 디졸브 시작, 교차점이 중간"으로 정련됨)
6. 헤더: 승인된 형태만 — pane 그리드 행 정합(테마별 `--header-h`+`--pane-inset`), 드래그
   아이콘 없음(헤더 전체가 드래그 손잡이), 임의 타이포 변경 금지(한 번 사고 남 — 즉시 원복했음).

목업의 이동 기하(참고): 사이드바 폭 246px 고정, 패널 x = `(100%-246px)*v% + (v>=sbx ? 246px : 0)`
— 즉 **레일 우측의 패널들만 +246px 강체 시프트**하고, 사이드바·패널 전부가 같은
`transition: left .28s cubic-bezier(.4,0,.2,1)`로 한 몸처럼 리플로우한다. 스테이션(sbx) =
포커스 패널 좌측의 클린 세로선(우리 `effectiveRailStation`과 동일 규칙).

## 2. 현재 구현 상태 (main `29dbc073` 기준, 전부 dev 앱 반영됨)

- 좌 레일 = 투영 전용(핀 축 폐지, `ui.projection.pin` 양측 거부), 배정표 = spec §11.
- 프레임 헤더: `--header-h`/`--pane-inset` 주입(GroupArea 상수 단일진실, cssContract R1c 게이트),
  그립 아이콘 제거, 헤더 전체 = 스테이션 드래그(App.tsx `.sidebar` onMouseDown 위임, 버튼 제외).
- railLook: `ground`(기본, 틴트·그림자·자기 세로선 없음 — `railEdgeWidths`) | `pane`, 토글 =
  좌측 첫 슬롯 헤더(`projection/left/look`), 설정 `railLook` 영속.
- 주행: `.sidebar { transition: left 280ms cubic-bezier(.4,0,.2,1) }`, 드래그 중 `transition:none`.
- 복도 동조: ProjectPane의 주행 위상(`railTraveling`, 스테이션 변경 커밋~300ms) 동안
  `.content-body.rail-traveling` 아래 railGap 소비자 전부(egroup-cell/frame/body-slot/divider/
  drop-ind-wrap)가 같은 280ms 곡선으로 transition(cssContract "주행 동조" 게이트가 등재 강제).
- z 구조: 레일 평면 `.left-rail-plane` **z:0 고정**(카드 아래). 활성 pane의 z는
  **parkedStyle 인라인 zIndex:1이 소유**(`src/lib/layerPark.ts`) — CSS로 pane z를 덮으려는
  시도는 인라인에 진다(한 번 사고 남). 그리드 컨테이너(.content-pane/.egroup-area)는
  pointer-events:none, 실요소(cell/body-slot/divider)만 auto — 정차 레일 상호작용 보장.
- 내용 디졸브: ProjectionSlots — 교체 즉시 새 슬롯 페이드-인(280ms ease-in-out), 옛 슬롯은
  `.proj-slot.leaving` 오버레이(position:absolute, 280ms 대칭 fade-out, forwards)로 여정 동안
  겹쳐 사라짐. 교차점 50%가 이동 중간에 오도록 설계.
- 합성 입력: `ui.input.*`/fill 이벤트 `composed:true`(Shadow DOM 경계 통과 — 본문 클릭 활성화
  사슬을 E2E로 구동 가능). 본문 클릭→활성화는 GroupArea body-slot `onMouseDownCapture`에 원래
  배선되어 있음.

오늘 커밋 체인(코어): 2624c9e8(투영 전용) → 74084397(프레임·railLook) → 9d562294(실이동+킷 플랜)
→ aae64b48(주행 z·헤더 드래그) → 07cd38eb(그리드 정합·복도 동조·ground 세로선) → 689fb9e5(composed)
→ 86688bae(정본 곡선·ground 기본) → d534a126(항상-아래 1차·페이드) → 0783439e(z:0 — 인라인 z 진범)
→ eafd16a6(반환점 교체+헤더 원복+그립 제거) → 40f00c6d(크로스페이드) → 29dbc073(출발 디졸브).

## 3. 미해결 — "전혀 자연스럽지 않음"

무엇이 부자연스러운지는 **미규명**(사용자 세부 지목 전에 핸드오프 요청). 다음 세션이 검증할 가설:

1. **복도 보간의 꿀렁임(유력)**: 목업은 "레일 우측 패널 전체 +246px" 강체 시프트의 단일 축인데,
   우리는 railGap을 셀별 `--rail-dx/--rail-dw`로 분배하고 각 셀의 left/width를 **독립 CSS
   transition**으로 보간한다. A-레이아웃→B-레이아웃의 셀별 선형 보간은 중간 상태에서 복도가
   한 몸으로 이동하는 그림이 아니라 셀들이 제각각 수렴하는 그림이 된다. → **목업 기하로 재구현**
   이 정공법: GroupArea의 railGap 투영(`projectRailCssRect`/`projectRailCssSpan`/`unprojectRailX`,
   `src/components/GroupArea.tsx` 상단 import)을 "스테이션 우측 셀 전체 +railW" 강체 모델로
   바꾸면 보간 중간 상태도 항상 정합이다.
2. pane 내용의 리사이즈 지연: 터미널(xterm fit)·네이티브 웹뷰(브라우저/CEF)는 CSS transition을
   모른다 — DOM은 미끄러지는데 네이티브 표면은 점프(layout.reflow는 커밋 후 1회 스냅).
3. 디졸브 곡선/지속의 취향 문제(280ms ease-in-out 대칭).
4. 주행 위상 300ms 타이머와 transition 280ms의 어긋남(끝단 20ms 스냅).

## 4. 검증 함정 (이 세션에서 피 흘리며 배운 것 — 반드시 숙지)

- **모션 캡처**: `window.record`/`snapshot`은 가려진 창에서 애니메이션을 settle(최종 상태로
  점프, 코어 b1f43285)한다 → **창이 전면일 때만** 모션 프레임이 찍힌다. 원격 검증이 "정지
  프레임"만 보이면 창 가림부터 의심하라. 최종 판정은 사용자 눈이다.
- **구동**: `view.activate {"view":"vN"}`가 가장 확실한 재결부+주행 트리거. 본문 클릭 사슬은
  composed 픽스 후 `ui.input.click`으로 구동 가능. `panel.focus`는 상태만 바꾸고 시각 추종이
  안 따라오는 것으로 관측됨(원인 미규명 — 별건).
- **머지 규율**: 워크트리 안에서 `git merge 자기브랜치` = no-op. **머지·push는 반드시 정본
  (<machine-path>/soksak/core)에서 별도 명령으로, `git log`로 main 확인 후에만 "반영" 선언**
  (memory: feedback_merge-in-canonical-only — 같은 실수 3회).
- **z**: pane z는 parkedStyle 인라인이 소유. CSS z-index로 pane 위·아래를 조정하려면 반드시
  인라인 값(active=1, parked=0)을 기준으로 레일 쪽을 움직여라.
- dev 앱 = canonical `make dev`(HMR). 검증 CLI =
  `<machine-path>/soksak/worktrees/sidebar-projection/src-tauri/target/debug/sok-dev`,
  창 라벨 `w-d9683c0c-9d72-4a5b-9030-b729ae372b44`(재기동 시 갱신됨 — window.list로 재확인).
  `make dev`는 plugin-spec dist를 빌드하지 않는다 → 파서 어휘가 갈리면 `pnpm run build:platform`.

## 5. 권장 진행 방식

사용자가 앱을 보고 있는 상태에서 **한 축씩 바꾸고 즉시 피드백** 받는 페어링이 유일하게 유효했다.
원격 단독 판정은 모션에 무력하다. 다음 세션은 가설 1(강체 시프트 기하)부터 착수하되, 변경
전에 사용자에게 "무엇이 부자연스러운지"(패널의 꿀렁임인지 / 내용 디졸브인지 / 속도인지)를
한 번 물어 축을 좁히는 것이 낫다 — 이 지점은 재질문 금지 대상이 아니라 미규명 사실이다.

관련 파일: `src/App.tsx`(ProjectPane: railTraveling·startRailStationDrag·railEdgeWidths 소비),
`src/App.css`(주행·동조·디졸브·ground·frame), `src/components/ProjectionSlots.tsx`(슬롯·leaving),
`src/components/GroupArea.tsx`(railGap 투영·PANE_INSET/HEADER_PX), `src/state/projectionWiring.ts`
(재결부), `src/ui/cssContract.test.ts`(R1c·주행 동조 게이트), `src/ui/railEdges.ts`.
