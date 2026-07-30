#!/usr/bin/env node
// 어휘 게이트 — "shell"·"셸" 은 명령 해석기(zsh·bash)의 말이다.
//
// 이 저장소의 어휘(docs/FRAMEWORK-PORT.md): framework=앱을 호스팅하는 것(Tauri·Electron) /
// platform=운영체제 / engine=웹을 그리는 것 / shell=명령 해석기. 프레임워크를 "셸"이라
// 부르던 옛말이 세 번에 걸쳐 개명됐고 세 번 다 잔여가 남아 새 코드로 다시 번졌다.
// 이 게이트는 그 재발을 막는다 — 진짜 셸의 자리는 허용 목록으로 두고, 그 밖에서
// 프레임워크 뜻의 shell 이 **새로** 생기면 실패한다.
//
// 두 규칙:
//   R1 식별자·와이어 — `shell` 이 다른 글자에 붙은 토큰(ShellEvent·no_shell·shell:event·
//      SHELL_FAMILIES·shell-binding)은 REAL_SHELL_TOKENS 에 없으면 위반이다. 이름과
//      와이어 문자열은 기계로 판별된다 — 여기는 예외 없이 막는다.
//   R2 산문 — 뜻은 기계가 못 읽는다. 그래서 파일별 **잔여 건수**를 장부(PROSE_LEDGER)로
//      못박는다. 늘면 위반(새로 번졌다), 줄어도 위반(고쳤으면 장부에서 빼라).
//      진짜 셸을 말하는 줄은 REAL_SHELL_MARKERS 로 세지 않는다.
//
// 한계를 정직하게: R2 의 마커는 휴리스틱이다. 진짜 셸을 새로 적는데 마커가 하나도
// 없으면 이 게이트가 그 줄을 프레임워크 뜻으로 오인한다 — 그때는 마커를 늘리거나
// 장부에 사유와 함께 올려라. 오인의 대가는 "선언하라"이지 "고쳐라"가 아니다.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPO_ROOT = resolve(HERE, "../..");

const SCANNED_EXT = /\.(rs|ts|tsx|cjs|mjs|js|json|md|css|toml|zsh)$/;

// ── 진짜 셸의 임자들 — 통째로 스캔에서 뺀다. 한 줄씩 왜 여기 있는지 적는다 ──────
export const REAL_SHELL_PATHS = [
  ["frameworks/tauri/src/pty.rs", "PTY 세션의 임자 — 셸을 스폰하고 env·통합·생존을 소유한다"],
  ["frameworks/tauri/src/daemon.rs", "Procfile 데몬이 로그인 셸을 인자로 받아 스폰한다"],
  ["frameworks/tauri/src/login_shell.rs", "`$SHELL` 을 읽는 저장소의 유일한 자리"],
  ["crates/soksak-core/src/ambient_gate.rs", "앰비언트 표에 `SHELL`·`ZDOTDIR` 이 항목으로 산다"],
  ["crates/soksak-core/assets/shell-integration.zsh", "셸 통합 스크립트 본체(OSC 133/633)"],
  ["crates/soksak-ptyd/", "PTY 세션 데몬 — 셸과 그 자식을 앱 밖에서 소유한다"],
  ["crates/soksak-spec-pty/", "PTY 계약 — shellPid·인계가 계약 필드다"],
  ["crates/soksak-core/src/shellq.rs", "로그인 셸에게 묻는 질의(-lc)의 임자"],
  ["crates/soksak-core/src/shell_env.rs", "자식 셸에 물려줄 env 화이트리스트·zsh 통합의 임자"],
  ["crates/soksak-core/src/ptyd.rs", "PTY 데몬 클라이언트 — 셸을 데몬에 띄우고 그 출력을 나른다"],
  ["crates/soksak-cored/src/pty.rs", "헬퍼의 터미널 서빙 — 같은 데몬에 붙어 셸을 띄운다"],
  ["src/terminal/", "터미널 셸 통합(OSC 7/133/633) 파서·브리지·status"],
  ["scripts/e2e/pty-survival.sh", "셸과 자식이 앱 재시작을 넘어 사는지 재는 하니스"],
  ["scripts/e2e/pty-degraded.sh", "degraded 복원에서 셸이 살아 도는지 재는 하니스"],
  ["scripts/e2e/pty-cold-restore.sh", "cold restore — 데몬 사망 후 새 셸 경로를 재는 하니스"],
  ["scripts/e2e/pty-cold-realistic.sh", "실사용 모사 cold restore 하니스"],
  ["scripts/e2e/pty-handoff.mjs", "무중단 판올림에서 같은 셸이 계속 답하는지 재는 게이트"],
  ["docs/RESTORE.md", "셸 생존·재부착·fd 인계 정본"],
  ["docs/RESTORE.ko.md", "셸 생존·재부착·fd 인계 정본(한글)"],
  ["docs/DEPLOY.md", "판올림이 셸을 죽이지 않는다는 배포 계약"],
  ["docs/DEPLOY.ko.md", "판올림이 셸을 죽이지 않는다는 배포 계약(한글)"],
  [".claude/", "에이전트 스킬 문서 — 여기의 shell 은 에이전트가 명령을 치는 셸이다"],
  ["plans/", "시점 기록 — 작성 당시 어휘를 보존한다(개명 대상 아님)"],
  ["scripts/gates/vocabulary-framework-scan.mjs", "이 게이트 자신 — 허용 목록·장부가 그 말을 인용한다"],
  ["scripts/gates/vocabulary-framework-scan.test.mjs", "이 게이트의 테스트 — 위반을 심어 잡는지 본다"],
];

