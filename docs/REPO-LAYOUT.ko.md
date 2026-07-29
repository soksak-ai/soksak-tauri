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

## 지금 상태(실측 2026-07-29)

```
core/
├── src/            앱 UI(프레임워크 무관) — 어댑터 뒤에서만 프레임워크를 본다
├── electron/       Electron 어댑터
├── src-tauri/      Tauri 어댑터  +  프레임워크 무관 크레이트 11개  +  Cargo 워크스페이스 루트
│   ├── src/            Tauri 어댑터 본체 (59파일 · 28,293줄)
│   ├── cli/            sok CLI (프레임워크 무관)
│   ├── capabilities/   Tauri capability 선언
│   ├── icons*/ gen/    Tauri 번들 자산
│   └── crates/         soksak-core · cored · store · watch · ptyd · seal · spec-* (38+12+… · 20,262줄)
├── platform/       OS 축 자산
├── packages/       npm 패키지(plugin-api · plugin-spec)
├── worker/         Cloudflare Worker
├── scripts/        게이트 · e2e · 도구
└── docs/ plans/ public/ examples/ secret/ dist/
```

## 어긋난 것

**① 프레임워크에서 독립한 것이 그 프레임워크 안에 산다.**

`crates/` 의 크레이트 10개와 `crates/soksak-cli/` 는 **하나도 tauri 에 의존하지 않는다**(실측:
Cargo.toml 전수 확인). 그중 `soksak-cored` 는 `tests/no_framework.rs` 로 `tauri`·`wry`·`tao`·`objc2`·
`libloading`·`windows-sys`·`tokio`·`interprocess`·`portable-pty` 를 **이름으로 금지**한다. 프레임워크를
이름으로 막는 코드가 프레임워크 이름의 폴더 안에 있다.

**② 워크스페이스 루트가 곧 한 프레임워크의 앱이다.**

`src-tauri/Cargo.toml` 은 `[workspace]` 이면서 동시에 Tauri 앱 패키지다(`name = "soksak-tauri-dev"`).
공용 크레이트 11개가 그 워크스페이스의 멤버다 — 즉 공용 코드가 한 프레임워크의 빌드 단위에 속한다.

**③ 두 프레임워크가 형제가 아니다.**

`electron/` 은 최상위에, Tauri 어댑터는 `src-tauri/src/` 에 있고 그 부모가 공용 코드를 함께 든다.
배치가 "Tauri 가 본체이고 Electron 은 손님"이라고 말한다. 이식의 명제는 그 반대다 — 코어 하나에
프레임워크 둘이고 둘은 대등하다.

**④ `src-tauri` 라는 이름 자체가 프레임워크 규약이다.**

Tauri CLI 의 기본 폴더명이다. 그 규약을 따르는 것은 Tauri 어댑터의 자유지만, 공용 코드가 그
규약 밑에 있을 이유는 없다.

## 목표 배치

```
core/
├── src/                앱 UI — 그대로
├── frameworks/         프레임워크는 형제다
│   ├── tauri/              지금의 src-tauri/{src,capabilities,icons*,gen}
│   └── electron/           지금의 electron/
├── crates/             프레임워크 무관 Rust — 워크스페이스 루트가 여기 산다
│   ├── soksak-core/        규칙(무의존)
│   ├── soksak-cored/       서빙 프로세스
│   ├── soksak-store/       저장소 자원
│   ├── soksak-watch/       파일 감시 자원
│   ├── soksak-ptyd/        PTY 데몬
│   ├── soksak-seal/        봉인
│   ├── soksak-spec-*/      계약
│   └── soksak-cli/         sok CLI(지금의 crates/soksak-cli)
├── platform/           OS 축
├── packages/ worker/ scripts/ docs/ plans/ …
```

규칙 셋으로 요약된다.

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

## 이주 비용

`src-tauri` 경로를 밖에서 참조하는 파일이 **63개**다(게이트·문서·플랜·매니페스트·CI). 그중
`crates` 를 직접 가리키는 것이 10개다. 옮기면 이 전부가 함께 바뀐다.

Rust 쪽은 `Cargo.toml` 의 `members`·`path` 의존과 `include_str!("../fixtures/…")` 상대경로가
따라 움직인다. 프론트는 `src-tauri` 를 빌드 산출물 경로로만 알고 있어 영향이 작다.

## 게이트

배치를 문서로만 두면 다음 사람이 다시 어긴다. 세울 검사는 셋이다.

1. `frameworks/*` 밖의 Rust 크레이트는 프레임워크 크레이트를 의존하지 않는다(지금 `no_framework`
   가 cored 하나에만 걸린 것을 배치 규칙으로 넓힌다).
2. 워크스페이스 루트 패키지는 프레임워크 앱이 아니다.
3. `frameworks/` 아래 이름은 framework 어휘만 쓴다(`platform`·`engine`·`shell` 금지).

---

이 문서는 **표준**이다. 옮기는 일은 별도이고, 이 문서가 확정된 뒤에 한다.
