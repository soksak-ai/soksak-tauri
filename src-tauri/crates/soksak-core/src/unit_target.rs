//! 유닛 아티팩트의 타깃 트리플 — 설치 클로저가 per-(os,arch) 자산을 고르는 기준.
//!
//! 타깃은 **인자**다. `cfg!(target_os)` 로 답하면 그 함수는 호출자가 물은 것이 아니라
//! **자기 빌드**를 말한다: 같은 소스가 프로세스마다 다른 답을 내고, 그 차이는 오류가
//! 아니라 "다른 바이너리를 받는다"로 나타난다. 어느 호스트를 묻는지는 부르는 쪽이 안다.

/// (os, arch) → 유닛 타깃 트리플. 모르는 조합은 이름을 짓지 않는다.
///
/// `os`/`arch` 는 rust 의 `std::env::consts::{OS, ARCH}` 표기다(macos/linux/windows,
/// aarch64/x86_64). 없는 조합에 그럴듯한 트리플을 지어 주면 그 유닛은 **다운로드에
/// 성공하고 실행에 실패한다** — 고르지 못한 것은 고르지 못했다고 답한다.
pub fn host_target(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        // 윈도우 배급은 x86_64 한 벌이다 — arch 를 보지 않는다(arm64 윈도우는 이것을 에뮬레이트한다).
        ("windows", _) => Some("x86_64-pc-windows-msvc"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_supported_host_names_its_own_triple() {
        assert_eq!(host_target("macos", "aarch64"), Some("aarch64-apple-darwin"));
        assert_eq!(host_target("macos", "x86_64"), Some("x86_64-apple-darwin"));
        assert_eq!(
            host_target("linux", "aarch64"),
            Some("aarch64-unknown-linux-gnu")
        );
        assert_eq!(
            host_target("linux", "x86_64"),
            Some("x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            host_target("windows", "x86_64"),
            Some("x86_64-pc-windows-msvc")
        );
        assert_eq!(
            host_target("windows", "aarch64"),
            Some("x86_64-pc-windows-msvc"),
            "윈도우 배급은 한 벌이다"
        );
    }

    /// 답이 인자로 갈린다 — 이 크레이트가 자기 타깃을 말하지 않는다는 증거.
    #[test]
    fn the_answer_follows_the_argument_not_this_build() {
        assert_ne!(
            host_target("macos", "aarch64"),
            host_target("linux", "aarch64")
        );
        assert_ne!(
            host_target("macos", "aarch64"),
            host_target("macos", "x86_64")
        );
    }

    /// 모르는 호스트에 이름을 지어 주면 그 유닛은 받아서 못 돈다.
    #[test]
    fn an_unknown_host_gets_no_invented_triple() {
        assert_eq!(host_target("linux", "riscv64"), None);
        assert_eq!(host_target("freebsd", "x86_64"), None);
        assert_eq!(host_target("", ""), None);
    }
}
