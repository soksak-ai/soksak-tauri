//! 바이너리 관찰 — "PATH 에 있는가"가 아니라 **"돌리면 exit 0 인가"**.
//!
//! 존재는 작동이 아니다: 부분 설치·깨진 심링크·의존성 미해소는 파일이 있어도 못 돈다.
//! 그래서 이 관찰은 실제로 실행해 보고 exit 코드와 stdout 을 그대로 돌려준다(버전 추출은
//! 호출자가 자기 정규식으로 한다 — 여기서 문자열을 해석하지 않는다).
//!
//! 실행 자체가 실패한 것(부재·권한)도 답이다. `ok=false` 로 접어 넣는다: 부르는 쪽이 묻는
//! 것은 "이 의존성이 작동하는가" 하나이고, 못 돈 이유가 부재든 실패든 답은 같다.
//!
//! argv 는 전부 인자다 — 이 함수가 환경에서 읽는 값은 없다. 다만 `bin` 이 이름이면 argv[0]
//! 해소를 OS 가 그 프로세스의 PATH 로 한다. 호출자가 절대경로를 주면 그 전제도 사라진다.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProbeResult {
    /// probe argv 가 exit 0 (실제 작동).
    pub ok: bool,
    /// 버전 추출용 원문 — 해석은 호출자의 것.
    pub stdout: String,
}

/// bin 을 실제 실행해 작동을 관찰한다. 실행 실패(부재)도 `ok=false` 다.
pub fn probe_binary(bin: String, args: Vec<String>) -> ProbeResult {
    match std::process::Command::new(&bin).args(&args).output() {
        Ok(o) => ProbeResult {
            ok: o.status.success(),
            stdout: String::from_utf8_lossy(&o.stdout).to_string(),
        },
        Err(_) => ProbeResult {
            ok: false,
            stdout: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 셋을 한자리에서 가른다: 작동 / 존재하나 실패 / 부재.
    /// 가운데가 이 관찰이 존재하는 이유다 — 존재를 작동으로 세면 깨진 설치가 통과한다.
    #[test]
    fn presence_and_working_are_two_different_answers() {
        let works = probe_binary("echo".into(), vec!["hello".into()]);
        assert!(works.ok, "{works:?}");
        assert!(works.stdout.contains("hello"), "{works:?}");

        let present_but_failing = probe_binary("false".into(), vec![]);
        assert!(!present_but_failing.ok, "존재는 작동이 아니다");

        let absent = probe_binary("definitely-no-such-bin-xyz".into(), vec![]);
        assert!(!absent.ok, "부재도 답이다 — 실행 실패를 삼키지 않는다");
        assert!(absent.stdout.is_empty(), "{absent:?}");
    }

    /// 인자는 호출자의 것이다 — 같은 bin 이 인자에 따라 다른 답을 낸다.
    #[test]
    fn the_arguments_decide_the_answer() {
        assert_eq!(probe_binary("echo".into(), vec!["a".into()]).stdout.trim(), "a");
        assert_eq!(probe_binary("echo".into(), vec!["b".into()]).stdout.trim(), "b");
    }
}
