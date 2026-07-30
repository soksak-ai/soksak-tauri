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
    //
    // notify 도 같은 판정으로 진다(2026-07-29). 파일시스템 사건은 창이 아니라 **자원**이다:
    // 창을 열지도 앱 핸들을 쥐지도 않고, 어느 프로세스가 같은 경로를 감시하든 같은 사건을
    // 받는다. cored 가 watch_dir 을 서빙하려면 그 핸들을 져야 한다 — 규칙은 soksak-watch 가
    // 소유하고 뿌리는 자리만 프로세스가 준다(앱=창 emit, 헬퍼=방송). 코어에는 여전히 금지다.
    // tokio 도 같은 판정으로 통과한다(2026-07-30). **비동기 실행기는 프레임워크가 아니다**:
    // 창을 열지도 앱 핸들을 쥐지도 않고, 어느 프로세스가 돌리든 같은 바이트를 같은 답으로
    // 받는다. 이 목록의 기준을 그대로 적용하면 tokio 는 걸리지 않는데도 이름으로 막혀 있었고,
    // 그 사이 soksak-net 은 자기 헤더에 "tokio 는 자원"이라고 적었다 — 한 저장소가 같은
    // 크레이트를 두 규칙으로 판정하고 있었다.
    //
    // 실측 결과: HTTP 가 프레임워크 능력으로 남아 두 번째 프레임워크는 런타임 의존을 내려받지
    // 못했다(download_verify 가 NOT_SERVED_HERE). 이 프로세스의 동시성 모형은 안 바뀐다 —
    // soksak-net 이 sync 표면만 노출하고 런타임을 자기 안에 가둔다. 이 크레이트는 그 전에도
    // UDP(net_udp_request)를 지고 있었다.
    //
    // 쓸 곳 없이 미리 열지 않았다: 이 이름이 풀린 커밋이 곧 download_verify 를 서빙하는 커밋이다.
    //
    // libloading 도 같은 판정으로 통과한다(2026-07-31). **동적 적재는 프레임워크가 아니라 OS
    // 호출이다**: 창을 열지도 앱 핸들을 쥐지도 않고, 어느 프로세스가 같은 dylib 을 열든 같은
    // 심볼을 같은 답으로 준다. 이 목록의 기준 셋(창을 여는가·앱 핸들을 쥐는가·프로세스마다
    // 답이 갈리는가) 어디에도 걸리지 않는데 이름으로 막혀 있었다.
    //
    // 그 이름 하나가 sidecar_open·send·close 를 이 프로세스 밖에 묶어 두고 있었다. 엔진 모델이
    // 요구하는 나머지 둘(메인스레드·부모 표면) 중 메인스레드는 창을 요구하지 않고, 부모 표면은
    // 이 프로세스에 없다 — 없는 것은 0 으로 실어 보내고, 그것을 **쓰는** 엔진이 자기 이름으로
    // 실패한다(지어낸 포인터는 유효한 주소로 읽혀 남의 메모리에 얹는다).
    //
    // 쓸 곳 없이 미리 열지 않았다: 이 이름이 풀린 커밋이 곧 그 셋을 서빙하는 커밋이다.
    for banned in [
        "tauri", "wry", "tao", "objc2", "block2",
        "clipboard-rs", "x11rb", "windows-sys", "interprocess", "portable-pty",
    ] {
        assert!(
            !names.iter().any(|n| *n == banned || n.starts_with(&format!("{banned}-"))),
            "cored 의존성에 프레임워크/런타임 크레이트가 있다: {banned}"
        );
    }
}
