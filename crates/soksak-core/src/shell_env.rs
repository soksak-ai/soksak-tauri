//! 셸 세션 env — 자식 셸에 무엇을 물려주고 무엇을 끊는가.
//!
//! **화이트리스트가 두 벌이면 시크릿 유출이 프로세스마다 다르다.** 앱이 막는 값을 헬퍼가
//! 흘리면 그 차이는 오류가 아니라 "그쪽으로 띄운 터미널에서만 새는" 조용한 구멍이다.
//!
//! 프로세스의 사실은 **인자**다: 물려줄 부모 env, 앱 소켓 경로, 끊을 AI 세션 키 목록. 여기서
//! 환경을 직접 읽으면 같은 코드가 프로세스마다 다른 셸을 만든다(no_framework 게이트가 그
//! 철자를 막는다). 조립 규칙만 여기 있다.

// (scrub_ai_env)가 같은 목록을 쓴다 — 목록 추가는 여기 한 곳.
pub const AI_SESSION_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_CODE_EXECPATH",
    "CODEX_COMPANION_SESSION_ID",
    "AI_AGENT",
];

/// 대화형 zsh 에 끼우는 통합 스크립트 — 명령 시작/끝·cwd 를 OSC 로 알린다.
/// 스크립트가 단일진실이라 파일에서 읽는다(사본을 두면 두 벌이 갈린다).
const ZSH_INTEGRATION: &str = include_str!("../assets/shell-integration.zsh");

// zsh 일 때 OSC 133/7 셸 통합을 주입한다. 임시 ZDOTDIR 에 .zshenv/.zshrc 를 써서
// 사용자 원본 설정을 먼저 source 한 뒤 통합 스크립트를 로드한다(사용자 설정 보존).
// 실패해도 통합만 빠질 뿐 셸은 정상 동작하므로 빈 목록을 돌려준다(에러 비전파).
// env 쌍을 돌려주는 순수한 형태 — Local(CommandBuilder)과 Daemon(env 목록 전송)이
// 같은 소스를 쓴다(단일 진실).
pub fn zsh_integration_env(shell: &str, temp_dir: &std::path::Path, orig_zdotdir: &str) -> Vec<(String, String)> {
    let is_zsh = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "zsh")
        .unwrap_or(false);
    if !is_zsh {
        return Vec::new();
    }

    let dir = temp_dir.join("vsterm-zdotdir");
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let integ = dir.join("shell-integration.zsh");
    if std::fs::write(&integ, ZSH_INTEGRATION).is_err() {
        return Vec::new();
    }

    let orig = orig_zdotdir;

    let zshenv = "[[ -f \"$VSTERM_ORIG_ZDOTDIR/.zshenv\" ]] && \
         source \"$VSTERM_ORIG_ZDOTDIR/.zshenv\"\n";
    let zshrc = format!(
        "[[ -f \"$VSTERM_ORIG_ZDOTDIR/.zshrc\" ]] && \
         source \"$VSTERM_ORIG_ZDOTDIR/.zshrc\"\n\
         ZDOTDIR=\"$VSTERM_ORIG_ZDOTDIR\"\n\
         source {:?}\n",
        integ.to_string_lossy()
    );
    if std::fs::write(dir.join(".zshenv"), zshenv).is_err()
        || std::fs::write(dir.join(".zshrc"), zshrc).is_err()
    {
        return Vec::new();
    }

    vec![
        ("VSTERM_ORIG_ZDOTDIR".to_string(), orig.to_string()),
        ("ZDOTDIR".to_string(), dir.to_string_lossy().to_string()),
    ]
}

// env_clear 후 부모 env 에서 자식 셸로 승계할 표준 화이트리스트. 이 목록 밖(내부 시크릿
// SOKSAK_VAULT_KEY·SOKSAK_SECRET_*·격리 볼트 경로, 그 밖의 임의 비밀)은 원천 차단된다. 대화형
// 셸은 프로파일(.zshrc 등)을 재소싱하므로 최소 승계로도 정상 동작한다 — 그래서 프로파일이 세팅하지
// 않는 런타임 핸들(SSH 에이전트·X/Wayland 세션)만 골라 담는다. SOKSAK_* 인터페이스와 TERM/COLORTERM
// 은 build_session_env 가 명시 주입한다(여기 중복 불필요).
const SHELL_ENV_ALLOW: &[&str] = &[
    // 셸·계정 기본
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    // 터미널·로케일(TERM/COLORTERM 은 build_session_env 가 덮어씀)
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "COLORTERM",
    "TERMINFO",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    // 에디터·페이저
    "EDITOR",
    "VISUAL",
    "PAGER",
    // SSH 사용 케이스 — 프로파일이 세팅하지 않는 에이전트·연결 핸들(SSH 세션에서 필수)
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    // Linux 세션/디스플레이 — 프로파일이 세팅하지 않는 런타임 핸들
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "GPG_TTY",
];

