# 성능 헌법 — 상호작용 성능 원칙

soksak 의 상호작용 성능을 지키는 7가지 원칙. 모든 프런트엔드 코드 변경은 이
문서를 기준으로 리뷰한다. 위반은 "동작하니까 통과"가 아니라 결함이다.

배경: 2026-06 전수조사에서 가벼운 상호작용(디바이더/탭/사이드바 드래그, 스크롤)
만으로 WebContent CPU 가 ~100% 까지 오르는 구조적 원인 10건(R1~R10)이 확인됐다.
원인은 전부 아래 원칙의 위반이었다. 측정 하니스는 `scripts/perf/` 참조.

정본은 영문 [`PERFORMANCE.md`](./PERFORMANCE.md)다. 두 벌이 어긋나면 영문이 이긴다.

## 원칙

### 1. 구독 최소

컴포넌트는 렌더에 실제로 쓰는 데이터에만 셀렉터로 구독한다.

- 금지: `useSessions()` / `useSettings()` 등 셀렉터 없는 bare 훅 — 스토어의 모든
  쓰기가 그 컴포넌트(와 전 자식)를 리렌더시킨다.
- `useSessions.subscribe(cb)` 류 store 전체 구독도 동일 — 콜백이 모든 쓰기마다
  실행되므로, 비싼 콜백은 프레임 단위로 coalesce 한다(원칙 4·5).
- 다중 필드가 필요하면 `useShallow` 픽. 액션은 정의 시점에 고정되는 안정 참조라
  액션별 셀렉터가 안전하다.

### 2. 렌더 경계 = 데이터 경계

`React.memo` 경계는 데이터 소유 단위와 일치시킨다(GroupArea=content,
FileViewer=view, ProjectPane=project …). 경계를 넘는 prop 은 참조 안정성을
보장한다(useCallback/안정 셀렉터/ref 경유). 커스텀 비교자는 금지 — staleness
버그의 온상이다. 기본 shallow compare 로 성립하지 않는 memo 는 설계가 틀린 것.

### 3. 일시 상태와 영속 상태의 분리

제스처(드래그) 중간값은 일시 상태다. 스토어(영속 상태) 커밋은 제스처 종료 시
1회, 또는 시각 추종이 필요하면 프레임당 1회를 상한으로 한다. 매 mousemove 마다
스토어에 쓰는 코드는 금지.

### 4. 고빈도 이벤트는 프레임당 1회

mousemove/dragover/스크롤 연동 등 연속 입력 핸들러는 `rafThrottle`(src/lib)로
프레임당 1회로 합친다. 제스처 종료 시 `flush()` 로 마지막 값을 반드시 커밋한다
(리스너 제거 전에 — 아니면 마지막 프레임이 유실돼 스냅백한다). 비전면 WebKit은 rAF를
멈추므로 그 상태에서는 같은 helper가 `MessageChannel` task 하나로 합친다. 이것은 timer나
폴링이 아닌 1회성 사건 경계이며, 포커스 없는 명령 주입도 요청한 각 DOM 레이아웃을 만든다.

### 5. 비싼 부수효과는 정착 후 1회

IPC(invoke)·PTY resize(SIGWINCH)·네이티브 웹뷰 이동/리사이즈는 trailing
debounce 로 입력이 정착한 뒤 1회 실행한다. 스톰은 본구간 CPU 뿐 아니라
**지연 스파이크**(예: SIGWINCH 수백 발 → TUI 가 수 초간 연쇄 재그리기)를 만든다.
강제 레이아웃 읽기(getBoundingClientRect 등)는 매 렌더 동기 실행 금지 — rAF
타이밍으로 옮긴다.

#### 5a. 네이티브 합성 경계의 시각 연속성

사용자 제스처는 불연속 콘텐츠를 보여주지 않는다. 방법은 콘텐츠가 사는 자리가 정한다.

- 문서 안 표면은 DOM 부모를 따른다. 코어와 Electron은 네이티브 bounds 추종자·스크린샷
  스탠드인·veil handoff·z-order 거래를 설치하지 않는다.
- Tauri child 웹뷰는 하나의 안정 z-order에서 계속 살아 있다. 예측 가능한 레일 재배치는 유한
  snap 거래다. 현재 DOM 슬롯을 출발 좌표로 삼고 중간 mutation 쓰기를 잠근 뒤 접힌 목표 frame을
  한 번 커밋한다. stale native frame을 다음 여정의 출발점으로 쓰지 않는다.
