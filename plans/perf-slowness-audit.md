# soksak 성능 감사 — 측정 원장과 개선 계획

측정일 2026-07-25. 기계 Apple M1 Pro. 대상 = 지금 돌고 있는 dev 인스턴스
(app pid 82541, 창 2개). 아래 §0 의 모든 숫자는 재현 명령과 함께 적었다.
추측은 §0 에 넣지 않았다 — 미측정 항목은 본문에서 "미측정" 으로 명시한다.

## 0. 측정 원장 (재현 명령 포함)

### 0.1 실행물의 정체 — 증명됨

| 사실 | 값 | 재현 명령 |
|---|---|---|
| `[profile.dev]` 선언 | **없음** (`[profile.release]` 1건뿐) | `grep -n '^\[profile' src-tauri/Cargo.toml` |
| 저장소 전체 `opt-level` 선언 | **0건** | `grep -rn opt-level src-tauri/Cargo.toml crates/*/Cargo.toml crates/soksak-cli/Cargo.toml` |
| 실행 중 앱 바이너리 | `target/debug/soksak-dev` | `ps -o pid,command -p 82541` |
| `target/release` 디렉터리 | **존재하지 않음** | `ls src-tauri/target/` |
| 실행 중 ptyd == cargo debug 산출물 | sha1 동일 `c7bcda9c…` | `shasum ~/.soksak-dev/bin/soksak-ptyd-p1 src-tauri/target/debug/soksak-ptyd` |
| debug 아이덴티티 번들도 debug 프로파일 | `Makefile:57` = `tauri build --debug` | `sed -n '57,58p' Makefile` |

결론(추론 아님): 이 저장소에서 **최적화된 Rust 산출물이 만들어진 적이 없다.**
docs/PERFORMANCE.md 의 모든 수치와 budgets.json 의 모든 예산은 `opt-level=0`,
`debug-assertions=on`, `overflow-checks=on` 위에서 잡혔다.

### 0.2 프로파일 배수 — 실측 (저장소 코드 그대로)

`crates/soksak-ptyd/src/ring.rs` 의 `RawRing::push` 를 수정 없이 컴파일해
운영 조건(RING_CAP 256 KiB, 청크 8192 B, 총 100 MB)으로 각 3회:

| 플래그 | 결과 | 중앙값 |
|---|---|---|
| `-C opt-level=0 -C debug-assertions=on -C overflow-checks=on` (cargo dev 등가) | 77.13 / 77.09 / 76.81 MB/s | **77.09** |
| `-C opt-level=3` (cargo release 등가) | 741.52 / 737.03 / 724.66 MB/s | **737.03** |

**배수 = 9.56x.** rustc 1.96.0 stable-aarch64-apple-darwin.
이것은 **한 핫루프의 배수**이지 시스템 전체 배수가 아니다. 시스템 델타는
릴리즈 산출물을 만들어 재기 전까지 **모른다** — 그것이 W0 다.

### 0.3 유휴 CPU — 실측 (창 2개, 입력 0, 30초 CPU시간 델타)

```
  8.00%  pid=82658  WebKit.WebContent   ← 워크스페이스 창 렌더러
  4.17%  pid=82541  soksak-dev          ← Rust 앱
  3.90%  pid=82625  WebKit.GPU          ← 연속 컴포지팅
  0.03%  pid=82626  WebKit.WebContent
  0.03%  pid=82627  WebKit.Networking
  0.00%  pid=82749  WebKit.WebContent
  합계 = 16.13% (1코어 기준)
```

형제 WebContent 가 0.00–0.03% 인데 한 렌더러만 8.00% 다. GPU 프로세스 3.90% 는
"아무 일도 없는데 매 프레임 합성 중" 이라는 뜻이다.

라이브 원인 확정 (소켓 직접 조회):
```
$ SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock \
  src-tauri/target/debug/sok-dev plugin.soksak-plugin-mascot.state
  attached      = False
  holder.inDom  = False   (w=0, h=0)
  tickerStarted = True
```
DOM 에 붙어 있지 않은 WebGL 캔버스를 디스플레이 주사율로 계속 그리고 있다.

### 0.4 터미널 전달 단위 — 저장소 기록으로 증명

기록된 t1 런 9개 전부에서 `writtenBytesDelta / ackSentDelta`:

```
20260711-075708 t1_plain  5168      20260711-142405 t1_plain  5231
20260711-075708 t1_ansi   5179      20260711-142405 t1_ansi   5755
20260711-141852 t1_plain  5166      20260711-142832 t1_plain  5166
20260711-141852 t1_ansi   5220      20260711-145114 t1_plain  5127
                                    20260711-145114 t1_ansi   5128
```

ack 는 `FLOW_ACK_SIZE = 5000` 에서 발화한다
(`~/.soksak-dev/plugins/soksak-plugin-terminal-xterm/src/terminal.ts:25,409`).
전달 단위를 u 라 하면 관측값 = `u × ceil(5000/u)`.
- u = 8192 → 8192. 관측과 불일치.
- u ≈ 1030 → 5150. **관측 5127–5231 과 일치.**

즉 ptyd 가 8192 B 버퍼로 읽어도(`main.rs:1036`) 프런트에 도착하는 단위는
**약 1 KB** 다. 그리고 핀된 tauri rev 의 고속 경로 임계가 정확히 거기 있다:

```
$ grep -n "MAX_RAW_DIRECT_EXECUTE_THRESHOLD\|bytes.len()" \
    ~/.cargo/git/checkouts/tauri-*/a370f65/crates/tauri/src/ipc/channel.rs
39:  const MAX_RAW_DIRECT_EXECUTE_THRESHOLD: usize = 1024;
163:  InvokeResponseBody::Raw(bytes) if bytes.len() < MAX_RAW_DIRECT_EXECUTE_THRESHOLD => {
```
가드가 `< 1024` 이므로 ~1030 B 청크는 **고속 경로를 못 탄다**. 100 MB 당
약 10만 회의 IPC 크로싱 = 스크립트 eval + fetch 왕복.

바이트 내용이 비용에 안 들어간다는 교차 증거: `t1_ansi` 4.49 vs `t1_plain` 4.58 —
**2% 차이**. ANSI 이스케이프가 가득한 스트림과 평문의 비용이 같다는 것은
병목이 파싱이 아니라 **크로싱 횟수**라는 뜻이다.

### 0.5 프런트엔드 전달량 — 실측 (dev 서버 전수 fetch)

| 축 | 바이트 | 비고 |
|---|---|---|
| 원본 소스(테스트 제외) | 1,819,419 | `find src … \| xargs cat \| wc -c` |
| **vite dev 서버 전송 총량** | **4,816,752** (183 모듈, 200 OK 183/183) | `for f in …; do curl -s -o /dev/null -w %{size_download} localhost:1420/$f; done` |
| 프로덕션 번들 | 987,655 (파일 3개) | `cat dist/assets/*.js dist/assets/*.css \| wc -c` |

**dev / prod = 4.88배**, 그리고 창(WKWebView)마다 다시 조립된다.

### 0.6 게이트가 결함을 인증하고 있다 — 저장소 기록으로 증명

마지막 기록된 게이트 리포트 `results/20260711-145114-gate-debug.json`:

| 지표 | baseline | 그날 실측 | 예산 | 판정 |
|---|---|---|---|---|
| t1_plain.mbps | 4.58 | **3.35 (−27%)** | min 3.2 | 통과 |
| t1_ansi.mbps | 4.49 | **3.31 (−26%)** | min 3.1 | 통과 |
| t5_idle.cpu.avg | 46.4 | **51.5 (+11%)** | max 60 | 통과 |
| t6_memory.rssMb | 752.3 | 699.5 | max 978 | 통과 |

예산은 `baseline × headroom` 으로 파생된다(`budgets.json:10-15`). 그래서
**유휴 CPU 46.4% 가 정상 기준이고 60% 까지 통과**하며, **t1 CPU 100.0% 가
기준이고 130% 까지 통과**한다. 회귀 게이트로는 옳은 설계지만, 절대 결함은
구조적으로 검출할 수 없다.

그리고 그 게이트는 돌지 않는다:
```
$ git log --oneline 14d6d7f7 -1
14d6d7f7 perf: record the daemon-window regression runs and the passing gate
$ git log --oneline 14d6d7f7..HEAD | wc -l
     524
$ git log --oneline 14d6d7f7..HEAD -- scripts/perf | wc -l
       2      # 둘 다 순수 rename, 이후 기록된 런 없음
```
마지막 실측 이후 **524 커밋**. `make verify` 에 perf-gate 가 없고
(`Makefile:163`), `.github/workflows/` 에 perf 는 0 hit 이다. CI 가 실제로
돌리는 유일한 perf 항목은 **비교기의 자기 테스트**(`check-budgets.test.mjs`)다.

### 0.7 미측정 — 추측하지 않고 남겨 둔 것

- 릴리즈 프로파일에서의 시스템 전체 성능. **비교 대상 바이너리가 존재하지 않는다.** → W0
- `make verify` / `cargo build` 실제 소요 시간. 실행 측정 안 함. → W11
- 부팅 → 첫 페인트 시간. 저장소에 이 지표를 재는 코드가 0 hit
  (`rg 'coldStart|firstPaint|bootMs'`). → W-M7 의 t7_boot

---

## 1. 진단

세 축은 서로 다른 결함이고, 하나로 뭉뚱그리면 잘못된 곳을 고치게 된다. 축을 먼저 갈라 놓는다.

### (a) 매일 쓰는 실행물이 debug/dev 빌드다

이 축이 지금 사용자가 체감하는 느림의 **최상위 배수**다. 코드를 한 줄도 안 고쳐도 배수가 곱해져 있다.

**a-1. cargo dev 프로파일이 제품이다.**
`src-tauri/Cargo.toml:157` 에 `[profile.release]` 하나만 있고 `[profile.dev]` 도, `[profile.dev.package."*"]` 도, `.cargo/config.toml` 오버라이드도 없다. 워크스페이스 7 멤버 전체(`src-tauri/Cargo.toml:2`)와 lockfile 689 패키지가 cargo 기본값(opt-level=0, debug-assertions, overflow-checks, codegen-units=256)으로 빌드된다. 살아 있는 프로세스가 그 산출물이라는 증거: pid 82541 = `target/debug/soksak-dev`, ppid 82388 = `tauri.js dev`; `~/.soksak-dev/bin/soksak-ptyd-p1` 과 `src-tauri/target/debug/soksak-ptyd` 의 md5 가 동일(`7bdfd45b1b7997e2a1a19638202c2526`). `src-tauri/target/` 에는 `release` 디렉터리가 없다.
기계적으로 확인된 파급: cc-1.2.67 이 `OPT_LEVEL` 을 읽어(`lib.rs:3921`) `-O{level}` 을 그대로 방출하므로(`lib.rs:2138`), `rusqlite features=["bundled"]`(`src-tauri/Cargo.toml:61`) 의 SQLite amalgamation 도 `-O0` 로 컴파일된다. 즉 모든 app.data 쿼리가 최적화 없는 SQLite 를 탄다.
**측정된 배수는 9.5x** — 이 결함의 대표 핫루프인 `RawRing::push` 를 그대로 떼어내 100 MB / 8192 B 청크로 돌리면 `-C opt-level=0 -C debug-assertions=on -C overflow-checks=on` 에서 77.24 MB/s, `-C opt-level=3` 에서 732.43 MB/s. "20-100x" 는 근거 없는 수치이므로 쓰지 않는다.
**추론 표시**: 앰비언트 1h43m 동안 Rust 앱 프로세스(82541)는 CPU 4:33(≈4.4%), 메인 WebContent(82658)는 10:34(≈10.2%) 를 태웠다. 즉 이 축은 배수이지 현재 지배항이 **아니다**. RustCrypto 봉인 경로는 지금 아예 안 뜨겁다 — `records` 11575 행 중 `enc=1` 이 0 행이고, `src-tauri/src/data/store.rs:405` 는 `crypto::active_key` 가 Some 일 때만 봉인한다.
소유 지표: `t1_plain.mbps`, `t1_plain.cpu.avg`, `t2.medianMs`, `t5_idle.cpu.avg` — 단, 오늘은 비교 대상 릴리즈 바이너리가 존재하지 않는다.