// 승계 대상 판정 — LC_* 로케일 카테고리는 접두 매칭, 나머지는 정확 일치.
pub fn is_shell_safe_env_key(k: &str) -> bool {
    SHELL_ENV_ALLOW.contains(&k) || k.starts_with("LC_")
}

// 부모 env 에서 대화형 셸에 정당한 표준 변수만 골라낸다. 순수 함수 — 실제 env 에 무관해 단위
// 테스트가 결정적이다. 이것이 화이트리스트의 단일 진실(Local·Daemon 백엔드가 같은 목록을 쓴다).
pub fn shell_safe_base_env<I: Iterator<Item = (String, String)>>(vars: I) -> Vec<(String, String)> {
    vars.filter(|(k, _)| is_shell_safe_env_key(k)).collect()
}

// 세션 env 조립 — 두 백엔드의 단일 소스. 터미널은 신선한 셸 컨텍스트여야 한다:
// soksak 을 claude(Claude Code) 세션 안에서 띄우면 claude 가 주입한 세션 env 가
// PTY 로 새어 터미널의 claude 가 자기를 중첩 자식 세션으로 오인한다 — AI 세션
// 컨텍스트 env 를 제거해 항상 최상위 세션으로 시작하게 한다(목록 정본은
// process.rs AI_SESSION_ENV). SOKSAK_* 주입은 AI 명령 인터페이스 컨텍스트
// 로, 자식이 자기가 붙은 pane 을 이름으로 알게 한다.
pub fn session_env(
    shell: &str,
    pane_id: &Option<String>,
    window_label: &Option<String>,
    inherited: impl Iterator<Item = (String, String)>,
    socket: Option<&str>,
    ai_session_env: &[&str],
    // 임시 경로와 사용자의 원래 ZDOTDIR 도 프로세스의 사실이다 — 여기서 읽으면 같은 코드가
    // 프로세스마다 다른 자리에 통합 스크립트를 쓰고, 다른 사용자 설정을 source 한다.
    temp_dir: &std::path::Path,
    orig_zdotdir: &str,
) -> (Vec<(String, String)>, Vec<String>) {
    // env_clear 후 이 목록만 자식 셸에 주입된다(양 백엔드 공통). 부모 env 에서 표준 화이트리스트만
    // 승계 — 내부 시크릿(SOKSAK_VAULT_KEY 등)은 목록 밖이라 자식으로 새지 않는다. TERM/COLORTERM 은
    // 승계값을 무시하고 아래에서 고정 주입한다.
    let mut env: Vec<(String, String)> = shell_safe_base_env(inherited);
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    if let Some(pane) = pane_id {
        // 호출자 문맥 축 — "터미널 안 내 위치"다. 옛 이름 SOKSAK_PANE 은 뜻이 뒤집힌
        // 세대(pane=탭 인스턴스)의 잔재라 SOKSAK_CALLER_TAB 으로 개명한다(IDENTITY §3).
        // 이행 구간: 둘 다 주입한다 — PTY 는 spawn 시점 env 가 고정이라 기존 셸이 옛
        // 이름을 들고 있고, 외부 스크립트도 옛 이름을 읽을 수 있다.
        // 제거 조건: 모든 세션 교체(옛 이름을 읽는 세션 소멸).
        env.push(("SOKSAK_CALLER_TAB".into(), pane.clone()));
        env.push(("SOKSAK_PANE".into(), pane.clone()));
    }
    // 멀티윈도우: 내 창 label 주입(PANE 과 대칭) — 빈 문자열은 미주입.
    if let Some(w) = window_label.as_deref().filter(|w| !w.is_empty()) {
        env.push(("SOKSAK_WINDOW".into(), w.to_string()));
    }
    if let Some(sock) = socket.filter(|s| !s.is_empty()) {
        env.push(("SOKSAK_SOCKET".into(), sock.to_string()));
    }
    env.extend(zsh_integration_env(shell, temp_dir, orig_zdotdir));
    let env_remove: Vec<String> = ai_session_env.iter().map(|k| k.to_string()).collect();
    (env, env_remove)
}


