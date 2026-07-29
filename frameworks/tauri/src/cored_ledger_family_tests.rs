// 갈래 선언 게이트 — cored_ledger 의 FRAMEWORK_FAMILIES 를 검사한다.
//
// 코드와 분리해 둔다. `#[path]` 로 붙으므로 같은 모듈 트리 안이고, 비공개 항목에 그대로 닿는다.
use super::*;

/// 선언한 갈래는 **실재해야 한다.**
///
/// 멤버가 없는 접두사는 아무것도 분류하지 않으면서 그물만 넓힌다. 앞으로 그 이름을 가진
/// 명령이 생기면 아무도 결정한 적 없이 "프레임워크의 것"이 되어 이식 대상에서 빠지고,
/// 프레임워크 쪽에서는 소켓에 닿지 못한 채 부재로 거절된다 — 양쪽 다 조용하다.
///
/// 앞을 내다본 선언은 그 자체가 결정이다. 결정은 대상이 생겼을 때 내린다.
#[test]
fn every_declared_family_has_a_member() {
    let cmds = crate::cored_shape_gate::app_commands();
    // 오라클 생존 — 표가 비면 아래 단언이 모든 갈래를 빈 것으로 몰아 오히려 실패하지만,
    // 표를 읽지 못하는 상태와 갈래가 빈 상태는 다른 사실이라 먼저 가른다.
    assert!(!cmds.is_empty(), "앱 명령 표를 읽지 못했다 — 이 검사는 판정할 수 없다");
    let empty: Vec<&str> = FRAMEWORK_FAMILIES
        .iter()
        .copied()
        .filter(|p| !cmds.iter().any(|c| c.name.starts_with(p)))
        .collect();
    assert_eq!(
        empty,
        Vec::<&str>::new(),
        "멤버 없는 갈래가 선언돼 있다 — 대상이 생겼을 때 선언해라",
    );
}

/// 갈래 목록은 **한 벌**이다 — 프레임워크도 같은 목록으로 발견한다.
///
/// 두 벌이면 갈라져도 아무것도 실패하지 않고, 갈라진 순간 "장부는 프레임워크의 것이라 하는데
/// 프레임워크는 안 받는" 이름이 생긴다. 그 이름은 어느 쪽에도 안 잡힌다.
#[test]
fn the_framework_declares_the_same_families() {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../electron/native/index.cjs"
    ))
    .expect("프레임워크의 발견 규칙을 읽지 못했다");
    let line = src
        .lines()
        .find(|l| l.contains("const BRANCHES"))
        .expect("프레임워크에 갈래 목록이 없다");
    for p in FRAMEWORK_FAMILIES {
        assert!(line.contains(p), "프레임워크 목록에 {p} 가 없다: {line}");
    }
    // 반대 방향도 본다 — 프레임워크에만 있는 갈래는 장부가 모르는 갈래다.
    let framework_count = line.matches("_\"").count();
    assert_eq!(
        framework_count,
        FRAMEWORK_FAMILIES.len(),
        "갈래 수가 다르다(프레임워크 {framework_count} · 장부 {}): {line}",
        FRAMEWORK_FAMILIES.len()
    );
}
