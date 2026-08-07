# 브라우저 12 게이트 인수인계 지시서

## 이 문서의 목적

이 문서는 새 에이전트가 브라우저 합성/레이아웃 문제를 처음부터 다시 추측하지 않고, 현재 기준과 증거를 이어서 작업하기 위한 실행 지시서다. 목표는 12개 게이트를 세 브라우저 구현에서 모두 `machine=green` 및 필요한 경우 `visualReview=passed`로 만드는 것이다.

완료 선언은 마지막에 한 번만 한다. `partial`, `blocked`, `not-run`, 시각 검토 미완료는 완료가 아니다. 기준을 낮추거나 실패한 증거를 삭제하지 않는다.

## 반드시 지킬 원칙

1. **관측 → 수치화된 RED → 원인 수정 → 동일 기준 GREEN** 순서를 지킨다.
2. 캡처와 녹화는 결함을 발견하고 사람이 화면을 확인하는 개발 증거다. 성공 판정은 좌표, 크기, 위상, 이벤트, 상태, 프레임 간격 등 기계적으로 재현 가능한 수치 영수증으로 한다.
3. DOM, native surface, slot, pane, sidebar, rail, overlay의 책임을 섞지 않는다. Electron은 DOM 자식으로만 동작하고 Tauri의 bounds/veil/drag/native composition hack은 Tauri 어댑터에만 둔다.
4. 프레임워크 이름으로 코어를 분기하지 않는다. 공개 capability와 어댑터 인터페이스로 경계를 표현한다.
5. 한 번에 하나의 앱 수명주기만 실행한다. 테스트를 병렬로 실행하거나 앱을 두 번 띄워 stale window/native surface를 만들지 않는다.
6. `make rebuild-dev`는 현재 소스를 빌드한 뒤 dev 앱을 재시작한다. `make restart-built-dev`는 이미 검증한 동일 번들을 빌드 없이 재시작할 때만 쓴다. debug 앱을 검증 대상으로 사용하지 않는다.
7. 임시 스크립트, symlink, 기준 완화, 숨김 폴백을 만들지 않는다. 반복 작업은 Git에 남는 테스트/커맨드로 만든다. 폴링은 이벤트/구독이 불가능하다는 근거와 종료 조건이 있는 bounded last resort일 때만 허용한다.
8. 변경은 작은 커밋으로 남긴다. GREEN을 만들지 못한 커밋을 알려진 RED 상태로 누적하지 말고 수정하거나 명시적으로 되돌린다.

## 시작 전에 읽을 것

- `AGENTS.md`
- `docs/TESTING.ko.md`, `docs/EVIDENCE.md`, `docs/NATIVE-SURFACES.ko.md`
- `docs/multiplatform-engine-strategy.ko.md`
- `scripts/e2e/lib/browser-gates.mjs`
- `scripts/e2e/slot-freeze.mjs`
- `scripts/e2e/lib/browser-matrix.mjs`
- `packages/dom-webview-compositor/`
- `frameworks/tauri/`와 Electron 어댑터 경계

게이트 정본은 `scripts/e2e/lib/browser-gates.mjs`다. 이름이나 판정을 문서에서 임의로 바꾸지 않는다.

## 현재 기준과 사실

현재 12개 전체 GREEN은 아니다. 실행 시점의 실제 report가 이 문서보다 우선하며, 최신 상태는 반드시 새 실행으로 갱신한다.

이 게이트를 재는 일 자체가 오래 막혀 있었다. 판정 실패가 측정을 끊어 36칸 중 33칸이 `not-run`으로 남았고, 여러 게이트는 judge 앞의 throw가 모든 실패 축을 선점해 판정이 대상에 닿지 못했다. 그래서 green이 통과의 증거가 아니었다. 지금 측정 구조는 다음을 강제한다.

