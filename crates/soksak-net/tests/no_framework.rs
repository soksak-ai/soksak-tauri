//! 이 크레이트에는 프레임워크가 없다 — 의존성으로 시행한다.
//!
//! 이 몸이 여기 따로 사는 이유는 tokio 때문이다: 전송기가 wreq 하나이고 wreq 는 tokio 를 끌고
//! 오는데, 그 이름은 soksak-core 의 무의존과 soksak-cored 의 no_framework 금지 목록 양쪽에
//! 걸린다. 그러나 tokio·wreq 는 **자원**이지 프레임워크가 아니다 — 창을 열지도 앱 핸들을 쥐지도
//! 않고, 어느 프로세스가 보내든 같은 요청이 같은 응답을 받는다. 그래서 여기서 막는 것은
//! 프레임워크 이름뿐이고, tokio 는 통과시킨다.
//!
//! 이 검사가 없으면 다음 사람이 "어차피 tokio 가 있으니" 하고 창·웹뷰를 여기로 들일 수 있다.
//! 그 순간 이 크레이트는 두 번째 프레임워크가 되고, 프레임워크마다 전송 규칙이 갈린다.

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
        .args([
            "tree",
            "-p",
            "soksak-net",
            "-e",
            "normal",
            "--prefix",
            "none",
        ])
        .current_dir(root)
        .output()
        .expect("cargo tree 실행");
    let tree = String::from_utf8_lossy(&out.stdout).to_lowercase();
    // 오라클 생존 단언 — 트리를 못 읽으면 아래 루프는 아무것도 안 지킨다("0"의 두 얼굴).
    assert!(
        !tree.is_empty(),
        "의존성 트리를 못 읽었다: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(tree.contains("wreq"), "전송기가 트리에 없다: {tree}");

    // 크레이트 **이름**으로 대조한다(부분문자열은 block-buffer 를 block2 로 오탐한다).
    let names: Vec<&str> = tree
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    for banned in ["tauri", "wry", "tao"] {
        assert!(
            !names
                .iter()
                .any(|n| *n == banned || n.starts_with(&format!("{banned}-"))),
            "soksak-net 의존성에 프레임워크 크레이트가 있다: {banned}"
        );
    }
}
