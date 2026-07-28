//! 이 프로세스에는 프레임워크가 없다 — 의존성으로 시행한다.
//!
//! cored 의 존재 이유는 "프레임워크 없이 답한다"이다. tauri/wry 가 의존성으로 한 번 들어오면 이
//! 프로세스는 두 번째 프레임워크가 되고, 그때부터 "여기서도 같은 답이 나온다"는 보장이 사라진다.
//! soksak-core 의 같은 이름 게이트와 짝이다: 로직 쪽은 그쪽이, 프로세스 쪽은 여기가 막는다.

use std::path::Path;

#[test]
fn the_dependency_tree_carries_no_framework_crate() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent());
    let Some(root) = root else {
        panic!("워크스페이스 루트를 못 찾았다 — 게이트가 통과로 위장한다");
    };
    let out = std::process::Command::new(env!("CARGO"))
        .args(["tree", "-p", "soksak-cored", "-e", "normal", "--prefix", "none"])
        .current_dir(root)
        .output()
        .expect("cargo tree 실행");
    let tree = String::from_utf8_lossy(&out.stdout).to_lowercase();
    // 오라클 생존 단언 — 트리를 못 읽으면 아래 루프는 아무것도 안 지킨다("0"의 두 얼굴).
    assert!(!tree.is_empty(), "의존성 트리를 못 읽었다: {}", String::from_utf8_lossy(&out.stderr));
    assert!(tree.contains("soksak-core"), "로직 크레이트가 트리에 없다: {tree}");

    // 크레이트 **이름**으로 대조한다(부분문자열은 block-buffer 를 block2 로 오탐한다).
    let names: Vec<&str> = tree
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    // 금지 목록은 **프레임워크**를 막는다 — 창·웹뷰·네이티브 런타임. 저장소(rusqlite)는 프레임워크가 아니라
    // 자원이다: 창을 열지도, 앱 핸들을 쥐지도 않고, 어느 프로세스에서 열든 같은 파일을 같은
    // 답으로 읽는다. cored 가 명령을 서빙하려면 그 자원을 져야 한다(로직은 코어의 KvRows
    // 계약이 소유하고 cored 는 그 구현 하나를 준다 — 질의문과 연결은 구현자의 것이다).
    // 코어 크레이트에는 rusqlite 가 여전히 금지다: 로직이 저장소를 알면 그 로직은 파일이
    // 있는 곳에서만 돌게 되고, 그게 이 분리가 없애려던 전제다.
    for banned in [
        "tauri", "wry", "tao", "objc2", "block2", "libloading", "notify",
        "clipboard-rs", "x11rb", "windows-sys", "tokio", "interprocess", "portable-pty",
    ] {
        assert!(
            !names.iter().any(|n| *n == banned || n.starts_with(&format!("{banned}-"))),
            "cored 의존성에 프레임워크/런타임 크레이트가 있다: {banned}"
        );
    }
}