- 판정 실패는 측정을 끊지 않는다. 측정을 이어갈 수 없게 된 셀만 사유와 함께 `blocked`로 닫고 남은 엔진은 계속 잰다. 최종 판정은 요약이 소유한다.
- 계약 위반은 던지지 않고 evidence에 실어 judge가 이름 붙은 `red`를 내게 한다. 던지는 것은 측정 불가(주소·창·응답 부재)뿐이다.
- 인수 합계는 프레임워크 축까지 센다. 한 프레임워크만 제출하면 나머지는 0이 아니라 `missingFrameworks`로 이름이 남는다.
- 증거 봉투의 키 대조는 양방향이다. 소비되지 않은 생산 키와 생산되지 않은 소비 키를 둘 다 이름으로 남긴다.
- 픽스처는 자기 창 크기를 소유한다. 앱 기본 크기나 앞 엔진이 남긴 크기를 물려받으면 같은 앱이 실행마다 다른 칸을 잃는다.
- 표시 배율은 창의 사실에서 읽는다. 캡처에서 잰 배율은 사본으로 따로 싣고, 사실이 없으면 1로 대체하지 않고 측정 불가로 거절한다.
- 인수는 자기 실행을 이름으로 읽는다. "가장 최근"을 파일 시각으로 고르면 한 실행기가 실패했을 때 지난 실행이 최신으로 남아 서로 다른 두 실행이 이어진다 — `buildId`가 우연히 같으면 통과하고 다르면 던진다. 부르는 쪽이 `BROWSER_EVIDENCE_RUN_ID`·`B12_RUN_ID`를 들고 오고, 이름이 없으면 다른 실행으로 대신하지 않는다.
- 한 칸의 상함이 판 전체를 가리지 않는다. 판정 규칙이 바뀐 뒤 옛 실행을 읽으면 재판정이 저장된 판정과 어긋나는데, 그것은 그 칸의 사실이다. 그 칸만 사유와 함께 `blocked`가 되고 나머지 35칸의 잰 값은 그대로 나온다. 방금 낸 영수증이 자기 증거와 안 맞는 쓰기 자리는 그대로 던진다.
- 부르는 쪽이 소유한 값은 부르는 쪽이 든다. 하니스가 만들어 상대에게 실어 보낸 식별자를 상대의 영수증에서 되읽으면, 우리가 소유한 값이 상대의 답 모양에 매인다. 그 되읽기 하나가 세 증상을 냈다 — 두 엔진의 표시 궤적이 다른 궤적의 버퍼를 읽어 3.63초 침묵으로 보였고, offscreen은 첫 게이트에서 파라미터 거절로 엔진 실행이 죽어 9칸이 `blocked`로 남았다.
- 해당 여부는 선언된 능력에서 파생한다. 인수는 프레임워크마다 36칸을 요구하지만 모든 칸이 모든 프레임워크에 해당하지는 않는다 — B09는 "native browser surface 위에 합성"을 요구하고, 네이티브 자식 표면이 없는 프레임워크에는 그 사실 자체가 없다. red로 칠하면 달성 불가능한 기준이 되고 green으로 세면 재지 않은 칸이 통과로 잡힌다. 칸이 자기 요구를 선언하고(`requires`) 판정 대상이 선언한 능력과 만난다. 이름으로 가르면 프레임워크가 하나 늘 때마다 갈래가 늘고 새 이름은 자기 자리를 못 찾는다.
- 신원이 능력을 든다. 판정·병합·영수증이 같은 사실을 봐야 한다 — 자리마다 능력을 다시 물으면 그 물음이 갈리고 같은 칸이 자리마다 다른 답을 받는다.
- 인수가 세는 프레임워크마다 재는 자리가 있어야 한다. 재는 자리가 한쪽에만 있으면 나머지 칸은 하니스가 못 재서가 아니라 부를 자리가 없어서 영원히 missing이다. 갈리는 것은 실행물·재시작·소켓 셋뿐이고 몸통은 하나다.
- 필드 목록을 손으로 나열하지 않는다. 축이 하나 늘 때 반드시 한 자리가 빠지고, 빠진 자리는 오류 없이 옛 값을 통과시킨다 — 실측 2026-08-07: 능력 축 하나를 세우자 판사 신원 조립·영수증 키 검사·저장 영수증 조립·병합 신원 네 곳이 동시에 빠졌다.
- 테스트는 고정 경로를 소유하지 않는다. 두 스위트가 같은 자리를 쓰면 판정이 실행 순서에 따라 갈린다 — 단독으로는 통과하는 스위트가 전체 실행에서만 실패한다.
- 증거 문자열은 비교의 이름만이 아니라 비교한 값을 낸다. 값 안에 구분자가 있으면(`/`를 담은 경로) 참가자 이름을 달아 경계를 지킨다. 이름만 있고 값이 없으면 1px 어긋남과 500px 어긋남이 같은 답이 되어, 읽는 사람이 잘못된 자리를 고친다.

판정이 대상에 닿기 시작하자 드러난 제품 결함들은 각각 고쳤다. 대표: 휠 사건이 창 좌표를 싣지 않아 스크롤은 움직이는데 DOM `wheel`이 한 번도 발화하지 않던 것, 도달성 판정이 히트가 뚫은 shadow 경계를 같이 넘지 않던 것.

