# 네이티브 콘텐츠 표면

이 문서는 메인 DOM 밖에서 그려지는 콘텐츠의 현재 계약이다.

## 1. 제품 슬롯 하나, 프레임워크가 배치 소유

브라우저 제품은 공개 슬롯 하나만 선언한다.

```html
<div data-content-view-body="<label>"></div>
```

플러그인은 브라우저 크롬·탐색·슬롯 선언을 소유한다. 외부 엔진 제공자는 자기 엔진의 bounds
명령도 소유하지만 프레임워크 배치 거래·z-order·클리핑·가시성 합성·프레임워크 판정은 소유하지 않는다.

- Electron은 `<webview>`를 슬롯의 직접 자식으로 붙인다. 일반 DOM 레이아웃을 따르며 bounds
  observer·기하 거래·veil·추종 루프를 설치하지 않는다.
  플러그인 native-presentation host도 등록하지 않는다. `nativeSurface`는 선택된 어댑터가 공개
  host를 등록했을 때만 `PaneSurfaceHost`로 들어가며 Electron의 등록부는 비어 있다. 일반 DOM
  요소의 평범한 stacking은 쓸 수 있지만 AppKit/native z-order 거래는 실행하지 않는다.
- Tauri는 OS 자식 웹뷰를 만든다. Tauri 어댑터가 슬롯 rect를 읽고 child frame·가시성 장부·
  입력 브릿지·overlay 순서·진단면을 소유한다.
- Tauri의 windowed 외부 엔진도 같은 슬롯을 선언하고 공개 DOM 거래
  `soksak:external-surface-layout-transition`을 동기 claim한다. Tauri가 snap을 선택하고 커밋된
  최종 슬롯 rect를 읽어 제공자의 bounds ACK를 기다린다. 제공자는 거래 동안 일반 사건 기반
  follower를 잠그며 CSS 중간 frame을 따라가지 않는다.

공개 플러그인 identity는 `soksak-plugin-browser-native` 하나다. 중립 명칭으로 바꾸려면 세션·의존·
명령 namespace migration이 먼저 있어야 한다.

이 경계는 두 번 시행한다. 소스 계약은 Electron 어댑터의 native follow·hole·veil·pane-host
소유를 금지한다. 빌드 산출물 게이트는 `dist/electron`에서 Tauri SDK·pane 명령·native bounds
거래·hole 표식·AppKit ordering·external-surface transition을 거부한다. 소스 파일이 올바른
폴더에 있다는 사실만으로 번들 격리를 증명했다고 판정하지 않는다.

## 2. Tauri 레이어링

브라우저 child는 메인 웹뷰 앞의 안정된 네이티브 경계에 고정한다. 일반 레이아웃 이동은 bounds만
바꾸며 모션의 일부로 child를 올렸다 내리지 않는다.

DOM overlay는 별도 명시 상태다. 모달·메뉴가 네이티브 콘텐츠를 덮어야 할 때만 Tauri overlay
gate가 child를 뒤로 내리고, 짝이 되는 종료 사건에서 다시 올린다. 좌표나 타이머로 추론하지 않는다.

외부 엔진 컨테이너도 메인 웹뷰 앞의 같은 안정 경계에 선다. 컨테이너의 빈 영역은
`hitTest=nil`이고, DOM 입력 포워딩을 쓰는 offscreen 표면도 `hitTest=nil`이다. 따라서 픽셀은
DOM 위에서 보이되 입력은 공개 슬롯 DOM이 소유한다. 제품 표시 경로는 네이티브 표면 하나뿐이며
frame stream을 DOM 이미지로 복제하지 않는다. overlay gate만 컨테이너 전체를 명시적으로 내리고 올린다.

포커스 조명의 단일 제품 사실은 각 탭 본문의 공개 `--dim` 값이다. 코어는 콘텐츠 트리 밖의 SVG
평면 하나로 모든 표면을 어둡게 하며, 콘텐츠 조상에 `filter`나 `opacity`를 걸지 않는다. 프레임워크
어댑터는 별도 조명 observer·IPC·네이티브 veil을 설치하지 않는다. 같은 0.5 감광을 DOM 평면과
네이티브 평면에서 두 번 적용하면 실제 픽셀은 0.25가 되므로 중복 조명은 계약 위반이다.

투명 DOM 픽셀과 `set_ignore_cursor_events`는 브라우저 임베딩 방식이 아니다. 그것들은 데스크톱
클릭스루 창의 창 전체 API라 슬롯 단위 합성 계약을 만들 수 없다.

