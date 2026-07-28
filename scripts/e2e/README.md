# 리사이즈 E2E (기계 측정, GREEN/RED)

빠른 창/디바이더 리사이즈에서 ① 본문 blank ② 프롬프트 잘림 ③ TUI 스테일 회귀를
**사람·AI 개입 없이** 기계로 판정한다. `panel.resize` 명령으로 빠른 드래그와 동일 경로
(resizeSplit → 렌더 → fit + PTY)를 구동하고, 터미널 버퍼(term.read)를 분석해 명확한
임계로 PASS/FAIL 한다(본문 blank 판정만 opt-in 화면 녹화 사용). 전용 워크스페이스 창
(w-*)에서만 동작한다 — `main` 은 컨트롤 플레인이라 창을 지정하지 않으면 측정이 무효다.

## 실행

```bash
# 대화형(TTY): 동의 프롬프트 후 진행
make e2e-resize                      # IDENTITY 기본 dev

# 비대화형(CI/스크립트): 동의를 환경변수로
E2E_CONSENT=1 scripts/e2e/resize.sh --identity dev
```

종료코드: `0`=GREEN(전 기준 통과), `1`=RED(회귀), `2`=실행 안 함(동의 없음/환경 미비).

## 검증 항목과 기준(명확·결정적)

| id | 검증 | 측정 | GREEN 기준 |
|---|---|---|---|
| T1 | 본문 blank 없음 | 빠른 디바이더 드래그 녹화 → 좌패널 본문 프레임별 내용 비율 | 최장 연속 blank 프레임 `maxRun ≤ 3` |
| T2 | 프롬프트 무결 | 드래그(시작=끝 폭) 후 양 패널 마지막 줄 `term.read` | 마지막 줄(trim) `== 마커` (양쪽) |
| T3 | TUI 추종 | TUI(alt screen)에 빠른 드래그 + 넓힘→좁힘 | blank `maxRun ≤ 3` **그리고** TUIDIM cols 가 넓힘>좁힘으로 감소 |

- **blank 정의**: 본문 영역의 "내용 비율"(배경과 다른 픽셀 비율)이
  `max(3%, baseline×0.30)` 미만인 프레임. baseline=전체 프레임 중앙값.
  회귀 버전은 수십 프레임 연속 blank(maxRun 30~50+), 수정 버전은 0~1 전환만 →
  임계 3 은 충분한 마진.
- **프롬프트 마커**: `E2EMARK_0123456789_ABCDEFGHIJ_END`(33자). 좁은 극단에서
  래핑될 만큼 길고, 시작=끝(net-zero) 폭이라 "SIGWINCH 미전달이면 영영 안 고쳐지는"
  worst case 를 친다. 수정(드래그 중 라이브 SIGWINCH)에서만 무결.
- **TUI 추종**: TUI 가 SIGWINCH 마다 재그린 cols 가 폭 변화를 따라가는지로
  스테일/lag 회귀를 잡는다(20Hz 라이브 SIGWINCH 가 TUI 를 망가뜨리지 않는지 — 우려 검증).

## 전제

- **macOS 전용**(현재): 합성 입력(CGEvent)·영상(screencapture)·창 좌표(AX)가
  macOS API. 타 플랫폼에선 RED 가 아니라 **SKIP**(종료 0) — 각 OS 입력/캡처 백엔드가
  생기면 동일 판정 로직을 이식한다.
- **앱 실행 중 + 창 가시**: 백그라운드 WKWebView 는 이벤트 루프가 스로틀되어 측정 무효
  (하니스가 자동 전면 활성화).
- **손쉬운 사용(Accessibility) 권한**: 터미널 앱에 1회 허용(없으면 RED — 좌표/입력 불가).
- **사용자 동의(필수)**: 합성 입력이 ~10초간 마우스를 점유한다. 동의 없이는 실행하지
  않는다(대화형 프롬프트 또는 `E2E_CONSENT=1`). 그동안 **마우스/키보드를 만지지 말 것** —
  실제 입력이 섞이면 측정이 오염된다.
- 도구: `node ffmpeg python3(pillow) screencapture swiftc`.

## 구성

- `resize.sh` — 오케스트레이터(플랫폼·동의·환경 게이트 → 셋업 → 측정 → 판정 → 정리).
- `e2e-driver.mjs` — sok 소켓 RPC: resize-e2e 프로젝트 셋업·디바이더 좌표(ui.measure)·
  결정적 프롬프트·버퍼 읽기·분할 비율·정리.
- `analyze-blank.py` — 영상 → 본문 blank 프레임 기계 측정(ffmpeg+PIL).
- `tui-probe.sh` — 결정적 TUI(WINCH 재그리기, 마지막 줄 `TUIDIM=CxL` 마커).
- `../perf/synth-input.swift` — CGEvent 합성(`osc` 연속 왕복 드래그 포함, perf 와 공유).

## 회귀 재현(수동 참고)

기준이 실제 버그를 잡는지 보려면, 수정 이전 동작으로 되돌린 뒤(예: createTerminal 의
fit 스로틀 제거 → 매 프레임 fit, 또는 PTY 라이브 SIGWINCH 제거) 같은 명령을 돌리면
T1 maxRun 이 수십으로, T2 마커가 잘려 RED 가 떠야 한다.

---

# 셸 결속 장부 — 하니스는 셸을 전제하지 않는다

하니스는 소켓 명령으로 앱을 몬다. 앱을 어느 셸이 이고 있는지는 하니스가 알 일이 아니다.
어디가 셸에 묶여 있는지는 **하니스를 하나도 돌리지 않고** 읽는다:

```bash
make e2e-shell-binding                          # A/B/C 표 + 개수
node scripts/e2e/shell-binding.mjs --json       # 기계 판독
node scripts/e2e/shell-binding.mjs --class C    # 셸마다 갈리는 하니스만
node scripts/e2e/shell-binding.mjs --surfaces   # 갈리는 자리(표면)와 그 이유
```

| 무리 | 뜻 |
|---|---|
| A | 셸 무관 — 소켓 명령만 쓴다. 다른 셸 위에서도 같은 답을 요구한다. |
| B | 경로 결속 — 프로세스·빌드 산출물·앱 홈을 직접 안다. 값이 밖에서 오면 A 가 된다. |
| C | 네이티브 — 창 캡처·네이티브 자식 표면·합성 입력에 선다. 셸마다 답이 다른 것이 정상이다. |

- **선언과 실측을 양방향으로 맞춘다.** 무리와 이유는 `shell-binding.json` 이 적고, 표면은
  `shell-binding.mjs` 가 소스에서 찾는다. 한쪽에만 있으면 실패다 — 새 하니스는 장부에
  들어와야 하고, 사라진 표면 선언은 지워야 한다. `make gates` 가 시행한다.
- **소켓 경로는 `SOKSAK_SOCKET` 하나로만 온다.** 기본값은 없다. 값이 없으면 이름을 달고
  실패한다(`scripts/e2e/lib/client.mjs` 의 `requireSocket`) — 기본 경로를 지어내면 값을 안 준
  실행이 실패 대신 **다른 홈의 앱**에 붙어 판정을 낸다.
- **창 라벨은 앱의 사실이지 셸의 사실이 아니다.** `main`(컨트롤 플레인)·`w-*`(워크스페이스)는
  NAMING 이 정한 예약어라 어느 셸 위에서든 같다. 라벨은 지어내지 말고 앱에 묻는다
  (`resolveControlWindow`·`workspaceWindows`), 무대를 직접 세운 하니스는 자기가 연 창을
  `SOKSAK_E2E_WINDOW` 로 잇는다.
- **C 는 스킵이 아니라 선언이다.** 픽셀 오라클·홀·네이티브 자식 표면은 셸마다 답이 다른
  것이 정상이므로, 그 자리를 표면 이름과 이유로 남긴다.

---

# 픽셀 오라클 (판정은 한 벌)

"이 프레임이 그려졌는가"를 **PNG 바이트만 보고** 답한다. 캡처는 셸마다 다르지만(Tauri 는 창
합성물, Electron `capturePage` 는 네이티브 자식이 빠진 그림) 판정은 하나여야 한다 — 아니면
"그려졌다"가 셸마다 다른 뜻이 된다.

- `lib/frame-oracle.mjs` — 순수 함수 `judgeFrame(bytes, opts)` / `compareFrames(정상, 대상, opts)`.
- `frame-verdict.mjs` — 같은 판정을 커맨드로. 어떤 셸이 찍은 파일이든 그대로 넣는다.
- `fixtures/frames/` — 픽스처와 출처(`frames.json`: 합성인지 실물 캡처 파생인지, 원본 sha256 까지).
- `lib/frame-oracle.test.mjs` — 기준. `npx vitest run scripts/e2e/lib/frame-oracle.test.mjs`.

```bash
node scripts/e2e/frame-verdict.mjs 창.png                       # 판정 + 평평한 구역
node scripts/e2e/frame-verdict.mjs --region 320,80,900,600 창.png  # 콘텐츠가 있어야 할 rect 만
node scripts/e2e/frame-verdict.mjs --baseline 정상.png 창.png      # 정상 대비 사라진 구역
```

판정 근거는 값으로 돌아온다 — 최빈색과 그 비율(단색인가), 고유색 수, 밝기 엔트로피,
**국소 대비(경계) 비율**. 실측(fixtures/frames): 실렌더 경계 14.9~19.0% 대 백지 0.0%.
파일 크기는 쓰지 않는다: 백지 레티나 창(27,697B)이 실렌더 슬롯 크롭(18,840B)보다 무겁고,
크기는 스칼라라 **어디가** 비었는지 못 말한다.

한계는 감추지 않는다. 평평한 구역이 "원래 여백"인지 "안 찍힌 구멍"인지는 프레임 안에 답이
없다(실렌더 창도 16 구역 중 3 이 평평하다). 구멍을 지목하려면 밖에서 사실을 줘야 한다 —
콘텐츠가 있어야 할 `--region`, 또는 같은 창의 정상 프레임 `--baseline`.

자는 한 벌이지만 재는 대상은 셸의 것이라, 오라클 위에 선 파일은 셸 결속 장부에서 C 다
(표면 `pixel-oracle`).

---

# 플러그인 E2E 는 각 플러그인 repo 가 소유한다

플러그인 전용 E2E 시나리오는 코어가 아니라 **해당 플러그인 repo** 에 둔다(분리 원칙 — 코어는
플러그인 전용 테스트를 담지 않는다). 코어 `scripts/e2e/` 는 코어 기능(리사이즈·멀티윈도우 등)만.

- soksak-plugin-claude-gui → `e2e/claude-gui.mjs` (그 repo)
- soksak-plugin-mailbox → `e2e/mailbox.mjs` (그 repo)

각 시나리오는 소켓 RPC(JSON-RPC) 로 실행 중인 코어 앱을 구동·단언하므로 코어 의존성 없이
플러그인 repo 안에서 독립 실행된다. 아래 방법론은 플러그인·코어 공통.

# E2E 작성 방법론

E2E 하니스·테스트 표준(멱등 시나리오, introspection 우선, 결정적/LLM 분리, 실측 시그니처,
하니스 규칙)의 정본은 **[docs/TESTING.md](../../docs/TESTING.md)** 다. 이 README 는 리사이즈
하니스의 검증 항목·기준·구성만 다룬다.