**a-2. 프런트엔드가 창마다 vite dev 서버에서 다시 조립된다.**
`src-tauri/tauri.conf.json:8` 이 `devUrl: http://localhost:1420`, `src-tauri/src/window.rs:157-177` 은 windows[0] 을 복제해 쿼리스트링만 바꾸므로 `WebviewUrl::External(devUrl)` 이 그대로 유지된다. 새 창마다 자기 WebKit 프로세스에서 모듈 그래프를 전부 다시 만든다.
바이트로 확인된 것: `react-dom-client.development.js` 1,065,698 B vs production 536,016 B, `.vite/deps/react-dom_client.js` 가 development 번들을 참조, 모든 문서 head 에 `@vite/client` + `@react-refresh` 주입, `main.tsx` 10,398 B → 서빙 25,273 B, `src/` 하위 런타임 모듈 181개 / 1,696,927 B, 그리고 `/src/*` 는 `Cache-Control: no-cache` + weak ETag 라 창마다 181개를 재검증·재변환한다(`/node_modules/.vite/deps/*` 만 immutable).
**정정해서 기록**: 살아 있는 메인 WebContent(82658)는 지금 RSS 193 MB 이고, `t6_memory.rssMb=752.3` 은 identity=debug(= 프로덕션 vite 번들) 에서 잰 값이라 이 축의 증거가 **아니다**. 이건 코드로 고치는 결함이 아니라 `tauri dev` 의 성질이다 — 고칠 것은 "사용자의 일상 실행물이 개발 하니스"라는 사실과, 그 영역을 재는 측정 체계가 없다는 것.
소유 지표: 신규 `t7_boot`(프로세스 기동→첫 페인트), `t6_memory.footprintMb`.

### (b) 코드 구조가 느린 것

**b-1. PTY 1 KB 청크마다 IPC 크로싱 1회 — t1 의 천장.**
`soksak-ptyd/src/main.rs:1036` 이 8192 B 버퍼로 읽고 :1044-1058 에서 배칭 없이 그대로 write, `src/pty.rs:1104-1111` 이 소켓 읽기 1회당 Raw 1개를 재전송, 인프로세스 대체 경로(`pty.rs:442-456`)도 형태가 동일하다. 실측: pty master 읽기 16,266회 중 16,042회가 정확히 1024 B(평균 1020.7 B), raw drain 203 MB/s — 전달 속도 4.58 MB/s 의 44배. 청크가 프런트까지 살아 있다는 증거는 기록된 5개 런 전부에서 written/ack 가 5127-5231 B(FLOW_ACK_SIZE=5000, 즉 5 x ~1033 B)라는 것.
크로싱의 정체: 핀된 tauri rev a370f65 의 `channel.rs:39` `MAX_RAW_DIRECT_EXECUTE_THRESHOLD = 1024`, 가드가 `bytes.len() < 1024` 이므로 1024 B 청크는 `_ =>` 분기(:167-180)로 떨어져 스크립트 eval + `fetch()` POST(ipc-protocol.js:22-58) 를 탄다. `channel_interceptor` 는 어디에도 등록돼 있지 않다. 그리고 리더 스레드에서의 eval 은 `tauri-runtime-wry/src/lib.rs:1766-1775` → `send_user_message:230-250` = 청크당 메인 이벤트루프 wake 1회.
xterm 은 밀린 게 아니라 **굶고 있다**: writeCbLag 92,617 ms / ~102,554 writes = 0.90 ms 평균 → Little's law 로 상주 4.2 writes(≈4 KB), 창은 1 MB. rafFrames 1306/21.85s = 59.8 fps.
바이트 내용이 비용에 안 들어간다는 것이 결정적 — t1_ansi 4.49 vs t1_plain 4.58, 2% 차이.
소유 지표: `t1_plain.mbps`, `t1_ansi.mbps`.

**b-2. rail hole clip 의 소유권이 프로젝트에 있다 — 제스처 시간 O(N).**
`src/App.tsx:1303-1317` 이 세션 유지를 위해 모든 프로젝트를 동시 마운트한다. 각 ProjectPane 이 (a) dep 배열 없는 useLayoutEffect(`src/App.tsx:290-293`) 로 매 커밋마다 `applyRailHoleClip`, (b) `onLayoutMotion` 구독(`:294-309`) 으로 자기 rAF 루프를 돌린다. `applyRailHoleClip` 은 `document.querySelectorAll(HOLE_SLOT_SELECTOR)`(`railHoleClip.ts:72-75`) 로 문서 전체를 훑고, 레이어마다 read `getBoundingClientRect`(:79) → write `style.clipPath`(:84) — 레이어 2개면 1번 write 가 2번 read 를 무효화하는 교과서적 thrash.
같은 소유권 결함이 freeze 엔진에서는 이미 진단·수정돼 있고 문구까지 남아 있다: `src/lib/slotFreezeHost.ts:4-8` "수명은 프로젝트, 범위는 창이라는 불일치 … 프로젝트 N 개면 정착 에지마다 캡처 IPC 가 N 배". railHoleClip 만 창 소유로 옮겨지지 않았다.
**정정**: P4(폴링) 위반은 아니다 — `railHoleClip.ts:56-59` 는 진행 중인 모션에 스코프돼 있고 stop 함수가 있으며 `layoutMotion.ts:90-115` 가 begin/end 를 refcount 한다. 위반은 P5(강제 레이아웃 읽기를 렌더마다 동기 실행 — `docs/PERFORMANCE.md:55-56` 이 명문화) 와 소유권이다. 또 parked pane 은 `contentVisibility:'hidden'`(`layerPark.ts:25`) 이라 rect 가 0x0 로 돌아와 `visibleHoles`(:38) 에서 걸러진다 — N-1 개의 낭비는 "문서 전역 querySelectorAll + 퇴화한 clip write" 이지 전체 강제 레이아웃 N회가 아니다.
소유 지표: 신규 s12(rail glide 프레임타임), 기존 s1/s3 active-phase CPU.

**b-3. sidebarW 가 memo 경계를 넘어 N개 pane 에 브로드캐스트된다 — b-2 의 배수 공급원.**
`src/App.tsx:910-915` useResizableWidth → `:132` rafThrottle 로 프레임당 1회 커밋 → `:1310`(sidebarW), `:1311`(rightW) 로 모든 ProjectPane 에 전달. ProjectPane 은 기본 shallow compare memo(`:165`, 주석 `:162-164` 가 "memo 경계 = project 데이터 경계" 라고 스스로 선언) 라 숫자 prop 변화에 N개가 전부 깨진다. 깨진 pane 은 `:194` 에서 memo 안 된 `solveArrangement`(`src/state/sessions.ts:665-682`) 를 다시 돌리고, dep 에 sidebarW 가 든 useLayoutEffect(`:387-401`) 가 `emitPluginEvent('layout.reflow')` 를 친다.
**정정**: `layout.reflow` fanout 자체는 드래그 중 비싸지 않다 — 실소비자(`soksak-plugin-browser-native/src/browser-view.tsx:427-435`)가 첫 줄에서 `if (veiledRef.current || gestureRef.current) return;` 로 빠지고, gestureRef 는 `layout.resize-gesture`(:367-372)로 세팅되며 `App.tsx:150` 이 폭 드래그 전 구간에 그걸 올린다. 지배항은 N회 재렌더이고, 그게 b-2 를 1회에서 N회로 곱한다. railW 는 전달되지 않고, divider 드래그는 resizeSplits 가 다른 프로젝트의 객체 동일성을 보존하므로 경계를 깨지 않는다.
소유 지표: s3 active-phase CPU, 프레임당 layout.reflow emit 수.

**b-4. mascot 이 화면에 없는 캔버스를 60 fps 로 그린다 — 유일하게 확인된 유휴 CPU 소비자.**
메커니즘은 게이트가 "몰래 뒤집힌" 게 아니라 **게이트가 아예 호출되지 않는다**. `renderer.ts:174` `loadModel()` 이 `this.ensurePixi().stage.addChild(model)` 를 호출하고, ensurePixi(:69-87)는 PIXI 기본 `autoStart:true` 로 `Ticker.shared.add(render)` 를 건다. loadModel 은 `syncTicker()` 를 **한 번도** 부르지 않는다(호출부는 :58 onVisibility, :95 attach, :103 detach 뿐). 모델 복원은 활성화 시 무조건 돈다(`engine.ts:135-140`). 게다가 `@pixi/ticker/lib/Ticker.mjs:249-253` 이 `shared.autoStart = true` 고 `:34-35 _startIfPossible()` 이 `add()`(:80) 에서 도달하므로 `t.stop()` 은 다음 `add` 에 되돌려진다 — 정지 게이트가 구조적으로 유지될 수 없다.
플러그인은 뷰가 없다(`main.ts:1` "뷰 없는 표현 엔진", `plugin.json contributes.views = null`), 상태는 `mascot:false` 라 `MascotOverlay.hide()` 가 `mascot.ts:58` 에서 조기 반환해 detach 에 도달하지 않는다. 즉 `attachedTo` 는 한 번도 세팅된 적이 없다.
라이브 증거: `plugin.soksak-plugin-mascot.state` → `{"attached":false,"holder":{"inDom":false,"w":0,"h":0},"tickerStarted":true}`. `sample 82658` → 5171 샘플 중 166이 `updateRendering`, 122가 rAF JS → WebGL2. `sample 82625`(GPU 프로세스) → `RemoteGraphicsContextGL work queue` 4314 중 86 busy.
**크기 정직하게**: WebContent 약 3.2% 코어 + GPU 프로세스 약 2.0% 코어 ≈ **1 코어의 5%**, 10코어 M1 Pro 기준. 배터리·팬 낭비이지 "앱이 빨라졌다"고 느낄 크기가 아니다. 레이어트리 커밋 비용(recursiveBuildTransaction 16, updateEventRegionsRecursive 14, IPC sendSync 9 샘플)은 무시 가능.
소유 지표: `t5_idle.cpu.avg`(프로세스별 귀속 추가 후).

**b-5. divider hover rAF 루프에 종료 에지가 없다 — 메인라인 폴링.**
`src/App.tsx:859-887`: dividerHoverKey 가 non-null 인 동안 tick(:870-881)이 매 프레임 `document.querySelector`(:871) + `getBoundingClientRect`(:873) 를 돌리고 :880 에서 무조건 재무장한다. IPC 만 rect 시그니처로 게이트된다(:875). 유일한 writer 는 `:838-840`, 소스는 Rust NSEvent **local** monitor 의 MouseMoved 분기(`src-tauri/src/webview.rs:1683-1697`, 등록은 :1730 `addLocalMonitorForEventsMatchingMask`). local monitor 는 이 앱에 배달된 이벤트만 보므로, 포인터가 앱 밖으로 나가면 MouseMoved 가 끊기고 키는 null 로 안 돌아온다. src 전역에 mouseleave/blur/deactivate 리셋이 없다(hit 은 텍스트 입력의 onBlur 두 개뿐).
문서 드리프트도 같이: `src/state/dividerHover.ts:3` 은 "GroupArea 가 구독해" 라고 적혀 있지만 `useDividerHover` 를 import 하는 곳은 `src/App.tsx:63` 뿐이다.
**크기 정직하게**: 창당 1개(effect 가 memo 밖 App 본문에 있음), 프레임당 수십 마이크로초, 그리고 가려진 창에서는 WebKit 이 rAF 를 정지시킨다(`src/plugins/hooks.ts:342-343`). 구조 판정("종료 에지 없는 폴링이 메인라인에 있다")은 유효, CPU 는 사용자 불만을 설명하지 못한다.
같은 경로의 미청구 형제가 더 비싸다: `src/App.tsx:838` 의 25 ms throttled 네이티브 mousemove 핸들러가 `document.elementFromPoint` 를 부른다 — wedge 여부와 무관하게 앱 위 모든 포인터 이동에 대해 초당 ~40회 강제 레이아웃.

