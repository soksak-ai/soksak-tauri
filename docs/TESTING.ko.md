# 테스트

모든 repo(코어·플러그인·사이드카)에 표준 타깃 둘. repo 는 `make test-unit` / `make test-e2e`
(Makefile) 또는 동명 `npm` 스크립트로 노출한다.

## 두 타깃

- **`test-unit`** — 결정적, LLM 0, 실행 중인 앱 불요. 기계가 오프라인으로 정착하는 순수 로직·
  타입 검사. 코어: `spec-gate`(plugin-spec/plugin-api 빌드 + 헤드리스 매니페스트 게이트),
  `typecheck`(tsc), `check`(cargo check), `test`(cargo test), `test-front`(vitest). 플러그인:
  그 repo 의 vitest/cargo 스위트. 커밋 전 게이트 — 매 커밋 전에 그린이어야 한다.
- **`test-e2e`** — 실행 중인 앱을 소켓으로 구동. 멱등·자기정리: 각 하니스가 자기 창·프로젝트를
  만들고 단언하고 정리한다(사용자 워크스페이스 무접촉). identity 인자를 받는다(기본
  `IDENTITY=debug`). 코어 스위트: orchestrator·project-rail·nl-console·browser-restore·
  multiwindow·resize.

## 하니스 방법론

- **멱등 시나리오 파일, 임시 스크립트 아님.** 하니스는 깨끗이 재실행된다: 진입 시 잔재를
  청소하고, 자기 픽스처 안에서만 동작하며, 만든 것을 지운다. 재사용 하니스가 소유할 일에
  일회용 스크립트를 쓰지 않는다.
- **픽스처 루트는 `~/.soksak-e2e` 하위**, 재사용·멱등 — app 홈(`~/.soksak`·`-dev`·`-debug`)과
  분리. 상태 회수는 창 라이프사이클(teardown=window.close)로, 매번 새 임시 dir 로가 아니다.
- **스킵 말고 introspect.** "테스트 못 함"이면 그 사실을 드러내는 introspection 명령(상태 조회·
  측정)을 추가한다. "메커니즘 없음"은 핑계가 아니다 — 표면을 확장한다.
- **결정적 단언과 LLM 의존 단계를 분리.** 결정적 검사는 정확한 결과를 단언하고, LLM 호출 단계
  (에이전트 턴)는 관용 재시도하며 특정 모델 출력에 게이트하지 않는다.
- **실제 신호를 측정.** 런타임 사실을 직접 읽는다(터미널 출력=`term.read`, 실 winsize=`stty size`,
  렌더=공개 presentation 상태·사건 trace) — 정적/추론값이나 이미지 픽셀 자동 판정이 아니라.

## 브라우저 acceptance 정본: B01–B12

`browser`, `browser-chromium`, `browser-chromium-offscreen`은 적용되는 모든 기준을 같은 fixture와
같은 단언으로 통과한다. 프레임워크별 상태는 실패 원인을 설명할 수 있을 뿐 적용되는 기준을
면제하거나 완화하지 않는다. 코드 정본은 `scripts/e2e/lib/browser-gates.mjs`이며, 보고서는 항상
3개 엔진 × 12개 게이트의 36칸을 전부 포함한다. `not-applicable`은 보고서의 framework/platform
신원에서 정본 catalog가 정적으로 도출할 때만 가능하며 runtime, adapter, test가 스스로 선언할 수 없다.

`slot-freeze.mjs`는 자신이 소유한 B01–B11을 engine 실행당 각각 정확히 한 번 canonical judge에
기록한다(B12는 별도 냉시작 titlebar 실행기 소유). 주소표시줄의 현재 값은 공개 주소를 찾은 뒤
`ui.measure.value`로 읽는다. IME·wheel·full-capture도 각각 사건 원장과 명시 view/path 영수증을
그대로 mapper에 전달한다. 공개 응답에 필드가 없으면 mapper는 `null`을 보존해 RED로 판정하며,
요청값이나 PNG 픽셀에서 값을 만들어 채우지 않는다.
B03 mapper는 독립 owner 원장, `compositionKind=slot|renderer` 공개 노드, surface 영수증의
공유 `topologyPath`를 요구한다. 어느 원장도 다른 원장에서 역산하지 않는다.
B05 mapper는 click ACK의 주소·시각, layout 거래의 trace 인과관계, 실제 presentation 사건,
settled 및 유한 hold 영수증을 닫힌 schema로 결합한다. 빠진 시각이나 hold를 녹화 프레임에서 추정하지 않는다.
B06 mapper는 pane별 공개 `--dim`/level, adapter alpha, 단일 plane의 base/aperture 원장,
rail·sidebar 면제와 plane 비포함 사실을 각각 요구한다. 면제 속성 하나로 다른 값을 대신하지 않는다.

