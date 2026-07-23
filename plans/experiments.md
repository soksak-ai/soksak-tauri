# 실험 대장 — 비교 스위치 추적

되돌릴 수 있는 개선 규율(2026-07-23 결정)의 대장이다. 시각·행동 개선은 라이브 스위치 뒤에
넣어 앱에서 즉석 비교하고, 결정이 나면 **채택안만 남기고 진 variant·스위치·전용 테스트를
폐기 커밋으로 소거**한다. 이 문서는 살아있는 스위치의 단일 목록이며, 항목이 0이면 실험도 0이다.

| 항목 | 스위치 | 안 | 상태 | 소거 조건 |
|---|---|---|---|---|
| 레일-패널 관계면 표현 | `settings.railRelation` (`sok settings.set '{"key":"railRelation","value":…}'`) | `stroke`(기본 — 사용자 확정: 아웃라인+라벨) / `tint`(바닥 틴트만) / `moment`(재결부 순간 600ms 스트로크 플래시) | **비교중** (main 6506a9a0) | 사용자 채택 결정 시 — 채택안을 무스위치 기본으로 고정하고 railRelation 축·모드 CSS 갈래·relation 테스트 파일 소거 |
| 레일 시각 모드 | `settings.railLook` | `ground`(기본: 바닥 크롬) / `pane`(카드) | **비교중** (main 86688bae — 디자인 정본은 ground) | 사용자 채택 결정 시 — 동일 규율 |

폐기(소거 완료) 항목은 이 표에서 지우고 git 이력만 남긴다.

## railFill — 결부 바탕 2안 (2026-07-23, **결정: faint(1%) 기본·정식 승격**)

사용자 요청: "연결된 화면의 바탕색을 ① 빼보자 ② 아주 옅게만 넣자".

- 스위치: `sok settings.set '{"railFill":"none"}'`(기본, 1안) | `'{"railFill":"faint"}'`(2안, 액센트 1% — 사용자 하향 판정 3%→1%)
- 적용 범위: relation-stroke 안의 fill 만. tint/moment 갈래 불간섭.
- 결정 시: 채택안만 남기고 축·CSS 갈래·테스트 갈래 소거(settings.railFill, App.css fill-none/faint).

## focusDim — 포커스 스포트라이트 (2026-07-23, **결정: on 기본·정식 승격**)

사용자 개념: "전체를 흐리게 하고 선택된 것만 명확하게".

- 스위치: `sok settings.set '{"key":"focusDim","value":true}'` | `false`(기본)
- 표현: 비활성 셀·본문 슬롯 brightness(.93)+saturate(.85), 활성만 filter:none, 전이 160ms(어둠이 옮겨감). blur 금지(텍스트 가독).
- 캐비앳: 네이티브 child(브라우저·astryx)는 1단계 대상 밖 — 채택 시 2단계(엔진 협조 dim) 별도 레인.
- 결정 시: 채택안 고정 후 focusDim 축·CSS 갈래·테스트 갈래 소거.

## focusDim 2단계 — 네이티브 표면 셰이드 (2026-07-23, 완결)

사용자 지시: 정공법. offscreen(CEF)·웹뷰 child·astryx 전부 지원, 꼼수 금지.

**채택 설계(레이어 역전 발견으로 CALayer 안 폐기)**: 이 앱은 DOM 이 항상 최상위이고 엔진·child
웹뷰는 메인 웹뷰 **아래**에서 투명 홀로 비친다(lower_below_main). 따라서 contentView CALayer 안은
DOM 크롬까지 덮는 오답이고, 정공법 = **홀 위의 DOM 슬롯에 반투명 셰이드 배경**:
`.egroup-area[data-focus-dim] .egroup-body-slot { background: color-mix(#000 7%) }` + spot-clear 해제.
아래의 모든 네이티브 표면(CEF·웹뷰 child·astryx·미래 엔진)이 한 규칙으로 균일 dim, DOM 뷰는 자기
불투명 배경 뒤라 이중 적용 없음, 배경은 이벤트를 안 막아 클릭 관통 보장, Rust·재시작 불요(HMR).

## railSeamStyle — 봉합 표시 2안 (2026-07-23, **결정: edge 기본**)

사용자 질문: "점선이 사이드바(접합부)에 있는 게 맞나, 오른쪽 실선을 점선으로 바꾸는 게 맞나".

- 스위치: `sok settings.set '{"key":"railSeamStyle","value":"seam"}'`(A안·기본 — 내부 공유변 점선) | `"edge"`(B안 — 바깥 오른쪽 변만 점선, 외곽선 분리 렌더)
- 두께는 두 안 모두 관계 스트로크와 동일(사용자 확정).
- 결정(2026-07-23): B안(edge) 채택 → 기본값. 사용자 판단으로 축은 소거하지 않고 **정식 설정으로 승격**(seam 선택지 유지).

## 종결 원칙 (2026-07-23, 사용자 확정)

"지금이 기본, 나머지는 옵션" — 현행 라이브 상태(focusDim on·railFill faint·railRelation stroke·railSeamStyle edge·railFocusNear on)를 기본값으로 확정하고, 모든 비교 축은 소거 대신 **정식 설정으로 승격**해 선택지를 유지한다.