측정 결함과 제품 결함을 가르는 데 오래 걸린 사례가 B04·B05다. 두 엔진이 거래 창 안에 표시 표본을 하나도 못 내고 3.63초 묵은 잔여를 돌려줬고, 그 간격이 실행마다 편차 44ms로 일정해 제품의 고정된 멈춤처럼 보였다. 실제 원인은 하니스가 무장은 자기가 만든 식별자로 하고 판독은 상대가 메아리친 식별자로 해서 다른 궤적의 버퍼를 읽은 것이었다. 그 위에 "창이 가려져 표시 시계가 멈춘다"는 가설을 세우고 `window.occlusion`까지 끌어왔으나, 되읽기를 없애자 `window-gap`이 한 건도 남지 않았다. 지어낸 증상을 설명하는 기계를 만들면 다음 사람이 그것을 사실로 읽는다 — 증상의 일정함은 제품이 고정됐다는 뜻이 아니라 우리가 같은 잘못을 반복한다는 뜻일 수 있다.

## 실행 환경과 증거 보존

소켓:

```sh
export SOKSAK_SOCKET=<machine-path>/.soksak-dev/cored.sock
```

앱을 조작하기 전에 `sok state.tree`로 실제 target을 발견한다. 브라우저/DOM/상태/커맨드는 `sok commands`, `sok help <command>`로 공개된 경로만 사용한다. 캡처는 창에 포커스를 주지 않고 `window.capture`/공개 capture 경로로 남긴다.

단일 엔진 FLOW 재현 예:

```sh
BROWSER_EVIDENCE_BUILD_ID="$(shasum -a 256 target/aarch64-apple-darwin/debug/bundle/macos/soksak-tauri-dev.app/Contents/MacOS/soksak-dev | awk '{print $1}')" \
SOKSAK_SOCKET=<machine-path>/.soksak-dev/cored.sock \
BROWSER_ENGINES=browser-chromium \
BROWSER_SCENARIOS=flow \
CROSS_CLICK_CYCLES=1 \
node scripts/e2e/slot-freeze.mjs
```

세 구현의 acceptance engine은 `browser`, `browser-chromium`, `browser-chromium-offscreen`이다. 하나만 GREEN이어도 전체 GREEN이 아니다. 앱 lifecycle 테스트는 순차 실행한다. RED artifact는 `<machine-path>/.soksak-e2e/evidence/slot-freeze/last-red/`를 덮어쓰지 않도록 커밋 또는 별도 run id로 보존한다.

## 12개 게이트의 완료 계약

### B01 — initial mount/address/page identity

세 구현 모두 최초 mount에서 주소표시줄이 존재하고 요청한 실제 페이지의 URL/title/body identity를 노출해야 한다. `about:blank`, Example Domain, IANA 등 실제 navigation을 각각 확인한다. 빈 흰 화면, 주소표시줄 없는 Chromium, stale 페이지는 RED다.

### B02 — Korean IME/state retention

주소표시줄과 페이지 input에 한글을 입력하고 `beforeinput` 및 `input` 이벤트 수, 최종 값, focus target을 수치로 기록한다. FLOW 좌/우, hostile window resize, pane resize, scroll 뒤 값이 보존되어야 한다. 세 엔진 각각 최소 2회 반복한다.

### B03 — DOM/live surface one-to-one

각 `data-content-view-body` DOM slot에 정확히 하나의 live renderer/native surface가 대응해야 한다. view id, pane id, topology, logical/physical rect, width/height, visibility/live 상태를 내보내고 물리 픽셀 반올림만 허용한다. 누락, 중복, stale member, DOM만 존재하는 빈 hole은 RED다.

### B04 — FLOW atomic composition

탭을 좌→우, 우→좌로 교차 클릭한다. rail, pane, DOM slot, native surface가 하나의 layout transaction으로 이동하고 commit/settlement/display frame의 좌표가 동일해야 한다. 두 방향 각각 48프레임 사람용 캡처를 남기되, verdict는 transaction/timeline/composition 숫자로 한다. `webview.pane.composition matched=false`는 즉시 RED다.

### B05 — continuous visible presentation

이동 중 surface disappearance, black frame, flicker, 잔상, 착지 후 빈 브라우저를 금지한다. native presentation trace의 callback skip/latency, visible frame 수, live surface 수, commit/settlement 경계를 기록한다. callback cadence와 surface continuity를 혼동하지 않는다.

### B06 — focus lighting

active pane만 밝고 inactive pane만 감광된다. rail/sidebar는 절대 감광되지 않는다. `brightness(...)`를 제거해 기준을 낮추지 않는다. 픽셀 샘플과 DOM computed style을 함께 남기고 active/inactive 전환 양방향을 검사한다.

### B07 — PIN border/layout invariance

sidebar 고정 상태에서 탭이 sidebar 왼쪽 인접, 오른쪽 인접, 어느 쪽에도 붙지 않는 세 경우를 만든다. 왼쪽이면 왼쪽 경계로 하나의 border, 오른쪽이면 오른쪽 경계로 하나의 border, 분리면 sidebar와 tabview가 각각 독립 border여야 한다. 고정 sidebar 자체의 위치나 활성 상태를 탭 교체 때문에 이동시키지 않는다.