**b-6. 부팅 시 34개 플러그인 번들을 직렬로 read+compile 한다 — 창마다, 페인트 전에.**
`src/main.tsx:108` 이 `await initPluginHost()`, `:171` 이 렌더 — 워크스페이스 창은 활성화가 끝날 때까지 아무것도 안 그린다. `src/plugins/host.ts:37` → `src/state/plugins.ts:561` `for (const id of get().enabledIds)` + `:579 await activateRuntime(p)` = 엄격 직렬. 각 회차는 `plugins.ts:433` 에서 `invoke("read_text_file")` — 범용 파일뷰어 커맨드(`src-tauri/src/fs.rs:75-104`: read_to_end → `buf.contains(&0)` NUL 스캔 :91 → 개행 카운트 :96 → `String::from_utf8_lossy(...).into_owned()` :99)가 모듈 전송로로 쓰인다. 스트리밍 컴파일 없음, 모듈 URL 없음, 캐시 없음. 이어서 프런트가 같은 텍스트에 11개 정규식(`hostChrome.js:7-19`, `plugins.ts:438` 에서 `views.length > 0` 인 22개에만 적용)을 돌리고 `loader.ts:60-68` 이 Blob → objectURL → dynamic import.
라이브 수치: 46 플러그인 중 34 enabled, 34/34 entry 보유, 합계 24,672,311 B = **23.5 MB 를 창마다 부팅마다** 읽고 컴파일. 실측(node, 웜 캐시, IPC 제외): read 45.7 ms + chrome-scan 101.9 ms + full-parse 225.0 ms ≈ **0.4 s 바닥 + 34회 직렬 IPC 왕복**. 활성화 계약은 존재하지 않는다 — `@soksak-ai/plugin-spec/dist/spec.d.ts` 에 activationEvents/activateOn/lazy 가 0 hit.
사이드카 축에는 이미 규칙이 있다(`docs/SIDECARS.md §4`: "nothing loads at app start; the first open loads"). 플러그인 축에만 없어서 enabled ≡ 지금-모든-창에서-컴파일 이다.
**추론 표시**: 워크스페이스 렌더러의 945.1 MB footprint 를 이 항목에 귀속시킬 수 없다. 대조군인 컨트롤플레인 창은 `main.tsx:102-104` 가 `<OrchestratorApp/>`, 워크스페이스는 `:171` 이 `<App/>` — 컴포넌트 트리가 아예 다르므로 통제된 실험이 아니다.
소유 지표: 신규 `t7_boot`.

**b-7. 복원 하이드레이션에 천장이 없다.**
`src/state/hydration.ts:40-53` 이 `s.tabs` × `t.contents` × `allGroups` × `g.views` 를 전부 순회해 비가시 플러그인 뷰를 cold 로 표시하고, `:59-75` 의 step 이 `promote(next)` 를 무조건 부르며 큐가 빌 때까지 `ric` 로 재무장한다 — 예산도, 가시성 술어도, 소진 외의 종료 조건도 없다. 승격은 비가역이다: `markCold` 호출부는 `hydration.ts:56` 하나뿐이고 `GroupArea.tsx:709` `const hydrated = !coldSet.has(view.id) || shown;` 이라 cold 집합을 벗어나면 영구 마운트. `GroupArea.tsx:233` 이 불변식을 명문화한다("세션 보존: 터미널/webview 마운트는 절대 깨지 않는다").
즉 "lazy" 는 부팅 스파이크를 idle 콜백으로 퍼뜨릴 뿐, 수 초 내에 모든 프로젝트 탭의 모든 스페이스의 모든 복원 뷰가 완전 마운트된다. 라이브 shape: 6 패널 / 22 뷰, 그중 플러그인 뷰 11개(xterm 2, ghostty 1, design-studio 1, chromium-offscreen 2, chromium 1, browser-native 1, db-studio 1, agent-native 1, kanban 1), 동시에 화면에 있을 수 있는 건 최대 6개.
**정정**: 네이티브 층은 일부 회수된다 — `src/lib/viewPark.ts commitViewVisibility` 가 `webview_visible` 을 호출하고 `view.parked` 를 emit 해 엔진 표면 소유자가 unsnap 한다. 남는 비용은 렌더러 힙과 detached 버퍼이지 살아 있는 GPU 컴포지팅이 아니다.
소유 지표: 부팅 후 60 s 시점 워크스페이스 WebContent footprint, N 에 대한 스윕.

**b-8. projectionWiring 의 sweep 이 coalesce 되지 않는다.**
`src/state/projectionWiring.ts:166-176` 이 selector 없는 bare 구독 4개(useSessions/useViewRegistry/useContractSelection/useProjection)를 걸고 전부 같은 sync() 로 모인다. sync(:108-162)는 프로젝트마다 boundViewOf(전체 split 트리 walk), projectionFor→resolveProjection, 그리고 binding + 좌/우 슬롯 튜플 + pins 를 `JSON.stringify`(:135-140) 해서 지문을 만들고, 다시 전 content/group/view 를 focusHistory GC 로 순회(:146-157)한다. divider 드래그는 `GroupArea.tsx:449-453` 이 rafThrottle 로 프레임당 1회 useSessions 를 쓴다 — projection 이 바뀔 수 없는 write 에 이 sweep 전체가 프레임 레이트로 돈다.
같은 코드베이스에 정답 대조군이 있다: `src/plugins/hooks.ts:338-357` 이 동일한 sessions sweep 을 마이크로태스크로 coalesce 하고 주석까지 달아 놨다("모든 store 쓰기마다 O(n) 스냅샷+diff 를 돌리지 않는다(원칙 1·5) — 드래그 중 resizeSplit 은 60Hz+ 로 쓰지만").
**정정**: 재진입은 루프가 아니다 — `projection.ts:213-224` 의 noteBinding 이 focusHistory[0] 불변이면 동일 객체를 반환해 zustand 가 통지하지 않는다. 그리고 마이크로태스크 coalescing 은 한 동기 버스트 내 다중 write 를 합칠 뿐 프레임당 1 write 를 그 아래로 못 줄인다. 크기는 드래그 중 서브밀리초.

**b-9. tee 두 번째 VT 파스가 측정 PID 집합 밖에 있다.**
`soksak-ptyd/src/main.rs:1051-1055` 가 청크를 구독자마다 복사(`tee.rs:47-50 push_data` = `bytes.to_vec()`, 초과 시 Gap)한 뒤 attached stream 에 쓴다. 측정 대상 pane 에 구독자가 실제로 붙는다: `terminal.ts:467 ensureSession` → `soksak-kit-terminal-common/src/restore.ts:84-108` 이 최대 8 s 동안 `pty.sidecarRequest({op:"ensureSession"})` 를 재시도. `docs/ARCHITECTURE.md` 대로 사이드카는 alacritty_terminal 로 VT 미러를 돌린다 — 세 번째 복사 + 두 번째 완전 VT 파스.
라이브 경로는 보호돼 있어 t1 을 조이지는 않는다. 문제는 **게이트가 못 본다**는 것: `scripts/perf/lib.sh:63-88 find_target_pids` 는 앱 pid + WebKit XPC 만 모으고, ptyd(74536)와 alacritty 사이드카(74411)는 ppid=1 로 reparent 돼 절대 집합에 못 들어온다. 이 축에 일을 옮기면 예산은 깨끗한 100.0 을 계속 보고한다.

**b-10. RawRing 바이트 단위 축출 — 잠복 천장(현재 병목 아님).**
`soksak-ptyd/src/ring.rs:45-53`: `self.buf.extend(bytes.iter().copied())` + `while self.buf.len() > self.cap { self.buf.pop_front(); }`. VecDeque 는 `Copied<slice::Iter<u8>>` 에 memcpy 경로가 없어 append 가 바이트 단위, 축출 루프는 무조건 바이트 단위. RING_CAP 256 KiB(`main.rs:67`), 읽기 버퍼 8192(`main.rs:1036`), 세션 락(`main.rs:1048`) 안에서 돈다. 같은 파일의 tee 는 이미 bulk copy 라 이 링이 예외다.
**임팩트는 작다**: `t1_plain.cpu.avg=100.0` 은 구성상 ptyd 를 아예 배제한다(위 b-9). 이 루프를 dev 프로파일로 재면 77.24 MB/s 이므로 관측 4.58 MB/s 에서 코어의 약 5.9% 를 쓴다. 라이브 dev ptyd(74536)는 1일 6시간 가동에 CPU 0:04.85. b-1 을 고친 뒤에야 의미가 생기는 천장이다.

### (c) 개발 루프가 느린 것

**추론이며 실행 측정은 안 했다.** lockfile 689 패키지, rlib 717개, fingerprint 유닛 1345개, `target/debug` 22 GB. `make verify`(`Makefile:163`) = spec-gate + node 게이트 7종 + tsc + `cargo check` + `cargo test` + vitest(테스트 파일 152개, `#[test]` 320개). `check` 와 `test` 는 fingerprint 가 분리돼 있어 의존 그래프를 두 번 걷는다. 이 축은 사용자 체감 "앱이 느리다" 와 무관하므로 아래 계획에서 우선순위 최하위에 둔다.

### 배제된 것(다시 쫓지 말 것)

- 하니스의 `ps %cpu` 샘플러가 거짓말하는 것 아님 — cputime-delta 대조 2회(25.9 vs 27.1, 18.3 vs 18.8)로 검증. 46.4 는 실재한다.
- src/ 에 무한 CSS 애니메이션 없음. `src/assets/logo-animated` 는 참조 0.
- Rust 스케줄러는 Condvar/kevent 파킹이지 폴링 아님.
- `docs/webview-leak-fix.md` 항목은 **고쳐져 있다** — `src-tauri/Cargo.toml:147-153` 의 `[patch.crates-io]` tauri rev a370f65 가 `Retained::as_ptr` 를 쓴다. `with_webview_balanced` 도 `browser.rs` 도 트리에 없다.
- 부팅 DB 작업은 싸다: 55.8 MB `soksak.db` 에 `PRAGMA quick_check` 123 ms, FTS 14테이블 reconcile 11 ms(사본 측정).
- `src/main.tsx:169` 가 StrictMode 를 끄므로 dev 이중 렌더는 기여자가 아니다.
- `::-webkit-scrollbar`(`App.css:23`)는 문서대로 A/B 측정됨(`results/20260612-141720-scroll-B2` ≈ `141503-scroll-B`) — 위반 아님.
- freeze-frame 캡처는 슬롯별 영역, 비동기, 350 ms 디바운스(`slotFreezeHost.ts:17,35`) — 준수.
- KILLED: "idle 예산이 결함을 baseline 으로 박제했다"의 역사 주장 — baseline 은 identity=debug 로 잡혔고 `~/.soksak-debug` 가 이 기계에 없어 2026-07-11 당시 플러그인 population 을 복원할 수 없다. 계측기 결함 부분은 §4 에서 별도로 다룬다.

## 2. 왜 지금까지 안 잡혔나

