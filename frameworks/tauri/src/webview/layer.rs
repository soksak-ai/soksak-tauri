use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::sel;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSView, NSViewLayerContentsPlacement,
    NSViewLayerContentsRedrawPolicy, NSWindowOrderingMode,
};
use objc2_foundation::{NSNumber, NSPoint, NSString};
use objc2_quartz_core::{
    CABasicAnimation, CACurrentMediaTime, CAMediaTiming, CAMediaTimingFunction, CATransaction,
    kCAFillModeBackwards,
};
use soksak_core::native_surface_ledger::{NativeSurfaceHosts, NativeSurfaceLedger};
use tauri::Manager;

// 창별 레이어 상태(멀티 윈도우): label → (그 창 메인 webview 의 NSView 포인터, 오버레이 게이트).
// 각 창이 자기 메인 view 와 오버레이 상태를 독립 보유한다. hit_test 는 this(view)가 *어느 창의*
// 메인인지 이 맵에서 판정하고, 홀 로직은 superview/형제 기준이라 창 독립적으로 그 창의 child
// webview 만 검사한다 — 그래서 한 맵으로 모든 창이 서로 간섭 없이 동작한다.
struct WinLayer {
    main_ptr: usize,         // 메인 webview NSView 포인터(창 수명 동안 불변)
    overlay: bool,           // 오버레이(모달/메뉴) 활성 시 홀 통과 차단
    holes: Vec<super::Hole>, // DOM 오버레이(사이드바 등) 영역 — 이 안은 DOM 이 이벤트를 갖는다
    host_ptr: usize,         // 엔진 호스트 컨테이너 NSView 포인터(0=미생성). 격리 계약: 모듈은
                             // contentView 가 아니라 이 컨테이너를 surface 로 받고 그 안에만 붙는다.
}
static LAYERS: LazyLock<Mutex<HashMap<String, WinLayer>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// Backend N 네이티브 surface 레지스트리 — 등록된 child NSView 포인터 집합. hit_test 는 형제 중
// 이 집합에 든 것만 "홀"로 본다(classname 대신 멤버십 — 엔진 중립: WKWebView·Chromium surface 동일
// 취급). identity(포인터)만 저장하고 geometry 는 live frame(sub.frame())에서 읽는다 — "홀 = 보이는
// child frame" 불변식 보존(별도 rect 레지스트리 없음).
static SURFACES: LazyLock<NativeSurfaceLedger> = LazyLock::new(NativeSurfaceLedger::default);
static SURFACE_HOSTS: LazyLock<NativeSurfaceHosts> = LazyLock::new(NativeSurfaceHosts::default);
// 교체 전 원본 hitTest IMP. 클래스(WryWebView) 단위 스위즐이라 앱 전역 1회면 충분.
static ORIG_HIT_TEST: AtomicUsize = AtomicUsize::new(0);

// 엔진 표면 컨테이너는 메인 webview 위에 서지만, 자식 표면 밖의 빈 영역은 DOM 입력을
// 가로채지 않는다. 자식이 nil을 돌려주는 입력-투과 표면(OSR)도 그대로 DOM으로 통과한다.
objc2::define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = objc2::MainThreadOnly]
struct EngineSurfaceHost;

    impl EngineSurfaceHost {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let hit: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            let this = self as *const Self as *mut NSView;
            if hit == this { std::ptr::null_mut() } else { hit }
        }
    }
);

// 한 패널의 UI renderer와 문서 밖 표면이 함께 사는 유일한 이동 단위. 두 renderer를
// Window content root의 서로 다른 가지에 둔 채 시각 epoch를 맞추지 않는다. 이 host의
// model/presentation frame 하나가 패널 이동의 단일 진실이다.
objc2::define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = objc2::MainThreadOnly]
    struct PaneSurfaceHost;

    impl PaneSurfaceHost {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let hit: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            let this = self as *const Self as *mut NSView;
            if hit == this { std::ptr::null_mut() } else { hit }
        }
    }
);

impl super::SurfaceLayoutContract {
    fn rect_for_viewport(&self, viewport_w: f64, viewport_h: f64) -> (f64, f64, f64, f64) {
        let root_w = (self.root_w + viewport_w - self.viewport_w).max(0.0);
        let root_h = (self.root_h + viewport_h - self.viewport_h).max(0.0);
        (
            self.root_x + self.left_ratio * root_w + self.fixed_x,
            self.root_y + self.top_ratio * root_h + self.fixed_y,
            (self.width_ratio * root_w + self.fixed_w).max(0.0),
            (self.height_ratio * root_h + self.fixed_h).max(0.0),
        )
    }

    fn belongs_to_viewport(&self, viewport_w: f64, viewport_h: f64) -> bool {
        (self.viewport_w - viewport_w).abs() <= 1.0
            && (self.viewport_h - viewport_h).abs() <= 1.0
    }
}

impl super::PaneMemberLayoutContract {
    fn rect_for_host(&self, width: f64, height: f64) -> (f64, f64, f64, f64) {
        (
            self.left,
            self.top,
            (width - self.left - self.right).max(0.0),
            (height - self.top - self.bottom).max(0.0),
        )
    }

    fn belongs_to_host(&self, width: f64, height: f64) -> bool {
        (self.host_w - width).abs() <= 1.0 && (self.host_h - height).abs() <= 1.0
    }
}

#[derive(Clone)]
struct PaneSurfaceRecord {
    ptr: usize,
    window: String,
    renderer: String,
    members: Vec<String>,
    layout: Option<super::SurfaceLayoutContract>,
    member_layouts: HashMap<String, super::PaneMemberLayoutContract>,
}

static PANE_SURFACE_HOSTS: LazyLock<Mutex<HashMap<String, PaneSurfaceRecord>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SURFACE_PANES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SURFACE_VIEWS: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SURFACE_TRANSPARENCY: LazyLock<Mutex<HashMap<String, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SURFACE_LAYOUTS: LazyLock<Mutex<HashMap<String, super::SurfaceLayoutContract>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// 창의 오버레이 게이트 갱신(프론트 ui 카운터 0↔1 전이 시 webview_overlay_active 가 호출).
pub fn set_overlay(label: &str, active: bool) {
    if let Ok(mut layers) = LAYERS.lock() {
        if let Some(w) = layers.get_mut(label) {
            w.overlay = active;
        }
    }
}

// 창의 현재 홀 목록 — 관측면(ui.holes)이 읽는다. 계약을 눈이 아니라 값으로 확인한다.
pub fn holes_of(label: &str) -> Vec<super::Hole> {
    LAYERS
        .lock()
        .ok()
        .and_then(|m| m.get(label).map(|w| w.holes.clone()))
        .unwrap_or_default()
}

// 창의 DOM 오버레이 홀 갱신(사이드바 열림/닫힘·폭 변화 시 webview_dom_holes 가 호출).
pub fn set_holes(label: &str, holes: Vec<super::Hole>) {
    if let Ok(mut layers) = LAYERS.lock() {
        if let Some(w) = layers.get_mut(label) {
            w.holes = holes;
        }
    }
}

// AppKit의 layer-hosting 기본값은 redraw=Never, placement=ScaleAxesIndependently다. 원격
// WKWebView/CEF layer가 새 픽셀을 제출하기 전 cached image를 새 bounds에 늘여 그리므로,
// 등록된 Tauri 합성 surface는 resize redraw를 요청하고 그 사이의 cached image는 원래 픽셀
// 크기로 top-left에 둔다. 가림/스냅샷이 아니라 AppKit이 제공하는 layer resize 정책이다.
fn configure_surface_resize(view: &NSView) {
    // surface frame은 공개 DOM slot→Tauri bounds transaction만 쓴다. 공용 전체창 host의
    // autoresize가 같은 child를 먼저 비례 변경하면 resize 주인이 둘이 된다.
    view.setAutoresizingMask(NSAutoresizingMaskOptions(0));
    view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
    view.setLayerContentsPlacement(NSViewLayerContentsPlacement::TopLeft);
}

