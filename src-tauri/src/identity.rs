// 정체성 계약 — "이 실행물은 누구이고 어느 홈을 쓰는가".
//
// 셸(ShellHost)·스트림 출구(StreamSink)·창 사실(WindowOracle)·활동 원장(ActivitySink)에
// 이어 다섯 번째 같은 모양의 경계다. 여기서 떼어내는 것은 **앰비언트 전역**이다:
// `home.rs` 의 `static HOME`/`IDENTIFIER` 는 `OnceLock` 이고 씨앗은 `lib.rs` 의
// `home::init(app.config().identifier)` 단 한 곳 — 즉 값의 출처가 셸이다.
//
// 그래서 홈 경로 하나만 알면 되는 함수도 `soksak_home()` 를 부르고, 그 순간 그 함수는
// "이 프로세스가 앱이다"를 전제하게 된다. 인자로 받으면 전제가 사라진다.
//
// 적대적 감사(2026-07-27, 명령 108개 전이 의존 추적)가 이 패턴을 최대 이득으로 짚었다:
// 28개가 닿아 있고, 이것 하나를 끊으면 15개가 즉시 풀린다. 다른 어떤 패턴도 단독으로는
// 0개를 푼다(AppHandle 시그니처·activity::publish 포함 — 그것들은 증상이지 원인이 아니다).
//
// 파생 규칙은 이미 순수 함수로 있었다(`core_build_for_identifier`·`cli_for_core_build`·
// `is_release_identifier`). 없던 것은 그 값을 **넘겨받는 통로**뿐이다.

use std::path::{Path, PathBuf};

/// 이 실행물의 정체성. 홈과 identifier 는 함께 다닌다 — 따로 넘기면 두 값이 어긋난
/// 조합("A 홈인데 B identifier")이 만들어지고, 그 조합은 어느 identity 에도 없다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Identity {
    home: PathBuf,
    identifier: String,
}

impl Identity {
    pub(crate) fn new(home: impl Into<PathBuf>, identifier: impl Into<String>) -> Self {
        Identity {
            home: home.into(),
            identifier: identifier.into(),
        }
    }

    pub(crate) fn home(&self) -> &Path {
        &self.home
    }

    pub(crate) fn identifier(&self) -> &str {
        &self.identifier
    }

    /// release core 판정 — identifier 마지막 세그먼트가 "app". updater 채널만 결정한다.
    pub(crate) fn is_release(&self) -> bool {
        crate::home::core_build_for_identifier(&self.identifier) == "release"
    }

    /// 이 정체성의 CLI 이름(sok / sok-dev / sok-debug).
    pub(crate) fn cli_name(&self) -> String {
        crate::home::cli_for_core_build(&crate::home::core_build_for_identifier(&self.identifier))
    }

    /// 홈 아래 경로 — 홈을 직접 조립하는 호출자를 없앤다.
    ///
    /// **항상 홈 아래**다. `Path::join` 은 절대경로를 받으면 베이스를 통째로 버리는데,
    /// 이 계약의 값은 "홈 아래"를 보장하는 데 있다. 조용히 탈출을 허용하면 계약이
    /// 거짓말이 되고, 그 거짓말은 호출자가 검사를 생략하는 근거가 된다. 절대경로·`..`
    /// 는 루트와 부모 컴포넌트를 떼어 상대 경로로 읽는다.
    pub(crate) fn path(&self, rel: impl AsRef<Path>) -> PathBuf {
        use std::path::Component;
        let mut out = self.home.clone();
        for c in rel.as_ref().components() {
            match c {
                Component::Normal(part) => out.push(part),
                // 루트·프리픽스·"."·".." 는 홈을 벗어나거나 되돌리는 컴포넌트다 — 버린다.
                _ => continue,
            }
        }
        out
    }
}

/// 현재 프로세스의 정체성 — 앰비언트 전역에서 한 번 읽어 값으로 만든다.
///
/// 이 함수는 **경계의 이쪽 끝**이다. 여기서만 전역을 읽고, 그 아래로는 값이 흐른다.
/// 헬퍼 프로세스에서는 이 함수 대신 인자로 받은 정체성을 쓰게 된다.
pub(crate) fn ambient() -> Identity {
    Identity::new(crate::home::soksak_home(), crate::home::identifier())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_a_value_not_an_ambient_read() {
        // 전역을 건드리지 않고 임의 정체성을 만들 수 있다 — 그것이 이 계약의 요점이다.
        let dev = Identity::new("/tmp/x-dev", "com.soksak.dev");
        assert_eq!(dev.home(), Path::new("/tmp/x-dev"));
        assert!(!dev.is_release());
        assert_eq!(dev.cli_name(), "sok-dev");
    }

    #[test]
    fn release_identity_reads_release() {
        let rel = Identity::new("/tmp/x", "com.soksak.app");
        assert!(rel.is_release());
        assert_eq!(rel.cli_name(), "sok");
    }

    #[test]
    fn two_identities_never_share_a_home() {
        // 홈과 identifier 가 함께 다니는 이유 — 따로 넘기면 어긋난 조합이 만들어진다.
        let a = Identity::new("/tmp/a", "com.soksak.dev");
        let b = Identity::new("/tmp/b", "com.soksak.debug");
        assert_ne!(a.home(), b.home());
        assert_ne!(a.identifier(), b.identifier());
    }

    #[test]
    fn paths_are_derived_from_the_identity_not_assembled_by_callers() {
        let id = Identity::new("/tmp/x-dev", "com.soksak.dev");
        assert_eq!(id.path("plugins"), Path::new("/tmp/x-dev/plugins"));
        // 여러 세그먼트를 한 번에 받는다 — 호출자가 join 을 이어붙이면 그 자리마다
        // 홈 조립 규칙이 흩어진다(plugins.rs 가 workspaces/plugins 를 그렇게 만들었다).
        assert_eq!(
            id.path("workspaces/plugins"),
            Path::new("/tmp/x-dev/workspaces/plugins")
        );
        assert_eq!(id.path("run/ptyd.sock"), Path::new("/tmp/x-dev/run/ptyd.sock"));
    }

    #[test]
    fn an_absolute_argument_cannot_escape_the_home() {
        // Path::join 은 절대경로를 받으면 **베이스를 통째로 버린다**. 이 계약의 값은
        // "홈 아래"를 보장하는 데 있으므로, 탈출을 조용히 허용하면 계약이 거짓말이 된다.
        let id = Identity::new("/tmp/x-dev", "com.soksak.dev");
        let escaped = id.path("/etc/passwd");
        assert_eq!(escaped, Path::new("/tmp/x-dev/etc/passwd"));
        // ".." 도 홈을 되돌리지 못한다.
        assert_eq!(
            id.path("../../etc/passwd"),
            Path::new("/tmp/x-dev/etc/passwd")
        );
    }
}
