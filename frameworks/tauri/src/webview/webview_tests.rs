#[test]
fn external_surface_hosts_are_always_below_the_dom_hole_plane() {
    let source = include_str!("layer.rs");
    let engine_host = source
        .split_once("pub fn ensure_engine_host")
        .expect("engine host constructor exists")
        .1;
    assert!(engine_host.contains("NSWindowOrderingMode::Below"));
    assert!(!source.contains("place_window_surface_hosts(label, !active)"));
    let adopted_host = source
        .split_once("pub fn adopt_surface_host")
        .expect("WKWebView host constructor exists")
        .1;
    assert!(adopted_host.contains("NSWindowOrderingMode::Below"));

    let pane_host = source
        .split_once("pub fn group_pane_surface_host")
        .expect("pane host constructor exists")
        .1
        .split_once("pub fn pane_surface_host_state")
        .expect("pane host constructor boundary")
        .0;
    assert!(pane_host.contains("addSubview_positioned_relativeTo"));
    assert!(pane_host.contains("NSWindowOrderingMode::Below"));
    assert!(pane_host.contains("Some(main_view)"));
    assert!(!pane_host.contains("parent.addSubview(pane_view)"));
}

#[test]
fn pane_group_converts_declared_members_from_their_adapter_parent() {
    let source = include_str!("layer.rs");
    let group = source
        .split_once("pub fn group_pane_surface_host")
        .expect("pane host constructor exists")
        .1
        .split_once("pub fn pane_surface_host_state")
        .expect("pane host constructor boundary")
        .0;
    assert!(group.contains("convertRect: member_bounds, toView: &*parent"));
    assert!(group.contains("member_host.window == window"));
    assert!(!group.contains("패인 member의 부모가 다릅니다"));
}

#[test]
fn pane_topology_observes_external_hosts_from_the_public_host_registry() {
    let source = include_str!("layer.rs");
    let state = source
        .split_once("pub fn pane_surface_host_state")
        .expect("pane state exists")
        .1
        .split_once("pub fn set_pane_surface_host_lighting")
        .expect("pane state boundary")
        .0;
    assert!(state.contains("(host_ptr != 0).then_some(host_ptr)"));
}

#[test]
fn native_layout_motion_animates_model_position_without_stacking_a_transform() {
    let source = include_str!("layer.rs");
    let motion = source
        .split_once("fn add_layout_position")
        .expect("position-only CA helper exists")
        .1
        .split_once("pub fn prepare_surface_host_translation")
        .expect("helper boundary exists")
        .0;
    assert!(motion.contains("position.x"));
    assert!(!motion.contains("transform.translation.x"));
}

#[test]
fn bounds_command_is_geometry_only() {
    let source = include_str!("../webview.rs");
    let body = source
        .split_once("fn apply_child_bounds(")
        .expect("apply_child_bounds exists")
        .1
        .split_once("// 패널 레이아웃 변화")
        .expect("bounds function boundary")
        .0;
    assert!(
        !body.contains(".show("),
        "bounds must not infer visible=true"
    );
    assert!(
        !body.contains(".hide("),
        "bounds must not infer visible=false"
    );
    assert!(
        !body.contains("webview_visible"),
        "bounds must not enter the visibility command path"
    );
}

#[test]
fn every_native_frame_commit_settles_child_layout_and_display() {
    let layer = include_str!("layer.rs");
    let settle = layer
        .split_once("pub fn settle_surface_frame")
        .expect("native frame settle helper exists")
        .1
        .split_once("pub fn prepare_surface_host_translation")
        .expect("settle helper boundary exists")
        .0;
    assert!(settle.contains("layoutSubtreeIfNeeded"));
    assert!(settle.contains("setNeedsDisplay(true)"));
    assert!(settle.contains("displayIfNeeded"));

    let direct = include_str!("../webview.rs")
        .split_once("fn set_child_frame(")
        .expect("direct frame path exists")
        .1
        .split_once("fn prepare_child_frame_transition(")
        .expect("direct frame path boundary exists")
        .0;
    assert!(direct.contains("settle_surface_frame(view)"));
    assert!(direct.contains("CATransaction::begin()"));
    assert!(direct.contains("CATransaction::setDisableActions(true)"));
    assert!(direct.contains("CATransaction::commit()"));

    let transition = layer
        .split_once("pub fn prepare_surface_host_translation")
        .expect("transition frame path exists")
        .1
        .split_once("pub fn cancel_surface_host_translation")
        .expect("transition frame path boundary exists")
        .0;
    assert!(transition.contains("settle_surface_frame(child)"));
}