- 예측 불가능한 resize 입력은 사건(`ResizeObserver`와 명시적 제스처 에지)으로 받고 label별로
  합쳐 현재 공개 슬롯에 수렴한다. 프레임 폴링 루프는 없다.
- 포커스 조명은 콘텐츠 조상의 `filter`/`opacity`가 아니라 작업면 밖 SVG 평면 하나가 그린다.
  그래야 DOM·canvas·WebGL renderer의 합성 경로를 바꾸지 않는다. Tauri native child만 어댑터가
  같은 `--dim` 값을 AppKit 평면에 투영하며, 그 frame은 surface frame 거래와 함께 커밋한다.
  SVG base veil의 포커스 구멍은 luminance mask다. 흰 영역은 veil을 유지하고 검은 aperture는
  제거한다. alpha mask로 바꾸면 두 색이 모두 불투명해져 포커스 구멍이 닫히므로 금지한다.
- `viewId`는 제품 뷰의 정체성이고 DOM container는 React 렌더 세대다. 같은 세대의 중복
  mount 등록은 멱등 acquire이며, 새 세대는 이전 세대를 원자적으로 승계한다. 이전 세대의 늦은
  cleanup은 identity guard로 새 세대를 지우지 않는다. 공간·탭 DOM 교체를 전역 중복 예외로
  막으면 정상 전환이 renderer 전체를 내리므로 금지한다.
- 캡처 픽셀은 증거(`window.record` / `window.snapshot`)이며 대체 UI가 아니다.
  Electron 캡처는 `capturePage`의 정규 capturer 수명으로 부모와 `<webview>` guest를 함께
  합성한다. `stayHidden:true`로 guest 합성을 막지 않으며 캡처를 위해 창을 포커스하지 않는다.

### 6. 플랫폼 페인트 경로 보존

WebKit 의 합성(비동기) 스크롤·합성 레이어를 깨는 CSS 를 금지한다. 대표:
전역 `::-webkit-scrollbar` 커스텀(레거시 스크롤바 경로 강제). 스크롤바 스타일은
표준 `scrollbar-width`/`scrollbar-color` 를 우선한다. 의심 패턴은 반드시
하니스 A/B 측정으로 검증 후 적용한다.

### 7. 측정 없이 완료 없음

성능에 닿는 변경은 `scripts/perf/run.sh` 의 before/after 수치를 동반해야 한다.
시나리오(S1~S7)와 게이트 절차는 `scripts/perf/README.md` 참조. 본구간(active)과
테일(tail) 둘 다 본다 — 테일 악화는 부수효과 스톰의 신호다.

### 8. 프로파일 없는 수치는 측정이 아니다

모든 성능 수치는 어느 cargo 프로파일에서 잡혔는지 함께 적고, 프로파일이 다른
수치끼리는 비교하지 않는다. `scripts/perf/run-t.sh` 가 실행 중 바이너리 경로에서
프로파일을 발견해(`lib.sh` 의 `identity_cargo_profile` — cargo 는 `dev` 를
`target/debug` 에, `release` 를 `target/release` 에 떨군다) `meta.cargoProfile` 에
쓰고, `check-budgets.mjs` 가 불일치를 `INVALID_CONDITIONS` 로 거부한다.

이것이 주석이 아니라 원칙인 이유: 워크스페이스에 `[profile.release]` 만 있어서
`make dev` 도 `make build-debug`(`tauri build --debug`)도 cargo 의 `dev` 프로파일 —
`opt-level=0`, `debug-assertions`, `overflow-checks` — 로 의존 트리 전체를(번들 C
SQLite 포함) 빌드한다. 저장소의 `RawRing::push` 를 그 운영 조건(256 KiB 링,
8192 B 청크, 100 MB)으로 실측하면 같은 코드가 `opt-level=0` 에서 **77.09 MB/s**,
`opt-level=3` 에서 **737.03 MB/s** — 핫루프 하나에서 9.56배 차이다. `budgets.json`
의 모든 예산이 비최적화 프로파일에서 잡혔다. 어느 프로파일에서 나온 수치인지
말하지 않는 숫자로는 아무것도 판단할 수 없다.

### 9. 회귀 게이트와 절대 목표는 파일을 나눈다

`budgets.json` 은 `baseline × headroom` 이다 — 회귀를 잡는 데는 옳은 모양이고,
절대 결함을 잡는 데는 틀린 모양이다. baseline 자체가 이미 그 결함이 만든 값이기
때문이다. 기록된 결과: 유휴 CPU baseline 46.4 에서 예산 60 이 파생돼, 게이트가
반쪽 코어를 쉬는 상태의 정상값으로 인증하고 51.5 짜리 런이 통과한다.