### B08 — PIN maximize/restore station

PIN 상태에서 전체 창 maximize/restore를 빠르게 반복하고 좌/우 방향을 모두 검사한다. sidebar가 고정되어 있으면 최대화 후에도 sidebar는 기준 위치를 유지하고 tabview가 계약된 반대 영역에 놓여야 한다. restore 뒤 station, adjacency, border, native surface가 원래 geometry로 돌아와야 한다.

### B09 — chrome-over-native layering

브라우저 native surface 위에 우측 sidebar, rail의 `+` 버튼, 메뉴/modal이 올라와야 한다. z-index는 Electron에서 필요한 경우에만 DOM stacking으로 사용하고, Tauri veil/overlay/hole은 Tauri 어댑터에만 둔다. 클릭 가능 영역, topmost 순서, capture pixel을 함께 검증한다.

### B10 — hostile window resize

전체 창을 큰 크기↔작은 크기로 빠르게 왕복한다. pane/native surface가 중간 위치에 남거나 늘어나 보이거나 사라지면 RED다. 최종 geometry가 초기 geometry와 rounding-only로 일치하고, 전환 중 surface가 계속 visible이어야 한다. HMR/옛 번들을 원인으로 추정하지 말고 build id와 lifecycle을 증명한다.

### B11 — pane resize/scroll/full capture

지정된 탭을 활성화한 뒤 pane 폭/높이를 빠르게 변경하고 wheel `0→480→0`을 실행한다. 브라우저 내부 스크롤이 실제로 움직이고 복귀해야 하며, 같은 탭을 대상으로 full scroll capture를 남긴다. capture는 시각 증거일 뿐 pass/fail은 scrollTop, content height, viewport rect, native rect 수치로 판정한다.

### B12 — traffic-light composition (macOS)

traffic-light DOM reservation/hole과 AppKit button/backing surface가 3:3으로 대응하고, 상하 중앙 정렬과 hostile resize를 유지해야 한다. 앱 재시작 직후 정렬→로딩 완료 후 정렬을 각각 측정한다. `정위치→오차→정위치`처럼 중간 회귀가 있으면 RED이며 최종 화면만 보고 GREEN으로 만들지 않는다. Electron은 공개 traffic-light position과 DOM reservation 정합을 증명한다.

## RED/GREEN 작성 규칙

각 결함마다 다음을 한 커밋 단위로 남긴다.

1. 재현 fixture와 명시적 command를 추가하고 기준을 실패시키는 RED 테스트를 먼저 커밋한다.
2. RED report에 run id, build id, engine, platform, 좌표/크기/epoch/event/status와 artifact 경로를 남긴다.
3. 원인 소유권을 찾는다. 예: DOM layout, Tauri native member bounds, Electron DOM adapter, pane composition ledger, overlay layer.
4. 한 책임만 수정하고 같은 테스트를 GREEN으로 만든다.
5. 세 엔진 누적 matrix와 시각 캡처를 다시 실행한다. 다른 게이트 회귀가 있으면 완료로 표시하지 않는다.

## 감사 에이전트에게 제출할 보고서

각 실행 후 다음 표를 제출한다.

| Gate | engine/platform | machine | visual | RED 재현/현재 GREEN 근거 | commit | artifact |
|---|---|---|---|---|---|---|

`machine=green`만으로 UI 완료라고 쓰지 않는다. 모든 게이트의 세 엔진 행, B12의 macOS 행, 미실행/차단 사유, 마지막 RED를 함께 적는다. 새 에이전트가 “거의 완료”, “조금 기다리면 됨”, “옛 빌드 탓” 같은 표현으로 수치 증거를 대체하는 것은 금지한다.

## 최종 완료 조건

- B01~B12의 적용 가능한 모든 engine/platform cell이 machine GREEN.
- 모든 UI gate의 visualReview가 passed이며 capture를 사람이 확인.
- 세 엔진에서 cross-click, resize, layer, scroll/full-capture, IME를 누적 matrix로 통과.
- Electron에 Tauri 추종 루프/veil/hole hack/z-index workaround가 없음.
- Tauri 전용 composition 계약과 공개 command/status/event가 문서·테스트와 일치.
- RED→GREEN 커밋 이력이 작고 추적 가능하며 known RED가 worktree와 증거 디렉터리에 남아 있지 않음.
- `docs/TESTING.ko.md`, `docs/EVIDENCE.md`, 멀티플랫폼 전략 문서가 현재 계약과 검증 명령을 반영.

이 조건을 하나라도 충족하지 못하면 완료 선언 대신 정확한 RED와 다음 원인 조사 범위를 보고한다.