**게이트가 실행된 적이 없다. 실행되는 건 게이트의 자[尺]뿐이다.**
`Makefile:163` `verify: spec-gate gates typecheck check test test-front` — perf-gate 가 없다. `Makefile:181-183` 의 perf-gate 는 독립 타깃이고, `grep -rn perf-gate Makefile .github/ scripts/ docs/` 는 자기 정의 한 줄만 돌려준다. `rg -n perf .github/workflows/` 는 0 hit; `verify.yml` 은 `make verify`, `make build-debug`, `sok-debug --help` 만 돈다. 다만 `vitest.config.ts:13` 의 `"scripts/**/*.test.mjs"` 때문에 `make verify` 는 `scripts/perf/check-budgets.test.mjs` — **비교기의 자기 테스트** — 를 실행한다. CI 초록은 "perf 게이트가 살아 있다"는 외관만 만든다. `docs/CI-STATUS.md`("어떤 게이트도 실행 전에 살아 있다고 주장하지 않는다"는 원장)에는 "perf" 가 0회 등장하고 verify.yml 자체가 **0 runs** 로 기록돼 있다.
정확한 거리: 마지막 실측 기록 커밋은 **14d6d7f7**(2026-07-11, "perf: record the daemon-window regression runs and the passing gate"). `git log --oneline 14d6d7f7..HEAD | wc -l` = **524**. `git log 14d6d7f7..HEAD -- scripts/perf | wc -l` = **2**, 둘 다 순수 rename(c935666b, 4a6ea35e) 이고 드라이버가 몰던 터미널 프로그램 이름을 재지정한 것인데 그 뒤 기록된 런이 없다. (배포된 브리프의 "1302 커밋", "81 커밋", "16 커밋" 은 잘못된 base 에서 나온 수치다. 쓰지 않는다.)

**회귀 게이트와 절대 결함을 구분하지 못한다.**
`scripts/perf/budgets.json:10-15` 가 파생 규칙을 명시한다 — `baseline x 0.7`, `baseline x 1.3`. `scripts/perf/README.md:44-45` 는 "초기값은 첫 실측에서 유도한다(수치 선긋기 금지)" 로 목표 설정을 **금지**한다. 결과: `t5_idle.cpu.avg 46.4 → max 60`, `t1_plain.cpu.avg 100.0 → max 130`, `t1_plain.mbps 4.58 → min 3.2`, `t6_memory.rssMb 752.3 → max 978`. 2026-06 감사의 헤드라인 증상(WebContent ~100%)이 그대로 기준점이 됐고 천장이 130% 다. 게이트는 사용자의 불만에 발화할 **구조적 능력이 없다** — 이미 망가진 상태보다 30% 더 나빠져야 운다. 실제로 마지막 기록 게이트(`20260711-145114-gate-debug.json`)는 t1_plain 3.35(-27%), t1_ansi 3.31(-26%), t5_idle 51.5(+11%) 인데 8개 예산을 전부 통과했다.
`docs/PERFORMANCE.md` 에는 `### ` 원칙 7개(17,29,37,43,50,84,92행)가 있고 수치 목표는 하나도 없다 — 허용 유휴 CPU, 처리량, 프레임타임, 기동시간 어느 것도 명시가 없다. `budgets.json:2-9` meta 에도 target/goal 필드가 없다.

**초록 신호가 정보를 담고 있지 않다.**
(1) 비교기가 조건을 안 본다: `scripts/perf/check-budgets.mjs:29-46` 의 `checkBudgets` 는 `report?.scenarios` 만 열고 함수 안에 `meta` 라는 단어가 없다. 반면 유효성 조건은 세 곳에 선언돼 있다 — `budgets.json:5-9`, `run-t.sh:15-16`("창 개수가 다르면 예산 비교는 무효"), `README.md:39-40`. `run-t.sh:130` 은 windowsOpen 을 성실히 기록한다. 강제는 0곳. `IDENTITY=dev make perf-gate` 도 창 1개짜리 런도 windowsOpen=7 debug 예산에 조용히 통과한다. `check-budgets.test.mjs:9-74` 의 5개 테스트는 전부 비교기 모양(min/max/MISSING/경계/비숫자)만 보고 meta 는 하나도 안 본다 — 자기 테스트의 형태가 구멍을 고정시켰다.
(2) 모든 예산이 n=1: 동일 선언 조건(identity=debug, windowsOpen=7, M1 Pro)의 2026-07-11 네 런에서 `t5_idle.cpu.avg` 가 46.4 / 14.9 / 8.4 / 51.5 — 6.1배 스프레드, 관측 밴드 43.1 포인트인데 baseline 위 헤드룸은 13.6 포인트. baseline 46.4 는 재현되지 않는다.
(3) 샘플러가 주장하는 것을 잴 수 없다: `lib.sh:92-101` 은 `ps -o %cpu` 를 0.5 s 간격으로 읽는데 `man ps` 는 "%cpu … a decaying average over up to a minute of previous (real) time". `run-t.sh:60-71` 은 앱 활성화 → sleep 1 → setup-t(드라이버 spawn + 터미널 생성) 뒤에 10 s 유휴 창을 열므로 셋업 버스트의 감쇠를 그대로 상속한다. `run.sh:94-96` 의 TAIL_SEC=8 은 "지연 스파이크 검출"이 목적인데 바로 앞 active phase 의 감쇠를 먹는다. `lib.sh:104-111 aggregate_stdin` 은 avg/max/samples 만 내보내고 분산이 없어, 하니스는 자기가 노이즈라는 사실조차 보고할 수 없다.

**느껴지는 축에 시나리오가 없다.**
`run.sh:155-158`: `s[3-6]` 은 권한이 없으면 `{"skipped":true}` 로 사라지고 루프는 계속, exit 0 — 모든 스크롤과 모든 실제 포인터 드래그가 그렇다. `jq -r '.budgets|keys[]' budgets.json` 은 t* 8개, s* 0개. `check-budgets` 는 `run-t.sh:145` 한 곳에서만 호출되므로 run.sh 는 아무것도 게이트하지 않고, 침묵 누락 방지 장치인 MISSING 가드가 인터랙션 축을 아예 안 덮는다. s1/s2 는 `driver.mjs:266-311` 의 `panel.resize` / `view.move` RPC 라 마우스 제스처 채널을 안 탄다 — `results/20260704-d-drag-freeze-gate.md` 가 스스로 적어 놓았다("소켓 panel.resize 스톰(s1)은 마우스 제스처 채널을 타지 않아 freeze 미개입").
`rg -l 'coldStart|cold-start|startupMs|bootMs|firstPaint|first-paint'` = 0 hit. 프레임타임도 드롭 프레임도 어떤 지표도 아니다. `driver.mjs:619` 는 t2 measurementPoint 를 "socket RPC/paint excluded" 로 기록한다.
그리고 실패한 시나리오가 통과 점수를 낸다: `driver.mjs:574` 가 mbps 를 디스크 픽스처 크기로만 계산하고 exitCode 나 writtenBytesDelta 와 대조하지 않는다 — `20260711-142832-ab-local-debug.json` 은 t1_ansi exitCode 1, writtenBytesDelta 765 인데 mbps 10000(min 예산의 3125배)으로 기록됐다. `20260711-142405-gate-debug.json` 은 두 t1 런 모두 rafFramesDelta 0(100 MB cat 동안 프레임 0장)인데 rafFrames·writeCbLagMs·exitCode 를 덮는 예산 키가 없다.

**공정한 인정**: 제스처 축이 완전한 무측정은 아니다. `results/20260704-d-drag-freeze-gate.md` 에 네이티브 ~30Hz divider 드래그의 실제 CPU A/B(freeze 전 31.9% vs 후 10.4/14.4%)가 있고, 정합성 E2E 두 개(`scripts/e2e/slot-freeze.mjs` — `make test-e2e` 포함, `scripts/e2e/divider-freeze.sh` — 미포함)가 freeze 기계를 덮는다. 없는 것은 **비용 시나리오**다: divider-freeze.sh 에 sample_cpu 도 CPU 단언도 없고, 2026-07-04 A/B 는 원장 1회성이며 시나리오나 예산으로 성문화되지 않았다.

**그리고 결정적으로, 게이트는 사용자의 실행물을 잴 수 없다.** 모든 예산은 identity=debug 에 핀돼 있는데 `~/.soksak-debug/*.sock` 이 지금 존재하지 않고(`run-t.sh:46` 이 여기서 abort), 사용자는 `target/debug/soksak-dev` 를 쓴다. `lib.sh identity_proc_pattern` 은 `dev` 를 매핑하고 있어 `run-t.sh --identity dev` 가 **지원은 된다** — 한 번도 baseline 을 잡지 않았을 뿐이다.

## 3. 개선 계획

작업 순서는 (임팩트 / 노력). 레인 표시가 같은 항목은 순차, 다른 항목은 병렬 가능.

---

### W0. 측정 가능한 두 번째 실행물을 만든다 — release 프로파일 baseline (레인 A, 선행 필수)

**근본 원인.** 최적화된 산출물이 이 체크아웃에 존재한 적이 없고(`ls src-tauri/target/` → CACHEDIR.TAG, debug, tmp), 성능 표준 전체가 비최적화 Rust 위에서 잡혔다. 배수를 모르면 나머지 모든 항목의 임팩트를 판정할 수 없다.

**바꿀 것.** 소유 파일 `scripts/perf/run-t.sh` + `scripts/perf/budgets.json`. 규칙 신설: **모든 perf 리포트는 cargo 프로파일을 meta 에 기록한다.** `run-t.sh` 가 대상 바이너리에서 프로파일을 판별해(경로 `target/release` vs `target/debug`, 또는 빌드시 주입되는 상수) `meta.conditions.cargoProfile` 을 쓰고, `check-budgets.mjs` 가 이 필드 불일치를 거부한다(§4 의 W-M1 과 같은 변경). 동시에 `docs/PERFORMANCE.md` 에 여덟 번째 원칙을 추가한다: **"성능 수치는 프로파일을 명시하지 않으면 무효다."** 지금 이 문서에는 opt-level/profile/unoptimized 가 0 hit 이다.

**RED.**
```
# 1) 현재 상태를 고정
bash scripts/perf/run-t.sh --identity dev --scenarios t1_plain,t1_ansi,t2,t5,t6
# 2) 릴리즈 산출물 생성 (이 체크아웃 최초)
pnpm tauri build --config <release cfg>   # 또는 make 상당 타깃
# 3) 같은 커밋, 같은 창 population 으로 재측정
bash scripts/perf/run-t.sh --identity release --scenarios t1_plain,t1_ansi,t2,t5,t6
```
RED 조건: 두 리포트의 `meta.conditions.cargoProfile` 이 다른데 `node scripts/perf/check-budgets.mjs` 가 **통과**한다 — 비교기가 프로파일을 안 보는 결함이 그대로 드러난다.

**GREEN.** 비교기가 프로파일 불일치를 `INVALID` 로 거부하고 exit≠0. 그리고 두 리포트의 델타가 기록으로 남는다. 나는 이 델타를 예측하지 않는다 — 유일하게 측정된 대리값은 대표 핫루프 단독 **9.5x**(77.24 → 732.43 MB/s)이고, 시스템 전체 델타는 재 봐야 안다. 앰비언트 CPU 배분(Rust 4.4% vs WebContent 10.2%)은 시스템 델타가 9.5x 보다 **훨씬 작을 것**을 시사한다.

**비용/위험.** 릴리즈 빌드 1회(689 패키지, lto=thin, codegen-units=1 — 수십 분 예상, 미측정). 사용자의 돌고 있는 dev 앱은 건드리지 않는다 — 별도 산출물이므로 R-불가침 위반 없음. 위험: 이 항목이 "그럼 release 로 쓰면 되잖아" 로 오독되는 것. 아니다 — 개발자가 dev 를 쓰는 건 정상이고, 결함은 **표준이 어느 프로파일에서 잡혔는지 아무 데도 안 적혀 있다**는 것이다.

---

### W1. PTY 전달 단위를 청크에서 배치로 바꾼다 (레인 B, W0 과 독립)

**근본 원인.** 전달 단위가 "pty read 1회" 로 고정돼 있고, 그 단위가 macOS pty master 의 1024 B 상한과 같아 IPC 크로싱 수 = 바이트 수 / 1024 로 못박혀 있다. 비용이 바이트가 아니라 크로싱에 붙는데(ansi 4.49 vs plain 4.58, 2% 차) 아무도 그 단위를 소유하지 않는다.