// PaneSurfaceHost 아래에서는 부모 frame이 패널의 단일 resize 거래다. 자식 host와 그 실제
// renderer가 폭·높이를 같은 AppKit epoch에 상속해야 하며, 뒤늦은 DOM/engine bounds는 같은
// 값의 최종 ACK일 뿐 두 번째 resize 주인이 아니다. pane 밖으로 분리될 때는 위 standalone
// 정책(mask=0)으로 반드시 되돌린다.
fn configure_pane_member_resize(view: &NSView) {
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
}

fn clip_surface_children(view: &NSView) -> Result<(), String> {
    let layer = view.layer().ok_or_else(|| "surface host layer가 없습니다".to_string())?;
    layer.setMasksToBounds(true);
    Ok(())
}

// Backend N surface 등록/해제 — webview_open 직후(가시 홀 편입), webview_close 직전(회수).
// 오프스크린 추출 webview(media_extract, -20000)는 홀이 아니므로 등록하지 않는다.
pub fn register_surface(ptr: usize, label: Option<&str>) {
    if ptr != 0 {
        let view = unsafe { &*(ptr as *const NSView) };
        configure_surface_resize(view);
    }
    SURFACES.register(ptr, label);
}

fn window_for_engine_ancestors(
    ancestors: &[usize],
    hosts: &[(String, usize)],
) -> Option<String> {
    hosts
        .iter()
        .find(|(_, host)| *host != 0 && ancestors.contains(host))
        .map(|(window, _)| window.clone())
}

/// A sidecar-created slot host already is the clipping/movement unit, so it must not be wrapped in
/// a second host. Bind that exact native identity to its declared surface key and owning workspace
/// window before `webview.present` groups it with the pane renderer.
pub fn register_external_surface_host(ptr: usize, label: &str) -> Result<(), String> {
    if ptr == 0 || label.is_empty() {
        return Err("external native surface identity가 비었습니다".into());
    }
    objc2_foundation::MainThreadMarker::new()
        .ok_or("external native surface는 main thread에서만 등록합니다")?;
    let view = unsafe { &*(ptr as *const NSView) };
    let mut ancestors = vec![ptr];
    let mut cursor = unsafe { view.superview() };
    while let Some(node) = cursor {
        ancestors.push(Retained::as_ptr(&node) as usize);
        cursor = unsafe { node.superview() };
    }
    let hosts = LAYERS
        .lock()
        .map_err(|_| "window layer 잠금 실패")?
        .iter()
        .map(|(window, layer)| (window.clone(), layer.host_ptr))
        .collect::<Vec<_>>();
    let window = window_for_engine_ancestors(&ancestors, &hosts)
        .ok_or_else(|| format!("external native surface의 소유 창을 찾을 수 없습니다: {label}"))?;
    configure_surface_resize(view);
    clip_surface_children(view)?;
    SURFACES.register(ptr, Some(label));
    SURFACE_HOSTS.register(label, ptr, &window);
    Ok(())
}
pub fn unregister_surface(ptr: usize) {
    SURFACES.unregister(ptr);
}
pub fn surface_label(ptr: usize) -> Option<String> {
    SURFACES.label(ptr)
}
pub fn surface_pane(label: Option<&str>) -> Option<String> {
    let label = label?;
    SURFACE_PANES.lock().ok().and_then(|panes| panes.get(label).cloned())
}
pub fn surface_host_ptr(label: &str) -> usize {
    SURFACE_HOSTS.ptr(label).unwrap_or(0)
}

pub fn has_surface_host(label: &str) -> bool {
    surface_host_ptr(label) != 0
}

// DOM renderer와 native surface의 실제 NSView 조상 경로를 공개한다. 둘의 최소 공통
// 조상이 창 content root뿐이면 패널 하나를 원자적으로 움직일 공통 소유자가 없는 구조다.
// 같은 CATransaction/시각 epoch는 이 구조 사실을 바꾸지 못한다.
pub fn renderer_topology(window_label: &str, surface_ptr: usize) -> serde_json::Value {
    let main_ptr = LAYERS
        .lock()
        .ok()
        .and_then(|layers| layers.get(window_label).map(|layer| layer.main_ptr))
        .unwrap_or(0);
    renderer_pair_topology(main_ptr, surface_ptr)
}

fn renderer_pair_topology(renderer_ptr: usize, surface_ptr: usize) -> serde_json::Value {
    fn ancestry(mut ptr: *mut NSView) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        while !ptr.is_null() {
            let view = unsafe { &*ptr };
            out.push((ptr as usize, view.class().name().to_string_lossy().into_owned()));
            ptr = unsafe { msg_send![view, superview] };
        }
        out.reverse();
        out
    }

    if renderer_ptr == 0 || surface_ptr == 0 {
        return serde_json::json!(null);
    }
    let dom = ancestry(renderer_ptr as *mut NSView);
    let native = ancestry(surface_ptr as *mut NSView);
    let mut common_depth: i64 = -1;
    let mut common_ptr = 0usize;
    for (index, (dom_ptr, _)) in dom.iter().enumerate() {
        if native.get(index).map(|(ptr, _)| ptr) == Some(dom_ptr) {
            common_depth = index as i64;
            common_ptr = *dom_ptr;
        } else {
            break;
        }
    }
    let window_content_root = unsafe { (&*(renderer_ptr as *const NSView)).superview() }
        .map(|view| Retained::as_ptr(&view) as usize)
        .unwrap_or(0);
    serde_json::json!({
        "domRendererPtr": renderer_ptr,
        "nativeSurfacePtr": surface_ptr,
        "sameView": renderer_ptr == surface_ptr,
        "domRendererPath": dom.into_iter().map(|(_, class)| class).collect::<Vec<_>>(),
        "nativeSurfacePath": native.into_iter().map(|(_, class)| class).collect::<Vec<_>>(),
        "lowestCommonAncestorDepth": common_depth,
        "lowestCommonAncestorIsWindowContentRoot": common_ptr != 0 && common_ptr == window_content_root,
    })
}

const LAYOUT_POSITION_KEY: &str = "soksak-layout-position-x";

fn add_layout_position(view: &NSView, dx: f64, start_delay: f64, duration: f64) -> Result<(), String> {
    let layer = view.layer().ok_or_else(|| "native surface host layer가 없다".to_string())?;
    let key_path = NSString::from_str("position.x");
    let animation = CABasicAnimation::animationWithKeyPath(Some(&key_path));
    // setFrame 뒤 model position이 목표다. 시작 presentation은 같은 좌표계에서 dx만큼
    // 되감는다. transform.translation을 겹치면 AppKit frame geometry와 이동량이 중복된다.
    let target_x = layer.position().x;
    let from = NSNumber::new_f64(target_x + dx);
    let to = NSNumber::new_f64(target_x);
    unsafe {
        animation.setFromValue(Some(&*from));
        animation.setToValue(Some(&*to));
    }
    // CAMediaTiming.beginTime은 대상 layer의 local time이다. 전역 media time을 그대로 넣으면
    // 부모 timing offset만큼 DOM epoch보다 먼저/늦게 출발한다.
    let local_now = layer.convertTime_fromLayer(CACurrentMediaTime(), None);
    animation.setBeginTime(local_now + start_delay);
    animation.setDuration(duration);
    animation.setFillMode(unsafe { kCAFillModeBackwards });
    animation.setRemovedOnCompletion(true);
    animation.setTimingFunction(Some(&CAMediaTimingFunction::functionWithControlPoints(
        0.4, 0.0, 0.2, 1.0,
    )));
    layer.addAnimation_forKey(&animation, Some(&NSString::from_str(LAYOUT_POSITION_KEY)));
    Ok(())
}

