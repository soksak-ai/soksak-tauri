// OS 키체인 KEK 의 검사 — 규칙은 이 크레이트가, 그 증명은 여기가 진다.
//
// 실 키체인을 건드리지 않는다. 인메모리 store 로 get-or-create 와 안전핀(무음 재생성 금지)을
// 재고, 서비스명은 값으로 대조한다 — 존재 확인만 하면 이름이 틀려도 통과하고, 틀린 이름은
// 빈 볼트를 새로 만드는 경로로 이어진다(그때 앱은 "시크릿이 비었다"를 답한다).
use super::*;
use std::sync::Mutex;










// zeroize 는 drop 스크럽이라 직접 관측 불가 — 정직하게 타입으로만 증명한다. 반환 타입이

/// 서비스명은 **값으로** 대조한다. 존재 확인만 하면 이름이 틀려도 통과하고, 틀린 이름은 빈 볼트를
/// 서비스명은 **값으로** 대조한다. 존재 확인만 하면 이름이 틀려도 통과하고, 틀린 이름은 빈 볼트를
/// 새로 만드는 경로로 이어진다 — 그때 앱은 오류가 아니라 "시크릿이 비었다"를 답한다.
#[test]
fn the_service_name_comes_from_the_environment_axis_not_the_framework() {
    let of = |id: &str| {
        KekStore::for_identity(&soksak_core::identity::Identity::new("<local-evidence>/vault-axis", id))
            .service()
            .to_string()
    };
    // 프레임워크가 달라도 같은 볼트를 연다 — 홈이 하나이기 때문이다.
    assert_eq!(of("com.soksak.tauri.dev"), "com.soksak.dev");
    assert_eq!(of("com.soksak.electron.dev"), "com.soksak.dev");
    // env 가 다르면 홈이 갈리므로 열쇠도 갈린다.
    assert_eq!(of("com.soksak.tauri.debug"), "com.soksak.debug");
    assert_ne!(of("com.soksak.tauri.dev"), of("com.soksak.tauri.debug"));
}