## 3. Bounds 계약

중첩된 `data-content-view-body` rect가 유일한 기하 원천이다. 바깥 tab·pane·rail·시각 홀 표식은
대체 bounds가 아니다.

1. `surfaceRectOf`로 분수 경계를 접는다: left/top은 ceil, right/bottom은 floor.
2. 위치 변화는 커밋된 `layout.reflow` 사건으로 받는다.
3. 크기 변화는 `ResizeObserver`로 받는다.
4. label별 쓰기를 직렬화하고 대기 사건은 최신 rect 한 번으로 합친다.
5. 같은 rect는 보내지 않는다.
6. 위치와 크기를 네이티브 frame 거래 한 번으로 적용한다.
7. 숨은 표면에는 우연한 bounds를 쓰지 않는다. 복귀 때 떨어진 child를 필요하면 복원하고 최신
   rect를 적용한 뒤 포커스를 훔치지 않고 보인다.

폴링·포인터 예측·무한 rAF 추종은 없다.

## 4. 레일 재배치

Electron은 일반 DOM 모션을 유지하고 플러그인 provider를 메인 문서에 마운트한다. Tauri는 창
루트에서만 만나는 메인 renderer pane과 native child를 원자적으로 제출할 수 없으므로, 어댑터가
같은 provider source를 pane renderer에 정확히 한 번 마운트하고 native member와 함께 하나의
`PaneSurfaceHost` 아래에 둔다.

- 플러그인과 코어는 공개 `PluginViewPresentationHost`로만 갈린다. 프레임워크 이름 분기는 없고,
  Electron은 host를 등록하지 않아 기존 직접 DOM 경로만 쓴다.
- Tauri pane renderer는 모든 공개 슬롯과 chrome node를 보고한다. 메인 문서는 발견·감사용 주소와
  frame을 투영할 뿐 두 번째 플러그인 UI를 그리지 않는다.
- pane 소유권에는 서로 다른 두 정체성이 있다. `logicalPaneId`는 workspace 레이아웃 pane(`pan-*`)이고,
  `nativeHostId`는 어댑터가 소유한 AppKit `PaneSurfaceHost` registry key다.
  `PluginViewPresentationHost`는 레이아웃 소유자에게서 logical id를 직접 받고 플러그인이나 native
  surface를 재생성하지 않은 채 이 결부를 갱신한다. `PluginViewContext.paneId`는 호출자/터미널 결부
  축이므로 레이아웃 정체성을 대신할 수 없다. `webview.pane.hosts`는 두 id와 `viewId`를 각각 노출하고
  모호한 `pane` 별칭을 노출하지 않는다. presentation trace는 window/view/logical-pane/member를 정확히
  하나로 결합한 뒤 반환된 `nativeHostId`로 native capture를 무장하며 framework label 파싱은 금지한다.
- pane renderer의 플러그인 API는 `commands.execute`만 제공한다. 창 단위 command 등록과 표면
  원장 reconcile은 실제 registrar를 가진 workspace runtime 한 곳의 책임이다. child에 무동작
  `commands.register`를 가장하거나 renderer-local 원장으로 창 전체 표면을 회수하면 형제 pane을
  고아로 오판하므로 금지한다.
- renderer와 native member는 pane-local frame을 유지한다. 레일 재배치는 부모
  `PaneSurfaceHost` frame 하나만 바꾸므로 모든 보이는 child가 같은 presentation 거래를 상속한다.
- `PaneSurfaceHost`의 renderer/member host와 그 실제 child는 부모의 폭·높이 autoresize를 같은
  AppKit epoch에 상속한다. 후행 DOM/engine bounds는 같은 값의 최종 ACK이며 별도 추종자가 아니다.
  pane에서 분리되는 즉시 standalone 표면의 명시 bounds 소유권(`autoresizingMask=0`)으로 되돌린다.
- 창·pane resize는 선언된 affine viewport 계약으로 host와 local member를 다시 계산한다. 옛 픽셀을
  늘리거나 follower loop를 돌리지 않는다.
- 적대적 resize는 두 유한 위상을 검증한다. 요청한 각 native 크기는 저장된 affine host/member
  계약과 즉시 일치해야 하고, 마지막 resize-settled 사건 뒤에는 실제 projection DOM과 native가
  일치해야 한다. 중간 renderer paint는 병합될 수 있으며 시각 진단이지 요청마다 꾸며 낸 DOM
  commit이 아니다.