/**
 * frame ACK가 단지 NSView 숫자 변경의 ACK에 머물지 않게 자식 레이아웃·표시를 같이
 * 정착시킨다. WKWebView는 내부 원격 표시 트리를 가지므로 host/child frame만 바꾸고
 * 돌아오면 직후 WindowServer 캡처에 직전 viewport 프레임이 남을 수 있다.
 */
pub fn settle_surface_frame(view: &NSView) {
    unsafe {
        view.layoutSubtreeIfNeeded();
        view.setNeedsDisplay(true);
        view.displayIfNeeded();
    }
}

/**
 * 목표 model frame을 먼저 세우고 위치 transform만 공통 epoch에 표시한다.
 * 크기 보간은 WKWebView raster를 늘이므로 거절한다. 호출자는 크기 변화 거래를 별도로 정착시킨다.
 */
pub fn prepare_surface_host_translation(
    label: &str,
    child: &NSView,
    target: objc2_foundation::NSRect,
    start_at_unix_ms: f64,
    duration_ms: f64,
) -> Result<(), String> {
    let host_ptr = surface_host_ptr(label);
    if host_ptr == 0 { return Err(format!("native surface host가 없다: {label}")); }
    let host = unsafe { &*(host_ptr as *const NSView) };
    let before = host.frame();
    if (before.size.width - target.size.width).abs() > 0.5
        || (before.size.height - target.size.height).abs() > 0.5
    {
        return Err(format!(
            "위치 전용 거래에 크기 변화가 들어왔다: {}x{} -> {}x{}",
            before.size.width, before.size.height, target.size.width, target.size.height,
        ));
    }
    let dx = before.origin.x - target.origin.x;
    let now_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(start_at_unix_ms);
    let start_delay = (start_at_unix_ms - now_unix_ms).max(0.0) / 1000.0;
    let duration = duration_ms.max(1.0) / 1000.0;

    CATransaction::begin();
    CATransaction::setDisableActions(true);
    host.setFrame(target);
    child.setFrame(objc2_foundation::NSRect::new(
        objc2_foundation::NSPoint::new(0.0, 0.0),
        target.size,
    ));
    settle_surface_frame(child);
    let animation_result = add_layout_position(host, dx, start_delay, duration);
    CATransaction::commit();
    animation_result
}

pub fn cancel_surface_host_translation(label: &str) {
    let key = NSString::from_str(LAYOUT_POSITION_KEY);
    if let Some(host_ptr) = SURFACE_HOSTS.ptr(label) {
        let host = unsafe { &*(host_ptr as *const NSView) };
        if let Some(layer) = host.layer() { layer.removeAnimationForKey(&key); }
    }
}

// child WKWebView를 전용 layer-backed NSView에 넣는다. host frame이 화면 좌표의 단일 진실이고
// child는 로컬 원점에 고정된다. addSubview는 기존 부모에서 표준 재부착을 수행한다.
pub fn adopt_surface_host<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    surface_label: &str,
    window_label: &str,
    transparent: bool,
) {
    let surface_label = surface_label.to_string();
    let window_label = window_label.to_string();
    let _ = webview.with_webview(move |pw| unsafe {
        use objc2::MainThreadOnly;
        use objc2_foundation::{NSPoint, NSRect};

        let main_ptr = LAYERS
            .lock()
            .ok()
            .and_then(|l| l.get(&window_label).map(|w| w.main_ptr))
            .unwrap_or(0);
        if main_ptr == 0 {
            return;
        }
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let child = &*(pw.inner() as *const NSView);
        if let Ok(mut views) = SURFACE_VIEWS.lock() {
            views.insert(surface_label.clone(), child as *const NSView as usize);
        }
        if let Ok(mut transparency) = SURFACE_TRANSPARENCY.lock() {
            transparency.insert(surface_label.clone(), transparent);
        }
        let main_view = &*(main_ptr as *const NSView);
        let (Some(parent), Some(main_parent)) = (child.superview(), main_view.superview()) else {
            return;
        };
        if Retained::as_ptr(&parent) != Retained::as_ptr(&main_parent) {
            eprintln!("[layer] surface host 채택 실패: child와 main 부모가 다름 — {surface_label}");
            return;
        }
        let frame = child.frame();
        let host = NSView::initWithFrame(NSView::alloc(mtm), frame);
        host.setWantsLayer(true);
        configure_surface_resize(&host);
        if let Err(error) = clip_surface_children(&host) {
            eprintln!("[layer] surface clip 설정 실패: {surface_label}: {error}");
            return;
        }
        configure_surface_resize(child);
        parent.addSubview_positioned_relativeTo(
            &host,
            NSWindowOrderingMode::Below,
            Some(main_view),
        );
        child.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
        host.addSubview(child);
        let ptr = Retained::as_ptr(&host) as usize;
        SURFACES.register(ptr, Some(&surface_label));
        SURFACE_HOSTS.register(&surface_label, ptr, &window_label);
    });
}

fn css_rect_in_parent(parent: &NSView, x: f64, y: f64, w: f64, h: f64) -> objc2_foundation::NSRect {
    use objc2_foundation::{NSRect, NSSize};
    let py = if parent.isFlipped() { y } else { parent.bounds().size.height - y - h };
    NSRect::new(NSPoint::new(x, py), NSSize::new(w, h))
}