#[cfg(test)]
mod tests {
    use super::*;

    // 셸 env 화이트리스트 — (a) 내부 시크릿·임의 비밀은 0, (b) 필수 표준·SSH 핸들은 승계.
    // env_clear 후 자식 셸에 실제로 들어갈 목록을 순수 함수 수준에서 못박는다(Local·Daemon 공통).
    #[test]
    fn shell_safe_base_env_whitelists_standard_and_drops_secrets() {
        let parent = [
            // 필수 표준 — 승계돼야 함
            ("PATH", "/usr/bin"),
            ("HOME", "/home/x"),
            ("USER", "x"),
            ("SHELL", "/bin/zsh"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C"),
            ("TZ", "UTC"),
            ("TMPDIR", "<local-evidence>"),
            ("SSH_AUTH_SOCK", "/run/ssh-agent.sock"),
            // 내부/민감 — 반드시 탈락
            ("SOKSAK_VAULT_KEY", "MASTER-LEAK"),
            ("SOKSAK_SECRET_0", "sk-real-9z"),
            ("SOKSAK_VAULT_PATH", "/iso/secrets.vault"),
            ("CLAUDECODE", "1"),
            ("AWS_SECRET_ACCESS_KEY", "zzz"),
        ];
        let got: std::collections::HashMap<String, String> =
            shell_safe_base_env(parent.iter().map(|(k, v)| (k.to_string(), v.to_string())))
                .into_iter()
                .collect();

        // (b) 필수 표준·SSH 핸들은 승계된다.
        for k in [
            "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "SSH_AUTH_SOCK",
        ] {
            assert!(got.contains_key(k), "{k} 는 화이트리스트로 승계돼야 한다");
        }
        // (a) 내부/민감은 자식 env 에서 0.
        for k in [
            "SOKSAK_VAULT_KEY",
            "SOKSAK_SECRET_0",
            "SOKSAK_VAULT_PATH",
            "CLAUDECODE",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!got.contains_key(k), "{k} 는 화이트리스트에 탈락해야 한다");
        }
    }

    /// 프로세스의 사실은 인자다 — 준 것만 물려주고, 안 준 소켓은 주입하지 않는다.
    #[test]
    fn the_process_facts_come_in_as_arguments() {
        let (env, remove) = session_env(
            "/bin/zsh",
            &Some("tab-1".to_string()),
            &Some("w-1".to_string()),
            [("PATH".to_string(), "/usr/bin".to_string())].into_iter(),
            Some("<local-evidence>/x.sock"),
            &["CLAUDECODE"],
            std::path::Path::new("<local-evidence>"),
            "/home/x",
        );
        let m: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(m.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(m.get("SOKSAK_SOCKET").map(String::as_str), Some("<local-evidence>/x.sock"));
        assert_eq!(m.get("SOKSAK_WINDOW").map(String::as_str), Some("w-1"));
        assert_eq!(m.get("SOKSAK_CALLER_TAB").map(String::as_str), Some("tab-1"));
        assert_eq!(remove, vec!["CLAUDECODE".to_string()]);
    }

    /// 소켓을 모르면 주입하지 않는다 — 빈 값을 심으면 자식이 없는 소켓에 붙으려 한다.
    #[test]
    fn an_unknown_socket_is_not_injected() {
        let (env, _) = session_env(
            "/bin/sh",
            &None,
            &None,
            std::iter::empty(),
            None,
            &[],
            std::path::Path::new("<local-evidence>"),
            "",
        );
        assert!(!env.iter().any(|(k, _)| k == "SOKSAK_SOCKET"));
        let (env2, _) = session_env(
            "/bin/sh",
            &None,
            &None,
            std::iter::empty(),
            Some(""),
            &[],
            std::path::Path::new("<local-evidence>"),
            "",
        );
        assert!(!env2.iter().any(|(k, _)| k == "SOKSAK_SOCKET"));
    }
}