- `webview.pane.composition`은 투영 pane/native host/member의 일대일, 반올림 오차만의 좌표 차이,
  `rendererTopology.panelAtomicMotion=true`를 함께 요구한다.
- 메인 문서의 layout settle은 child renderer settle을 뜻하지 않는다. slot 보고와 그 frame의 native
  member 적용 ACK는 별도 상태다. `webview.pane.composition.wait`은 현재 host DOM frame을 먼저
  커밋하고, 정확히 그 child viewport에 속한 native member commit 사건을 기다린 뒤 동일한 엄격
  판정을 수행한다. 이전 viewport의 늦은 commit은 배리어를 해제하지 못한다. 유한
  `settleTimeoutMs`는 실패 경계일 뿐 polling이 아니며, `timeoutMs`는 명령 전송 응답 제한이라는
  예약 의미를 유지한다.
  비전면 WKWebView가 `ResizeObserver`와 `resize`를 지연할 수 있으므로 부모는 이 경계에서
  `measure` 사건을 정확히 한 번 보낸다. child는 기존 slot reporter 하나를 실행하며 별도 좌표
  경로나 follower loop를 만들지 않는다.

스크린샷·PNG 스탠드인·모션 스탠드인·Core Animation 복제·veil·두 rAF handoff·프레임별 bounds
루프는 금지한다. 독립 renderer 둘의 제출을 타이밍으로 맞추는 구현도 금지한다. 이들은 공통 표시
소유자를 만들지 못하고 같은 결함을 확률적으로 감춘다.

모든 direct surface host와 그룹화한 `PaneSurfaceHost`는 main DOM WKWebView 바로 아래의 AppKit
형제다. DOM의 투명 content hole은 아래 surface를 드러내고, 불투명 chrome(레일 + 버튼, 우측
overlay sidebar, 메뉴, modal)은 자연스럽게 그 위에 남는다. 그룹화도 이 순서를 보존해야 하며,
pane을 DOM 위에 append하는 일반 `addSubview`는 금지한다.
`webview.pane.composition`은 실제 형제 순서를 `chromeAboveHost`로 노출한다. 선언이나 class 이름
추측은 증거가 아니다. rail과 browser는 정상 배치에서 겹치지 않으므로 rail 게이트는 이 전역 형제
순서와 `rail/add` 내부 DOM hit를 사용한다. 우측 sidebar와 modal은 live surface와 실제로 겹치므로
양의 교집합 내부 hit까지 추가로 요구한다. 두 사실 모두 게이트 영수증에 실린다. 형제 순서는 surface의
`chromeAboveHost`로, DOM 쪽은 `ui.hit`의 `owners`(그 점의 선언 소유자 사슬, 최상단 먼저)로 싣는다.
소비자는 `dataset`·`host`·`painters`를 자기 규칙으로 이어붙이지 않고, 기대한 소유자를 영수증에
적어 넣지도 않는다. 하니스가 적은 소유자나 순서는 실패할 수 없다. 두 사실의 위반은 던지지 않고
증거로 기록해 판정한다. 던진 위반은 실행을 blocked로 만들고 보고서에서 이름을 지운다.

그 점의 소유는 사슬 포함이 답한다. 주소 접두사로 읽지 않는다. 사슬은 조상 경로이므로 chrome 표면이
그 점을 소유했다는 것과 사슬이 그것을 담는다는 것은 같은 말이고, 그보다 위의 항목은 전부 그것의
자손이다. 주소는 어느 방향으로도 포함을 증명하지 못한다. `sidebar/right/resizer`는 `sidebar/right`의
DOM 형제이고, 사이드바 안에 마운트한 플러그인 뷰는 자기 이름공간의 노드 id를 선언한다. 플러그인은
코어가 자기 뷰를 어느 자리에 붙였는지 모르고, 알면 그것이 강결합이다. target 위에 남을 수 있는 것은
target의 자손 chrome뿐이며, 사이에 낀 native surface는 사슬이 target을 담아도 위반이다.
`ui.measure`의 `occlusion.reachable`은 노드 중심에서 같은 질문에 답하며, 플러그인 뷰가 shadow root
안에 마운트되므로 히트테스트가 내려간 그대로 shadow 경계를 관통해 포함을 읽는다.