/// 이미 생성된 child webview host들을 한 패널 이동 단위로 묶는다. renderer는 같은 패널의
/// DOM/chrome를 그리는 child이고 members는 그 아래의 문서 밖 표면이다. 멤버의 기존 전역
/// frame은 pane-local frame으로 보존되며, 이후 패널 이동은 이 부모 하나만 바꾼다.
pub fn group_pane_surface_host(
    pane: &str,
    window: &str,
    renderer: &str,
    members: &[String],
    rect: (f64, f64, f64, f64),
) -> Result<(), String> {
    use objc2_foundation::{NSRect, NSSize};

    if members.is_empty() { return Err("pane surface member가 비었습니다".into()); }
    if members.iter().any(|label| label == renderer) {
        return Err("pane renderer와 문서 밖 surface는 같은 label일 수 없습니다".into());
    }
    if PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?.contains_key(pane) {
        return Err(format!("pane surface host가 이미 있습니다: {pane}"));
    }
    let renderer_host_ptr = surface_host_ptr(renderer);
    if renderer_host_ptr == 0 { return Err(format!("pane renderer host가 없습니다: {renderer}")); }
    let mut labels = Vec::with_capacity(members.len() + 1);
    labels.push(renderer.to_owned());
    labels.extend(members.iter().cloned());
    let host_ptrs = labels.iter().map(|label| {
        let ptr = surface_host_ptr(label);
        if ptr == 0 { Err(format!("surface host가 없습니다: {label}")) } else { Ok((label.clone(), ptr)) }
    }).collect::<Result<Vec<_>, _>>()?;

    let renderer_host = unsafe { &*(renderer_host_ptr as *const NSView) };
    let parent = unsafe { renderer_host.superview() }
        .ok_or_else(|| format!("pane renderer 부모가 없습니다: {renderer}"))?;
    let main_ptr = LAYERS.lock().map_err(|_| "창 layer 잠금 실패")?
        .get(window).map(|layer| layer.main_ptr).unwrap_or(0);
    if main_ptr == 0 { return Err(format!("main DOM view가 없습니다: {window}")); }
    let main_view = unsafe { &*(main_ptr as *const NSView) };
    let main_parent = unsafe { main_view.superview() }
        .ok_or_else(|| format!("main DOM view 부모가 없습니다: {window}"))?;
    if Retained::as_ptr(&parent) != Retained::as_ptr(&main_parent) {
        return Err(format!("pane renderer와 main DOM view의 부모가 다릅니다: {renderer}"));
    }
    for (label, ptr) in host_ptrs.iter().skip(1) {
        let member_host = SURFACE_HOSTS.host(label)
            .ok_or_else(|| format!("pane member host identity가 없습니다: {label}"))?;
        let same_window = member_host.window == window;
        if !same_window {
            return Err(format!("pane member의 소유 창이 다릅니다: {label}"));
        }
        let host = unsafe { &*(*ptr as *const NSView) };
        let same_native_window = host.window().zip(parent.window())
            .map(|(candidate, expected)| Retained::as_ptr(&candidate) == Retained::as_ptr(&expected))
            .unwrap_or(false);
        if !same_native_window {
            return Err(format!("pane member의 native window가 다릅니다: {label}"));
        }
    }

    // Renderer and external members may start under different adapter-owned parents. Convert every
    // existing host bounds into the target content-root coordinates before any reparenting.
    let frames_in_parent = host_ptrs.iter().map(|(_, ptr)| {
        let host = unsafe { &*(*ptr as *const NSView) };
        let member_bounds = host.bounds();
        let converted: NSRect = unsafe { msg_send![host, convertRect: member_bounds, toView: &*parent] };
        converted
    }).collect::<Vec<_>>();

    let mtm = objc2::MainThreadMarker::new().ok_or("pane host는 main thread에서만 생성합니다")?;
    let frame = css_rect_in_parent(&parent, rect.0, rect.1, rect.2, rect.3);
    let pane_host: Retained<PaneSurfaceHost> =
        unsafe { msg_send![mtm.alloc::<PaneSurfaceHost>(), initWithFrame: frame] };
    let pane_view: &NSView = &pane_host;
    pane_view.setWantsLayer(true);
    configure_surface_resize(pane_view);
    pane_view.setAutoresizesSubviews(true);
    clip_surface_children(pane_view)?;
    // PaneSurfaceHost도 최초 개별 surface와 동일하게 main DOM WKWebView 바로 아래에 둔다.
    // addSubview(맨 끝)는 pane을 DOM 위로 올려 sidebar/+버튼/modal을 덮는다.
    parent.addSubview_positioned_relativeTo(
        pane_view,
        NSWindowOrderingMode::Below,
        Some(main_view),
    );

    for ((label, ptr), old) in host_ptrs.iter().zip(frames_in_parent) {
        let host = unsafe { &*(*ptr as *const NSView) };
        let local = NSRect::new(
            NSPoint::new(old.origin.x - frame.origin.x, old.origin.y - frame.origin.y),
            NSSize::new(old.size.width, old.size.height),
        );
        host.removeFromSuperview();
        host.setFrame(local);
        configure_pane_member_resize(host);
        if let Some(child_ptr) = SURFACE_VIEWS.lock().ok().and_then(|views| views.get(label).copied()) {
            let child = unsafe { &*(child_ptr as *const NSView) };
            configure_pane_member_resize(child);
        }
        pane_view.addSubview(host);
        SURFACE_PANES.lock().map_err(|_| "surface pane 잠금 실패")?
            .insert(label.clone(), pane.to_owned());
    }
    // addSubview 순서상 마지막이 위다. renderer를 마지막으로 다시 붙여 chrome/input을 소유시킨다.
    renderer_host.removeFromSuperview();
    pane_view.addSubview(renderer_host);
    settle_surface_frame(pane_view);

    let ptr = Retained::as_ptr(&pane_host) as usize;
    PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?.insert(
        pane.to_owned(),
        PaneSurfaceRecord {
            ptr,
            window: window.to_owned(),
            renderer: renderer.to_owned(),
            members: members.to_vec(),
            layout: None,
            member_layouts: HashMap::new(),
        },
    );
    std::mem::forget(pane_host);
    Ok(())
}

pub fn pane_surface_host_state() -> serde_json::Value {
    let Ok(hosts) = PANE_SURFACE_HOSTS.lock() else { return serde_json::json!([]); };
    let views = SURFACE_VIEWS.lock().ok();
    let transparency = SURFACE_TRANSPARENCY.lock().ok();
    serde_json::Value::Array(hosts.iter().map(|(pane, record)| {
        let host = unsafe { &*(record.ptr as *const NSView) };
        let frame = host.frame();
        let css_frame = unsafe { host.superview() }.map(|parent| {
            let y = if parent.isFlipped() {
                frame.origin.y
            } else {
                parent.bounds().size.height - frame.origin.y - frame.size.height
            };
            serde_json::json!({
                "x": frame.origin.x, "y": y,
                "w": frame.size.width, "h": frame.size.height,
            })
        });
        let contract_frame = unsafe { host.superview() }.and_then(|parent| {
            let bounds = parent.bounds();
            record.layout.as_ref().map(|layout| {
                let (x, y, w, h) = layout.rect_for_viewport(bounds.size.width, bounds.size.height);
                serde_json::json!({ "x": x, "y": y, "w": w, "h": h })
            })
        });
        let clips_to_bounds = host.layer().map(|layer| layer.masksToBounds()).unwrap_or(false);
        let renderer_ptr = views.as_ref().and_then(|map| map.get(&record.renderer)).copied().unwrap_or(0);
        let topology = record.members.first()
            .and_then(|label| {
                let host_ptr = surface_host_ptr(label);
                views.as_ref().and_then(|map| map.get(label)).copied()
                    .or_else(|| (host_ptr != 0).then_some(host_ptr))
            })
            .map(|surface_ptr| renderer_pair_topology(renderer_ptr, surface_ptr));
        let member_frames = record.members.iter().map(|label| {
            let ptr = surface_host_ptr(label);
            let frame = if ptr == 0 { None } else {
                let member = unsafe { &*(ptr as *const NSView) };
                let raw = member.frame();
                let y = if host.isFlipped() {
                    raw.origin.y
                } else {
                    host.bounds().size.height - raw.origin.y - raw.size.height
                };
                Some(serde_json::json!({
                    "x": raw.origin.x, "y": y,
                    "w": raw.size.width, "h": raw.size.height,
                }))
            };
            let contract_frame = record.member_layouts.get(label).map(|layout| {
                let bounds = host.bounds();
                let (x, y, w, h) = layout.rect_for_host(bounds.size.width, bounds.size.height);
                serde_json::json!({ "x": x, "y": y, "w": w, "h": h })
            });
            serde_json::json!({ "label": label, "cssFrame": frame, "contractFrame": contract_frame })
        }).collect::<Vec<_>>();
        serde_json::json!({
            "pane": pane,
            "window": record.window,
            "renderer": record.renderer,
            "rendererTransparent": transparency.as_ref()
                .and_then(|map| map.get(&record.renderer)).copied().unwrap_or(false),
            "members": record.members,
            "memberFrames": member_frames,
            "frame": { "x": frame.origin.x, "y": frame.origin.y, "w": frame.size.width, "h": frame.size.height },
            "cssFrame": css_frame,
            "contractFrame": contract_frame,
            "clipsToBounds": clips_to_bounds,
            "alpha": host.alphaValue(),
            "rendererTopology": topology,
        })
    }).collect())
}

/// 공개 pane `--dim` 사실을 renderer/member 공통 부모에 정확히 한 번 적용한다.
/// 개별 child에 alpha/veil을 중복 적용하지 않아 전체 pane의 상대 밝기를 보존한다.
pub fn set_pane_surface_host_lighting(pane: &str, alpha: f64) -> Result<(), String> {
    if !alpha.is_finite() || !(0.0..=1.0).contains(&alpha) {
        return Err(format!("pane alpha가 유효하지 않습니다: {alpha}"));
    }
    let ptr = PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?
        .get(pane).map(|record| record.ptr)
        .ok_or_else(|| format!("pane surface host가 없습니다: {pane}"))?;
    let host = unsafe { &*(ptr as *const NSView) };
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    host.setAlphaValue(alpha);
    CATransaction::commit();
    Ok(())
}