**바꿀 것.** 소유 파일 `crates/soksak-spec-pty/src/lib.rs` — 지금 여기에 있는 모델 문장이 반증됐다: "The high mark is the throughput ceiling: bulk output moves in pause/drain cycles, so sustained rate ~= window / ack-loop round trip". `git show f104e423`(윈도 100k→1M, 저수위 5k→500k)가 이 모델의 A/B 다 — 창을 10배 넓혀 **+11%**(3.02 → 3.35). 서비스레이트 한계이지 윈도 한계가 아니다. 이 문장을 삭제하고 **전달 계약**으로 대체한다: *"PTY 출력의 전달 단위는 read 단위가 아니다. 프로듀서는 크기 임계(≥64 KiB) 또는 데드라인(≥N ms) 중 먼저 도달한 쪽에서 배치를 방출한다."* 시행 지점 두 곳: `crates/soksak-ptyd/src/main.rs:1036-1058`(데몬), `src-tauri/src/pty.rs:442-456`(인프로세스) + `src-tauri/src/pty.rs:1104-1111`(재전송 레그). 데드라인은 인터랙티브 지연을 지키기 위한 것이지 폴링이 아니다 — 타이머는 데이터가 있을 때만 무장하고 방출과 함께 해제된다.
부수: `FLOW_ACK_SIZE=5000`(`terminal.ts:25/409`)은 배치 뒤 재도출해야 한다. 지금은 100 MB 당 20,512회 ack invoke = 전 전달단위의 16.5% 가 데이터 플레인이 이미 포화시킨 같은 직렬 메인스레드를 탄다.

**RED.**
```
bash scripts/perf/run-t.sh --identity dev --scenarios t1_plain,t1_ansi
jq '.scenarios.t1_plain | {mbps, cpu, counters}' scripts/perf/results/<new>.json
```
RED 조건: `writtenBytesDelta / ackSentDelta ≈ 1033`(오늘 기록된 5개 런 전부 5127-5231 B / 5000 B ack) 이고 `mbps < 10`.

**GREEN.** 같은 명령, 같은 창 population, 같은 프로파일에서:
- `writtenBytesDelta / ackSentDelta ≥ 60000`(배치가 실제로 형성됐다는 직접 증거)
- `t1_plain.mbps ≥ 100`, `t1_ansi.mbps ≥ 100`.

**100 을 쓰는 근거(R4 — 낮추지 않는다).** 발명한 숫자가 아니다. 같은 기계에서 측정된 상류 레이트가 하한을 준다: pty master raw drain **203 MB/s**, 프런트 관측 파서 **248 MB/s(plain) / 227 MB/s(ansi)**(V8, 실제 1 KB 양자). 즉 데이터 경로의 양 끝이 200 MB/s 대에 있고 그 사이에 있는 것이 크로싱뿐이다. 64 KiB 배치는 크로싱을 ~64배 줄인다. 100 MB/s 는 그 두 실측값의 절반 이하로 잡은 보수적 목표다. 이 목표를 못 맞추면 예산을 넓히지 말고 **다음 병목을 실측으로 특정**한다.
GREEN 의 부수 신호(예산 아님, 관측용): `writeCbLagMs` 는 **올라가야** 정상이다 — 백로그가 IPC 안에서 xterm 안으로 이동한다는 뜻이고, 그게 있어야 할 자리다. 지금 xterm 은 1 MB 창에 4.2 writes(≈4 KB)만 상주한 굶은 상태다.

**비용/위험.** 데드라인 상수가 인터랙티브 에코 지연을 늘릴 수 있다 — `t2.medianMs` 로 방어한다(예산 max 4.5, 오늘 baseline 1). 데몬/인프로세스 두 백엔드가 형태가 같으므로 두 곳 다 고쳐야 하고, 한 쪽만 고치면 A/B 가 오염된다. tauri 의 1024 임계(`channel.rs:39`)는 우리가 못 바꾸지만 배치가 그 위로 올라가면 무관해진다.

---

### W2. rail hole clip 의 소유권을 프로젝트에서 창으로 옮긴다 (레인 C, W1 과 독립)

**근본 원인.** 창 스코프 자원(레일 구멍 clip)을 프로젝트 수명 컴포넌트가 소유한다. 프로젝트 N개면 프레임당 문서 전역 스캔이 N회. 동일 결함이 freeze 엔진에서 이미 진단·수정됐고 문장까지 남아 있다 — `src/lib/slotFreezeHost.ts:4-8`.

**바꿀 것.** 소유 파일 신설 `src/lib/railHoleClipHost.ts`(slotFreezeHost 와 동일 패턴): 창당 1개 호스트가 모션 구독과 rAF 를 소유하고, ProjectPane 은 자기 plane 을 등록/해제만 한다. `src/App.tsx:290-293` 의 dep 없는 useLayoutEffect 는 제거한다 — `docs/PERFORMANCE.md:55-56` 이 명문으로 금지한다("Forced layout reads (getBoundingClientRect etc.) never run synchronously per render — move them to rAF timing"). `src/lib/railHoleClip.ts:71-91` 의 read→write→read 인터리브는 두 페이즈로 분리한다(전 레이어 rect 를 먼저 읽고, 그 다음 전 레이어 clipPath 를 쓴다).
동시에 W3 이 필요하다 — sidebarW 브로드캐스트가 N 배수를 공급하므로 둘은 같은 레인이다.

**RED.** 신규 시나리오 `s12`(§4 에서 정의): 실제 포인터 채널로 rail glide 를 구동하고 프레임타임/드롭 프레임을 센다. 기존 s1/s3 는 소켓 RPC 라 제스처 채널을 안 탄다(`results/20260704-d-drag-freeze-gate.md` 가 명시).
```
bash scripts/perf/run.sh --scenarios s12 --projects 6
```
RED 조건: 프로젝트 6개에서 드롭 프레임 수가 프로젝트 1개 대비 선형 증가(≥3배). 부수 RED: 신규 vitest 유닛이 `applyRailHoleClip` 호출 수를 세어, N개 pane 마운트 상태에서 프레임당 N회임을 단언하고 실패한다.

**GREEN.** 같은 `s12`: 프로젝트 1개 대비 6개의 드롭 프레임 증가가 **≤20%**(창 소유이므로 원리상 O(1)). vitest 유닛: 프레임당 `applyRailHoleClip` 호출 정확히 1회.

**비용/위험.** 등록/해제 수명이 틀리면 clip 이 안 걸리거나 유령 plane 이 남는다 — `scripts/e2e/slot-freeze.mjs` 와 같은 급의 정합성 E2E 를 railHoleClip 에도 붙여야 한다. UI 변경이므로 R3: 글라이드 전/중/후 스크린샷 확인 필수.

---

### W3. memo 경계를 데이터 경계로 되돌린다 — 크롬 폭을 프로젝트에 넣지 않는다 (레인 C, W2 와 순차)

**근본 원인.** `src/App.tsx:162-164` 가 "memo 경계 = project 데이터 경계" 라고 스스로 선언해 놓고, `:1310-1311` 에서 사이드바 크롬 폭(sidebarW, rightW)을 프로젝트 prop 으로 밀어 넣는다. 크롬 폭은 프로젝트 데이터가 아니다.

**바꿀 것.** 소유 파일 `src/App.tsx`. 폭을 prop 대신 창 스코프 채널로 넘긴다 — CSS 변수(레이아웃 커밋 불필요) 또는 ProjectPane 이 selector 로 구독하는 전용 store. `docs/PERFORMANCE.md` 원칙 2(memo 경계)를 시행하는 변경이지 새 규칙이 아니다. 부수: `:194` 의 memo 안 된 `solveArrangement`(`src/state/sessions.ts:665-682`) 도 이 커밋에서 함께 캐시한다.

**RED.**
```
pnpm vitest run src/App.perf.test.tsx   # 신규
```
프로젝트 6개 마운트 후 sidebarW 를 1프레임 변경했을 때 ProjectPane 렌더 횟수를 세는 테스트. RED: 6.

**GREEN.** 같은 테스트: 1(=드래그 중인 창 크롬만). 그리고 `s3` active-phase CPU 가 프로젝트 수에 대해 평탄(6개 vs 1개 차이 ≤20%).

**비용/위험.** 낮다. 단, `layout.reflow` emit 이 N→1 로 줄면서 플러그인이 그걸 세고 있었다면 계약 영향 — 실소비자는 어차피 제스처 중 첫 줄에서 빠지므로(`browser-view.tsx:427-435`) 실질 위험 없음.

---

### W4. mascot 의 티커 소유권을 고친다 (레인 D, 완전 독립)

**근본 원인.** 두 개의 독립 결함. (1) `renderer.ts:174 loadModel()` 이 `ensurePixi()`(PIXI 기본 `autoStart:true`) 를 통해 `Ticker.shared` 에 렌더를 걸면서 `syncTicker()` 를 호출하지 않는다 — 게이트가 우회된 게 아니라 **불려지지 않는다**. (2) `@pixi/ticker/lib/Ticker.mjs:249-253` 이 `shared.autoStart=true` 이고 `_startIfPossible()`(:34-35)이 `add()`(:80)에서 도달하므로, 성공한 `stop()` 도 다음 `add` 가 되돌린다. 정지 게이트가 구조적으로 유지 불가능하다.

**바꿀 것.** 소유 파일 `~/.soksak-dev/plugins/soksak-plugin-mascot/src/renderer.ts`. `Ticker.shared` 를 쓰지 않는다 — `sharedTicker:false` + `autoStart:false` 로 전용 티커를 만들고, 렌더 루프의 유일한 시작/정지 지점을 `syncTicker()` 로 만든다. `loadModel()` 도 `syncTicker()` 를 통과해야 한다. 즉 **"이 렌더러의 티커는 syncTicker 만이 켜고 끈다"** 를 클래스 불변식으로 세운다.
추가로 `preserveDrawingBuffer:true`(`renderer.ts:79`)를 정상 경로에서 빼낸다. 인코드 주석(:77-78)이 근거를 시각 E2E 스냅샷으로 명시하고 비용을 "아바타 1장 스테이지라 비용 미미" 로 **측정 없이** 기각한다. 테스트 요구가 프로덕션 렌더 설정을 규정하는 것이 결함이다 — 캡처 시점 토글(켜고, 한 프레임 그리고, 읽고, 끈다)로 옮긴다. 주의: `antialias:true`(:73)와 `resolution`(:75)은 이 주석이 정당화하지 않으므로 이 항목에서 건드리지 않는다. 그리고 현재 백킹 스토어는 부풀지 않았다 — `attachedTo` 가 null 이라 `resize()` 가 `renderer.ts:105` 에서 조기 반환해 PIXI 기본 800x600@2x = 1600x1200 에 머물러 있다(`@pixi/core/lib/Renderer.mjs:123` 상 `renderer.width` 는 이미 물리 픽셀).

**RED.**
```
sok plugin.soksak-plugin-mascot.state    # 또는 소켓 RPC
```
RED 조건: `attached:false, holder.inDom:false` 인데 `tickerStarted:true`(오늘 라이브 값). 이것을 그대로 플러그인 repo 의 헤드리스 테스트로 성문화한다 — 모델 로드 후 attach 없이 `tickerStarted` 를 단언.

**GREEN.** 같은 상태 조회에서 `attached:false` 이면 `tickerStarted:false`. 그리고 `sample <plugin-window WebContent pid> 5` 에서 `serviceRequestAnimationFrameCallbacks` 샘플 0. 회수량은 정직하게 **1 코어의 약 5%**(WebContent 3.2% + GPU 2.0%) — 10코어 기계에서 사용자가 "빨라졌다"고 느낄 크기가 아니라 배터리/팬 항목이다.

**비용/위험.** 매우 낮음, 완전 격리. 위험은 전용 티커 전환이 다른 PIXI 소비자와 프레임 동기를 깨는 것 — 이 플러그인은 스테이지가 하나라 해당 없음.

---

### W5. 뷰 가시성 계약을 코어에 신설한다 (레인 D, W4 와 순차)