// ── 진짜 셸을 가리키는 토큰 — R1 이 통과시킨다. 한 줄씩 사유를 적는다 ──────────
export const REAL_SHELL_TOKENS = new Map([
  ["login-shell", "cored 부팅 인자 `--login-shell` — 로그인 셸 경로를 값으로 받는다"],
  ["login_shell", "로그인 셸 필드·모듈(`$SHELL` 을 읽는 자리)"],
  ["login_shell:", "로그인 셸 필드"],
  ["loginshell", "로그인 셸(camelCase)"],
  ["with_login_shell", "로그인 셸을 실은 ctx 빌더"],
  ["ctx.login_shell", "ctx 의 로그인 셸 필드 읽기"],
  ["ctx.with_login_shell", "ctx 의 로그인 셸 필드 주입"],
  ["self.login_shell", "ctx 의 로그인 셸 필드"],
  ["self.login_shell.as_deref", "ctx 의 로그인 셸 필드"],
  ["crate::login_shell", "로그인 셸 모듈 참조"],
  ["crate::login_shell::ambient", "로그인 셸 앰비언트 읽기(유일 자리)"],
  ["login_shell.rs", "로그인 셸 모듈 파일명"],
  ["login_shell_readers", "`$SHELL` 을 읽는 자리를 세는 앰비언트 게이트"],
  ["each_framework_has_exactly_one_login_shell_reader", "프레임워크마다 로그인 셸 읽기가 하나인지 세는 검사 — 셸은 진짜 셸이다"],
  ["the_login_shell_scan_actually_finds_a_reader", "그 게이트가 실제로 잡는지 보는 테스트"],
  ["the_login_shell_has_one_reader", "`$SHELL` 을 읽는 자리는 하나라는 게이트"],
  ["powershell", "Windows 명령 해석기 — 어휘 표에서 shell 축의 예시로 적힌 이름"],
  ["$shell", "사용자 계정 속성 — 로그인 셸 경로"],
  ["process.env.shell", "사용자 계정 속성 읽기"],
  ["default_shell", "로그인 셸 부재 시 기본 경로"],
  ["shell_env", "자식 셸에 물려줄 env 규칙 모듈(진짜 셸의 환경)"],
  ["soksak_core::shell_env::session_env", "그 모듈의 세션 env 조립"],
  ["soksak_core::shell_env::AI_SESSION_ENV", "자식 셸에서 끊을 AI 세션 키 목록"],
  ["an_unknown_shell_is_refused_instead_of_guessed", "로그인 셸을 모르면 추측하지 않는다는 검사"],
  ["shell_which", "로그인 셸 PATH 로 바이너리를 찾는 질의"],
  ["shell-which", "같은 질의의 명령명 표기"],
  ["run_shell_which", "그 질의의 실행 헬퍼"],
  ["pty::shell_which", "그 질의의 모듈 경로"],
  ["shellq", "로그인 셸 질의 모듈"],
  ["soksak_core::shellq", "로그인 셸 질의 모듈 경로"],
  ["soksak_core::shellq::which_argv", "로그인 셸 질의 argv 조립"],
  ["soksak_core::shellq::npm_prefix_argv", "로그인 셸로 npm prefix 를 묻는 argv"],
  ["soksak_core::shellq::run_once_argv", "로그인 셸에게 명령 한 줄을 시키는 argv(-lc / /C)"],
  ["soksak_core::shellq::ps_command_argv", "그 실행이 남긴 pid 로 무엇이 도는지 묻는 argv"],
  ["soksak_core::shellq::reap_matches", "ps 명령줄 대조 — pid 재사용으로 남을 죽이지 않는 판정"],
  ["soksak_core::shellq::ring_push", "로그인 셸 실행의 출력 링버퍼 적재(줄 수 상한)"],
  ["soksak_core::shellq::ring_cap", "그 링버퍼의 줄 수 상한(토큰은 소문자로 대조된다)"],
  ["spawn_with_login_shell", "진짜 로그인 셸을 인자로 준 cored 를 띄우는 테스트 헬퍼"],
  ["daemon_run_once_refuses_without_a_login_shell", "로그인 셸을 못 받으면 추측하지 않고 거절하는지 보는 테스트"],
  ["daemon-run-once-no-shell", "그 테스트의 픽스처 루트 이름(로그인 셸 없는 판)"],
  ["soksak_core::shellq::npm_dirs_from_prefix", "npm prefix 파생"],
  ["soksak_core::shellq::is_safe_binary_name", "셸 한 줄에 끼워도 되는 이름인가"],
  ["serves_shell_which_by_asking_the_shell_it_was_given", "인자로 받은 셸에 묻는지 보는 테스트"],
  ["serves_npm_global_dirs_from_the_shell_it_was_given", "같은 축의 테스트"],
  ["the_shell_it_is_given_is_the_shell_it_uses", "받은 셸을 그대로 쓴다는 게이트"],
  ["a_shell_metacharacter_is_refused", "셸 메타문자 주입 거절 테스트"],
  ["a_session_is_registered_and_closed_without_a_shell_handle", "셸 핸들 없이 세션 장부만 도는지"],
  ["shell_survives_client_death_and_reattaches_with_replay", "앱 사망 후 셸 생존 테스트"],
  ["shellescape", "셸 한 줄에 넣을 값을 POSIX 인용한다"],
  ["shellcmd", "셸에 넘길 명령줄"],
  ["shell-command", "셸에 넘길 명령줄(문서 표기)"],
  ["shell-out", "네이티브 CLI 를 셸로 위임 실행"],
  ["shell-backed", "PTY 백드 셸 세션"],
  ["spawn_shell", "주어진 셸 경로로 스폰"],
  ["spawn_with_shell", "같은 스폰의 테스트 헬퍼"],
  ["fixture_shell", "픽스처 셸(정해진 답만 내는 가짜 로그인 셸)"],
  ["fixture-shell", "픽스처 셸 파일명"],
  ["fake-shell", "가짜 셸 실행 파일(데몬 스폰 테스트)"],
  ["soksak-daemon-namedshell", "부른 쪽이 지목한 셸이 돌았는지 재는 검사의 임시 디렉터리 접두"],
  ["run_once_uses_the_shell_the_caller_named", "셸은 입구가 인자로 나른다 — 전역 기본값이 있으면 배선을 잊어도 조용히 /bin/sh 로 돈다는 것을 재는 검사"],
  ["myshell", "shellq 테스트의 가짜 셸 경로"],
  ["shell_safe_base_env", "자식 셸에 승계할 표준 env 화이트리스트"],
  ["shell_safe_base_env_whitelists_standard_and_drops_secrets", "그 화이트리스트 게이트"],
  ["is_shell_safe_env_key", "자식 셸 승계 허용 키 판정"],
  ["shell_env_allow", "셸 env 승계 허용 목록"],
  ["shell_env_allow:", "셸 env 승계 허용 목록 필드"],
  ["shell_pid", "PTY 세션이 소유한 셸의 pid"],
  ["shell_pid:", "PTY 계약의 셸 pid 필드"],
  ["shellpid", "PTY 계약의 셸 pid 필드(와이어 표기)"],
  ["shell_pid2", "셸 pid 재측정 변수(생존 하니스)"],
  ["_shell", "마커 접미(`MARK_SHELL=$$` — 셸 pid 를 화면으로 낸다)"],
  ["_shell2", "같은 마커의 두 번째 측정"],
  ["shellsession", "셸 세션 id 종류(`sh-`)"],
  ["shellsession:", "셸 세션 접두 표의 키"],
  ["shell-integration", "셸 통합(OSC 133/633)"],
  ["shell-integration.zsh", "셸 통합 스크립트 파일명"],
  ["shellintegration", "셸 통합 모듈"],
  ["shellintegration.ts", "셸 통합 모듈 파일명"],
  ["shellintegration.ts:95-118", "셸 통합 모듈의 줄 인용"],
  ["settings.shell", "터미널 설정의 셸 경로 항목"],
  ["shell.default", "그 항목의 기본값 문구"],
  ["setshell", "그 설정의 React setter"],
  ["initshell", "부팅 파라미터로 받은 프로젝트 셸"],
  ["ps-shell-options", "프로젝트 설정 셸 입력의 datalist id"],
  ["np-shell-options", "새 프로젝트 셸 입력의 datalist id"],
  ["terminal-shell", "터미널 셸(이름 충돌 기록)"],
  ["powershell.exe", "윈도우의 명령 해석기"],
  ["shell-less", "셸이 없는 에이전트(Bash 도구 없음)"],
  ["shell-having", "셸이 있는 에이전트(Bash 도구 있음)"],
  ["shellcheck", "셸 스크립트 린터"],
  ["shells", "셸 복수형(산문)"],
  ["shells.", "셸 복수형(산문)"],
  ["hello_summary_resolves_to_shell_locale", "sok 이 셸 로케일로 문장을 해소하는지"],
]);