| ID | 고정 기준 | 기계 판정 근거 |
|---|---|---|
| B01 | 3종 최초 mount + 주소표시줄 + 페이지 신원 | 공개 DOM/status의 mount, address, page identity가 모두 요청값과 일치한다. |
| B02 | 한글 IME `beforeinput`/`input` 및 전환·resize 값 유지 | 두 입력 사건과 최종 value를 읽고 모든 전환·resize checkpoint에서 같은 값을 단언한다. |
| B03 | DOM slot ↔ live surface 1:1 rounding-only frame/shared topology | 공개 DOM rect·native/engine rect·identity ledger의 개수, 소유권, 좌표 차이를 단언한다. Tauri에서는 어댑터 수명주기 claim(`direct`/`pane`) 또는 중립 공개 선언 `data-external-surface=<안정적 identity>`가 있는 content 슬롯만 native hole이 된다. 선언 없는 DOM 슬롯을 hole로 추측하지 않는다. `direct`, `PaneSurfaceHost`, 외부 제공자 기하는 각 소유 판정면에서 정확히 한 번만 감사한다. Electron은 브라우저 본문이 DOM 자식이므로 이 선언을 hole로 투영하지 않는다. |
| B04 | FLOW rail·pane·native 단일 원자 이동 | ACK된 유한 trace의 initial raw rect와 같은 transaction의 정확한 DOM-commit raw rect를 실제 presentation 사건에 결합해 세 대상의 연결·좌표·정착을 단언한다. |
| B05 | flicker/black/잔상/착지 후 소실 0 | 공개 presentation trace에서 live·visible·painted 연속성과 replacement/gap/disappearance 0을 단언한다. |
| B06 | active만 밝음/inactive 감광/rail·sidebar 비감광 | 공개 style 상태에서 단일 lighting plane의 base·active aperture, pane별 dim, rail·sidebar의 plane 비포함, 프레임워크 adapter alpha 1(중복 감광 없음)을 단언한다. |
| B07 | PIN 좌·우 인접·분리 border/레이아웃 불변 | 세 focus 상태의 border 관계와 rail/pane DOM identity·rect·split tree 불변을 단언한다. |
| B08 | PIN 양방향 maximize/restore/station 불변 | 좌·우 각각 maximize/restore 전후 방향·split·station의 완전 동일성을 단언한다. |
| B09 | rail `+`/우측 sidebar/modal이 native 위 | 실제 교집합의 공개 hit/layer 상태가 chrome을 최상단 소유자로 보고하는지 단언한다. |
| B10 | hostile 전체창 빠른 resize affine + 원복 | 유한 resize transaction마다 DOM/native 좌표 정합과 최종 원래 기하 복원을 단언한다. |
| B11 | pane resize 왕복 + wheel `0→480→0` + 탭 지정 full capture | 명시한 view의 resize 정착, 실제 scroll 사건, capture 범위·문서 기하·scroll 복원을 단언한다. |
| B12 | macOS traffic lights 냉시작·상하 중심·composition·hostile resize·titlebar 높이 변화 | 복원 논리 크기와 저장 zoom이 native 적용 ACK를 받고 post-zoom 공개 titlebar가 GREEN으로 합성된 뒤에만 창을 표시한다. Tauri는 하나의 AppKit 메인 스레드 transaction과 하나의 paint owner만 쓴다. 현재 버튼 프레임에서 그리는 backing 영역 3개, 공개 AppKit button 3개, DOM reservation 3개의 대응·포함·상하 중심·resize 정합을 단언한다. 시작 게이트는 AppKit 표시 transaction을 flush한 다음 실제 프레임과 선언 프레임을 읽기 전용으로 다시 대조한다. 과거의 `lastApplyOk` 영수증만으로는 표시 뒤 button 프레임이나 owner 계층이 유지되지 않은 창의 노출을 승인할 수 없다. 동적 합성기가 설치된 동안 Tauri 설정의 `trafficLightPosition`은 금지한다. 그렇지 않으면 Tao의 고정-y draw owner가 DOM 합성기와 경쟁하고 non-child Wry 경로에도 같은 고정 목표가 전달된다. 어댑터는 최초 AppKit 가로 간격을 유지하고 세로 위치만 공개 DOM titlebar에서 도출한다. 공개 async resize는 `Window`를 awaited oneshot ACK까지 소유하며 timeout 뒤 지연 mutation과 큐에 넘긴 bare `NSWindow` pointer를 금지한다. `titlebar.height.set {height}`은 공개 DOM 높이를 바꾸고 완전한 paint 경계를 지난 뒤 같은 엄격 native 영수증을 반환하며, `titlebar.height.reset`은 직전 inline height/flex-basis를 정확히 복원한다. 모든 냉시작·높이 표본에서 button/backing 중심 차이는 반올림 허용치 안의 0이어야 한다. Electron은 Tauri paint owner를 지어내지 않고 공개 traffic-light position과 DOM reservation으로 같은 가시적 중심/resize 계약을 단언한다. macOS가 아니면 정적으로 `not-applicable`이다. |