overlay 검증은 전체 창 backdrop만이 아니라 실제 보이는 overlay 표면을 지정한다. modal card는
`modal/project-new/card`로 노출하고 card/native-slot 교집합 안에 probe를 둔다. 우측 sidebar도
sidebar/native-slot 교집합 안에 probe를 둔다. 두 교집합과 probe 좌표를 PNG 옆의 수치 증거로
기록하며, 겹치지 않는 임의 marker로는 GREEN을 만들 수 없다.

## 5. 가시성과 입력

가시성은 Tauri 콘텐츠 뷰 어댑터의 명시 상태다. bounds는 show/hide를 뜻하지 않는다.
`webview.composition`은 숨은 DOM 슬롯과 숨은 네이티브 표면을 대조하며 zero rect로 추측하지 않는다.

네이티브 child 입력은 메인 DOM에 오지 않는다. Tauri 어댑터는 divider 같은 공통 host UI에 필요한
최소 사건만 브릿지할 수 있다. 이 브릿지는 Tauri 전용이고 멱등 검증용 command/status를 노출한다.
Electron은 DOM 경로를 그대로 쓴다.

offscreen 엔진은 예외적으로 표시 NSView가 입력을 받지 않고 공개 슬롯 DOM의 사건을 엔진 프로토콜로
전달한다. 이는 표시 복제가 아니라 하나의 네이티브 픽셀 소유자와 하나의 DOM 입력 소유자를 분리한 계약이다.

포커스 조명의 제품 사실은 각 pane의 공개 `--dim` 하나이고 표시 장치는 메인 문서의 콘텐츠 밖
SVG 평면 하나다. Tauri와 Electron 어댑터 모두 `--dim` observer, 조명 IPC,
`PaneSurfaceHost`/member alpha 조절, 별도 veil을 설치하지 않는다. 어댑터가 공개하는 presentation
alpha는 항상 1이며 감광은 SVG 평면에서 정확히 한 번만 일어난다.

제품에 보이는 차이는 공개 capability다.

| Capability | Tauri 시스템 웹뷰 | Electron 웹뷰 |
| --- | ---: | ---: |
| `supportsDocumentStart` | true | false |
| `supportsInputInjection` | false | true |

합성 구현 세부는 capability가 아니며 제품 분기로 새면 안 된다.

## 6. 검증

완료에는 다음이 모두 필요하다.

- 어댑터 소유권·사건 기반 추종·목표 bounds 1회·모션 중 z-order handoff 0을 RED→GREEN 단위
  테스트로 증명한다.
- `webview.composition`으로 보이는 슬롯과 live native frame이 공통 반올림 규칙 안에서 일대일인지 본다.
- 레일 재배치는 투영 DOM 전환 trace, native presentation trace, 최종 slot/native 좌표와
  shared renderer topology를 한 수치 시나리오에서 모두 통과해야 한다.
- DOM 전환 trace는 자극 전에 start ACK로 무장하고, journal의 같은 transaction DOM-commit
  callback에서 읽은 raw rect만 판정에 쓴다. timer-nearest 표본·보간·이동량 투영은 금지한다.
- native presentation trace의 사건은 각 어댑터가 실제 compositor/display callback에서 발행한다.
  owner identity·generation·revision·시각·lifecycle을 공개하며 코어는 그 인터페이스만 소비한다.
  DOM/status/PNG/녹화/stats로 사건을 추론하거나 hold를 polling으로 채우지 않는다.
- presentation 영수증이 신고한 위반 수는 그 영수증의 사건만으로 되찾을 수 있어야 한다. 그래서
  한 축을 아예 재지 않는 어댑터가 그 축에 0을 답할 수 없다. close 명령이 되찾을 수 있는 하한을
  다시 세어 `selfAudit`으로 싣는다. 영수증 자신의 표시 epoch가 증명하는 값보다 신고가 작으면 그
  사실이 이름으로 실리고, 부르는 쪽은 묻지 않아도 그 사실을 읽는다. 표시 건너뜀은 직전 프레임이
  스스로 실어 보낸 다음 표시 시각으로 판정한다. 주사율이 프레임마다 달라지므로 고정 주기로
  나누지 않는다.
- 자극과 표면 사이의 인과는 시각 근접이 아니라 선언한 id와 코어 영수증으로 잇는다. 자극이 답한
  epoch, 그 자극이 연 배치 거래가 싣고 있는 `causeTraceId`, 정착 영수증의 정착 epoch와 표면 주인의
  확인 여부를 결합한다. 호출자가 자기 시계로 정착 시각을 대신 찍거나 프레임 번호로 자극을 되짚지 않는다.
