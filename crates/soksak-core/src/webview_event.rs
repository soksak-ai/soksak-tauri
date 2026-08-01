//! 콘텐츠 뷰(브라우저) 사건의 **이름과 축** — 내는 쪽이 둘이라 한 자리에 둔다.
//!
//! 같은 사건을 두 곳이 낸다: 콘텐츠가 프로세스 밖에 사는 프레임워크는 Rust 가 emit 하고,
//! DOM 안에 사는 프레임워크는 렌더러가 그 자리에서 뿌린다(`contentViewEvents.ts`). 구독자는
//! 어디서 왔는지 모른다 — 이름이나 필드가 갈리면 **한쪽 프레임워크에서만 아무 일도 안 일어난다.**
//!
//! 실측(2026-08-01): Rust 페이로드가 `rename_all = "camelCase"` 라 `canBack`·`canForward` 를
//! 내는데 TS 는 `can_back`·`can_forward` 를 실었다. 소비자(발행된 browser-native·
//! browser-chromium)는 카멜을 읽으므로 그 프레임워크에서는 **뒤로가기 버튼이 항상 비활성**
//! 이었다. 오류는 아무 데도 안 났고, 주석과 검사가 오히려 그 틀린 기준을 지키고 있었다.

/// 항행 — 주소가 바뀌었다.
pub const NAV: &str = "browser-nav";
/// 제목이 바뀌었다.
pub const TITLE: &str = "browser-title";
/// 적재 시작/끝 — 뒤·앞 가능 여부를 함께 싣는다.
pub const LOADING: &str = "browser-loading";
/// 마우스가 가리키는 링크 등 상태줄 사실.
pub const STATUS: &str = "browser-status";
/// 이 뷰가 열 수 없는 주소 — 밖으로 넘긴다.
pub const OPEN_EXTERNAL: &str = "browser-open-external";

/// `LOADING` 이 싣는 축. **카멜이다** — 소비자가 그렇게 읽는다.
pub const LOADING_FIELDS: &[&str] = &["label", "loading", "canBack", "canForward"];

#[cfg(test)]
mod tests {
    use super::*;

    /// 이름은 접두사를 공유한다 — 구독자가 `browser-` 로 거른다.
    #[test]
    fn 모든_이름이_같은_갈래에_산다() {
        for n in [NAV, TITLE, LOADING, STATUS, OPEN_EXTERNAL] {
            assert!(n.starts_with("browser-"), "{n}");
        }
    }

    /// 적재 축은 카멜이다. 스네이크로 내면 소비자가 undefined 를 읽고, 그것은 오류가 아니라
    /// **항상 비활성인 버튼**으로 나타난다.
    #[test]
    fn 적재_축은_카멜이다() {
        assert!(LOADING_FIELDS.contains(&"canBack"));
        assert!(LOADING_FIELDS.contains(&"canForward"));
        assert!(!LOADING_FIELDS.iter().any(|f| f.contains('_')));
    }
}
