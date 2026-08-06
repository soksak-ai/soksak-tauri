use super::{begin_teardown, forget_teardown};

fn crate_source(path: &str) -> String {
    std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR")))
        .unwrap_or_else(|error| panic!("failed to read {path}: {error}"))
}

fn source_region<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    source
        .split_once(start)
        .unwrap_or_else(|| panic!("source region start is absent: {start}"))
        .1
        .split_once(end)
        .unwrap_or_else(|| panic!("source region end is absent after {start}: {end}"))
        .0
}

fn ordered_positions(source: &str, markers: &[&str]) -> Result<Vec<usize>, String> {
    let mut positions = Vec::with_capacity(markers.len());
    let mut cursor = 0;
    for marker in markers {
        let relative = source[cursor..]
            .find(marker)
            .ok_or_else(|| format!("missing ordered marker: {marker}"))?;
        let position = cursor + relative;
        positions.push(position);
        cursor = position + marker.len();
    }
    Ok(positions)
}

#[test]
fn startup_order_assertion_rejects_a_native_install_before_exact_lifetime_binding() {
    let invalid = "register_startup_window install_window_natives bind_startup_native_window commit_startup_window";
    assert!(
        ordered_positions(
            invalid,
            &[
                "register_startup_window",
                "bind_startup_native_window",
                "install_window_natives",
                "commit_startup_window",
            ],
        )
        .is_err(),
        "the source contract must turn an early native install into RED",
    );
}

#[test]
fn configured_main_binds_its_hidden_native_lifetime_before_install_and_commits_after_setup() {
    let source = crate_source("src/lib.rs");
    let setup = source_region(
        &source,
        ".setup(|app| {",
        "        .on_window_event(|window, event| {",
    );
    ordered_positions(
        setup,
        &[
            "window::register_startup_window(app.handle(), \"main\", true)",
            "window::bind_startup_native_window(app.handle(), &main_startup)",
            "window::install_window_natives(app.handle(), \"main\")",
            "window::commit_startup_window(app.handle(), &main_startup)",
            "Ok(())",
        ],
    )
    .expect("main must be registered and bound while hidden, then commit only after native setup");
}

#[test]
fn runtime_workspace_windows_stay_hidden_through_build_and_commit_after_final_geometry() {
    let source = crate_source("src/window.rs");
    let core = source_region(&source, "fn create_window_core(", "static USER_CLOSED:");
    ordered_positions(
        core,
        &[
            "register_startup_window(app, label, focus)",
            "cfg.visible = false",
            "WebviewWindowBuilder::from_config(app, &cfg)",
            ".build()",
            "bind_startup_native_window(app, &startup)",
            "install_window_natives(app, label)",
            "Ok(startup)",
        ],
    )
    .expect("a workspace window must remain hidden until its exact native lifetime is installed");

    let fresh = source_region(
        &source,
        "pub fn create_window_init(",
        "fn create_window_labeled(",
    );
    ordered_positions(
        fresh,
        &[
            "create_window_core(app, &label, init, focus)",
            "win.set_position(",
            "commit_startup_window(app, &startup)",
            "Ok(label)",
        ],
    )
    .expect("a fresh workspace must commit only after its cascade position is final");

    let restored = source_region(
        &source,
        "fn create_window_labeled(",
        "fn create_window_core(",
    );
    ordered_positions(
        restored,
        &[
            "create_window_core(app, label, init, focus)",
            "win.set_position(",
            "win.set_size(",
            "commit_startup_window(app, &startup)",
            "Ok(label.to_string())",
        ],
    )
    .expect("a restored workspace must commit only after position and size restoration are final");
}

#[test]
fn macos_presentation_uses_explicit_key_and_non_key_appkit_paths() {
    let source = crate_source("src/window.rs");
    let present = source_region(
        &source,
        "fn try_present_startup_window(",
        "pub(crate) fn commit_startup_window(",
    );
    let decision = source_region(
        present,
        "PresentationOutcome::Present(decision) => {",
        "PresentationOutcome::Pending",
    );
    let macos = source_region(
        decision,
        "#[cfg(target_os = \"macos\")]",
        "#[cfg(not(target_os = \"macos\"))]",
    );
    ordered_positions(
        macos,
        &[
            "if decision.requested_focus",
            "native.makeKeyAndOrderFront(None)",
            "else",
            "native.orderFront(None)",
        ],
    )
    .expect("focused macOS reveal must be key; no-focus reveal must be non-key");
    assert!(
        !macos.contains("window.show("),
        "the macOS branch must never call Tauri show(), which steals focus",
    );
    for ordering in ["native.makeKeyAndOrderFront(None)", "native.orderFront(None)"] {
        ordered_positions(
            decision,
            &[
                ordering,
                "crate::titlebar::prepare_startup_presentation(",
                "commit_presentation(identity)",
            ],
        )
        .unwrap_or_else(|error| {
            panic!(
                "AppKit may relayout traffic lights while ordering; the same main-thread turn must recompose and only then commit visibility: {error}"
            )
        });
    }

    let invalid = "prepare_startup_presentation native.orderFront commit_presentation";
    assert!(
        ordered_positions(
            invalid,
            &[
                "native.orderFront",
                "prepare_startup_presentation",
                "commit_presentation",
            ],
        )
        .is_err(),
        "the contract must make a pre-order-only composition transaction RED",
    );

    let non_macos = decision
        .split_once("#[cfg(not(target_os = \"macos\"))]")
        .expect("non-macOS presentation branch")
        .1;
    assert!(
        non_macos.contains("window.show()"),
        "the cross-platform DOM-backed branch owns the ordinary Tauri show path",
    );
}