### B04 정확한 DOM commit 원장

B04는 자극 전에 `ui.trace.multi.start` ACK를 받아 initial raw rect 읽기와 layout journal 구독 설치를
확정한다. 목표 DOM이 React layout effect에 커밋되면 journal wrapper는 surface ACK를 기다리기 전에
`transactionId`와 `domCommittedAtUnixMs`를 동기 발행하며, 구독자는 같은 callback에서 rail과 양쪽
pane/slot rect를 한 번 읽는다. `ui.trace.multi.close` 영수증은 initial 1개와 판정할 transaction의
DOM-commit 1개만 가져야 한다. 누락·중복·다른 transaction 오염은 RED다. 실제 presentation 사건은
commit epoch 전이면 initial rect, 이후면 commit rect에만 결합한다. 16ms timer 근접도, 허용 간격 확대,
보간·이동량 투영은 합성 판정 근거가 아니다. 종료 timeout은 구독 회수 장벽일 뿐 좌표 polling이 아니다.

Tauri pane surface의 owner 원장도 정확해야 한다. `webview.pane.hosts`에서 요청한 window, `viewId`,
workspace `logicalPaneId`, surface member에 해당하는 host가 정확히 하나여야 하고, trace는 그 사실의
별도 `nativeHostId`로 무장한다. 결합 누락·중복, null logical identity, 모호한 `pane` 필드,
host label에서 logical id를 추론하는 구현은 RED다.

이 거래 사건은 FLOW 재배치만 나타낸다. 최초 mount에는 layout transaction이 없으므로 새 앱 첫 화면의
DOM/surface 정합은 B01 mount와 B03 1:1 inventory/frame 계약으로 별도 증명한다.

### B05 실제 presentation event 원장

B05는 자극 전에 유한 trace를 무장하고 실제 compositor/display callback이 낸 사건만 받는다.
DOM/status 표본, PNG·녹화, recorder frame 번호, 통계 조회를 표시 사건으로 합성하지 않는다.
각 사건은 연속 sequence, 동일 surface identity/generation, 증가하는 presentation revision/시각,
live·visible·painted, DOM frame과 실제 surface frame의 1px 이하 차이를 가진다. judge의 고정 상한은
첫 표시 50ms, 활성 사건 간격 50ms, click→settled 550ms이며 settled 뒤 최소 250ms를 같은 owner
inventory로 유지한다. replacement, gap, disappearance, unpresented, dropped event는 모두 0이어야
한다. 어댑터가 실제 사건과 lifecycle을 발행하고 코어 하니스가 공개 trace를 소비한다. hold는
유한 사건 구독으로 닫으며 interval/rAF 폴링으로 채우지 않는다.

실제 Tauri/macOS B12 게이트는 `make e2e-titlebar-dev`로 실행한다. 한 번 빌드한 뒤 세 번 냉재시작하고, 모든 실제 창을 공개 커맨드로 30·60·72 CSS px에서 측정한다. 적용 직후의 모든 표본에는 나중에 읽기만 하는 유지 표본이 대응하며, 그 사이 기하·DOM 인스턴스/스타일·native presentation revision이 정확히 유지되어야 한다. 따라서 프레임워크가 늦게 다시 그려 초기 정위치만 맞는 상태는 통과하지 못한다. 기계 판정은 DOM/AppKit 사각형과 시작 영수증만 사용한다. 저장된 스크린샷은 필수 육안 검사 증거이며 PASS/FAIL 근거로 사용하지 않는다.

각 engine×gate의 machine 상태는 `not-applicable`, `not-run`, `blocked`, `red`, `green` 중 하나다. `green`과 `red`는
기계가 재현한 근거가 필수이고, `blocked`는 누락된 공개 측정면 같은 구체적 이유가 필수다. `blocked`나
`not-run`을 성공으로 세지 않는다. `not-applicable`은 위의 정적 catalog 조건일 때만 required 개수에서
제외한다. machine 전체는 적용되는 모든 칸이 `green`일 때만 `green`이며, 그 외에는 `red` → `blocked`
→ `not-run` 우선순위로 미완료 원인을 보존한다.