**근본 원인.** 플러그인 뷰 계약(`src/plugins/viewRegistry.ts:52-60`)이 `mount / unmount? / setFocused? / prepareFocusTransfer?` 만 노출한다. `setFocused` 는 활성 체인 **포커스** 신호이지 가시성이 아니다. `docs/PERFORMANCE.md:99-105` 의 "Plugin performance contract" 는 이벤트 핸들러 내부의 동기 작업만 규율하고 연속 렌더 루프에 대해 아무 의무도 부과하지 않는다. `src/plugins/api.ts:460, 1860-1869` 의 `visible` 은 **네이티브 자식 웹뷰**용이다. 어떤 플러그인도 "내 픽셀이 화면에 있는가" 를 알 수 없어 각자 다른 술어로 추측한다.

**정직한 크기 조정.** 이건 오늘의 비용이 아니라 표준의 구멍이다. 브리프가 피해자로 든 두 플러그인은 **반증**이다 — `overlay-sakura/main.js:82,84` 는 `isConnected` 와 입력 유휴 양쪽에서 자진 종료하고, `overlay-shark/main.js:147` 도 `isConnected` 로 게이트한다. 둘 다 올바르다. mascot 은 뷰가 없어서 이 신호가 있었어도 못 막았다. 그러니 이건 **재발 방지**이지 회수가 아니다.

**바꿀 것.** 소유 파일 `src/plugins/viewRegistry.ts` + `docs/PERFORMANCE.md`. `PluginViewProvider` 에 `setVisible?(visible: boolean)` 을 추가하고, 코어만 아는 사실(활성 뷰, 배경 탭, 가려진 창)을 여기로 흘린다. 문서에 플러그인 성능 계약 조항 추가: **"연속 렌더 루프는 setVisible(false) 이후 프레임을 그리지 않는다."** 그리고 conformance 테스트로 시행한다 — `project_plugin-conformance-v1` 의 헤드리스 게이트에 붙인다.
부수 정리: `docs/PERFORMANCE.md:101` 이 언급하는 `onDidChangeActiveView` 는 TS 소스 어디에도 존재하지 않는다(--type ts 전역 0 hit). 문서가 없는 API 를 가리키고 있다.

**RED.** 신규 conformance 케이스: 더미 플러그인이 rAF 루프를 돌리고 `setVisible(false)` 후에도 프레임을 그리면 실패. 오늘은 API 가 없어 컴파일 자체가 안 되는 것이 RED.

**GREEN.** conformance 스위트 통과 + `t5_idle.cpu.avg` 를 **프로세스별 귀속**으로 측정했을 때(§4 W-M2), 뷰가 가려진 창의 WebContent 가 0.5% 미만.

**비용/위험.** 계약 추가이므로 기존 플러그인 26+개 호환 — optional 로 두면 breaking 아님. 위험: 가시성 판정을 코어가 틀리면 화면에 있는 뷰가 멈춘다. R3 대로 스크린샷 검증 필수.

---

### W6. 플러그인 활성화 계약을 만든다 — enabled ≠ 지금 모든 창에서 컴파일 (레인 E, 독립)

**근본 원인.** 활성화 계약이 존재하지 않는다. `@soksak-ai/plugin-spec/dist/spec.d.ts` 에 activationEvents/activateOn/lazy 가 0 hit 이라 `enabled` 가 곧 "부팅 시, 창마다, 페인트 전에, 직렬로 read+compile" 을 의미한다. 사이드카 축에는 이미 정답 규칙이 있다 — `docs/SIDECARS.md:157` "nothing loads at app start; the first `app.sidecar.open(name)` loads."

**바꿀 것.** 소유 파일 `@soksak-ai/plugin-spec`(계약) + `src/state/plugins.ts:561-581`(시행). 매니페스트에 활성화 조건을 선언하게 하고(뷰 열림 / 커맨드 호출 / 이벤트), 부팅 시에는 매니페스트만 읽는다. 부수로 모듈 전송로를 고친다: 지금은 범용 파일뷰어 커맨드가 모듈을 나른다 — `plugins.ts:433 invoke("read_text_file")` → `src-tauri/src/fs.rs:75-104` 가 read_to_end 후 NUL 스캔(:91), 개행 카운트(:96), `String::from_utf8_lossy(...).into_owned()`(:99). 스트리밍 컴파일도, 모듈 URL 도, 캐시도 없다. 플러그인 모듈은 자기 전송로(모듈 URL 또는 캐시되는 전용 커맨드)를 가져야 한다.
`src/plugins/loader.ts:1` 이 "entry is evaluated in the window realm (v1)" 이라고 적어 놓았으므로 그래프가 창마다 사는 것은 설계다 — 창 수 배수는 구조이지 버그가 아니다. 고칠 것은 **얼마나 많이** 창마다 사느냐다.
같은 항목에 `soksak-plugin-browser-chromium` 을 넣는다: `plugin-entry.tsx:42` 가 `activate()` 안에서 `scheduleOrphanSweep(app)` 를 무조건 부르고, 그게 `chromium-adapter.ts:219 engineOwnedIds` → `:197 send({type:"stats"})` → `:321 app.sidecar.open("browser-chromium")` → 코어 dlopen + 메인스레드 CEF init(`src-tauri/src/sidecar.rs:236,242,278,295` — `run_on_main_thread` 랑데부, 10 s 캡)로 이어진다. 이건 §4 의 사이드카 규칙 위반이다 — activate() 가 무엇을 해도 되는지에 코어가 계약을 안 걸어서 생긴다. **정정해 둘 것**: activate 는 `scheduleOrphanSweep` 을 await 하지 않고(`plugin-entry.tsx:42` 는 맨 호출, `chromium-adapter.ts:219` 는 프라미스만 보관) 모듈은 `sidecar.rs:426-452` 의 전역 MODULES 맵에 캐시되므로 창 수만큼 곱해지지 않는다. 확정 비용은 항상 켜진 CEF 서비스 3종 **78.8 MB**(gpu 34.0 + 24.9 + 19.9, ppid=82541, 앱보다 8 s 늦게 기동) 와 메인스레드 랑데부 결합이다. "부팅 수백 ms" 는 측정된 바 없다.

**RED.** 신규 시나리오 `t7_boot`(§4): 프로세스 기동 → 워크스페이스 창 첫 페인트 wall time, 그리고 T+30 s 시점 `soksak-sidecar-browser-chromium` 프로세스 수.
```
bash scripts/perf/run-t.sh --identity dev --scenarios t7_boot
```
RED 조건: 브라우저 뷰가 하나도 없는 레이아웃에서 `t7_boot.chromiumProcs > 0`, 그리고 `t7_boot.bytesCompiled ≈ 23_500_000`.

**GREEN.** 같은 명령: 브라우저 뷰 없는 레이아웃에서 `chromiumProcs == 0`, `bytesCompiled ≤ 3_000_000`(뷰를 기여하는 플러그인만 즉시 활성 — 오늘 34개 중 22개가 뷰 기여이므로 이것도 더 줄어야 한다), `t7_boot.firstPaintMs` 를 baseline 대비 절대 목표로 §4 에서 논증한다.
계산 근거: 오늘 측정된 활성화 바닥은 read 45.7 ms + chrome-scan 101.9 ms + full-parse 225.0 ms = **372.6 ms**(IPC 34회 왕복 제외, node 측정이라 JSC 대리값). 이건 순수 CPU 바닥이고 직렬 IPC 왕복이 그 위에 얹힌다.

**비용/위험.** 크다, 그리고 숨기지 않는다 — 계약 신설 + 46개 플러그인의 매니페스트 이행 + 코어 시행. 위험: lazy 로 바꾸면 "커맨드가 없다" 는 UNKNOWN_COMMAND 가 새로 생긴다. 커맨드 레지스트리가 활성화 트리거여야 하고(호출이 활성화를 유발), 그게 계약의 핵심 조항이다.

---

### W7. 하이드레이션에 천장과 역방향을 만든다 (레인 E, W6 과 순차)

**근본 원인.** `promote` 가 무조건적이고 예산도 가시성 술어도 없으며(`src/state/hydration.ts:64-75`), 승격이 비가역이다(`markCold` 호출부는 `:56` 하나, `GroupArea.tsx:709` 가 cold 집합 이탈 후 영구 마운트). 결과적으로 "lazy" 가 부팅 스파이크를 분산시킬 뿐 수 초 내 전량 마운트된다. 불변식은 `GroupArea.tsx:233` 에 명문화돼 있다("세션 보존: 터미널/webview 마운트는 절대 깨지 않는다").

**바꿀 것.** 소유 파일 `src/state/hydration.ts` + `src/components/GroupArea.tsx:233` 의 불변식 문장. 규칙을 둘로 쪼갠다: **세션 상태는 절대 안 깨지지만, 세션 상태와 렌더러 자원은 같은 것이 아니다.** 오프스크린 임계를 넘은 뷰는 상태를 직렬화해 보관하고 자원(xterm 버퍼, WebGL 컨텍스트, 대형 React 트리)을 반납한다. 즉 promote 의 역연산 demote 를 만든다. `viewPark.ts commitViewVisibility` 가 네이티브 층에서 이미 하는 일(webview_visible + `view.parked` emit)의 렌더러 층 대응물이다.

**RED.** 신규 시나리오 `t8_hydration`: N개 복원 뷰로 부팅 → 60 s 대기 → 워크스페이스 WebContent **physical footprint**(RSS 아님, §4 W-M3) 측정 → 뷰 하나를 임계 이상 오프스크린으로 두고 재측정.
```
bash scripts/perf/run-t.sh --identity dev --scenarios t8_hydration
```
RED 조건: 오프스크린 후 footprint 가 **안 내려간다**(오늘 구조상 반드시 그렇다).

**GREEN.** 오프스크린 임계 초과 뷰당 footprint 가 유의하게 감소, 그리고 재진입 시 세션 내용(터미널 스크롤백, 브라우저 페이지)이 손실 0. 후자는 기존 `scripts/e2e/` 정합성 스위트로 단언한다 — 이 항목에서 세션 보존은 **협상 대상이 아니다**.
절대 목표 수치는 W0/W-M3 이후에 정한다. 오늘의 945.1 MB 를 목표 기준선으로 쓰지 않는다 — 그 숫자는 이 항목과 W6 이 나눠 갖고 있고 어느 쪽에도 분리 측정이 없다.

**비용/위험.** 큼. 세션 보존 불변식을 건드리므로 가장 회귀 위험이 크다. R3: 뷰 복귀 스크린샷 필수. 라이브 shape 는 11 플러그인 뷰 / 최대 동시 6개이므로 회수 상한도 그 비율을 넘지 않는다.

---

### W8. divider hover 루프에 종료 에지를 준다 + elementFromPoint 를 뺀다 (레인 F, 독립, 저비용)

**근본 원인.** 상태(`dividerHoverKey`)의 writer 는 하나인데(`src/App.tsx:838-840`) 그 소스가 **local** NSEvent monitor(`src-tauri/src/webview.rs:1730`) 라 "포인터가 앱을 떠남" 이라는 사건이 채널에 존재하지 않는다. 그래서 키가 null 로 돌아올 경로가 없고 rAF 가 창 수명 동안 돈다(`:859-887`, :880 무조건 재무장). 소유권/경계 결함이지 루프 자체의 결함이 아니다.

**바꿀 것.** 소유 파일 `src/state/dividerHover.ts` — 여기에 **"이 키는 진입과 이탈이 쌍을 이루는 상태다"** 를 규칙으로 쓰고, 이탈 소스를 만든다(창 deactivate / pointerleave / global monitor 보완 중 하나). 같은 파일의 드리프트도 고친다: `:3` 은 "GroupArea 가 구독해" 라고 적혀 있지만 실제 import 는 `src/App.tsx:63` 하나뿐이다 — 문서가 틀렸거나 소비자가 없어졌다.
같은 커밋에서 `src/App.tsx:838` 의 25 ms throttled `document.elementFromPoint` 를 없앤다. wedge 여부와 무관하게 앱 위 모든 포인터 이동에 초당 ~40회 강제 레이아웃을 유발하고, 이건 `docs/PERFORMANCE.md:55-56` 직접 위반이다. hit-test 는 이미 존재하는 경로가 있다(`reference_envelope-reserved-keys` 의 `ui.hit`/`ui.measure`).

