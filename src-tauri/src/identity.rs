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
// **값 자체는 soksak-core 이 소유한다.** 앱과 cored 가 같은 정체성을 같은 규칙으로 읽어야
// 하기 때문이다(각자 struct 를 들면 파생 규칙이 두 벌이 되고, 두 벌은 언젠가 갈라진다).
// 이 파일에 남는 것은 **앰비언트에서 값으로 건너오는 한 지점**뿐이다.

pub(crate) use soksak_core::identity::Identity;

/// 현재 프로세스의 정체성 — 앰비언트 전역에서 한 번 읽어 값으로 만든다.
///
/// 이 함수는 **경계의 이쪽 끝**이다. 여기서만 전역을 읽고, 그 아래로는 값이 흐른다.
/// cored 프로세스에는 이 함수가 없다 — 거기서는 띄운 쪽이 준 값이 그대로 정체성이다.
pub(crate) fn ambient() -> Identity {
    Identity::new(crate::home::soksak_home(), crate::home::identifier())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

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

    /// 앱과 cored 가 **같은 규칙**을 본다는 사실 자체를 단언한다. 앱이 자기 struct 를 다시
    /// 들면 이 단언은 컴파일은 되지만 뜻을 잃는다 — 그래서 코어 크레이트 경로로 못박는다.
    #[test]
    fn the_app_and_the_helper_share_one_identity_type() {
        fn takes_core(id: soksak_core::identity::Identity) -> String {
            id.cli_name()
        }
        assert_eq!(
            takes_core(Identity::new("/tmp/x-debug", "com.soksak.debug")),
            "sok-debug"
        );
    }
}
