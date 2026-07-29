//! 이 프로세스가 상속한 로그인 셸 — `SHELL` 을 읽는 **유일한 자리**.
//!
//! 셋이 각자 읽던 자리다. 등재표는 "왜 읽는가"만 물어서 셋을 다 통과시켰고, 그 사이 폴백이
//! 갈렸다 — pty.rs 는 `/bin/bash`, daemon.rs 와 runtime_dep.rs 는 `/bin/sh`. 같은 프로세스가
//! 같은 질문에 두 답을 갖는 것은 그 자체로 결함이다.
//!
//! 더 비싼 것은 그 다음이다. 읽은 값이 읽은 함수 밖으로 흐르지 않아 명령의 몸이 프로세스
//! 환경에 묶였고, 그래서 `shell_which`·`npm_global_dirs` 를 cored 로 옮길 수 없었다. 한 자리가
//! 읽어 **값으로 흘리면** 폴백 분기와 이식 차단이 함께 풀린다.
//!
//! 값이 여기서 나가면 그 뒤로는 인자다. 프로세스가 갈리면 이 자리에 부팅 인자가 온다 —
//! `$SHELL` 은 프로세스 속성이 아니라 사용자 계정 속성이라 `--home`·`--identifier` 와 같은
//! 부팅 인자 자리가 맞다.

/// `$SHELL` 부재 시의 답.
///
/// `/bin/sh` 다. POSIX 가 존재를 보장하고 `/bin/bash` 는 아니다 — 최소 리눅스와 컨테이너에는
/// bash 가 없을 수 있다. 없는 셸을 폴백으로 두면 부재가 오류가 아니라 "명령이 조용히 실패"로
/// 나타난다. `-lc` 는 둘 다 받는다.
#[cfg(unix)]
pub const FALLBACK: &str = "/bin/sh";

/// 윈도우는 셸 개념이 다르다 — `SHELL` 이 아니라 `COMSPEC` 축이고, 그 자리는 호출자가 정한다.
#[cfg(not(unix))]
pub const FALLBACK: &str = "cmd";

/// 이 프로세스가 상속한 로그인 셸 경로.
///
/// 앰비언트 읽기는 여기 한 번이다. 아래로는 값이 인자로 흐른다.
pub fn ambient() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| FALLBACK.to_string())
    }
    #[cfg(not(unix))]
    {
        FALLBACK.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 폴백은 하나다 — 갈리면 같은 질문에 두 답이 된다.
    #[test]
    fn there_is_one_fallback() {
        assert!(!FALLBACK.is_empty());
        #[cfg(unix)]
        assert_eq!(FALLBACK, "/bin/sh", "POSIX 가 보장하는 것은 sh 다");
    }

    /// 읽기가 값을 낸다 — 빈 문자열은 spawn 에서 "No such file" 로만 드러난다.
    #[test]
    fn the_ambient_read_yields_a_path() {
        assert!(!ambient().is_empty());
    }
}