/// 일반 레이아웃/창 리사이즈의 정착 경로. 위치 전용 transition과 달리 크기 변화도 허용하고,
/// renderer/member는 PaneSurfaceHost의 자식으로 남긴 채 부모 frame 하나만 바꾼다.
pub fn set_pane_surface_host_bounds(
    pane: &str,
    rect: (f64, f64, f64, f64),
    layout: Option<super::SurfaceLayoutContract>,
) -> Result<(), String> {
    let mut record = PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?
        .get(pane).cloned().ok_or_else(|| format!("pane surface host가 없습니다: {pane}"))?;
    let host = unsafe { &*(record.ptr as *const NSView) };
    let parent = unsafe { host.superview() }.ok_or_else(|| format!("pane host 부모가 없습니다: {pane}"))?;
    if let Some(ref candidate) = layout {
        let bounds = parent.bounds();
        // AppKit resize transaction이 새 viewport를 이미 반영한 뒤 도착한 이전 renderer IPC는
        // model frame을 과거 크기로 되돌릴 수 없다. 현재 세대가 아니면 no-op ACK한다.
        if !candidate.belongs_to_viewport(bounds.size.width, bounds.size.height) { return Ok(()); }
        record.layout = Some(candidate.clone());
        PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?
            .get_mut(pane).ok_or_else(|| format!("pane surface host가 없습니다: {pane}"))?
            .layout = Some(candidate.clone());
    }
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    let target = css_rect_in_parent(&parent, rect.0, rect.1, rect.2, rect.3);
    host.setFrame(target);
    resize_pane_children(&record, host, target.size);
    settle_surface_frame(host);
    CATransaction::commit();
    Ok(())
}

/// 공개 DOM 슬롯에서 받은 affine 계약을 해당 native surface identity에 결속한다.
/// 계약은 플러그인/엔진 이름을 포함하지 않으며 창 resize 통지에서만 소비된다.
pub fn set_surface_layout(label: &str, layout: super::SurfaceLayoutContract) {
    if let Ok(mut layouts) = SURFACE_LAYOUTS.lock() {
        layouts.insert(label.to_owned(), layout);
    }
}

/// 이전 window viewport에서 측정한 후행 IPC가 현재 native frame을 되돌리지 못하게 한다.
pub fn accept_surface_layout(label: &str, layout: super::SurfaceLayoutContract) -> bool {
    let Some(ptr) = SURFACE_HOSTS.ptr(label) else { return false };
    let host = unsafe { &*(ptr as *const NSView) };
    let Some(parent) = (unsafe { host.superview() }) else { return false };
    let bounds = parent.bounds();
    if !layout.belongs_to_viewport(bounds.size.width, bounds.size.height) {
        return false;
    }
    set_surface_layout(label, layout);
    true
}

/// 일반 DOM renderer 아래의 native surface를 NSWindowDidResize와 같은 AppKit epoch에 옮긴다.
/// JavaScript resize 이벤트는 이보다 뒤에 오므로 최종 검증/정착 경로일 뿐 실시간 추종자가 아니다.
pub fn resize_registered_surface_hosts(window: &str) {
    let labels = SURFACE_HOSTS.labels_in(window);
    let layouts = SURFACE_LAYOUTS.lock().ok().map(|layouts| layouts.clone()).unwrap_or_default();
    let pane_members = SURFACE_PANES.lock().ok().map(|members| members.clone()).unwrap_or_default();
    let records = labels.into_iter().filter_map(|label| {
        if pane_members.contains_key(&label) { return None; }
        let layout = layouts.get(&label)?.clone();
        let ptr = SURFACE_HOSTS.ptr(&label)?;
        Some((label, ptr, layout))
    }).collect::<Vec<_>>();
    let viewport = records.first().and_then(|(_, ptr, _)| {
        let host = unsafe { &*(*ptr as *const NSView) };
        unsafe { host.superview() }.map(|parent| {
            let bounds = parent.bounds();
            (bounds.size.width, bounds.size.height)
        })
    });
    let Some((viewport_w, viewport_h)) = viewport else { return };

    CATransaction::begin();
    CATransaction::setDisableActions(true);
    for (label, ptr, layout) in records {
        let host = unsafe { &*(ptr as *const NSView) };
        let Some(parent) = (unsafe { host.superview() }) else { continue };
        let rect = layout.rect_for_viewport(viewport_w, viewport_h);
        let target = css_rect_in_parent(&parent, rect.0, rect.1, rect.2, rect.3);
        host.setFrame(target);
        if let Some(child_ptr) = SURFACE_VIEWS.lock().ok().and_then(|views| views.get(&label).copied()) {
            let child = unsafe { &*(child_ptr as *const NSView) };
            child.setFrame(objc2_foundation::NSRect::new(NSPoint::new(0.0, 0.0), target.size));
            settle_surface_frame(child);
        }
        settle_surface_frame(host);
    }
    CATransaction::commit();
}

/// NSWindowDidResize 통지 차례에서 DOM IPC보다 먼저 실행된다. 마지막으로 확정된 공개 CSS
/// 레이아웃 계약을 새 viewport에 투영해 모든 pane host를 같은 native resize epoch로 옮긴다.
pub fn resize_pane_surface_hosts(window: &str) {
    let viewport = PANE_SURFACE_HOSTS.lock().ok().and_then(|hosts| {
        hosts.values().find(|record| record.window == window).and_then(|record| {
            let host = unsafe { &*(record.ptr as *const NSView) };
            unsafe { host.superview() }.map(|parent| {
                let bounds = parent.bounds();
                (bounds.size.width, bounds.size.height)
            })
        })
    });
    if let Some((width, height)) = viewport {
        resize_pane_surface_hosts_for_viewport(window, width, height);
    }
}

/// windowWillResize가 알려 준 다음 content viewport를 실제 창 frame 적용보다 먼저 투영한다.
/// 후행 DidResize와 같은 식을 쓰므로 선행/확정 경로가 서로 다른 좌표 규칙을 만들지 않는다.
fn resize_pane_surface_hosts_for_viewport(window: &str, viewport_w: f64, viewport_h: f64) {
    let records = PANE_SURFACE_HOSTS.lock().ok().map(|hosts| {
        hosts.iter()
            .filter(|(_, record)| record.window == window && record.layout.is_some())
            .map(|(pane, record)| (pane.clone(), record.clone()))
            .collect::<Vec<_>>()
    }).unwrap_or_default();
    for (_pane, record) in records {
        let Some(ref layout) = record.layout else { continue };
        let host = unsafe { &*(record.ptr as *const NSView) };
        let Some(parent) = (unsafe { host.superview() }) else { continue };
        let rect = layout.rect_for_viewport(viewport_w, viewport_h);
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        let target = css_rect_in_parent(&parent, rect.0, rect.1, rect.2, rect.3);
        host.setFrame(target);
        resize_pane_children(&record, host, target.size);
        settle_surface_frame(host);
        CATransaction::commit();
    }
}