// ── 프레임워크 뜻으로 아직 남은 식별자 — 개명하면 여기서 빼라 ────────────────
export const IDENTIFIER_RESIDUE = new Map([
  ["a_sink_needs_no_shell_type", "frameworks/tauri/src/{stream_sink,activity_sink}.rs — 프레임워크 타입 없이 서는 출구"],
  ["the_sink_seam_needs_no_shell_type", "frameworks/tauri/src/watcher.rs — 같은 축"],
  ["an_oracle_needs_no_shell_type", "frameworks/tauri/src/window_oracle.rs — 같은 축"],
  ["a_dispatch_needs_no_shell_type", "frameworks/tauri/src/command_dispatch.rs — 같은 축"],
  ["a_fire_needs_no_shell_type", "crates/soksak-schedule/src/lib_tests.rs — 발화가 프레임워크 타입을 모른다는 검사 이름(몸을 따라 옮겼다)"],
  ["admitting_needs_no_shell_and_does_not_fan_out", "frameworks/tauri/src/activity.rs — 같은 축"],
  ["application_shell_denies_external_and_privileged_navigation", "frameworks/tauri/src/navigation_policy.rs — 앱 웹뷰(프레임워크)의 항행 정책"],
  ["application_shell_allows_only_the_declared_dev_origin", "frameworks/tauri/src/navigation_policy.rs — 같은 축"],
  ["shellwin", "src/commands/catalogDom.test.ts — 프레임워크 창 목(mock)"],
  ["hostshellpluginimport", "packages/plugin-spec — 발행된 계약 키(소비자 동반 개명 필요)"],
  ["host-shell-plugin-import", "packages/plugin-spec — 같은 축의 와이어 값"],
  ["chromium-shell", "docs/NATIVE-SURFACES.md — 프레임워크가 Chromium 인 앱"],
]);

