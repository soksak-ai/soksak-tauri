#[cfg(target_os = "macos")]
use super::surface_sibling_order;

#[cfg(target_os = "macos")]
#[test]
fn surface_host_order_is_rebuilt_immediately_around_main_view() {
    let siblings = [10, 20, 30, 40];
    assert_eq!(
        surface_sibling_order(&siblings, 10, 40, true),
        vec![20, 30, 40, 10]
    );
    assert_eq!(
        surface_sibling_order(&siblings, 10, 40, false),
        vec![20, 30, 10, 40]
    );
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