fn resize_surface_host(label: &str, frame: objc2_foundation::NSRect) {
    let host_ptr = surface_host_ptr(label);
    if host_ptr == 0 { return; }
    let surface_host = unsafe { &*(host_ptr as *const NSView) };
    surface_host.setFrame(frame);
    if let Some(child_ptr) = SURFACE_VIEWS.lock().ok().and_then(|views| views.get(label).copied()) {
        let child = unsafe { &*(child_ptr as *const NSView) };
        child.setFrame(objc2_foundation::NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
        settle_surface_frame(child);
    }
    settle_surface_frame(surface_host);
}

fn resize_pane_children(record: &PaneSurfaceRecord, host: &NSView, size: objc2_foundation::NSSize) {
    resize_surface_host(
        &record.renderer,
        objc2_foundation::NSRect::new(NSPoint::new(0.0, 0.0), size),
    );
    for (label, layout) in &record.member_layouts {
        let rect = layout.rect_for_host(size.width, size.height);
        resize_surface_host(
            label,
            css_rect_in_parent(host, rect.0, rect.1, rect.2, rect.3),
        );
    }
}

#[cfg(test)]
mod pane_layout_tests {
    use crate::webview::{PaneMemberLayoutContract, SurfaceLayoutContract};

    #[test]
    fn projects_percentage_grid_and_fixed_chrome_into_the_new_viewport() {
        let contract = SurfaceLayoutContract {
            viewport_w: 900.0, viewport_h: 1080.0,
            root_x: 54.0, root_y: 82.0, root_w: 846.0, root_h: 998.0,
            left_ratio: 2.0 / 3.0, top_ratio: 0.0,
            width_ratio: 1.0 / 3.0, height_ratio: 0.5,
            fixed_x: 51.0, fixed_y: 39.0, fixed_w: -58.0, fixed_h: -69.0,
        };
        let rect = contract.rect_for_viewport(600.0, 450.0);
        assert_eq!(rect, (469.0, 121.0, 124.0, 115.0));
        assert!(contract.belongs_to_viewport(900.5, 1079.5));
        assert!(!contract.belongs_to_viewport(600.0, 450.0));
    }

    #[test]
    fn keeps_member_insets_while_the_pane_host_resizes() {
        let contract = PaneMemberLayoutContract {
            host_w: 320.0, host_h: 240.0,
            left: 0.0, top: 56.0, right: 0.0, bottom: 0.0,
        };
        assert_eq!(contract.rect_for_host(320.0, 240.0), (0.0, 56.0, 320.0, 184.0));
        assert!(contract.belongs_to_host(320.5, 239.5));
        assert!(!contract.belongs_to_host(400.0, 300.0));
    }
}

/// child renderer가 공개한 content slot의 pane-local CSS 좌표를 실제 member frame에 적용한다.
/// 전역 좌표를 다시 빼지 않는다. 그룹 뒤 기하의 단일 좌표계는 PaneSurfaceHost local이다.
pub fn set_pane_surface_member_bounds(
    pane: &str,
    label: &str,
    rect: (f64, f64, f64, f64),
    layout: Option<super::PaneMemberLayoutContract>,
) -> Result<(), String> {
    let mut record = PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?
        .get(pane).cloned().ok_or_else(|| format!("pane surface host가 없습니다: {pane}"))?;
    if !record.members.iter().any(|member| member == label) {
        return Err(format!("pane member가 아닙니다: {pane}/{label}"));
    }
    let host = unsafe { &*(record.ptr as *const NSView) };
    if let Some(ref candidate) = layout {
        let bounds = host.bounds();
        if !candidate.belongs_to_host(bounds.size.width, bounds.size.height) { return Ok(()); }
        record.member_layouts.insert(label.to_owned(), candidate.clone());
        PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?
            .get_mut(pane).ok_or_else(|| format!("pane surface host가 없습니다: {pane}"))?
            .member_layouts.insert(label.to_owned(), candidate.clone());
    }
    let surface_ptr = surface_host_ptr(label);
    if surface_ptr == 0 { return Err(format!("pane member host가 없습니다: {label}")); }
    let surface = unsafe { &*(surface_ptr as *const NSView) };
    let same_parent = unsafe { surface.superview() }
        .map(|parent| Retained::as_ptr(&parent) == host as *const NSView)
        .unwrap_or(false);
    if !same_parent { return Err(format!("pane member 부모가 일치하지 않습니다: {pane}/{label}")); }
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    let target = css_rect_in_parent(host, rect.0, rect.1, rect.2, rect.3);
    surface.setFrame(target);
    if let Some(child_ptr) = SURFACE_VIEWS.lock().map_err(|_| "surface view 잠금 실패")?.get(label).copied() {
        let child = unsafe { &*(child_ptr as *const NSView) };
        child.setFrame(objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(0.0, 0.0),
            target.size,
        ));
        settle_surface_frame(child);
    }
    settle_surface_frame(surface);
    CATransaction::commit();
    Ok(())
}

pub fn prepare_pane_surface_host_translation(
    pane: &str,
    rect: (f64, f64, f64, f64),
    start_at_unix_ms: f64,
    duration_ms: f64,
) -> Result<(), String> {
    let record = PANE_SURFACE_HOSTS.lock().map_err(|_| "pane host 잠금 실패")?
        .get(pane).cloned().ok_or_else(|| format!("pane surface host가 없습니다: {pane}"))?;
    let host = unsafe { &*(record.ptr as *const NSView) };
    let parent = unsafe { host.superview() }.ok_or_else(|| format!("pane host 부모가 없습니다: {pane}"))?;
    let target = css_rect_in_parent(&parent, rect.0, rect.1, rect.2, rect.3);
    let before = host.frame();
    if (before.size.width - target.size.width).abs() > 0.5
        || (before.size.height - target.size.height).abs() > 0.5
    {
        return Err(format!(
            "pane 위치 전용 거래에 크기 변화가 들어왔습니다: {}x{} -> {}x{}",
            before.size.width, before.size.height, target.size.width, target.size.height,
        ));
    }
    let dx = before.origin.x - target.origin.x;
    let now_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(start_at_unix_ms);
    let delay = (start_at_unix_ms - now_unix_ms).max(0.0) / 1000.0;
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    host.setFrame(target);
    let result = add_layout_position(host, dx, delay, duration_ms.max(1.0) / 1000.0);
    CATransaction::commit();
    result
}

pub fn set_surface_host_hidden(label: &str, hidden: bool) {
    if let Some(ptr) = SURFACE_HOSTS.ptr(label) {
        let host = unsafe { &*(ptr as *const NSView) };
        host.setHidden(hidden);
    }
}

pub fn remove_surface_host(label: &str) {
    detach_surface_from_pane(label);
    let host = SURFACE_HOSTS.remove(label);
    let Some(host) = host else { return };
    SURFACES.unregister(host.ptr);
    let host = unsafe { &*(host.ptr as *const NSView) };
    host.removeFromSuperview();
    if let Ok(mut views) = SURFACE_VIEWS.lock() {
        views.remove(label);
    }
    if let Ok(mut transparency) = SURFACE_TRANSPARENCY.lock() {
        transparency.remove(label);
    }
    if let Ok(mut layouts) = SURFACE_LAYOUTS.lock() {
        layouts.remove(label);
    }
}

/// WindowEvent::Destroyed 뒤에는 NSView를 만지지 않는다. 창 소유 장부에서 identity만
/// 원자적으로 걷어 다음 창/다음 E2E가 해제된 포인터를 보지 않게 한다.
pub fn forget_window(window: &str) {
    let removed = SURFACE_HOSTS.remove_window(window);
    let labels = removed.iter().map(|(label, _)| label.clone()).collect::<std::collections::HashSet<_>>();
    for (_, host) in &removed { SURFACES.unregister(host.ptr); }
    if let Ok(mut views) = SURFACE_VIEWS.lock() { views.retain(|label, _| !labels.contains(label)); }
    if let Ok(mut transparency) = SURFACE_TRANSPARENCY.lock() {
        transparency.retain(|label, _| !labels.contains(label));
    }
    if let Ok(mut layouts) = SURFACE_LAYOUTS.lock() {
        layouts.retain(|label, _| !labels.contains(label));
    }
    if let Ok(mut panes) = SURFACE_PANES.lock() { panes.retain(|label, _| !labels.contains(label)); }
    if let Ok(mut hosts) = PANE_SURFACE_HOSTS.lock() { hosts.retain(|_, record| record.window != window); }
    if let Ok(mut layers) = LAYERS.lock() { layers.remove(window); }
}