스크린샷과 녹화는 개발 중 반드시 직접 보고 결함을 발견하는 자료지만 자동 machine gate의 입력이나
성공 근거가 아니다. 관측한 결함은 공개 좌표·상태·사건 trace로 수치화해 같은 gate의 RED로 만든다.
이미지·녹화의 사람 검토는 별도 `visualReview`에 `not-applicable`, `pending`, `passed`, `failed`로 기록하며 machine
상태를 바꾸지 않는다. 반대로 machine `green`도 `visualReview`를 자동 `passed`로 만들지 않는다.
`createBrowserGateReport`, `setMachineGateStatus`, `setVisualReviewStatus`,
`serializeBrowserGateReport`는 이 두 판정을 섞지 않고 고정 순서로 전체 결과를 직렬화한다.

## 하니스 규칙 (실측으로 얻은)

- **하니스가 앱을 루프로 재기동하게 두지 마라.** 멈춘 상태 회복은 최대 1회, 그다음 진단과 함께
  시끄럽게 실패한다 — 재기동→부활→재스캔 루프는 회복이 아니다.
- **EOF 소켓 읽기는 예외를 던진다**, 공회전 아님: `recv` 가 빈 바이트를 영원히 돌려주면 행이므로
  EOF 를 오류로 본다.
- **응답 봉투는 rpc 헬퍼 한 곳에서 언랩.** 기계 페이로드는 `data` 에 중첩(MESSAGE-PROTOCOL);
  헬퍼에서 평탄화해 단언이 평면 필드를 읽게 한다.
- **워크스페이스 창을 명시 타게팅.** `main` 은 워크스페이스 없는 컨트롤 플레인이라, 프로젝트를
  측정하는 하니스는 자기 `w-*` 창을 열고 모든 명령을 그 창으로 라우팅한다 — 창 미지정 명령은
  컨트롤 플레인에 착지해 아무것도 측정하지 못한다.
- **비전면 단계 캡처는 timer가 아니라 사건 경계를 쓴다.** `ui.input.drag`의
  `captureSteps:true`는 전면 paint 뒤에는 rAF를 쓰지만, 비전면 WebKit은 rAF가 없고 짧은 timer도
  throttle한다. 포커스 없는 경로는 `MessageChannel` task를 한 번 기다려 DOM layout을 확정하고,
  이 경계를 쓴 횟수를 `recording.frameFallbacks`로 보고한다.
- **DOM/native 레이어 판정점은 실제 교집합에 둔다.** 사이드바나 모달의 임의 위치에 색을
  칠해 존재만 확인하지 않는다. 공개 `ui.tree`/`ui.measure`로 크롬과 native 슬롯의 교집합을
  계산하고, 그 안의 기준점 좌표와 PNG를 함께 저장한다. React 커밋이 검증용 선언을 제거할 수
  있으므로 유한한 검증 수명 동안에는 속성 `MutationObserver`가 선언을 복구하고, 빈 선언으로
  종료할 때 반드시 disconnect한다. 이는 제품 추종 루프가 아니라 테스트 계측의 시작/종료가
  명시된 사건 구독이다. 선언 명령의 ACK는 DOM mutation에서 끝나지 않고 공통
  `ContentViewHost.chromePresentationSettled()`까지 기다린다. Tauri는 메인 WKWebView의
  `afterScreenUpdates=true` snapshot 완료 에지로 답하며, 고정 지연을 표시 완료의 대리값으로
  사용하지 않는다.
- **UI 변경 command의 ACK는 상태 저장이 아니라 공개 DOM 커밋까지다.** 예를 들어
  `project.rightbar.toggle`은 Zustand 값만 바꾼 직후 성공하지 않는다. 해당 프로젝트의 공개
  `sidebar/right`가 요청한 open/width를 그린 mutation 사건과 크롬 표시 완료를 확인한 뒤
  응답한다. 검사는 `MutationObserver` 하나와 유한 timeout을 쓰며 interval/rAF 폴링은 없다.
- **실제 프로세스를 소유하는 측정은 격리 레인에서 돈다.** `pnpm test`는 일반 Vitest 파일을
  병렬 실행한 뒤 `scripts/electron/content-view-live.test.mjs`를 단독 실행한다. 이 검사는 실제
  Chromium 게스트를 띄워 전체 worker 경쟁에서는 45초 동안 굶지만 단독으로는 2초 안에 끝난다.
  시간 기준을 늘리거나 검사를 빼지 않고, 두 단계를 같은 공개 테스트 명령에 둔다.

## 플러그인·사이드카 repo

플러그인 repo 의 `test-unit` 은 자기 스위트(vitest/cargo). 빌드 단계(TypeScript `src/`)가 있는
repo 는 발행 전 빌드하고, 플러그인은 `soksak-plugin-doctor` 를 `prepublishOnly` 에 배선해 발행 전
무결성 게이트(theme/permission/naming/envelope)가 돌게 한다. 테스트 파일 0 인데 `vitest` 를
돌리는 스크립트는 거짓 그린 — 실 테스트를 넣거나 스크립트를 제거한다.

---

English guide: [TESTING.md](TESTING.md).