- 적대적 창 resize 검증의 기준선은 같은 명령이 첫 크기를 요청하기 전에 같은 관측자에게서 읽은
  resize 이전 관측이다. 요청한 크기에서 기준선을 만들지 않는다. 관측자가 아직 답할 수 없으면 그
  사실은 사유를 남긴 거절이지 0도 요청값도 아니며, 거절이 유한 resize 거래를 취소하지 않는다.
- 동일 구간은 반드시 녹화하고 사람이 직접 본다. 다만 PNG/녹화 해독은 E2E의
  성공·실패 판정이 아니다. 화면에서 발견한 결함은 거래 ID·phase·좌표·시계 불변식으로
  옮겨 같은 기준의 수치 RED→GREEN을 만든다.
- `window.pixels`로 활성/비활성 콘텐츠의 실제 휘도 비가 선언한 `--dim`과 일치하는지 보고,
  `webview.surfaces`에 per-surface 조명 상태가 없음을 확인한다.
- 시스템 웹뷰·windowed Chromium·offscreen Chromium을 같은 로컬 문서로 열고 실제 입력 경로로
  한글을 커밋한 뒤, 노출된 양 탭 주소를 6회 교차 클릭하며 포커스 없이 전이마다 48프레임을 찍는
  재사용 matrix를 둔다.
- 모든 녹화 자극은 recorder가 기준 프레임 기록 완료 사건을 보낸 뒤에만 시작한다. record Promise를
  호출한 사실은 캡처 준비가 아니며 추정 lead 지연은 경계가 아니다.
- PNG 열을 직접 보고 검은 프레임·가느다란 잔여 띠·떨어진 페이지·착지 뒤 표면 소실이 없는지 확인한다.
- Electron 빌드와 테스트에서 Tauri observer·IPC·native 조명·z-order·기하 거래가 설치되지 않음을 증명한다.

`window.snapshot`과 `window.record`가 시각 정본이다. DOM 상태만으로 네이티브 child가 실제로
그려졌다고 증명할 수 없다.

## 네이티브 표면에 넣는 포인터 입력

표면은 투영이 **선언한** 것으로 지목한다 — 콘텐츠 표면 자신은 `data-surface`, 자식 renderer 안의
노드는 `data-realm`. 주소 글자 모양으로 추측하지 않는다. 게스처 명령은 **한 게스처의 모든 단계를 한
호출 안에서** 보낸다. 단계를 부르는 쪽이 이어 붙이게 두면 그 간격을 CLI 왕복이 정하고, 왕복은
더블클릭 간격보다 길어서 두 번 누름이 별개의 단발 클릭 둘이 된다.

계약은 자리뿐 아니라 **무엇이 일어났는지**를 나른다: `down`·`up`·`move`·`drag`·`enter`·`exit`,
어느 버튼인지, 든 수가 몇인지. `drag`는 `move`가 아니다 — 버튼이 눌린 채의 이동은 OS가 내는 다른
사건이고, 그것을 이동으로 보내면 페이지가 받는 `buttons`가 0이라 눌림을 보는 코드가 아무 일도 안 한다.

주입한 포인터에 대한 두 가지는 엔진의 규칙이지 결함이 아니다.

- `MouseEvent.buttons`는 항상 `0`이다. macOS가 그 값을 실제 물리 마우스에서 읽고, 바꾸려면 진짜
  커서를 움직여야 한다.
- **시스템 웹뷰에는 hover를 넣을 수 없다.** 실측 2026-08-08: 다섯 가지 배달이 각각 0회였다 —
  뷰의 `mouseMoved:` 직접 호출, 창의 `sendEvent:`, 창에 붙여 지은 NSEvent, `mouseEntered:`와
  `mouseMoved:` 짝, 그리고 이 프로세스 큐로 넣는 `CGEventPostToPid`. 조건은 전부 만족시켰다(숨김
  아님, `visibleRect` 전체, 창이 key, 그 자리에서 맨 위, 이 뷰가 입력 responder). 누름·뗌·끌기는
  같은 통로로 전부 도착한다. 엔진의 hover는 실제 포인터 스트림에서만 갱신되고, 그 스트림을 만들려면
  기계 앞 사람의 커서를 빼앗아야 한다. 그래서 성공으로 답하지 않고 이름으로 거절한다. 거기서
  hover를 만드는 것은 누름이다 — 클릭 한 번이 `mouseover`·`mouseenter`·`pointerover`를 함께 낸다.

