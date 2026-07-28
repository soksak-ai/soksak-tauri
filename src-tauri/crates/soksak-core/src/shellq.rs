//! 로그인 셸에게 묻는 질문들 — **셸 경로를 값으로 받는다.**
//!
//! 이 자리가 없어서 `shell_which`·`npm_global_dirs` 가 이식되지 못했다. 명령의 몸이 프로세스
//! 환경(`$SHELL`)을 직접 읽으면 그 명령은 자기를 띄운 프로세스에 묶인다.
//!
//! 한때 이식 차단 사유가 이렇게 적혀 있었다: "부팅 인자로 셸을 받으면 GUI 셸의 좁은 PATH 를
//! 피하려 만든 명령이 다시 그 PATH 에 묶인다." **성립하지 않는다.** 넘기는 값은 PATH 가 아니라
//! 셸 실행 파일 경로이고, 호출은 `-lc` 다 — `-l` 이 rc/profile 을 읽어 PATH 를 처음부터 다시
//! 만들므로 부모의 좁은 PATH 는 상속되지 않는다. 이 저장소가 자기 코드에 그렇게 적어 뒀고
//! (GUI PATH 함정의 해법 자체가 그것이다), 사유가 사라졌으므로 두 명령은 서빙 가능하다.
//!
//! 여기 있는 것은 **argv 조립과 출력 해석**뿐이다. spawn 은 프로세스를 가진 쪽의 일이라
//! 코어가 하지 않는다 — 그래서 이 모듈은 셸 없이도 전부 검사된다.

/// 셸 한 줄에 끼워 넣어도 되는 이름인가.
///
/// `-lc` 뒤 문자열에 그대로 들어가므로 이름 문자만 허용한다. 이 검사가 없으면 `;`·`$(`·백틱이
/// 그대로 셸 문법이 된다 — 거부가 아니라 **다른 명령의 실행**으로 나타난다.
pub fn is_safe_binary_name(bin: &str) -> bool {
    !bin.is_empty()
        && bin
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// "이 바이너리가 사용자 PATH 에 있는가"를 묻는 argv.
///
/// `-l` 이 핵심이다 — 로그인 셸이 rc/profile 로 PATH 를 새로 만든다. 그래서 이 프로세스가
/// GUI 에서 떠 PATH 가 좁아도 답은 사용자 터미널과 같다.
pub fn which_argv(shell: &str, bin: &str) -> Option<(String, Vec<String>)> {
    if !is_safe_binary_name(bin) {
        return None;
    }
    Some((
        shell.to_string(),
        vec!["-lc".into(), format!("command -v {bin}")],
    ))
}

/// npm 글로벌 prefix 를 묻는 argv.
pub fn npm_prefix_argv(shell: &str) -> (String, Vec<String>) {
    (
        shell.to_string(),
        vec!["-lc".into(), "npm prefix -g".into()],
    )
}

/// npm prefix 출력에서 bin/lib 경로를 낸다.
///
/// 빈 출력은 "prefix 가 빈 문자열"이 아니라 **npm 이 없거나 답하지 못한 것**이다. 빈 값을
/// 그대로 흘리면 `/bin`·`/lib` 같은 시스템 경로가 만들어져 무결성 검사가 엉뚱한 곳을 본다.
pub fn npm_dirs_from_prefix(stdout: &str) -> Result<(String, String), String> {
    let prefix = stdout.trim();
    if prefix.is_empty() {
        return Err("npm prefix 미해소".into());
    }
    Ok((format!("{prefix}/bin"), format!("{prefix}/lib")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_metacharacter_is_refused() {
        for bad in ["a;rm -rf /", "$(whoami)", "`id`", "a b", "a|b", "", "a&b", "a>b"] {
            assert!(!is_safe_binary_name(bad), "{bad:?} 를 통과시켰다");
            assert!(which_argv("/bin/sh", bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn a_plain_name_is_allowed() {
        for ok in ["node", "npm", "python3", "my-tool", "my_tool", "a.out"] {
            assert!(is_safe_binary_name(ok), "{ok:?} 를 막았다");
        }
    }

    /// 셸은 **인자**다 — 준 값이 그대로 argv[0] 이어야 한다. 환경에서 다시 읽으면 이 단언이
    /// 통과할 수 없다.
    #[test]
    fn the_shell_it_is_given_is_the_shell_it_uses() {
        let (prog, args) = which_argv("/opt/fixture/myshell", "node").expect("정상 이름");
        assert_eq!(prog, "/opt/fixture/myshell");
        assert_eq!(args[0], "-lc");
        assert!(args[1].contains("node"));

        let (prog2, args2) = npm_prefix_argv("/opt/fixture/myshell");
        assert_eq!(prog2, "/opt/fixture/myshell");
        assert_eq!(args2[0], "-lc");
    }

    /// `-l` 이 빠지면 PATH 를 다시 만들지 않아 GUI 의 좁은 PATH 에 묶인다 — 그 차이는 오류가
    /// 아니라 "설치돼 있는데 없다고 답함"으로 나타난다.
    #[test]
    fn the_login_flag_is_present() {
        let (_, args) = which_argv("/bin/sh", "node").unwrap();
        assert!(args[0].contains('l'), "로그인 플래그가 없다: {args:?}");
        let (_, args2) = npm_prefix_argv("/bin/sh");
        assert!(args2[0].contains('l'), "{args2:?}");
    }

    #[test]
    fn an_empty_prefix_is_an_error_not_a_root_path() {
        assert!(npm_dirs_from_prefix("").is_err());
        assert!(npm_dirs_from_prefix("   \n ").is_err());
        let (bin, lib) = npm_dirs_from_prefix("/usr/local\n").unwrap();
        assert_eq!(bin, "/usr/local/bin");
        assert_eq!(lib, "/usr/local/lib");
    }
}