#[test]
fn public_window_startup_command_is_a_read_only_projection() {
    let rust = crate_source("src/window.rs");
    let state_command = source_region(
        &rust,
        "pub fn window_startup_state(",
        "fn window_startup_present_on_main(",
    );
    assert!(
        rust.contains("#[tauri::command]\npub fn window_startup_state("),
        "window_startup_state must be an invokable Tauri command",
    );
    assert!(
        state_command.contains(".status(&identity)"),
        "window_startup_state must project the active startup gate status",
    );
    for forbidden in [
        "accept_renderer_green",
        "take_present_decision",
        "prepare_startup_presentation",
        "makeKeyAndOrderFront",
        "orderFront",
        "window.show(",
    ] {
        assert!(
            !state_command.contains(forbidden),
            "window_startup_state must not mutate or present through {forbidden}",
        );
    }

    let lib = crate_source("src/lib.rs");
    assert!(
        lib.contains("window::window_startup_state,"),
        "the native read projection must be callable through Tauri invoke",
    );

    let frontend = crate_source("../../src/framework/tauri/install.ts");
    let command = source_region(
        &frontend,
        "function installStartupPresentationCommand(): void {",
        "export async function installTauri(): Promise<void> {",
    );
    assert!(command.contains("register(\"window.startup\""));
    assert!(command.contains("handler: async () => invoke(\"window_startup_state\")"));
    for forbidden in [
        "danger:",
        "window_startup_present",
        "composeTitlebarComposition",
        "document.",
    ] {
        assert!(
            !command.contains(forbidden),
            "public window.startup inspection must remain read-only: {forbidden}",
        );
    }
    assert!(
        frontend.contains("installStartupPresentationCommand();"),
        "the public command must be installed by the selected Tauri adapter",
    );
}