// ── 진짜 셸을 말하는 줄의 표지 — R2 가 세지 않는다 ─────────────────────────────
export const REAL_SHELL_MARKERS = [
  /로그인\s?셸|login[ _-]shell|loginShell/i,
  /\$SHELL|env::var\("SHELL"\)|process\.env\.SHELL|"SHELL"/,
  /shell_which|shell-which|shellq|npm_global_dirs|npm prefix|shellEscape|shq /,
  /셸 통합|shell[ -]integration|OSC ?(7|133|633)|ZDOTDIR|preexec|\$COLUMNS/,
  /셸 세션|shell session|live shell|PTY|pty|ptyd|데몬|daemon/i,
  /zsh|bash|\/bin\/(sh|bash|zsh)|-lc\b|COMSPEC|xterm/,
  /셸 명령|셸 문법|셸 메타문자|셸 주입|셸 args|셸 프롬프트|셸 스크립트|셸 env|셸 환경|셸 질의/,
  /shell command|shell word|shell syntax|shell metacharacter|shell history|shell script/i,
  /shell-(having|less|out|backed|command)|shell breakout|shell permission|core shell API/i,
  /픽스처 셸|가짜 셸|진짜 셸|fixture[_-]shell|fake-shell|spawn_with_shell|셸 pid/,
  /셸 생존|셸 종료|셸이 살|셸을 죽|셸을 소유|살아 있는 셸|유령 셸|셸 스크롤백|셸 실행/,
  /셸 PATH|셸 로케일|셸 권한|셸 없는|셸 있는|셸 가진|셸아웃|셸-리스|셸 초기화|셸 위에서/,
  /이 셸의|셸의 로케일|셸의 언어|셸의 env|셸이 필요한|셸에 닿|셸에 물었|셸을 거치지/,
  /인자로 셸|셸을 받으면|인자로 받은 셸|주어진 셸|셸 실행 파일|셸 경로|셸 프로파일/,
  /터미널 셸|terminal[ -]shell|invoking shell|user shell|Shell binary|Terminal shell/i,
  /사용자 셸|시스템 \$?SHELL|기본 셸|미통합 셸|raw·미통합|서브셸|대화형 셸|자식 셸|패널 셸/,
  /셸·|셸 둘 다|셸\/xterm|shell query|shell\/font|Signal origin|shell \/ idle/,
  /settings\.shell|shell\.default|shell\?:|&shell=|=== "shell"|^\s*shell:\s*\{\s*$/,
  /\b(p|s|opts|args|patch|next|back|project)\??\.shell\b|setShell|\[shell, |, shell\)/,
  /shell-options|shell\.trim\(\)|\{shell\}|\("shell"\)|initShell|설정\(shell\)/,
  /스크롤백|cwd\/셸|\/셸\/|·셸\.|셸\/바이너리|셸\/null|셸이 출력|`alias`, `shell`/,
  /shell provider|source: "shell"|sessions `shell` field|"shell" \| "idle"|셸처럼/,
];

// ── 표지 없는 산문 줄의 장부 — 파일별 건수 + 판정. 개명하면 줄여라(0 이면 지워라) ──
// 판정 넷: [프레임워크] 개명 대상 · [UI] 앱 UI 컨테이너 뜻(제3의 용법, 어휘 미결) ·
//          [인용] 옛말을 기록으로 남긴 자리 · [진짜셸] 표지가 없는 진짜 셸 줄.
export const PROSE_LEDGER = new Map([
  // 데몬은 로그인 셸로 자식을 띄운다(GUI PATH 함정) — 전부 진짜 셸이다.
  ["crates/soksak-daemon/src/lib.rs", [13, "[진짜 셸] 로그인 셸 래핑·재시작 시 같은 셸 유지 — stop·status·logs·reap 의 몸이 프레임워크 폴더에서 따라 들어오며 늘었다(뜻은 그대로 로그인 셸)"]],
  ["crates/soksak-daemon/src/lib_tests.rs", [4, "[진짜 셸] 로그인 셸로 자식을 띄우는 검사 — 부른 쪽이 지목한 셸로 도는지 재는 검사가 늘었다"]],
  ["crates/soksak-cored/src/unserved.rs", [1, "[진짜 셸] pty_pane_pid 사유의 '셸이 비었다' — 로그인 셸의 전경 프로세스를 말한다"]],
  // 표를 몸에서 가르면서 이 줄이 따라왔다(registry.rs → registry_table.rs).
  ["crates/soksak-cored/src/registry_table.rs", [1, "[진짜 셸] spawn_terminal 의 shell 인자"]],
  ["crates/soksak-cored/src/pty_tests.rs", [2, "[진짜 셸] 로그인 셸 추측 금지 검사"]],
  ["crates/soksak-cored/src/main.rs", [1, "[진짜 셸] 부팅 인자 --login-shell"]],
  ["frameworks/tauri/src/activity.rs", [1, "[프레임워크] \"셸 타입\"·\"셸에 넘긴다\""]],
  ["frameworks/tauri/src/navigation_policy.rs", [2, "[UI] \"app shell\" — 앱 웹뷰의 항행 정책"]],
  ["crates/soksak-core/src/kv.rs", [1, "[프레임워크] \"자원이지 셸이 아니다\"·\"무-셸 게이트\"·\"셸 타입\""]],
  ["crates/soksak-core/src/identity.rs", [1, "[프레임워크] \"앱은 셸 설정에서\"·\"붙는 것은 셸의 일\""]],
  ["crates/soksak-core/src/pathx.rs", [1, "[진짜셸] 틸드 확장은 명령 해석기의 일 — \"우리는 셸이 아니다\""]],
  ["crates/soksak-core/src/ambient_gate_tests.rs", [1, "[진짜셸] 로그인 셸 읽기를 세는 검사"]],
  ["frameworks/tauri/src/cored_host_tests.rs", [1, "[진짜셸] cored 에 넘길 로그인 셸"]],
  ["scripts/diag/workspace-doctor.mjs", [1, "[프레임워크] \"셸이 아니라 도구가 채운다\" 서술"]],
  ["crates/soksak-core/src/pathx_tests.rs", [1, "[진짜셸] 같은 선언을 검사가 되풀이한다 — 형제 파일로 분리된 자리"]],
  ["src/lib/notify.test.ts", [1, "[프레임워크] \"셸은 경계 하나로 mock\" — 죽은 참조 ../platform 동반"]],
  ["src/framework/contract.ts", [1, "[인용] \"한때 이것을 '셸'이라 불렀는데\""]],
  ["docs/REPO-LAYOUT.md", [1, "[진짜셸] 어휘 넷의 표 — shell 은 사용자 셸(zsh·bash)이라고 정의하는 그 줄"]],
  ["docs/REPO-LAYOUT.ko.md", [1, "[진짜셸] 같은 표의 한글본"]],
  ["src/main.tsx", [1, "[UI] \"셸만 렌더한다\" — 앱 UI 컨테이너"]],
  ["src/orchestrator/OrchestratorApp.tsx", [2, "[UI] \"창 셸(A3)\" — 앱 UI 컨테이너"]],
  ["src/App.css", [1, "[UI] \"독립 셸\" — 앱 UI 컨테이너"]],
  ["src/components/ProjectionSlots.frame.test.tsx", [2, "[UI] \"레일 셸\" — UI 컨테이너"]],
  ["scripts/e2e/lib/frame-oracle.mjs", [2, "[프레임워크] \"셸마다 다른 것을 찍는다\"(Tauri vs Electron)"]],
  ["scripts/e2e/lib/frame-oracle.test.mjs", [2, "[프레임워크] 같은 축"]],
  ["scripts/e2e/frame-verdict.mjs", [1, "[프레임워크] \"셸이 어떻게 찍었든\""]],
  ["packages/plugin-api/README.md", [2, "[UI] \"the shell\"·\"main shell renderer\" — 발행된 README"]],
  ["packages/plugin-spec/src/pluginRuntime.ts", [2, "[UI] \"main shell renderer\"·와이어 값 host-shell-plugin-import"]],
  ["docs/FRAMEWORK-PORT.md", [2, "[인용] 옛말을 기록으로 남긴 자리 + [진짜 셸] ptyd 가 소유하는 셸(터미널 절)"]],
  ["docs/FRAMEWORK-PORT.ko.md", [1, "[인용] 옛말을 기록으로 남긴 자리"]],
  ["docs/NATIVE-SURFACES.md", [4, "[프레임워크/UI] \"DOM shell\"·\"Chromium-shell apps\"·\"webview shell\""]],
  ["docs/NATIVE-SURFACES.ko.md", [4, "[프레임워크/UI] 같은 축(한글)"]],
  ["docs/multiplatform-engine-strategy.md", [3, "[프레임워크/UI] \"host shell\"·\"app UI shell\""]],
  ["docs/multiplatform-engine-strategy.ko.md", [3, "[프레임워크/UI] 같은 축(한글)"]],
  // 배치 게이트 셋 — 어휘 넷을 **정의하는** 쪽이라 shell 축을 이름으로 적을 수밖에 없다.
  // 개명 대상이 아니다: 여기서 shell 이 사라지면 그 축을 판정할 근거가 사라진다.
  ["scripts/gates/framework-folder-vocabulary.mjs", [9, "[정의] 어휘 표와 그 사유 — shell 축을 이름으로 든다"]],
  ["scripts/gates/layout-gates.test.mjs", [1, "[정의] 그 표를 검증하는 단언 — 다른 축의 낱말 목록에 shell 이 든다"]],
  ["scripts/gates/workspace-root-not-framework.mjs", [1, "[정의] 어휘 넷 머리말"]],
]);


const TOKEN = /[A-Za-z0-9_$:\-]*[Ss][Hh][Ee][Ll][Ll][A-Za-z0-9_$:\-]*/g;
const WORD = /(^|[^A-Za-z0-9_$])(shell|Shell|SHELL)($|[^A-Za-z0-9_$])|셸/;

function listFiles(root) {
  let rels;
  try {
    const out = execFileSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    rels = out.split("\n");
  } catch {
    rels = walk(root, ""); // git 밖(테스트 픽스처) — 같은 규칙으로 훑는다
  }
  return rels.filter((rel) => rel && SCANNED_EXT.test(rel) && !rel.startsWith("node_modules/"));
}

function walk(root, prefix) {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

function allowedPath(rel) {
  return REAL_SHELL_PATHS.some(([p]) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

/** 이 줄이 진짜 셸을 말하는가. */
export function saysRealShell(line) {
  return REAL_SHELL_MARKERS.some((re) => re.test(line));
}

export function scanRoot(root = REPO_ROOT) {
  const violations = [];
  const seenIdentifierResidue = new Set();
  const proseCounts = new Map();

  for (const rel of listFiles(root)) {
    if (allowedPath(rel)) continue;
    let body;
    try {
      if (statSync(join(root, rel)).size > 4 * 1024 * 1024) continue;
      body = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (!/shell|SHELL|Shell|셸/.test(body) && !/shell/i.test(basename(rel))) continue;

    if (/shell/i.test(basename(rel))) {
      violations.push(`${rel}: 파일명이 shell 을 쓴다 — 프레임워크면 개명하고, 진짜 셸이면 REAL_SHELL_PATHS 에 사유와 함께 올려라`);
    }

    const lines = body.split("\n");
    let prose = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/shell|SHELL|Shell|셸/.test(line)) continue;

      // R1 — 붙은 토큰은 이름이다. 기계로 판별한다.
      for (const raw of line.match(TOKEN) ?? []) {
        const token = raw.toLowerCase().replace(/^[.:\-]+|[.:\-]+$/g, "");
        if (!token || token === "shell") continue;
        if (REAL_SHELL_TOKENS.has(token)) continue;
        if (IDENTIFIER_RESIDUE.has(token)) {
          seenIdentifierResidue.add(token);
          continue;
        }
        violations.push(`${rel}:${i + 1}: 식별자 \`${raw}\` — 프레임워크 뜻이면 framework 로 개명하고, 진짜 셸이면 REAL_SHELL_TOKENS 에 사유와 함께 올려라`);
      }

      // R2 — 산문. 진짜 셸 표지가 없는 줄만 센다.
      if (WORD.test(line) && !saysRealShell(line)) {
        prose += 1;
        if (process.env.VOCAB_DEBUG) console.error(`? ${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      }
    }
    if (prose) proseCounts.set(rel, prose);
  }

  for (const [token, why] of IDENTIFIER_RESIDUE) {
    if (!seenIdentifierResidue.has(token)) {
      violations.push(`IDENTIFIER_RESIDUE \`${token}\` 이 소스에 없다(${why}) — 개명됐으면 장부에서 빼라`);
    }
  }
  for (const [rel, count] of proseCounts) {
    const declared = PROSE_LEDGER.get(rel);
    if (!declared) {
      violations.push(`${rel}: 프레임워크 뜻으로 읽히는 줄 ${count}건이 장부에 없다 — 개명하거나 PROSE_LEDGER 에 사유와 함께 올려라`);
    } else if (declared[0] !== count) {
      violations.push(`${rel}: 장부 ${declared[0]}건 ≠ 실측 ${count}건 — 늘었으면 개명하고, 줄었으면 장부를 줄여라`);
    }
  }
  for (const [rel] of PROSE_LEDGER) {
    if (!proseCounts.has(rel)) {
      violations.push(`${rel}: 장부에 있는데 실측 0건 — 장부에서 지워라`);
    }
  }
  return violations;
}

function main() {
  const arg = process.argv.indexOf("--root");
  const root = arg >= 0 ? resolve(process.argv[arg + 1]) : REPO_ROOT;
  const violations = scanRoot(root);
  if (violations.length) {
    console.error(`vocabulary-framework: FAIL (${violations.length})`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  const residue = [...PROSE_LEDGER.values()].reduce((n, [c]) => n + c, 0) + IDENTIFIER_RESIDUE.size;
  console.log(`vocabulary-framework: PASS (선언된 잔여 ${residue}건 — 줄이면 장부도 줄여라)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
