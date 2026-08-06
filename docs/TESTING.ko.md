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
  렌더=픽셀 밝기) — 정적/추론값이 아니라.
- **브라우저 구현은 한 acceptance matrix를 공유.** `slot-freeze.mjs`는 시스템 웹뷰·windowed
  Chromium·offscreen Chromium에 같은 로컬 문서를 제공한다. 각 구현은 주소표시줄과 페이지 신원을
  노출하고, `beforeinput`·`input`을 동반한 한글을 커밋하며, 양 탭을 6회 교차 이동하는 동안 전이당
  무포커스 48프레임 모두에서 두 live page marker를 유지해야 한다. 이어서 `window.resizeSequence`가
  큰 폭의 축소·확대를 짧은 간격으로 반복하면서 64프레임을 기록한다. 모든 프레임에서 두 marker가
  살아 있고, resize 거래가 정해진 시간 안에 끝나며, 마지막 DOM 슬롯·페이지 viewport·고정 marker
  크기가 rounding-only로 일치해야 한다. 구현별 status는 실패를 설명할 수 있지만 제품 기준을 낮출
  수 없다. 생성·첫 페인트·매 교차 클릭·창 resize 정착·패널 resize 양 끝·최종 캡처마다 엔진 기반
  구현은 `viewId -> surfaceId -> 실제 live engine surface`, 정확한 `plugin@window` 소유권,
  visibility, ledger 동일성, viewport 정착도 함께 증명한다. 별도 무포커스 fixture 창이 공개된
  owner-scope `gc`를 실행해도 첫 창의 surface id·DOM 신원·한글 입력 상태·픽셀이 그대로여야 한다.
  이것이 교차 창 surface 오회수의 회귀 게이트다.
  PIN 모드에서는 같은 행렬이 좌측 인접·우측 인접·분리 포커스 변경을 DOM rect 불변으로 녹화한
  뒤 양쪽 판을 각각 최대화한다. 최대화는 저장 station을 쓰지 않고 판/레일 방향을 보존해야 하며,
  복원은 최대화 전 분할을 정확히 재현해야 한다.
  SCROLL 모드는 각 탭에 실제 엔진 wheel 입력을 보내고 폴링 없이 페이지 `scroll` 사건을 기다린다.
  모든 구현은 정확히 `0→480→0`을 보고해야 한다. 이어서 명시한 `viewId`의 viewport PNG와 문서
  전체 PNG를 저장한다. 문서 전체 primitive가 없는 Electron guest는 유한한 viewport 집합을 실제
  scroll 사건과 두 presentation frame으로 확정해 합성한다. 합성 중 기본 오버레이 scrollbar는
  문서의 두 루트에서만 일시 비표시하고, 원래 inline overflow 값·우선순위와 정확한 scroll 위치를
  모두 복원한 뒤에만 성공한다. 라이브 RED는 전체 PNG 우측의 scrollbar 색 픽셀을 0으로 고정한다.
  폴링이나 고정 지연은 허용하지 않는다. 모든 경로에서 문서 기하와 CSS/PNG 배율이 일치하고 상단 신원 marker가
  정확히 한 번, 하단 tail marker가 정확히 한 번 존재해야 한다. 다른 탭의 활성 상태나 캡처 전
  scroll 위치에 기대는 구현은 실패다.

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
