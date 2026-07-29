# 저장소 배치

## 법: 폴더 이름은 **소유자**를 선언한다

폴더에 든 것은 그 폴더 이름이 가리키는 것의 소유다. 이름과 내용이 어긋나면 그 어긋남은 오류로
나타나지 않는다 — 사람이 "여기 있으니 이것의 일부겠지"라고 읽고, 그 오독 위에 다음 결합이 쌓인다.

여기서 쓰는 낱말은 넷이고 뜻이 고정되어 있다(게이트가 강제한다).

| 낱말 | 뜻 | 예 |
| --- | --- | --- |
| framework | 창·이벤트루프·번들을 주는 것 | Tauri · Electron |
| platform | 운영체제 | macOS · Windows · Linux |
| engine | 웹뷰 엔진 | WKWebView · Chromium |
| shell | 사용자 셸 | zsh · bash |

그래서 `tauri`·`electron` 이 사는 자리의 이름은 `frameworks` 다. `platform` 이 아니다.

## 지금 상태(이주 완료 2026-07-29)

```
core/
├── Cargo.toml          워크스페이스 루트 — 아무 패키지도 아니다
├── src/                앱 UI(프레임워크 무관)
├── frameworks/         프레임워크는 형제다
│   ├── tauri/              Tauri 어댑터(src·capabilities·icons·gen·conf)
│   └── electron/           Electron 어댑터
├── crates/             프레임워크 무관 Rust 11개
│   ├── soksak-core/        규칙(무의존) + assets/shell-integration.zsh
│   ├── soksak-cored/ store/ watch/ ptyd/ seal/ spec-*/ cli/
├── platform/           OS 축 자산
├── packages/ worker/ scripts/ docs/ plans/ public/ examples/ secret/
```

## 무엇이 바뀌었나

**① 프레임워크에서 독립한 것이 프레임워크 밖으로 나왔다.** `src-tauri/crates/*` → `crates/*`,
`src-tauri/cli` → `crates/soksak-cli`. 열한 크레이트 전부 tauri 에 의존하지 않는다. 그중
`soksak-cored` 는 `tauri`·`wry`·`tao`·`objc2`·`libloading`·`windows-sys`·`tokio` 를 이름으로 막는
게이트를 갖고 있었다 — 프레임워크를 이름으로 막는 코드가 그 프레임워크 폴더 안에 살고 있었다.

**② 워크스페이스 루트가 프레임워크를 벗었다.** 전에는 `src-tauri/Cargo.toml` 이 `[workspace]`
이면서 Tauri 앱 패키지였다. 이제 루트는 최상위이고 아무 패키지도 아니다.

루트에서만 먹는 것도 함께 왔다 — `[patch.crates-io]` 와 `[profile.release]`. 멤버 매니페스트에
두면 cargo 가 **경고만 내고 무시한다**(실측): 상류 wry 누수 패치가 풀려도 빌드는 그대로 서고
그 차이는 런타임에서만 드러난다. 가상 매니페스트는 `resolver` 미지정 시 조용히 1을 쓰므로
`resolver = "2"` 를 명시했다.

**③ 두 프레임워크가 형제가 됐다.** `frameworks/{tauri,electron}`. 배치가 더는 "Tauri 가 본체,
Electron 은 손님"이라고 말하지 않는다.

**④ `src-tauri` 라는 이름이 사라졌다.** 그것은 Tauri CLI 의 규약이었고, 공용 코드가 그 밑에
있을 이유가 없었다.

## 배치의 법

규칙 셋이다.

1. **프레임워크 무관 코드는 프레임워크 이름 밑에 두지 않는다.**
2. **프레임워크는 형제다** — 하나가 다른 하나의 부모가 되지 않는다.
3. **워크스페이스 루트는 프레임워크가 아니다** — 공용 크레이트가 한 프레임워크의 빌드 단위에
   속하면 그 프레임워크를 지우는 순간 나머지가 함께 무너진다.

## soksak-core 내부

지금은 `src/` 아래 38개 파일이 평면이다. 성질이 다른 것이 나란히 있다: 정체성·경로, 저장소 규칙,
프로세스·PTY, 창·표면 명세, 플러그인 규칙, 제어면.

그리고 검사 파일 다섯(`activity_recent_tests.rs`·`control_tests.rs`·`plugin_data_tests.rs`·
`pty_delivery_tests.rs`·`skillgen_tests.rs`)만 형제로 떨어져 있고 나머지는 `#[cfg(test)] mod tests`
인라인이다 — 두 방식이 섞여 있고 어느 쪽이 규칙인지 파일만 봐서는 알 수 없다.

정리 축은 **무엇의 규칙인가**다(파일 크기나 알파벳이 아니다).

```
soksak-core/src/
├── lib.rs
├── identity/     identity · pathx · unit_dev · unit_target
├── store/        kv · store_open · store_lock · integrity(현재 없음) · seal_keys
├── proc/         proc · ptyd · pty_delivery · shell_env · shellq · session
├── surface/      window_spec · window_traces · surface_spec · geometry
├── plugin/       plugin_data · plugin_dir · skillgen · themes · probe
└── wire/         control · stream · stream_sink · activity · activity_sink · udp · secret_env
```

검사는 한 방식으로 통일한다 — 인라인 `#[cfg(test)] mod tests` 가 다수이므로 그쪽이 기준이고,
떨어져 나온 다섯은 사유를 적거나 인라인으로 되돌린다.

## 이주가 건드린 것

바깥 참조 **136 파일**(게이트·검사·문서·플랜·매니페스트·CI·설정). 조용히 깨질 수 있던 자리는
따로 잡았다.

- `include_str!` 상대경로 둘 — 크레이트 경계를 넘던 것. `shell-integration.zsh` 는 소비자 곁
  (`crates/soksak-core/assets/`)으로 옮겨 교차 include 자체를 없앴다.
- 게이트의 **스캔 뿌리** — `["src","src-tauri"]` 에서 뿌리가 사라지면 Rust 전체가 스캔 밖으로
  나가 위반 0건으로 통과 위장한다. 뿌리가 하나도 없으면 실패하도록 먼저 고쳤다(선행 커밋).
- **봉인 장부**가 경로를 키로 든다(`baseline-unwrap.txt`·`baseline-file-length.txt`). 키가
  어긋나면 봉인이 풀려 봉인으로만 통과 중이던 파일이 즉시 위반이 된다.
- `.github/fixtures` — 루트가 최상위로 오면서 워크스페이스 디렉터리 안에 들어온다. `exclude` 했다.
- 정규식 안의 경로(`framework-binding.mjs`) — 슬래시 이스케이프가 함께 바뀌어야 한다.
- npm 패키지 이름 `electron/…` — 저장소 폴더가 아니다. 일괄 치환이 이것까지 바꾸면 모듈 해석이
  깨진다.


## 게이트

배치를 문서로만 두면 다음 사람이 다시 어긴다. 세울 검사는 셋이다.

1. `frameworks/*` 밖의 Rust 크레이트는 프레임워크 크레이트를 의존하지 않는다(지금 `no_framework`
   가 cored 하나에만 걸린 것을 배치 규칙으로 넓힌다).
2. 워크스페이스 루트 패키지는 프레임워크 앱이 아니다.
3. `frameworks/` 아래 이름은 framework 어휘만 쓴다(`platform`·`engine`·`shell` 금지).

---

이 문서는 **표준**이고, 배치는 그 표준대로 서 있다. 어기면 위 게이트 셋이 잡는다.