**RED.** vitest: hover 키를 세팅한 뒤 "포인터 이탈" 이벤트를 주입하고 rAF 스케줄이 취소됐는지 단언 — 오늘은 이탈 이벤트가 없으므로 테스트 작성 자체가 RED.
런타임 RED: divider 에 hover → 다른 앱으로 포인터 이동 → `sample <WebContent pid> 5` 에서 rAF 콜백 지속 관측.

**GREEN.** 같은 절차에서 rAF 샘플 0. vitest 통과. `elementFromPoint` 호출 수 0(`rg` 로 단언 가능한 정적 게이트로도 걸 수 있다).

**비용/위험.** 낮음. 구조 판정은 확실하지만 회수 CPU 는 작다 — "폴링이 메인라인에 있으면 그 자체가 결함" 이라는 룰의 시행으로 처리한다. `elementFromPoint` 제거 쪽이 실 CPU 회수는 더 크다(미측정).

---

### W9. projectionWiring sweep 을 coalesce 한다 (레인 F, 독립, 저비용)

**근본 원인.** 같은 코드베이스가 같은 store 에 대해 두 가지 규율을 쓴다. `src/plugins/hooks.ts:338-357` 은 마이크로태스크로 coalesce 하고 이유까지 주석으로 남겼다. `src/state/projectionWiring.ts:166-176` 은 selector 없는 bare 구독 4개를 그대로 sync() 에 물린다. 규율이 코드베이스 규칙이 아니라 파일별 관습이다.

**바꿀 것.** 소유 파일 `src/state/projectionWiring.ts`. hooks.ts 와 같은 coalescing 을 적용하고, 값싼 키(프로젝트 수 + 바인딩 id 해시)로 게이트해 `JSON.stringify` 지문(:135-140)이 매번 안 돌게 한다. 그리고 `docs/PERFORMANCE.md` 원칙 1/4/5 에 **"store 전체 구독의 콜백은 프레임/마이크로태스크로 coalesce 한다"** 를 코드베이스 규칙으로 승격한다(지금은 hooks.ts 주석에만 산다).

**RED.** vitest: divider 드래그 60프레임을 시뮬레이션하고 `resolveProjection` 호출 수를 센다. RED: ≥60 × 프로젝트 수.

**GREEN.** 같은 테스트: ≤60(프레임당 1회 이하), 그리고 projection 이 바뀌지 않는 write 에 대해 0.

**비용/위험.** 낮음. 재진입은 이미 안전하다(`projection.ts:213-224` 가 focusHistory[0] 불변 시 동일 객체 반환 → zustand 미통지). 실 회수는 드래그 중 서브밀리초이므로 이 항목은 **규율 통일**이 목적이지 수치 회수가 목적이 아니다 — 그렇게 적어 둔다.

---

### W10. RawRing 을 고정 용량 바이트 버퍼로 바꾼다 (레인 B, W1 이후)

**근본 원인.** 링 버퍼가 VecDeque<u8> 위에 얹혀 있어 append 도 축출도 바이트 단위다(`ring.rs:45-53`). 같은 파일의 tee 는 이미 bulk copy(`tee.rs:48-51 bytes.to_vec()`) 라 이 링만 예외다.

**바꿀 것.** 소유 파일 `crates/soksak-ptyd/src/ring.rs`. 고정 용량 원형 바이트 버퍼 + bulk copy/drain. 세션 락(`main.rs:1048`) 보유 시간이 짧아지는 것이 부수 효과이고, 그 락 뒤에는 tee 구독자와 attached-stream writer 가 직렬화돼 있다.

**RED.** 크레이트 로컬 bench 또는 `#[test]` 로 100 MB / 8192 B 청크 처리 시간. RED: dev 프로파일 기준 **77.24 MB/s 근방**(내가 재현 측정한 값).

**GREEN.** 같은 bench, 같은 프로파일, 같은 플래그에서 **≥400 MB/s**. 근거: bulk memcpy 는 바이트 루프 대비 최소 5배이며, `-O3` 로 재면 별개의 배수가 더 붙는다(측정 시 732.43 MB/s). 프로파일을 섞어 재지 않는다.

**우선순위 근거(작다고 적는다).** `t1_plain.cpu.avg=100.0` 은 구성상 ptyd 를 배제한다 — `lib.sh:63 find_target_pids` 는 앱 pid + WebKit XPC 만 모으고 ptyd 는 ppid=1 로 reparent 돼 있다. 관측 4.58 MB/s 에서 이 링은 코어의 약 5.9%. 라이브 dev ptyd 는 30시간 가동에 CPU 4.85 초. W1 이 크로싱을 걷어낸 **뒤에** 드러나는 천장이다.

**비용/위험.** 낮고 격리됨. 위험: seq/gap 회계가 링 구현에 결합돼 있으면 tee 프레이밍이 깨진다.

---

### W11. 개발 루프 (레인 G, 최하위, 사용자 체감과 무관)

**근본 원인(추론 — 실행 측정 안 함).** `make verify`(`Makefile:163`)가 `cargo check` 와 `cargo test` 를 별도 fingerprint 로 돌려 689 패키지 의존 그래프를 두 번 걷는다. `target/debug` 22 GB.

**바꿀 것.** 이 항목은 **먼저 측정하고 그 다음에 정한다.** 측정 없이 `[profile.dev.package."*"] opt-level` 같은 손을 대면 W0 의 A/B 를 오염시킨다. 순서상 W0 이 끝난 뒤에만 착수한다.

**RED.** `make verify` 각 단계 wall time 을 기록하는 재현 가능한 타이밍(임시 스크립트 금지 — `Makefile` 타깃 또는 `scripts/` 의 멱등 명령으로).

**GREEN.** RED 에서 특정된 지배 단계 기준으로 설정. 지금 숫자를 쓰면 발명이 된다.

**비용/위험.** 낮음. 위험은 오직 "측정 전에 손대는 것".

---

### 레인 요약

| 레인 | 항목 | 병렬 |
|---|---|---|
| A | W0 (release baseline) | 다른 모든 레인의 **판정 근거**. 먼저 시작. |
| B | W1 → W10 (PTY) | A 와 독립 |
| C | W2 → W3 (rail clip / memo 경계) | 독립 |
| D | W4 → W5 (mascot / 가시성 계약) | 독립 |
| E | W6 → W7 (활성화 / 하이드레이션) | 독립, 가장 큼 |
| F | W8, W9 (hover 루프 / sweep coalescing) | 서로도 독립, 저비용 |
| G | W11 (개발 루프) | W0 이후 |

임팩트/노력 순: **W0 → W1 → W2+W3 → W6 → W8+W9 → W4 → W7 → W5 → W10 → W11**.

## 4. 측정 체계 수리

계획의 모든 항목이 여기에 의존한다. 이 절이 먼저 끝나지 않으면 나머지는 검증 불가능하다.

### W-M1. 비교기가 조건을 강제한다

`scripts/perf/check-budgets.mjs:29-46` 의 `checkBudgets` 는 `report?.scenarios` 만 연다 — 함수 본문에 `meta` 라는 단어가 없다. 반면 유효성 조건은 세 곳에 선언돼 있다(`budgets.json:5-9`, `run-t.sh:15-16`, `README.md:39-40`). 선언 3, 강제 0.
바꿀 것: `checkBudgets` 가 `meta.conditions`(identity, windowsOpen, machine, **신규 cargoProfile**)를 budgets.json 과 대조하고 불일치 시 `INVALID` 로 exit≠0. `check-budgets.test.mjs:9-74` 의 5개 테스트가 전부 비교기 모양만 봐서 구멍을 고정시켰으므로, 조건 테스트를 추가하는 것이 이 항목의 RED 다.
RED: `pnpm vitest run scripts/perf/check-budgets.test.mjs` — windowsOpen 이 다른 리포트가 통과함을 단언하는 신규 테스트가 실패(=오늘 통과한다).
GREEN: 같은 명령, 조건 불일치 리포트가 거부됨.

### W-M2. 샘플러를 CPU 시간 델타로 바꾸고 프로세스별로 귀속한다

두 결함이 겹쳐 있다.
(1) `lib.sh:92-101` 이 `ps -o %cpu` 를 읽는데 `man ps` 상 이건 "최대 1분에 걸친 감쇠 평균" 이다. `run-t.sh:60-71` 은 앱 활성화 → sleep 1 → setup-t 뒤에 10 s 유휴 창을 열므로 셋업 버스트를 상속하고, `run.sh:94-96` 의 8 s tail 은 그 목적(지연 스파이크 분리)과 정반대로 바로 앞 active phase 의 감쇠를 먹는다. 실제로 동일 조건 4런에서 t5_idle 이 46.4 / 14.9 / 8.4 / 51.5 — 6.1배. **주의**: 샘플러가 전면적으로 거짓말하는 건 아니다. cputime-delta 대조 2회(25.9 vs 27.1, 18.3 vs 18.8)로 검증됐다. 문제는 **경계에서의 감쇠 오염**과 **분산 미보고**(`aggregate_stdin`:104-111 이 avg/max/samples 만 낸다)다.
(2) 합계만 남는다. `sample_cpu` 가 pid 집합의 합을 찍고 per-process 를 측정 시점에 버린다. 라이브 대조가 그 대가를 보여준다 — WebContent 82658 이 9.7%, 형제 82626/82749 가 0.0% 인데 합계는 "≈18" 한 개다. 범인 렌더러가 안 보인다.
바꿀 것: `proc_pid_rusage` 또는 `ps -o time` 차분으로 per-pid CPU 시간 델타를 재고, 리포트에 per-pid 배열 + stddev/p95 를 남긴다.
RED: `bash scripts/perf/run-t.sh --identity dev --scenarios t5` 를 연속 5회 — 오늘 스프레드가 헤드룸(13.6 pt)을 초과.
GREEN: 같은 5회 스프레드가 baseline 의 ±15% 이내, 그리고 리포트에 per-pid 귀속이 존재.

### W-M3. PID 집합을 앱 자손 + 분리 사이드카까지 넓히고, RSS 를 footprint 로 바꾼다

`lib.sh:63-88 find_target_pids` 는 앱 pid + WebKit XPC(±5 s 기동시간 또는 lsof identity 마커) 만 모은다. 그래서 CEF 헬퍼 3종, ptyd(74536, ppid=1), alacritty 터미널 사이드카(74411, ppid=1), db-studio 사이드카가 t5(유휴 CPU) 와 t6(메모리) 양쪽에서 **구성상** 제외된다. 사이드카로 일을 옮기면 예산은 계속 깨끗하다.
`run-t.sh:114` 는 `t6_memory.rssMb` 를 `ps -o rss` 합으로 계산한다. macOS 는 압박 시 페이지를 압축/스왑하고 RSS 는 정확히 그 부분을 제외하므로, 지표가 압박이 시작되는 순간 상승을 멈춘다. 라이브 확인: 82658 의 `vmmap -summary` 가 physical footprint 945.1 MB / peak 1.3 G / writable resident 131.1 MB / swapped_out 564.1 MB. 지금 2창 기준 게이트 pid 집합의 RSS 합 353 MB 대 footprint 합 ~1.49 GB(4.2배), 전체 11 pid 로는 ~450 MB 대 ~1.60 GB(3.6배).
**정정해 둘 것**: "오늘 RSS 가 752.3 baseline 과 구별 불가라서 포화 증거" 라는 논증은 재현되지 않는다 — 오늘 게이트 집합 RSS 353 MB 는 baseline 보다 훨씬 낮다. 결함은 메커니즘(RSS 가 스왑을 제외)과 82658 내부의 resident/swapped 분할로 직접 성립한다.
바꿀 것: `t6_memory.footprintMb`(`vmmap -summary` physical footprint 합) 신설, pid 집합에 앱 자손 + identity home 의 분리 사이드카 포함. 같은 windowsOpen 에서 재baseline.
RED: `bash scripts/perf/run-t.sh --identity dev --scenarios t5,t6` — ptyd/사이드카 pid 가 리포트에 부재.
GREEN: 리포트가 그 pid 들을 포함하고 `footprintMb` 를 낸다.