#[test]
fn every_configured_tauri_window_starts_hidden_until_its_composition_receipt_is_green() {
    let source = crate_source("tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(&source).expect("tauri config JSON");
    let windows = config["app"]["windows"]
        .as_array()
        .expect("configured windows");
    assert!(
        !windows.is_empty(),
        "at least one configured window is required"
    );
    for window in windows {
        assert_eq!(
            window.get("visible").and_then(serde_json::Value::as_bool),
            Some(false),
            "a native window must not expose a pre-composition first frame",
        );
    }
}

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
fn appkit_resize_projects_titlebar_and_native_surfaces_before_the_single_display_commit() {
    let src = std::fs::read_to_string("src/webview/appkit_events.rs").expect("appkit events");
    let transaction = src
        .split_once("recompose_from_appkit_resize")
        .expect("titlebar resize transaction")
        .1;
    let titlebar = 0;
    let direct = transaction
        .find("resize_registered_surface_hosts")
        .expect("direct surface projection");
    let panes = transaction
        .find("resize_pane_surface_hosts")
        .expect("pane surface projection");
    let commit = transaction
        .find("commit_resize_composition")
        .expect("single display commit");
    assert!(
        titlebar < direct && direct < panes && panes < commit,
        "AppKit DidResize는 titlebar → direct surface → pane surface → display 순서여야 한다",
    );
}

#[test]
fn physical_resize_replies_after_appkit_applied_and_displayed_the_size() {
    let src = std::fs::read_to_string("src/window.rs").expect("window source");
    let command = src
        .split_once("fn window_set_physical_size(")
        .expect("framework resize command")
        .1
        .split_once("\n}\n\n// 한 창의")
        .expect("command boundary")
        .0;
    assert!(
        command.contains("setContentSize"),
        "tao의 비동기 setContentSize dispatch를 앱 창 계약으로 노출하면 안 된다"
    );
    assert!(
        command.contains("commit_resize_composition"),
        "크기 적용 뒤 같은 메인스레드 transaction에서 layout/display를 확정해야 한다"
    );
    let layout = command
        .find("layoutIfNeeded")
        .expect("새 content viewport를 affine 투영 전에 확정해야 한다");
    let titlebar = command
        .find("recompose_from_appkit_resize")
        .expect("공개 DOM titlebar 목표도 같은 resize transaction에서 재합성해야 한다");
    let project = command
        .find("resize_registered_surface_hosts")
        .expect("공개 DOM affine 계약을 같은 명령 transaction에서 투영해야 한다");
    let project_panes = command
        .find("resize_pane_surface_hosts")
        .expect("PaneSurfaceHost affine 계약도 같은 명령 transaction에서 투영해야 한다");
    let commit = command
        .find("commit_resize_composition")
        .expect("resize composition commit");
    assert!(
        layout < titlebar
            && titlebar < project
            && project < project_panes
            && project_panes < commit,
        "content layout → titlebar → direct surface → pane host 투영 → 전체 창 display commit 순서여야 한다"
    );
    assert!(
        command.contains("recv_timeout"),
        "명령 응답은 메인스레드 resize transaction 완료를 기다려야 한다"
    );
}

#[test]
fn registered_native_surfaces_never_scale_cached_layer_pixels() {
    let src = std::fs::read_to_string("src/webview/layer.rs").expect("layer source");
    let policy = src
        .split_once("fn configure_surface_resize(")
        .expect("native surface resize policy")
        .1
        .split_once("\n}")
        .expect("policy boundary")
        .0;
    assert!(
        policy.contains("DuringViewResize"),
        "AppKit이 surface 크기 변화마다 redraw하도록 선언해야 한다"
    );
    assert!(
        policy.contains("TopLeft"),
        "새 paint 전 cached layer image를 새 bounds에 scale하지 않아야 한다"
    );
    assert!(
        policy.contains("setAutoresizingMask(NSAutoresizingMaskOptions(0))"),
        "공용 전체창 host의 resize가 명시적 bounds 소유 surface를 다시 resize하면 안 된다"
    );
    assert!(
        src.contains("configure_surface_resize(view)"),
        "엔진이 등록한 실제 NSView에도 정책을 적용해야 한다"
    );
}

#[test]
fn grouped_pane_members_inherit_parent_resize_in_the_same_appkit_epoch() {
    let src = std::fs::read_to_string("src/webview/layer.rs").expect("layer source");
    let policy = src
        .split_once("fn configure_pane_member_resize(")
        .expect("pane member resize policy")
        .1
        .split_once("\n}")
        .expect("policy boundary")
        .0;
    assert!(
        policy.contains("ViewWidthSizable") && policy.contains("ViewHeightSizable"),
        "PaneSurfaceHost의 자식은 부모 frame 거래와 같은 epoch에 폭·높이를 상속해야 한다"
    );
    let grouping = src
        .split_once("pub fn group_pane_surface_host(")
        .expect("pane grouping")
        .1
        .split_once("pub fn pane_surface_host_state")
        .expect("grouping boundary")
        .0;
    assert!(
        grouping.contains("configure_pane_member_resize(host)"),
        "grouping 시 모든 renderer/native member에 동기 resize 정책을 설치해야 한다"
    );
    let detach = src
        .split_once("fn detach_surface_from_pane(")
        .expect("pane detach")
        .1
        .split_once("pub fn surface_count")
        .expect("detach boundary")
        .0;
    assert!(
        detach.contains("configure_surface_resize(host)"),
        "pane에서 분리된 surface는 standalone 명시 bounds 소유권으로 복귀해야 한다"
    );
}

#[test]
fn stale_renderer_resize_ipc_cannot_overwrite_the_current_native_epoch() {
    let src = std::fs::read_to_string("src/webview/layer.rs").expect("layer source");
    let pane = src
        .split_once("pub fn set_pane_surface_host_bounds(")
        .expect("pane bounds setter")
        .1
        .split_once("/// 공개 DOM 슬롯")
        .expect("pane bounds boundary")
        .0;
    assert!(
        pane.contains("belongs_to_viewport"),
        "pane host는 이전 viewport IPC를 거부해야 한다"
    );
    let member = src
        .split_once("pub fn set_pane_surface_member_bounds(")
        .expect("pane member setter")
        .1
        .split_once("pub fn forget_window")
        .expect("member bounds boundary")
        .0;
    assert!(
        member.contains("belongs_to_host"),
        "pane member는 이전 host 크기 IPC를 거부해야 한다"
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