fn detach_surface_from_pane(label: &str) {
    let pane = SURFACE_PANES.lock().ok().and_then(|mut map| map.remove(label));
    let Some(pane) = pane else { return };
    let mut hosts = match PANE_SURFACE_HOSTS.lock() { Ok(hosts) => hosts, Err(_) => return };
    let Some(record) = hosts.get_mut(&pane) else { return };
    record.members.retain(|member| member != label);
    if record.renderer != label && !record.members.is_empty() { return; }

    let record = hosts.remove(&pane).expect("pane record existed");
    let pane_host = unsafe { &*(record.ptr as *const NSView) };
    let Some(parent) = (unsafe { pane_host.superview() }) else { return };
    let pane_frame = pane_host.frame();
    let main_ptr = LAYERS.lock().ok().and_then(|layers| {
        layers.get(&record.window).map(|layer| layer.main_ptr)
    }).unwrap_or(0);
    let main_view = (main_ptr != 0).then(|| unsafe { &*(main_ptr as *const NSView) });
    let mut labels = vec![record.renderer];
    labels.extend(record.members);
    for member in labels {
        if member == label { continue; }
        let ptr = surface_host_ptr(&member);
        if ptr == 0 { continue; }
        let host = unsafe { &*(ptr as *const NSView) };
        let local = host.frame();
        host.removeFromSuperview();
        configure_surface_resize(host);
        if let Some(child_ptr) = SURFACE_VIEWS.lock().ok().and_then(|views| views.get(&member).copied()) {
            let child = unsafe { &*(child_ptr as *const NSView) };
            configure_surface_resize(child);
        }
        host.setFrameOrigin(NSPoint::new(
            pane_frame.origin.x + local.origin.x,
            pane_frame.origin.y + local.origin.y,
        ));
        if let Some(main_view) = main_view {
            parent.addSubview_positioned_relativeTo(
                host,
                NSWindowOrderingMode::Below,
                Some(main_view),
            );
        } else {
            // 창 파괴와 detach가 경주할 때만 가능한 수명 종료 경로다.
            parent.addSubview(host);
        }
        if let Ok(mut surface_panes) = SURFACE_PANES.lock() {
            surface_panes.remove(&member);
        }
    }
    pane_host.removeFromSuperview();
}

// 등록된 엔진 서피스 수 — 관측면(webview.surfaces 의 engine 축)이 읽는다.
pub fn surface_count() -> usize {
    SURFACES.len()
}

// 창의 살아있는 등록 서피스 실측 — SURFACES(포인터 집합)를 직접 순회하면 파괴와
// 해제 relay 사이의 틈에 죽은 포인터로 msg_send 가 나간다(실사고: engine_surface_stats
// 의 NSView::window() 에서 SIGTRAP — use-after-free 앱 즉사). 순회의 원천은 창의
// live subview 트리다: 존재하는 뷰만 만지고, SURFACES 는 멤버십 판정에만 쓴다
// (hit_test 의 "형제 순회가 live subview 만 본다" 원리와 동일). 메인 스레드 전용.
pub fn live_registered_views(ns_window_ptr: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let set = SURFACES.members();
    if ns_window_ptr == 0 {
        return out;
    }
    let ns_window: &objc2_app_kit::NSWindow =
        unsafe { &*(ns_window_ptr as *const objc2_app_kit::NSWindow) };
    let Some(content) = ns_window.contentView() else {
        return out;
    };
    fn walk(
        v: &objc2_app_kit::NSView,
        set: &std::collections::HashSet<usize>,
        out: &mut Vec<usize>,
    ) {
        for sub in v.subviews().iter() {
            let ptr = &*sub as *const objc2_app_kit::NSView as usize;
            if set.contains(&ptr) {
                out.push(ptr);
            }
            walk(&sub, set, out);
        }
    }
    walk(&content, &set, &mut out);
    out
}

// 창의 엔진 호스트 컨테이너 포인터(0=미생성) — 재부팅 구간 숨김의 손잡이.
pub fn engine_host_ptr(label: &str) -> usize {
    LAYERS
        .lock()
        .ok()
        .and_then(|m| m.get(label).map(|w| w.host_ptr))
        .unwrap_or(0)
}

type HitTestFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSPoint) -> *mut AnyObject;

// hitTest: 교체 구현. 클래스(WryWebView) 단위 스위즐이므로 모든 webview 가
// 거치지만 메인 뷰만 홀 로직을 탄다 — isa-swizzle(인스턴스 클래스 교체)은
// AppKit 의 클래스 기반 design-property 조회(NSDP)가 런타임 서브클래스에서
// assert 로 SIGABRT 를 내므로 금지(실측: <select> 팝업 attachPopUpWithFrame
// 경로 크래시). 클래스 정체성은 절대 바꾸지 않는다.
//
// AppKit 은 부모가 서브뷰를 앞→뒤로 hitTest 하고 첫 비-nil 이 이긴다 —
// 메인(최상위)이 nil 을 돌려주면 같은 지점의 아래 child webview 가 자연히
// 수신한다. point 는 superview 좌표계(형제 frame 과 동일 공간)이므로 변환
// 없이 비교한다. 메인 스레드에서만 호출된다(AppKit).
unsafe extern "C-unwind" fn hit_test(
    this: *mut AnyObject,
    cmd: Sel,
    point: NSPoint,
) -> *mut AnyObject {
    let orig: HitTestFn = std::mem::transmute(ORIG_HIT_TEST.load(Ordering::Relaxed));
    let default = orig(this, cmd, point);
    // this 가 *어느 창의* 메인 view 인가 + 그 창 오버레이 활성/홀? 미등록(child/팝업)이거나
    // 맵 poisoned 면 원본 동작. (마우스 이벤트마다 호출 — lock 은 짧고 창 수는 적다.)
    // overlay 와 holes(클론)를 lock 한 번에 같이 꺼낸다.
    let (overlay, holes, host_ptr) = {
        let Ok(layers) = LAYERS.lock() else {
            return default;
        };
        match layers.values().find(|w| w.main_ptr == this as usize) {
            None => return default, // child/팝업 webview — 원본 동작 그대로.
            Some(w) => (w.overlay, w.holes.clone(), w.host_ptr),
        }
    };
    // 등록된 Backend N surface 스냅샷(마우스 이벤트마다 — 탭 수만큼 작음, holes.clone 과 동일 층위).
    let surfaces = SURFACES.members();
    if default.is_null() || overlay {
        return default;
    }
    let view = &*(this as *const NSView);
    let Some(superview) = view.superview() else {
        return default;
    };
    // 사이드바 등 DOM 오버레이 영역은 풀사이즈 브라우저 위에 떠 있어도 DOM 이 이벤트를
    // 갖는다(스크롤이 브라우저로 새지 않음). 홀 안이면 default(메인 webview)를 그대로
    // 돌려줘 DOM 이 이벤트를 받는다. holes 는 메인 webview 콘텐츠 기준 CSS 논리 px(top-left,
    // webview_bounds 와 동일 규약)이고, point 는 superview 좌표계이므로 mf(메인 frame)를
    // 통해 변환한다. mf 는 메인 webview 콘텐츠 전 영역이다.
    let mf = view.frame();
    let flipped = superview.isFlipped();
    for hole in holes.iter() {
        let xlo = mf.origin.x + hole.x;
        let xhi = mf.origin.x + hole.x + hole.w;
        // y 변환: superview 가 flipped(top-left 원점)면 hole.y 를 그대로 더한다.
        // AppKit 기본(non-flipped, bottom-left 원점)이면 콘텐츠 상단이 mf 의 위쪽 변
        // (mf.origin.y + mf.size.height)이므로 거기서 hole.y/hole.y+h 를 빼 뒤집는다.
        let (ylo, yhi) = if flipped {
            (mf.origin.y + hole.y, mf.origin.y + hole.y + hole.h)
        } else {
            let y_high = mf.origin.y + mf.size.height - hole.y;
            let y_low = mf.origin.y + mf.size.height - (hole.y + hole.h);
            (y_low, y_high)
        };
        if point.x >= xlo && point.x < xhi && point.y >= ylo && point.y < yhi {
            return default;
        }
    }
    // 등록된 surface 가 point 를 덮으면 null 반환(형제 stack 아래 child 가 이벤트 수신). surface 는
    // ① contentView 직속 형제(레거시/코어 webview) ② 엔진 호스트 컨테이너 안(격리 계약)에 있을 수
    // 있다. 두 곳 모두 검사한다. 컨테이너는 contentView 전체크기·원점(0,0)이라 그 안 surface 의 frame
    // 은 contentView(=point) 좌표와 identity — 형제와 동일 비교식이 성립한다.
    let hit = |parent: &NSView| -> bool {
        for sub in parent.subviews().iter() {
            if Retained::as_ptr(&sub) as *mut AnyObject == this || sub.isHidden() {
                continue;
            }
            if !surfaces.contains(&(Retained::as_ptr(&sub) as usize)) {
                continue;
            }
            let f = sub.frame();
            if point.x >= f.origin.x
                && point.x < f.origin.x + f.size.width
                && point.y >= f.origin.y
                && point.y < f.origin.y + f.size.height
            {
                return true;
            }
        }
        false
    };
    if hit(&superview) {
        return std::ptr::null_mut();
    }
    if host_ptr != 0 {
        let host = &*(host_ptr as *const NSView);
        if hit(host) {
            return std::ptr::null_mut();
        }
    }
    default
}