### W-M4. 실패한 시나리오가 점수를 못 내게 한다

`driver.mjs:574` 가 mbps 를 디스크 픽스처 크기로만 계산하고 exitCode 나 `writtenBytesDelta` 와 대조하지 않는다. `20260711-142832-ab-local-debug.json` 이 결과를 증명한다 — t1_ansi exitCode 1, writtenBytesDelta 765, mbps 10000(min 예산 3.2 의 3125배). 그리고 `20260711-142405-gate-debug.json` 은 두 t1 런 모두 rafFramesDelta 0(100 MB cat 동안 프레임 0장)인데 rafFrames/writeCbLagMs/exitCode 를 덮는 예산 키가 없다.
바꿀 것: `check-budgets.mjs` 가 `exitCode != 0` 인 시나리오, 그리고 보고된 바이트와 `writtenBytesDelta` 가 불일치하는 시나리오를 무조건 실패시킨다. `rafFramesDelta`, `writeCbLagMs` 를 예산 키로 승격.
RED: `pnpm vitest run scripts/perf/check-budgets.test.mjs` — exitCode 1 픽스처가 통과함을 단언하는 신규 테스트.
GREEN: 거부.

### W-M5. 게이트를 실행 경로에 넣는다

`Makefile:163` 에 perf-gate 가 없고, `grep -rn perf-gate` 는 자기 정의 한 줄뿐이며, `rg -n perf .github/workflows/` 는 0 hit 이다. CI 가 실행하는 유일한 perf 관련 항목은 `vitest.config.ts:13` 의 `"scripts/**/*.test.mjs"` 때문에 도는 **비교기의 자기 테스트**다. `docs/CI-STATUS.md` 에 "perf" 가 0회 등장한다.
바꿀 것: perf-gate 는 앱 실행+전면이 필요하므로 순수 CI 에 넣을 수 없다. 대신 (a) `docs/CI-STATUS.md` 에 perf 게이트 항목을 신설해 마지막 실행 커밋과 실행 횟수를 원장으로 남기고, (b) `make verify` 에 **원장 검사**를 넣는다 — 마지막 기록 런이 HEAD 로부터 N 커밋 이상 떨어져 있으면 경고 또는 실패. 오늘 그 거리는 **524**(마지막 실측 커밋 14d6d7f7, 2026-07-11). 그 사이 두 커밋(c935666b, 4a6ea35e)이 드라이버가 몰던 터미널 프로그램 이름을 재지정했는데 이후 런이 없다.
RED: 원장 검사 신설 시점에 즉시 실패(거리 524).
GREEN: 새 런이 기록되면 통과.

### W-M6. 회귀 게이트와 절대 목표를 분리한다 — 두 파일

이게 §2 의 핵심 결함에 대한 직접 수리다.

**회귀 게이트**(`scripts/perf/budgets.json`, 현행 유지): baseline × headroom. `README.md:44-45` 의 "초기값은 첫 실측에서 유도한다(수치 선긋기 금지)" 는 이 파일에 대해 **옳다** — 회귀 검출에는 파생이 맞다. 다만 baseline 은 n=1 을 못 쓴다. 각 지표 baseline 은 **연속 5런의 중앙값**이어야 하고, headroom 은 관측 스프레드보다 커야 한다(오늘은 t5_idle 스프레드 43.1 pt 에 헤드룸 13.6 pt).

**절대 목표**(신규 `scripts/perf/targets.json`): 건강한 숫자가 무엇인지. `docs/PERFORMANCE.md` 에는 오늘 수치 목표가 하나도 없다(원칙 7개, 17/29/37/43/50/84/92행). 목표는 발명하지 않고 **비교 가능한 참조**에서 논증한다.

- `t1_plain.mbps ≥ 100` — 근거: 같은 기계에서 잰 상류 pty master raw drain **203 MB/s**, 그리고 프런트 관측 파서 **248 MB/s(plain) / 227 MB/s(ansi)**. 데이터 경로의 양 끝이 200 MB/s 대이고 사이에 있는 게 크로싱뿐이다. 두 실측의 절반 이하로 잡은 보수적 값.
- `t1_plain.cpu.avg ≤ 40` — 근거: 현재 100.0 은 직렬 메인스레드가 크로싱에 완전 포화된 상태이고, 크로싱을 ~64배 줄이면 이 항이 지배항에서 내려온다. **주의**: 이 값은 W1 GREEN 이후에 실측으로 재도출해야 하며, 지금은 "100 은 목표가 아니다" 만 확정 사실이다.
- `t5_idle.cpu.avg ≤ 5` — 근거: 유휴는 정의상 일이 없는 상태다. 라이브 대조가 이미 그 값을 보여준다 — 플러그인 런타임이 없는 두 WebContent(82626/82749)가 0.0-0.3%. 현재 46.4 를 baseline 으로 삼은 예산(max 60)은 반쪽 코어를 정상으로 인증한다.
- `t2.medianMs` — 현행 1 ms 는 좋지만 **paint 를 제외한다**(`driver.mjs:619` 가 "socket RPC/paint excluded" 로 기록). 페인트까지 포함하는 신규 지표가 필요하다(아래 s14).
- `t6_memory.footprintMb` — W-M3 재baseline 후에 설정. 오늘의 945.1 MB 를 기준선으로 쓰지 않는다.

**시행**: `check-budgets.mjs` 가 두 파일을 모두 읽고, 회귀 위반은 FAIL, 목표 미달은 `BELOW_TARGET` 으로 별도 보고한다. 목표 미달이 있는 동안 게이트를 초록으로 부르지 않는다. 오늘 기록된 수치에 이 파일을 적용하면 코드 변경 0 으로 `t5_idle.cpu.avg` 와 `t1_plain.cpu.avg` 가 즉시 RED 다 — 그게 이 항목의 RED 다.

### W-M7. 느껴지는 축에 시나리오를 만든다

오늘 `run.sh:155-158` 은 `s[3-6]` 을 권한 없으면 `{"skipped":true}` 로 버리고 exit 0 한다 — 모든 스크롤과 모든 실제 포인터 드래그가 그렇다. `jq -r '.budgets|keys[]'` 는 t* 8개, s* 0개이고, `check-budgets` 는 `run-t.sh:145` 한 곳에서만 불리므로 run.sh 는 아무것도 게이트하지 않는다 — MISSING 가드가 인터랙션 축을 아예 안 덮는다. s1/s2 는 `driver.mjs:266-311` 의 `panel.resize`/`view.move` RPC 라 제스처 채널을 안 탄다.

신규 시나리오와 각자의 소유 항목:
- `t7_boot` — 프로세스 기동 → 워크스페이스 창 첫 페인트, + 컴파일된 바이트, + T+30 s 시점 사이드카 프로세스 수. (W6)
- `t8_hydration` — N개 복원 뷰 부팅 후 60 s footprint, N 스윕 + 오프스크린 후 감소 단언. (W7)
- `s12` — rail glide 프레임타임/드롭 프레임, **실제 포인터 채널**로 구동(`drag-cpu.sh` 방식, `panel.resize` RPC 금지). 프로젝트 수 파라미터. (W2/W3)
- `s13` — 터미널 백로그 스크롤.
- `s14` — 키 입력 → 페인트 지연(t2 가 제외하는 구간).
- `s15` — 창 열기 / 스페이스·프로젝트 전환.

그리고 `s[3-6]` 의 skip 을 없앤다 — 권한이 없으면 스킵이 아니라 **실패**여야 한다. 침묵 스킵은 초록을 무의미하게 만든다.
공정하게 기록: 제스처 축이 완전 무측정은 아니다. `results/20260704-d-drag-freeze-gate.md` 에 네이티브 ~30Hz divider 드래그 CPU A/B(31.9% → 10.4/14.4%)가 있고, 정합성 E2E 두 개(`scripts/e2e/slot-freeze.mjs` — `make test-e2e` 포함, `scripts/e2e/divider-freeze.sh` — 미포함, sample_cpu/CPU 단언 없음)가 있다. 없는 것은 **비용 시나리오**이고, 2026-07-04 A/B 는 시나리오·예산으로 성문화되지 않은 1회성 원장이다.

### W-M8. identity=dev 를 1급 측정 대상으로 만든다

`lib.sh identity_proc_pattern` 이 `dev` → `target/debug/soksak-dev` 를 이미 매핑하므로 `run-t.sh --identity dev` 는 **지원된다**. 한 번도 baseline 을 안 잡았을 뿐이다. 반면 모든 예산은 identity=debug 에 핀돼 있고 `~/.soksak-debug/*.sock` 이 없어 `run-t.sh:46` 이 abort 한다 — 게이트는 지금 사용자의 실행물을 자기 비교 계약을 어기지 않고는 잴 수 없다.
그리고 identity=debug 자체가 제3의 체제라는 걸 명시해야 한다: `Makefile:57` 이 `tauri build --debug`, `tauri.conf.json:9` 의 `beforeBuildCommand: pnpm build` — **비최적화 Rust + 프로덕션 vite 번들**. release(최적 Rust + 프로덕션 JS) 도 아니고 사용자의 dev(비최적 Rust + dev 서버 JS) 도 아니다.
바꿀 것: `budgets.json` 을 identity 별로 분리하고(dev / debug / release), 각각 별도 baseline. `docs/PERFORMANCE.md` 에 세 체제의 정의를 적는다.

## 5. 즉시 확인

세 명령이면 지배 원인들을 직접 볼 수 있다. 전부 읽기 전용이고 돌고 있는 앱을 건드리지 않는다.

**1) 매일 쓰는 실행물이 dev 프로파일이라는 것 — 10초**
```
ps -Ao pid,ppid,command | grep -E 'target/debug/soksak-dev|tauri.js dev' | grep -v grep
ls src-tauri/target/
grep -n '^\[profile' src-tauri/Cargo.toml
```
`target/debug/soksak-dev` 가 `tauri.js dev` 의 자식으로 뜨고, `target/` 에 `release` 가 없으며, `[profile]` 히트가 `[profile.release]` 하나뿐인 것을 확인한다. `[profile.dev]` 는 어디에도 없다.

**2) 유휴 CPU 가 화면에 없는 캔버스를 그리는 데 나간다는 것 — 30초**
```
ps -Ao pid,%cpu,command | grep -E 'com.apple.WebKit.WebContent|soksak-dev' | grep -v grep
sample <위에서 %cpu 가 가장 높은 WebContent pid> 5
```
`sample` 출력에서 `RemoteLayerTreeDrawingArea::updateRendering` → `ScriptedAnimationController::serviceRequestAnimationFrameCallbacks` → WebGL2 호출(`bufferData` / `vertexAttribPointer` / `uniformMatrix4fv` / `blendFuncSeparate`)이 보인다. 형제 WebContent 들은 0.0% 다. mascot 플러그인 상태를 같이 보면 확정된다 — `attached:false`, `holder.inDom:false`, `tickerStarted:true`.

**3) 게이트가 결함을 정상으로 인증하고 있다는 것 — 1분**
```
jq '{baseline: .meta.baseline, budgets: .budgets, headroom: .meta.headroom}' scripts/perf/budgets.json
git log --oneline 14d6d7f7..HEAD | wc -l
ls -t scripts/perf/results/ | head -3
```
`t5_idle.cpu.avg` baseline 46.4 → max 60, `t1_plain.cpu.avg` baseline 100.0 → max 130 을 눈으로 확인한다. 마지막 실측 이후 커밋 수가 **524**, `results/` 의 최신 산출물이 `20260711-145114-gate-debug.json` 이다. 그 리포트를 열어 보면(`jq '.scenarios | {t1_plain, t5_idle}' scripts/perf/results/20260711-145114-gate-debug.json`) t1_plain 이 baseline 대비 -27%, t5_idle 이 +11% 인데 8개 예산을 전부 통과한 게 보인다.