`targets.json` 은 건강한 수치가 **무엇인가**를 담는다. 목표는 실측이나 실측
위의 산술에서 도출하고 발명하지 않는다. 각 항목은 도출 근거와 재현 명령을 함께
싣는다. 런을 통과시키려고 목표를 넓히지 않는다 — 못 맞추면 다음 병목을 실측으로
특정해 기록한다. 회귀한 런은 실패(exit 1), 회귀는 없지만 목표를 못 맞춘 런은
exit 3 이고 초록이라 부르지 않는다.

## 플러그인 성능 계약

플러그인 이벤트 핸들러(`onDidChangeActiveView` 등)는 **메인스레드에서 동기
실행**된다. 무거운 작업(파싱, 네트워크 후처리, 대량 DOM)은 핸들러 안에서 직접
하지 말고 defer 한다. 호스트는 상태 diff 를 프레임 단위로 coalesce 해 전달하므로
이벤트는 "최종 상태" 기준이다 — 틱 단위 중간값에 의존하지 말 것.

## 터미널 렌더러 — WKWebView 합성 stretch (불변식)

증상: macOS 창 가장자리 드래그(라이브 리사이즈) 중 터미널 글자가 늘어난다(흐릿한
확대). DOM(탭·사이드바)은 멀쩡한데 터미널만.

근본 원인: 라이브 리사이즈 동안 AppKit 은 `inLiveResize` 로 redraw 를 멈추고, GPU
합성 레이어(WebGL/Canvas 렌더러의 `<canvas>`)를 새 창 크기로 CALayer 스케일한다
(`layerContentsRedrawPolicy` 가 명시적 redraw 없으면 콘텐츠를 stretch). DOM 은 WebKit
이 타일을 매 프레임 재래스터하므로 또렷하다. Chromium 은 리사이즈 콜백에서 동기
페인트로 회피하지만 WKWebView 엔 그 경로가 없어 Safari 에도 같은 증상이 있다. 즉
**WKWebView + GPU 캔버스는 리사이즈 stretch 를 구조적으로 못 피한다** — 그 캔버스는
WebKit 내부 합성 레이어라 우리가 contentsGravity 를 만질 수 없다.

규칙:

- 기본 터미널 렌더러는 WebGL(`xtermRenderer: "webgl"`) — 처리량 우선(사용자 기본값).
  단 창 리사이즈 중 합성 stretch 가 따라온다(원인은 위). 정확성보다 처리량을 택한
  기본값이다.
- DOM 은 리사이즈 정확성이 필요할 때 전환 — WebKit 이 DOM 을 매 프레임 재래스터해
  안 늘어난다. 설정의 "터미널 렌더러" 또는
  `sok settings.set '{"key":"xtermRenderer","value":"dom"}'`. 살아있는 터미널에
  라이브 전환된다(WebGL addon load/dispose).
- [HARD] stretch 를 "본문을 가려서" 숨기는 류의 우회는 금지 — 은폐는 해결이 아니다.
  렌더러 선택(DOM)만이 근본 해법이다. (5a 의 제스처 스탠드인은 이에 해당하지
  않는다: 유예된 리사이즈를 잇고 진짜 재페인트로 끝난다.)

근거(2026-06 조사, URL 검증 완료):

- NSView.LayerContentsRedrawPolicy — `never`/`onSetNeedsDisplay` 는 명시적 redraw
  없으면 레이어 콘텐츠를 리사이즈 시 stretch(`duringViewResize` 는 매 프레임 redraw):
  <https://developer.apple.com/documentation/appkit/nsview/layercontentsredrawpolicy-swift.enum>
- Cocoa Live Window Resizing — `inLiveResize`, 콘텐츠 보존은 opt-in 최적화:
  <https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CocoaPerformance/Articles/CocoaLiveResize.html>
- MTKView/SKView 라이브 리사이즈 콘텐츠 stretch(CALayer contentsGravity + redraw 중단):
  <https://developer.apple.com/forums/thread/94765>
- servo/webrender #1640 — macOS 는 "리사이즈 콜백에서 반환 전에 한 프레임을 그려야"
  한다(동기 페인트 부재 시 콘텐츠가 lag/scale): <https://github.com/servo/webrender/issues/1640>

코드 앵커: 렌더러 선택은 터미널 플러그인(soksak-plugin-terminal-xterm,
`src/terminal.ts` `xtermRenderer`) 소유.
