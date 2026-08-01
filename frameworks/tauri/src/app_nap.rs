// 가려진 창도 계속 그린다 — 이 실행물이 자기 자신에게 주는 보장이다.
//
// macOS 는 앞에 없는 앱의 타이머·렌더를 늦춘다(App Nap). 그래서 가려진 웹뷰를 재면 측정이
// 무효가 되고, 그걸 피하려고 검증 스크립트가 **OS 를 빌려 창을 앞으로 냈다**
// (`osascript System Events`, `scripts/e2e/resize.sh`).
//
// 그 방법은 두 가지를 어긴다. 운영체제의 표면(UI 스크립팅·보조 접근 권한)에 기대고, 사용자가
// 보던 화면을 빼앗는다. 포커스는 모든 동작이 끝난 뒤 보이지 않아서 사용자가 요청할 때만 준다.
//
// 그러므로 고칠 자리는 스크립트가 아니라 **앱**이다. 가려져도 안 느려진다는 것은 앱이 선언할
// 보장이고, 형제 프레임워크는 이미 선언했다(`backgroundThrottling: false`). 여기서 같은 보장을
// 세운다 — 권한도, 포커스도, 사용자 승인도 필요 없는 자기 선언이다.
//
// `beginActivity` 는 **살아 있는 동안만** 유효하다. 반환된 토큰을 떨구면 그 순간 보장이 사라진다.
// 그래서 프로세스 수명 동안 든다 — 놓을 자리가 없다는 것이 이 자리의 계약이다.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};
    use std::sync::OnceLock;

    /// 활동 토큰 — 프로세스가 사는 동안 든다. 떨구면 그 즉시 App Nap 이 돌아온다.
    static TOKEN: OnceLock<TokenCell> = OnceLock::new();

    struct TokenCell(Retained<objc2::runtime::ProtocolObject<dyn NSObjectProtocol>>);
    // 토큰은 들고만 있는다 — 다른 스레드가 만지지 않는다.
    unsafe impl Send for TokenCell {}
    unsafe impl Sync for TokenCell {}

    /// 이 프로세스가 App Nap 에 들지 않게 한다. 두 번 불러도 한 번만 든다.
    pub fn hold() {
        if TOKEN.get().is_some() {
            return;
        }
        // userInitiated: 사용자가 시킨 일이다. latencyCritical: 늦추면 재는 값이 거짓이 된다.
        let options = NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical;
        let reason = NSString::from_str("가려진 창도 계속 그린다 — 측정과 렌더가 앞뒤에 무관해야 한다");
        let token = unsafe { NSProcessInfo::processInfo().beginActivityWithOptions_reason(options, &reason) };
        let _ = TOKEN.set(TokenCell(token));
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// 이 플랫폼은 앞뒤로 렌더를 늦추지 않는다 — 들 것이 없다.
    pub fn hold() {}
}

pub use imp::hold;