// 메인 webview 에 1회 설치: ① 자체 배경 비활성(KVC drawsBackground=false —
// wry 의 transparent 경로와 동일 기법; CSS 불투명 표면은 그대로 그려지고
// 투명 슬롯만 아래가 비친다) ② hitTest 메서드 스위즐(클래스 단위, 위 주석).
pub fn install(app: &tauri::AppHandle, label: &str) {
    let Some(wv) = app.get_webview(label) else {
        eprintln!("[layer] {label} webview 없음 — 레이어 역전 미설치");
        return;
    };
    let label = label.to_string();
    let _ = wv.with_webview(move |pw| unsafe {
        let obj = pw.inner() as *mut AnyObject;
        if let Ok(mut layers) = LAYERS.lock() {
            layers.insert(
                label,
                WinLayer {
                    main_ptr: obj as usize,
                    overlay: false,
                    holes: Vec::new(),
                    host_ptr: 0,
                },
            );
        }

        let no = NSNumber::new_bool(false);
        let key = NSString::from_str("drawsBackground");
        let _: () = msg_send![&*obj, setValue: Some(&*no as &AnyObject), forKey: &*key];

        // hitTest 스위즐 — 클래스(WryWebView) 단위라 앱 전역 1회면 모든 창 webview 가 거친다.
        // 원본 IMP 를 보관하고 같은 타입 인코딩으로 교체. 이미 설치됐으면(ORIG≠0) 건너뛴다.
        if ORIG_HIT_TEST.load(Ordering::Relaxed) != 0 {
            return;
        }
        let cls = (*obj).class();
        let sel = sel!(hitTest:);
        let Some(method) = cls.instance_method(sel) else {
            eprintln!("[layer] hitTest 메서드 없음 — 홀 위임 미설치");
            return;
        };
        ORIG_HIT_TEST.store(method.implementation() as usize, Ordering::Relaxed);
        objc2::ffi::class_replaceMethod(
            (cls as *const objc2::runtime::AnyClass).cast_mut(),
            sel,
            std::mem::transmute::<HitTestFn, objc2::runtime::Imp>(hit_test),
            objc2::ffi::method_getTypeEncoding(method as *const objc2::runtime::Method),
        );
    });
}

// 엔진 호스트 컨테이너 취득(격리 계약) — 창 label 의 contentView 안, 메인 webview 아래에 코어 소유
// 전체크기 NSView 를 1회 생성해 그 포인터를 반환한다. 모듈은 이 컨테이너를 surface 로 받아 그 안에만
// child/레이어를 붙인다 → 모듈 결함의 피해가 컨테이너로 국한되고 contentView(=코어 소유)는 불가침.
// **메인 스레드에서만 호출**(NSView 생성/삽입). 미설치 창(WinLayer 없음)·실패 시 None → 호출부가
// contentView 폴백(격리는 심층방어라, 폴백 시 hitTest 형제 경로가 그대로 동작한다).
#[cfg(target_os = "macos")]
pub fn ensure_engine_host(label: &str) -> Option<usize> {
    use objc2_app_kit::NSAutoresizingMaskOptions;
    let mtm = objc2_foundation::MainThreadMarker::new()?; // 메인 스레드 계약 확인.
    unsafe {
        let main_ptr = {
            let layers = LAYERS.lock().ok()?;
            let w = layers.get(label)?;
            if w.host_ptr != 0 {
                return Some(w.host_ptr); // 이미 생성됨(멱등).
            }
            w.main_ptr
        };
        if main_ptr == 0 {
            return None;
        }
        let main_view = &*(main_ptr as *const NSView);
        let content = main_view.superview()?; // contentView(코어 소유) — 컨테이너의 부모.
        let bounds = content.bounds();
        let host: Retained<EngineSurfaceHost> =
            msg_send![mtm.alloc::<EngineSurfaceHost>(), initWithFrame: bounds];
        let host_view: &NSView = &host;
        // 합성 호스트는 레이어-백드여야 한다 — Chromium windowed 는 GPU 프로세스의 원격
        // CALayer(CAContext) 를 자기 뷰 레이어에 호스팅하는데, 부모 사슬이 레이어-백드가
        // 아니면 그 레이어가 창의 합성 트리에 영영 안 올라간다(실사고: 페이지 DOM 생존·
        // 뷰 정위치·unhidden 인데 픽셀만 없음 — 단독 하니스(winit 레이어-백드)는 GREEN,
        // 앱 임베딩만 블랭크). OSR 은 프레젠터가 자기 CALayer 를 직접 붙여 무사했다.
        host_view.setWantsLayer(true);
        configure_surface_resize(host_view);
        // 컨테이너는 콘텐츠 전면을 채우고 리사이즈를 따라간다(원점 0,0 유지 → 좌표 identity).
        host_view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        // 엔진 픽셀은 항상 메인 DOM 아래에 둔다. 보이는 범위의 단일 진실은 투명한
        // data-content-view-body 슬롯이며, 이동 중에도 사이드바·버튼·모달을 덮을 수 없다.
        content.addSubview_positioned_relativeTo(
            host_view,
            NSWindowOrderingMode::Below,
            Some(main_view),
        );
        let host_ptr = Retained::as_ptr(&host) as usize;
        // Retained 를 leak 해 컨테이너 수명을 뷰 계층에 위임(창이 소유; 창 파괴 시 함께 해제).
        std::mem::forget(host);
        if let Ok(mut layers) = LAYERS.lock() {
            if let Some(w) = layers.get_mut(label) {
                w.host_ptr = host_ptr;
            }
        }
        Some(host_ptr)
    }
}

// 실측 프로브: contentView 서브뷰 트리 덤프(클래스/frame/hidden) — 계층
// 가정(형제 구조·순서)의 검증·진단용.
pub fn dump_view(view: &NSView, depth: usize, out: &mut String) {
    let f = view.frame();
    let _ = std::fmt::Write::write_fmt(
        out,
        format_args!(
            "{}{} frame=({}, {}, {}, {}) hidden={} layer={} wants={} ptr={:p}\n",
            "  ".repeat(depth),
            view.class().name().to_string_lossy(),
            f.origin.x,
            f.origin.y,
            f.size.width,
            f.size.height,
            view.isHidden(),
            unsafe { view.layer().is_some() },
            unsafe { view.wantsLayer() },
            view as *const NSView,
        ),
    );
    if depth >= 6 {
        return; // CEF windowed 의 원격 레이어 호스트(WebContentsViewCocoa 하위)까지 관측
    }
    for sub in view.subviews().iter() {
        dump_view(&sub, depth + 1, out);
    }
}

#[cfg(test)]
mod external_surface_identity_tests {
    use super::window_for_engine_ancestors;

    #[test]
    fn resolves_the_owner_window_from_the_registered_engine_host_ancestor() {
        let hosts = vec![("w-a".to_owned(), 11), ("w-b".to_owned(), 22)];
        assert_eq!(window_for_engine_ancestors(&[40, 22, 3], &hosts).as_deref(), Some("w-b"));
        assert_eq!(window_for_engine_ancestors(&[40, 33, 3], &hosts), None);
    }
}
