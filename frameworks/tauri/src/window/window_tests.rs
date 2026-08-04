use super::{begin_teardown, forget_teardown};

#[test]
fn created_window_is_an_address_before_creation_returns() {
    let src = std::fs::read_to_string("src/window.rs").expect("window source");
    let create = src
        .split_once("fn create_window_core(")
        .expect("create_window_core")
        .1
        .split_once("pub fn window_list")
        .expect("create_window_core boundary")
        .0;
    assert!(
        create.contains("host.windows_settled("),
        "window_create가 성공을 답하기 전에 새 창이 cored 주소 원장에 서야 한다"
    );
}

#[test]
fn no_hardcoded_main_window() {
    const PATS: [&str; 3] = [
        "get_window(\"main\")",
        "get_webview(\"main\")",
        "get_webview_window(\"main\")",
    ];
    for f in [
        "src/webview.rs",
        "src/ipc.rs",
        "src/window.rs",
        "src/lib.rs",
        "src/dockmenu.rs",
    ] {
        let src = std::fs::read_to_string(f).unwrap_or_default();
        for pat in PATS {
            assert!(
                !src.contains(pat),
                "MW1 위반({f}): `{pat}` 하드코딩 — 창-종속 리소스는 창 label 로 키잉하라"
            );
        }
    }
}

#[test]
fn capability_covers_new_windows() {
    let src = std::fs::read_to_string("capabilities/default.json").unwrap_or_default();
    let doc: serde_json::Value = serde_json::from_str(&src).expect("capability JSON 파싱");
    let windows: Vec<&str> = doc["windows"]
        .as_array()
        .expect("windows 배열")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        windows.contains(&"w-*") || windows.contains(&"*"),
        "capability windows 스코프가 런타임 창(w-*)을 포함해야 한다"
    );
    assert!(
        windows.contains(&"main"),
        "capability windows 스코프에 컨트롤 플레인(main)이 있어야 한다(NAMING 4b)"
    );
    assert!(
        !windows.contains(&"win-*") && !windows.contains(&"orch-*"),
        "구세대 창 라벨 재등재 금지"
    );
}

#[test]
fn every_appkit_resize_commits_layout_and_display_in_the_notification_turn() {
    let src = std::fs::read_to_string("src/webview/appkit_events.rs").expect("appkit events");
    assert!(
        src.contains("NSWindowDidResizeNotification"),
        "programmatic·live resize 모두를 덮는 NSWindowDidResize 통지가 필요하다"
    );
    let commit = src
        .split_once("fn commit_resize_composition(")
        .expect("resize composition transaction")
        .1
        .split_once("\n}\n\n// AppKit")
        .expect("transaction boundary")
        .0;
    assert!(
        commit.contains("layoutIfNeeded") || commit.contains("layoutSubtreeIfNeeded"),
        "새 frame의 view hierarchy layout을 같은 통지 차례에 확정해야 한다"
    );
    assert!(
        commit.contains("setViewsNeedDisplay") && commit.contains("displayIfNeeded"),
        "이전 backing을 확대·축소해 보이지 않게 새 layout을 invalidate하고 즉시 display해야 한다"
    );
}

#[test]
fn prune_window_persistence_removes_only_that_window() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    soksak_store::store::init_base(&c).unwrap();
    let set =
        |k: &str, v: serde_json::Value| soksak_store::store::kv_set(&c, "core", k, &v).unwrap();
    set(
        "window/w-1",
        serde_json::json!({"activeId":"t1","projects":[{"id":"t1"}]}),
    );
    set(
        "window/main",
        serde_json::json!({"activeId":"t9","projects":[{"id":"t9"}]}),
    );
    set(
        "windows",
        serde_json::json!({"slots":[
            {"label":"w-1","roots":["/a"],"activeRoot":"/a"},
            {"label":"main","roots":["/m"],"activeRoot":"/m"}
        ]}),
    );
    super::prune_window_persistence(&c, "w-1").unwrap();
    assert_eq!(
        soksak_store::store::kv_get(&c, "core", "window/w-1").unwrap(),
        None
    );
    assert!(soksak_store::store::kv_get(&c, "core", "window/main")
        .unwrap()
        .is_some());
    let m = soksak_store::store::kv_get(&c, "core", "windows")
        .unwrap()
        .unwrap();
    let slots = m["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0]["label"], "main");
    super::prune_window_persistence(&c, "w-1").unwrap();
}

#[test]
fn first_close_defers_second_proceeds() {
    let label = "w-teardown-once";
    forget_teardown(label);
    assert!(begin_teardown(label), "첫 진입은 보류한다");
    assert!(!begin_teardown(label), "두 번째 진입은 그대로 닫힌다");
    forget_teardown(label);
}

#[test]
fn each_window_defers_on_its_own() {
    let (a, b) = ("w-teardown-a", "w-teardown-b");
    forget_teardown(a);
    forget_teardown(b);
    assert!(begin_teardown(a));
    assert!(begin_teardown(b), "다른 창의 보류가 이 창을 삼키지 않는다");
    forget_teardown(a);
    forget_teardown(b);
}

#[test]
fn forgetting_lets_a_reused_label_defer_again() {
    let label = "w-teardown-reuse";
    forget_teardown(label);
    assert!(begin_teardown(label));
    forget_teardown(label);
    assert!(begin_teardown(label), "폐기 뒤에는 다시 보류할 수 있다");
    forget_teardown(label);
}