`ui.input.state`는 그 표면이 지금 무엇을 받을 수 있는지 답하고, 자리마다 다른 조건이 있어서 좌표를
받는다. 입력 명령이 성공이라 답했는데 아무 일도 안 일어나면 그것부터 묻는다.

## 조합 입력(IME)

확정 문자열을 넣는 것은 조합 상태를 지나지 않으므로 그 경로를 증명하지 못한다. 한글·일본어·중국어는
확정 전에 그 상태를 지난다 — 페이지는 `compositionstart`·`compositionupdate` 를 받고, 아직 값이 아닌
글자를 보여 주며, 백스페이스는 글자가 아니라 자모를 지운다.

`ui.input.compose` 가 조합 중 글자를 세우고, `text` 없이 같은 명령을 부르면 조합을 끝낸다 — 사람이
스페이스·엔터로 끝내는 그 자리다. 열어 두면 다음 입력이 그 위에 얹힌다.

실측 2026-08-08, 시스템 웹뷰에서 `ㅎ` → `하` → `한` 을 넣고 끝냈을 때:

```
compositionstart → compositionupdate:ㅎ → compositionupdate:하 → compositionupdate:한
                 → compositionend:한     값: "한"
```

각 단계는 `beforeinput` 과 `input` 도 함께 냈다 — 사람이 IME 로 칠 때 나는 것과 같다. DOM 값 대입이
아니라 AppKit 텍스트 입력자를 지난다.

## 표면의 입력은 그 표면의 주인이 배달한다

프레임워크가 쥔 표면에만 포인터가 들어갔다. 콘텐츠를 엔진 사이드카가 그리는 뷰는 "webview 없음"
으로 거절됐다 — 실측 2026-08-08: 브라우저 세 종 중 시스템 웹뷰 하나만 클릭·더블클릭·끌기가 됐고,
사람에게는 브라우저마다 되는 것이 다른 것으로 보였다.

코어는 그 엔진들을 알지 않는다. 누가 주인인지 묻고, 주인이 스스로 답한다:
`app.provideSurfaceInput({ owns, sendInput, inputState })`. 주인 판정은 **지금 살아 있는 뷰의
라벨과 대조**해서 하고, 라벨 모양으로 추측하지 않는다 — 접두사 규칙은 뷰가 사라진 뒤에도 자기
것이라 답하고 그 배달은 조용히 사라진다. 두 주인이 같은 표면을 주장하면 하나를 고르지 않고
그 사실을 던진다.

주입한 이동을 받는 엔진에서는 hover 도 된다 — 시스템 웹뷰와 다르다.

## 키보드는 창이 포커스를 쥐어야 닿는다

키는 엔진의 제 경로로 간다: 이름 있는 키(Enter·Escape·화살표)는 사람이 칠 때 AppKit 이 보내는
명령으로, 글자는 텍스트 입력자로.

그런데 **그 창이 키보드 포커스를 쥐고 있지 않으면** 아무것도 도착하지 않는다. 실측 2026-08-08:
창이 키가 아니면 문서의 `hasFocus()` 가 거짓이고 페이지는 아무것도 못 받는데, 부름은 성공을
답하고 있었다. 그 상태에서 `ui.input.key` 와 `ui.input.compose` 는 이름으로 거절한다.

`window.focus` 가 `key` 를 함께 답하는 이유도 같다 — 다른 앱이 활성이면 창을 앞으로 올려도
키보드는 안 온다. 요청이 성공한 것과 포커스가 온 것은 다른 사실이고, 뒤따르는 키보드 명령은
전부 두 번째에 달려 있다.

## 메시지는 무엇을 하라는 말이어야 한다

옛 거절 문장은 이랬다: "이 노드는 다른 realm 의 투영입니다 — 호스트에 꽂은 사건은 그 안에 닿지
않습니다". 대신 무엇을 부를지 알고 싶었던 사람에게 우리 내부 구조를 설명한 것이다. 명령 카탈로그의
모든 `message:` 에 두 규칙을 게이트로 세웠다: 내부 어휘(realm·투영·renderer)를 쓰지 않는다,
그리고 할 수 없다고만 말하고 끝내지 않는다.
