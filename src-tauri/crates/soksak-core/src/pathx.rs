//! 경로 확장 — 홈은 **인자로 온다**.
//!
//! `~` 확장은 홈 하나만 알면 되는 순수 계산이다. 그런데 홈을 함수 안에서 읽으면
//! 그 순간 "이 프로세스의 환경"이 답의 일부가 되고, 프로세스가 갈리면 같은 입력이 다른
//! 경로를 낸다 — 그것도 조용히. 홈을 받으면 전제가 사라진다.
//!
//! 다른 사용자의 홈(`~user`)은 지원하지 않는다. 그것을 풀려면 사용자 데이터베이스를
//! 읽어야 하고, 그건 이 프로세스가 무엇인지에 다시 의존하게 된다 — 우리는 셸이 아니다.

use std::path::{Path, PathBuf};

/// 선행 `~` 를 주어진 홈으로 확장한다. `~` 단독과 `~/...` 만 처리한다.
pub fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}


/// 프로젝트 루트로 쓸 수 있는 경로인가 — **정규화된** 경로와 홈을 받아 판정한다.
///
/// 규칙: 홈(~) 자신과 파일시스템 루트(/)는 될 수 없다. 루트 초기화 정책이 그 트리 전체를
/// 대상으로 동작하므로, 홈이나 루트를 프로젝트로 잡으면 그 정책이 사용자 전체 파일에 걸린다.
///
/// 디스크를 만지지 않는다 — 존재 확인·정규화는 호출자가 하고 여기는 **판정만** 한다.
/// 그래야 같은 규칙을 어느 프로세스에서도 같은 답으로 물을 수 있다.
pub fn project_root_verdict(canonical: &Path, home: &Path) -> Result<(), String> {
    if canonical == home {
        return Err("홈 디렉토리(~)는 프로젝트 루트가 될 수 없음".to_string());
    }
    if canonical.parent().is_none() {
        return Err("파일시스템 루트(/)는 프로젝트 루트가 될 수 없음".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_alone_is_the_home() {
        assert_eq!(expand_tilde("~", Path::new("/u/max")), Path::new("/u/max"));
    }

    #[test]
    fn tilde_slash_joins_under_the_home() {
        assert_eq!(
            expand_tilde("~/.claude/projects", Path::new("/u/max")),
            Path::new("/u/max/.claude/projects")
        );
    }

    #[test]
    fn a_plain_path_is_untouched() {
        assert_eq!(expand_tilde("/etc/hosts", Path::new("/u/max")), Path::new("/etc/hosts"));
        assert_eq!(expand_tilde("rel/x", Path::new("/u/max")), Path::new("rel/x"));
    }

    #[test]
    fn another_users_home_is_not_expanded() {
        // "~other" 는 사용자 데이터베이스를 읽어야 풀린다 — 그건 프로세스 의존이다.
        // 확장하지 않고 그대로 둔다(셸이 아니라는 선언).
        assert_eq!(expand_tilde("~other/x", Path::new("/u/max")), Path::new("~other/x"));
    }

    #[test]
    fn the_same_input_with_two_homes_gives_two_answers() {
        // 홈이 인자라는 것의 요점 — 답이 프로세스가 아니라 입력으로 결정된다.
        let a = expand_tilde("~/x", Path::new("/home/a"));
        let b = expand_tilde("~/x", Path::new("/home/b"));
        assert_ne!(a, b);
    }

    #[test]
    fn the_home_itself_is_not_a_project_root() {
        let home = Path::new("/u/max");
        assert!(project_root_verdict(home, home).is_err());
        assert!(project_root_verdict(Path::new("/u/max/work"), home).is_ok());
    }

    #[test]
    fn the_filesystem_root_is_not_a_project_root() {
        assert!(project_root_verdict(Path::new("/"), Path::new("/u/max")).is_err());
    }

    #[test]
    fn the_verdict_follows_the_home_it_is_given() {
        // 홈이 인자라는 것의 요점 — 같은 경로가 홈에 따라 다르게 판정된다.
        let p = Path::new("/u/a");
        assert!(project_root_verdict(p, Path::new("/u/a")).is_err());
        assert!(project_root_verdict(p, Path::new("/u/b")).is_ok());
    }
}
