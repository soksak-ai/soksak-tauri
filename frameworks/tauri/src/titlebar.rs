// macOS 신호등(트래픽 라이트) — webview 앱이라는 경계 때문에 생기는, 누구의
// 책임도 아닌 문제 두 가지에 대한 최소 보정. 위치의 단일 진실은 tauri.conf.json
// trafficLightPosition 이고, 이 모듈은 그것을 "유지"시키는 역할만 한다.
//
// 문제 1 — 위치 풀림(tauri#14072, 업스트림 버그):
//   정상 경로에선 wry(WryWebViewParent.drawRect)가 매 redraw 마다 inset 을
//   재적용하지만, unstable(child webview) 경로에선 창의 trafficLightPosition 이
//   자식 webview attributes 로 전파되지 않아 그 루프가 설치되지 않는다 → 키 상태
//   전환/리사이즈/전체화면 해제 때 AppKit 표준 재배치를 덮어쓸 주체가 없다.
//   치료: 표준 버튼과 같은 AppKit titlebar hierarchy에 입력 투과 NSView draw owner를
//   정확히 하나 두고, 버튼과 그 두 단계 native container의 동기 frame-change 사건에서 같은
//   목표를 즉시 적용한다. window update 이후의 보정은 잘못된 중간 프레임을 노출하므로 쓰지 않는다.
//   업스트림이 #14072 를 고치면
//   이 draw owner를 삭제하고 Tauri runtime setter로 목표만 전달한다.
//
// 문제 2 — 비활성 유령(Apple 동작, 고칠 주체 없음):
//   비활성 회색 점은 backdrop 합성(뒤 픽셀 샘플링)으로 그려지는데, 뒤가
//   out-of-process WKWebView 레이어라 샘플링이 실패해 배경과 Δ2~3 의 유령이 된다.
//   계측으로 뷰 상태(hidden/alpha/frame/z)는 전부 정상임을 확인 — 그리기 단계 문제.
//   네이티브 앱의 전제(샘플링 가능한 backdrop) 밖이라 Apple 도 tauri 도 안 고친다.
//   치료: 단일 draw owner가 현재 버튼 프레임에서 원형 백킹 3개를 그린다. 독립 native
//   backing view는 만들지 않으므로 AppKit 레이아웃과 별개의 좌표·z-order 상태가 없다.
//
// titlebar_native_state 는 읽기 전용 사실면이고, titlebar_compose 는 공개 DOM titlebar의
// 물리 좌표를 받아 한 메인스레드 거래에서 버튼 배치·paint owner 갱신·readback 영수증까지
// 끝낸다. DOM 예약 3개, AppKit 버튼 3개, owner가 그릴 backing 영역 3개를 같은 물리 좌표계에서
// 대조하므로 파일 로그나 private view dump를 판정 근거로 쓰지 않는다.

#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
    DefinedClass, MainThreadMarker,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBezierPath, NSButton, NSColor, NSGraphicsContext, NSView,
    NSWindow, NSWindowButton, NSWindowOrderingMode,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSNotification, NSNotificationCenter, NSPoint, NSRect};
#[cfg(target_os = "macos")]
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct PhysicalRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[cfg(target_os = "macos")]
impl PhysicalRect {
    const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    fn from_ns(rect: NSRect) -> Self {
        Self::new(
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        )
    }

    fn is_finite_positive(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.w.is_finite()
            && self.h.is_finite()
            && self.w > 0.0
            && self.h > 0.0
    }

    fn divided_by(self, scale: f64) -> Self {
        Self::new(
            self.x / scale,
            self.y / scale,
            self.w / scale,
            self.h / scale,
        )
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct CompositionTarget {
    titlebar_css: PhysicalRect,
    window_zoom: f64,
    /// AppKit logical-point origins captured by the first explicit DOM transaction. AppKit may
    /// reset them on later titlebar layouts; the draw owner reapplies the committed positions.
    button_origin_x: [f64; 3],
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct BackingColor {
    r: f64,
    g: f64,
    b: f64,
}

#[cfg(target_os = "macos")]
impl BackingColor {
    fn new(r: f64, g: f64, b: f64) -> Result<Self, String> {
        let values = [r, g, b];
        if values
            .into_iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
        {
            Ok(Self { r, g, b })
        } else {
            Err("titlebar backing color channels must be finite values from 0 to 1".to_string())
        }
    }
}

#[cfg(target_os = "macos")]
thread_local! {
    // AppKit 객체와 같은 메인스레드 수명. 목표·색·영수증은 창당 draw owner 자신이 소유한다.
    // 관측은 이 맵에서 기존 owner만 읽으며 만들거나 합성하지 않는다.
    static COMPOSITION_DRAW_OWNERS: std::cell::RefCell<
        std::collections::HashMap<String, TitlebarCompositionOwnerEntry>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(target_os = "macos")]
struct TitlebarCompositionOwnerEntry {
    owner: Retained<TitlebarCompositionDrawOwner>,
    native_layout_observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

#[cfg(target_os = "macos")]
static NEXT_OWNER_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(target_os = "macos")]
pub struct TitlebarCompositionDrawOwnerIvars {
    label: String,
    generation: u64,
    declared_button_origin_x: std::cell::Cell<Option<[f64; 3]>>,
    target: std::cell::Cell<Option<CompositionTarget>>,
    target_sequence: std::cell::Cell<u64>,
    applied_target_sequence: std::cell::Cell<u64>,
    draw_sequence: std::cell::Cell<u64>,
    mutation_sequence: std::cell::Cell<u64>,
    applying: std::cell::Cell<bool>,
    last_apply_ok: std::cell::Cell<bool>,
    last_apply_error: std::cell::RefCell<Option<String>>,
    backing_color: std::cell::Cell<Option<BackingColor>>,
}

// Tauri unstable child-webview 경로에 빠진 WryWebViewParent.drawRect 역할을 어댑터가
// content viewport에 복구한다. 투명하고 입력을 받지 않으며 위치를 그리지도 않는다.
// 유일한 역할은 AppKit이 표준 버튼을 재배치한 같은 draw epoch에 선언된 DOM 목표를 다시 적용하는 것.
#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = objc2::MainThreadOnly]
    #[ivars = TitlebarCompositionDrawOwnerIvars]
    #[name = "SoksakTitlebarCompositionDrawOwner"]
    struct TitlebarCompositionDrawOwner;

    impl TitlebarCompositionDrawOwner {
        #[unsafe(method(viewWillDraw))]
        fn view_will_draw(&self) {
            // AppKit explicitly permits viewWillDraw to move/resize views. The standard titlebar
            // superclass must finish its own layout before we restore the complete owned
            // button/paint-owner transaction. Calling super afterwards would invalidate our result in
            // the same display pass. drawRect below remains validation-only.
            unsafe {
                let _: () = msg_send![super(self), viewWillDraw];
            }
            if NSGraphicsContext::currentContextDrawingToScreen() {
                let target = self
                    .ivars()
                    .target
                    .get()
                    .map(|target| (target, self.ivars().target_sequence.get()));
                let _ = unsafe { apply_owner_now(self, target, true) };
            }
        }

        #[unsafe(method(drawRect:))]
        fn draw(&self, _dirty_rect: NSRect) {
            if !NSGraphicsContext::currentContextDrawingToScreen() {
                return;
            }
            let ivars = self.ivars();
            if ivars.applying.replace(true) {
                return;
            }
            let _guard = ApplyingGuard(&ivars.applying);
            ivars
                .draw_sequence
                .set(ivars.draw_sequence.get().saturating_add(1));
            let target = ivars
                .target
                .get()
                .map(|target| (target, ivars.target_sequence.get()));
            let result = unsafe { apply_owner_body(self, target, false) };
            record_apply_result(self, target.map(|(_, sequence)| sequence), &result);
            if result.is_ok() {
                unsafe { draw_owned_backings(self) };
            }
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }

        #[unsafe(method(isOpaque))]
        fn is_opaque(&self) -> bool {
            false
        }

        #[unsafe(method(canDrawConcurrently))]
        fn can_draw_concurrently(&self) -> bool {
            false
        }
    }
);

#[cfg(target_os = "macos")]
struct ApplyingGuard<'a>(&'a std::cell::Cell<bool>);

#[cfg(target_os = "macos")]
impl Drop for ApplyingGuard<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PhysicalSize {
    w: f64,
    h: f64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
pub struct NativeTitlebarElement {
    role: &'static str,
    rect: Option<PhysicalRect>,
    hidden: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
pub struct NativeTitlebarDeclaredElement {
    role: &'static str,
    rect: Option<PhysicalRect>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTitlebarBackingElement {
    role: &'static str,
    rect: Option<PhysicalRect>,
    hidden: bool,
    expected_hidden: bool,
    painted_by_owner: bool,
    owner_below_buttons: bool,
    hidden_matches_window_key: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTitlebarOwnerState {
    installed: bool,
    identity: Option<String>,
    draw_owner_count: usize,
    target_sequence: u64,
    applied_target_sequence: u64,
    draw_sequence: u64,
    mutation_sequence: u64,
    applying: bool,
    last_apply_ok: bool,
    last_apply_error: Option<String>,
    window_visible: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTitlebarState {
    schema_version: u8,
    kind: &'static str,
    window: String,
    sequence: u64,
    coordinate_contract: &'static str,
    css_to_physical_scale: f64,
    viewport_physical: PhysicalSize,
    buttons: Vec<NativeTitlebarElement>,
    declared_buttons: Vec<NativeTitlebarDeclaredElement>,
    backings: Vec<NativeTitlebarBackingElement>,
    window_key: bool,
    backing_hidden_contract: bool,
    owner: NativeTitlebarOwnerState,
}

/// AppKit backing 좌표(좌하단 원점)를 DOM이 쓰는 viewport 좌상단 물리 좌표로 바꾼다.
/// 입력 둘은 이미 같은 backing 좌표계여야 하며, 이 단계에는 반올림이나 보정값이 없다.
#[cfg(target_os = "macos")]
fn viewport_top_left_rect(rect: PhysicalRect, viewport: PhysicalRect) -> PhysicalRect {
    PhysicalRect::new(
        rect.x - viewport.x,
        viewport.y + viewport.h - (rect.y + rect.h),
        rect.w,
        rect.h,
    )
}

#[cfg(target_os = "macos")]
unsafe fn physical_rect_in_viewport(view: &NSView, viewport: &NSView) -> PhysicalRect {
    // frame은 superview 좌표, bounds는 자기 좌표다. 공개 장부의 모든 요소는 frame을 그 frame의
    // 소유 좌표계에서 viewport로 변환한다. 자기 bounds를 변환하면 frame origin을 잃는다.
    let in_viewport = match view.superview() {
        Some(superview) => superview.convertRect_toView(view.frame(), Some(viewport)),
        None => view.convertRect_toView(view.bounds(), Some(viewport)),
    };
    let backing = viewport.convertRectToBacking(in_viewport);
    let viewport_backing = viewport.convertRectToBacking(viewport.bounds());
    viewport_top_left_rect(
        PhysicalRect::from_ns(backing),
        PhysicalRect::from_ns(viewport_backing),
    )
}

#[cfg(target_os = "macos")]
fn appkit_origin_y_delta(
    current_button_physical: PhysicalRect,
    titlebar_css: PhysicalRect,
    backing_scale: f64,
    css_to_physical_scale: f64,
) -> Option<f64> {
    if !current_button_physical.is_finite_positive()
        || !titlebar_css.is_finite_positive()
        || !backing_scale.is_finite()
        || backing_scale <= 0.0
        || !css_to_physical_scale.is_finite()
        || css_to_physical_scale <= 0.0
    {
        return None;
    }
    let current_center = current_button_physical.y + (current_button_physical.h / 2.0);
    let target_center = (titlebar_css.y + (titlebar_css.h / 2.0)) * css_to_physical_scale;
    // 공개 좌표는 y-down physical px, AppKit frame origin은 y-up point다.
    Some((current_center - target_center) / backing_scale)
}

#[cfg(target_os = "macos")]
fn next_sequence(current: u64, label: &str) -> Result<u64, String> {
    current
        .checked_add(1)
        .ok_or_else(|| format!("titlebar composition sequence exhausted: {label}"))
}

#[cfg(target_os = "macos")]
fn next_owner_generation(label: &str) -> Result<u64, String> {
    NEXT_OWNER_GENERATION
        .fetch_update(
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
            |current| current.checked_add(1),
        )
        .map_err(|_| format!("titlebar owner generation exhausted: {label}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn forget_window<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    let label = window.label();
    // Remove the registry borrow before calling AppKit. removeFromSuperview may synchronously
    // enter drawing/layout callbacks, and those callbacks are allowed to inspect the registry.
    let owner = COMPOSITION_DRAW_OWNERS.with(|owners| {
        let matches_window = owners
            .borrow()
            .get(label)
            .and_then(|entry| entry.owner.window())
            .is_some_and(|owner_window| std::ptr::eq(&*owner_window, pointer as *const NSWindow));
        matches_window
            .then(|| owners.borrow_mut().remove(label))
            .flatten()
    });
    if let Some(entry) = owner {
        let center = NSNotificationCenter::defaultCenter();
        for observer in entry.native_layout_observers {
            let observer: &ProtocolObject<dyn NSObjectProtocol> = &observer;
            unsafe { center.removeObserver(observer.as_ref()) };
        }
        entry.owner.removeFromSuperview();
    }
}

#[cfg(target_os = "macos")]
fn existing_draw_owner(label: &str) -> Option<Retained<TitlebarCompositionDrawOwner>> {
    COMPOSITION_DRAW_OWNERS.with(|owners| owners.borrow().get(label).map(|entry| entry.owner.clone()))
}

#[cfg(target_os = "macos")]
unsafe fn apply_registered_owner_from_native_layout(label: &str) {
    let Some(owner) = existing_draw_owner(label) else {
        return;
    };
    if owner.ivars().applying.get() {
        return;
    }
    let target = owner
        .ivars()
        .target
        .get()
        .map(|target| (target, owner.ivars().target_sequence.get()));
    let _ = apply_owner_now(&owner, target, true);
}

#[cfg(target_os = "macos")]
unsafe fn install_native_layout_observers(
    label: &str,
    buttons: &[Retained<NSButton>; 3],
) -> Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>> {
    let mut views: Vec<Retained<NSView>> = buttons
        .iter()
        .map(|button| button.clone().into_super().into_super())
        .collect();
    for button in buttons {
        let mut ancestor = button.superview();
        for _ in 0..2 {
            let Some(view) = ancestor else { break };
            if !views.iter().any(|known| std::ptr::eq(&**known, &*view)) {
                views.push(view.clone());
            }
            ancestor = view.superview();
        }
    }
    let center = NSNotificationCenter::defaultCenter();
    views
        .into_iter()
        .map(|view| {
            view.setPostsFrameChangedNotifications(true);
            let label = label.to_string();
            let block = block2::RcBlock::new(move |_note: std::ptr::NonNull<NSNotification>| {
                unsafe { apply_registered_owner_from_native_layout(&label) };
            });
            center.addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSViewFrameDidChangeNotification),
                Some(&view),
                None,
                &block,
            )
        })
        .collect()
}

#[cfg(target_os = "macos")]
unsafe fn traffic_light_parent(
    buttons: &[Retained<NSButton>; 3],
) -> Result<Retained<NSView>, String> {
    let parent = buttons[0]
        .superview()
        .ok_or_else(|| "traffic-light button has no titlebar parent".to_string())?;
    for button in &buttons[1..] {
        let candidate = button
            .superview()
            .ok_or_else(|| "traffic-light button has no titlebar parent".to_string())?;
        if !std::ptr::eq(&*candidate, &*parent) {
            return Err("traffic-light buttons do not share one titlebar parent".to_string());
        }
    }
    Ok(parent)
}

#[cfg(target_os = "macos")]
unsafe fn draw_owner_for_window(
    window: &NSWindow,
    label: &str,
) -> Result<Retained<TitlebarCompositionDrawOwner>, String> {
    let owner = existing_draw_owner(label)
        .ok_or_else(|| format!("titlebar draw owner is not installed: {label}"))?;
    let owner_window = owner
        .window()
        .ok_or_else(|| format!("titlebar draw owner is detached from its window: {label}"))?;
    if !std::ptr::eq(&*owner_window, window) {
        return Err(format!(
            "titlebar draw owner belongs to another window: {label}"
        ));
    }
    let buttons = traffic_light_buttons(window)?;
    let titlebar_parent = traffic_light_parent(&buttons)?;
    let owner_parent = owner
        .superview()
        .ok_or_else(|| format!("titlebar draw owner is detached from its titlebar parent: {label}"))?;
    if !std::ptr::eq(&*owner_parent, &*titlebar_parent) {
        return Err(format!(
            "titlebar draw owner belongs to another titlebar parent: {label}"
        ));
    }
    Ok(owner)
}

#[cfg(target_os = "macos")]
unsafe fn allocate_draw_owner(
    label: &str,
    declared_button_origin_x: [f64; 3],
    buttons: &[Retained<NSButton>; 3],
) -> Result<Retained<TitlebarCompositionDrawOwner>, String> {
    let titlebar_parent = traffic_light_parent(buttons)?;
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "titlebar draw owner must be installed on the main thread".to_string())?;
    let generation = next_owner_generation(label)?;
    let allocated =
        mtm.alloc::<TitlebarCompositionDrawOwner>()
            .set_ivars(TitlebarCompositionDrawOwnerIvars {
                label: label.to_string(),
                generation,
                declared_button_origin_x: std::cell::Cell::new(Some(declared_button_origin_x)),
                target: std::cell::Cell::new(None),
                target_sequence: std::cell::Cell::new(0),
                applied_target_sequence: std::cell::Cell::new(0),
                draw_sequence: std::cell::Cell::new(0),
                mutation_sequence: std::cell::Cell::new(0),
                applying: std::cell::Cell::new(false),
                last_apply_ok: std::cell::Cell::new(false),
                last_apply_error: std::cell::RefCell::new(None),
                backing_color: std::cell::Cell::new(None),
            });
    let owner: Retained<TitlebarCompositionDrawOwner> =
        msg_send![super(allocated), initWithFrame: titlebar_parent.bounds()];
    owner.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    owner.setWantsLayer(false);
    owner.setCanDrawConcurrently(false);
    // One paint owner supplies all three inactive backings. It is the only custom sibling below
    // the standard buttons, so AppKit has no independently moving backing views to reorder.
    titlebar_parent.addSubview_positioned_relativeTo(
        &owner,
        NSWindowOrderingMode::Below,
        Some(&buttons[0]),
    );
    Ok(owner)
}

#[cfg(target_os = "macos")]
fn record_apply_result(
    owner: &TitlebarCompositionDrawOwner,
    target_sequence: Option<u64>,
    result: &Result<bool, String>,
) {
    let ivars = owner.ivars();
    match result {
        Ok(changed) => {
            *ivars.last_apply_error.borrow_mut() = None;
            if *changed {
                ivars
                    .mutation_sequence
                    .set(ivars.mutation_sequence.get().saturating_add(1));
            }
            if let Some(sequence) = target_sequence {
                ivars.applied_target_sequence.set(sequence);
                ivars.last_apply_ok.set(true);
            }
        }
        Err(error) => {
            ivars.last_apply_ok.set(false);
            *ivars.last_apply_error.borrow_mut() = Some(error.clone());
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn apply_owner_now(
    owner: &TitlebarCompositionDrawOwner,
    target: Option<(CompositionTarget, u64)>,
    allow_hierarchy_repair: bool,
) -> Result<(), String> {
    let ivars = owner.ivars();
    if ivars.applying.replace(true) {
        return Err(format!(
            "titlebar composition re-entered for {}",
            ivars.label
        ));
    }
    let _guard = ApplyingGuard(&ivars.applying);
    let result = apply_owner_body(owner, target, allow_hierarchy_repair);
    record_apply_result(owner, target.map(|(_, sequence)| sequence), &result);
    if result? {
        owner.setNeedsDisplay(true);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn draw_owner_count(parent: &NSView) -> usize {
    parent
        .subviews()
        .iter()
        .filter(|view| {
            view.clone()
                .downcast::<TitlebarCompositionDrawOwner>()
                .is_ok()
        })
        .count()
}

#[cfg(target_os = "macos")]
fn owner_below_all_buttons(
    parent: &NSView,
    owner: &TitlebarCompositionDrawOwner,
    buttons: [&NSView; 3],
) -> bool {
    let subviews = parent.subviews();
    let owner_index = subviews
        .iter()
        .position(|candidate| {
            Retained::as_ptr(&candidate)
                == owner as *const TitlebarCompositionDrawOwner as *const NSView
        });
    let button_indices = buttons.map(|button| {
        subviews
            .iter()
            .position(|candidate| Retained::as_ptr(&candidate) == button as *const NSView)
    });
    owner_below_indices(owner_index, button_indices)
}

#[cfg(target_os = "macos")]
fn owner_below_indices(owner: Option<usize>, buttons: [Option<usize>; 3]) -> bool {
    owner.is_some_and(|owner| {
        buttons
            .into_iter()
            .all(|button| button.is_some_and(|button| owner < button))
    })
}

#[cfg(target_os = "macos")]
unsafe fn draw_owned_backings(owner: &TitlebarCompositionDrawOwner) {
    let Some(window) = owner.window() else { return };
    if window.isKeyWindow() {
        return;
    }
    let Ok(buttons) = traffic_light_buttons(&window) else { return };
    let Some(parent) = owner.superview() else { return };
    let color = match owner.ivars().backing_color.get() {
        Some(color) => NSColor::colorWithSRGBRed_green_blue_alpha(color.r, color.g, color.b, 1.0),
        None => NSColor::windowBackgroundColor(),
    };
    color.setFill();
    for button in buttons {
        let frame = parent.convertRect_toView(NSView::frame(&button), Some(owner));
        NSBezierPath::bezierPathWithOvalInRect(frame).fill();
    }
}

#[cfg(target_os = "macos")]
fn center_rect_on_declared_titlebar(
    mut rect: PhysicalRect,
    titlebar_css: PhysicalRect,
    css_to_physical_scale: f64,
) -> Option<PhysicalRect> {
    if !rect.is_finite_positive()
        || !titlebar_css.is_finite_positive()
        || !css_to_physical_scale.is_finite()
        || css_to_physical_scale <= 0.0
    {
        return None;
    }
    rect.y = (titlebar_css.y + (titlebar_css.h / 2.0)) * css_to_physical_scale - (rect.h / 2.0);
    rect.is_finite_positive().then_some(rect)
}

#[cfg(target_os = "macos")]
fn backing_hidden_matches_window_key(
    painted_by_owner: bool,
    hidden: bool,
    window_key: bool,
) -> bool {
    painted_by_owner && hidden == window_key
}

#[cfg(target_os = "macos")]
unsafe fn declared_button_target_rect(
    button: &NSView,
    viewport: &NSView,
    target: CompositionTarget,
    role_index: usize,
    css_to_physical_scale: f64,
) -> Option<PhysicalRect> {
    if !css_to_physical_scale.is_finite() || css_to_physical_scale <= 0.0 {
        return None;
    }
    let superview = button.superview()?;
    let mut frame = NSView::frame(button);
    frame.origin.x = target.button_origin_x[role_index];
    let in_viewport = superview.convertRect_toView(frame, Some(viewport));
    let backing = viewport.convertRectToBacking(in_viewport);
    let viewport_backing = viewport.convertRectToBacking(viewport.bounds());
    let rect = viewport_top_left_rect(
        PhysicalRect::from_ns(backing),
        PhysicalRect::from_ns(viewport_backing),
    );
    center_rect_on_declared_titlebar(rect, target.titlebar_css, css_to_physical_scale)
}

#[cfg(target_os = "macos")]
unsafe fn native_element(
    role: &'static str,
    view: Option<&NSView>,
    viewport: &NSView,
) -> NativeTitlebarElement {
    NativeTitlebarElement {
        role,
        rect: view.map(|view| physical_rect_in_viewport(view, viewport)),
        hidden: view.is_none_or(|view| view.isHiddenOrHasHiddenAncestor()),
    }
}

#[cfg(target_os = "macos")]
unsafe fn native_backing_element(
    role: &'static str,
    button: Option<&NSView>,
    viewport: &NSView,
    owner_installed: bool,
    owner_below_buttons: bool,
    window_key: bool,
) -> NativeTitlebarBackingElement {
    let painted_by_owner = owner_installed && owner_below_buttons && button.is_some();
    let hidden = window_key || !painted_by_owner;
    let hidden_matches_window_key =
        backing_hidden_matches_window_key(painted_by_owner, hidden, window_key);
    NativeTitlebarBackingElement {
        role,
        rect: button.map(|button| physical_rect_in_viewport(button, viewport)),
        hidden,
        expected_hidden: window_key,
        painted_by_owner,
        owner_below_buttons,
        hidden_matches_window_key,
    }
}

#[cfg(target_os = "macos")]
unsafe fn read_native_state(
    window: &NSWindow,
    viewport: &NSView,
    label: String,
    css_to_physical_scale: f64,
) -> NativeTitlebarState {
    let definitions = [
        ("close", NSWindowButton::CloseButton),
        ("minimize", NSWindowButton::MiniaturizeButton),
        ("zoom", NSWindowButton::ZoomButton),
    ];
    let mut buttons = Vec::with_capacity(definitions.len());
    let mut declared_buttons = Vec::with_capacity(definitions.len());
    let mut backings = Vec::with_capacity(definitions.len());
    let native_buttons = traffic_light_buttons(window).ok();
    let titlebar_parent = native_buttons
        .as_ref()
        .and_then(|buttons| traffic_light_parent(buttons).ok());
    let owner_count = titlebar_parent
        .as_ref()
        .map_or(0, |parent| draw_owner_count(parent));
    let owner = existing_draw_owner(&label).filter(|owner| {
        let same_window = owner
            .window()
            .is_some_and(|owner_window| std::ptr::eq(&*owner_window, window));
        let same_titlebar_parent = owner.superview().zip(titlebar_parent.as_ref()).is_some_and(
            |(superview, parent)| Retained::as_ptr(&superview) == Retained::as_ptr(parent),
        );
        same_window && same_titlebar_parent
    });
    let declared_target = owner.as_ref().and_then(|owner| owner.ivars().target.get());
    let window_key = window.isKeyWindow();
    let owner_below_buttons = owner
        .as_ref()
        .zip(titlebar_parent.as_ref())
        .zip(native_buttons.as_ref())
        .is_some_and(|((owner, parent), buttons)| {
            owner_below_all_buttons(parent, owner, [&buttons[0], &buttons[1], &buttons[2]])
        });
    for (index, (role, kind)) in definitions.into_iter().enumerate() {
        let button = window.standardWindowButton(kind);
        let button_view: Option<&NSView> = button.as_ref().map(|button| {
            let view: &NSView = button;
            view
        });
        buttons.push(native_element(role, button_view, viewport));
        declared_buttons.push(NativeTitlebarDeclaredElement {
            role,
            rect: button_view
                .zip(declared_target)
                .and_then(|(button, target)| {
                    declared_button_target_rect(
                        button,
                        viewport,
                        target,
                        index,
                        css_to_physical_scale,
                    )
                }),
        });
        backings.push(native_backing_element(
            role,
            button_view,
            viewport,
            owner.is_some(),
            owner_below_buttons,
            window_key,
        ));
    }
    let viewport_backing = viewport.convertRectToBacking(viewport.bounds());
    let owner_state = owner.as_ref().map(|owner| {
        let ivars = owner.ivars();
        NativeTitlebarOwnerState {
            installed: true,
            identity: Some(format!("{}#{}", ivars.label, ivars.generation)),
            draw_owner_count: owner_count,
            target_sequence: ivars.target_sequence.get(),
            applied_target_sequence: ivars.applied_target_sequence.get(),
            draw_sequence: ivars.draw_sequence.get(),
            mutation_sequence: ivars.mutation_sequence.get(),
            applying: ivars.applying.get(),
            last_apply_ok: ivars.last_apply_ok.get(),
            last_apply_error: ivars.last_apply_error.borrow().clone(),
            window_visible: window.isVisible(),
        }
    });
    NativeTitlebarState {
        schema_version: 3,
        kind: "tauri-titlebar-native-state",
        window: label,
        sequence: owner_state
            .as_ref()
            .map(|state| state.target_sequence)
            .unwrap_or(0),
        coordinate_contract: "physical px, viewport top-left",
        css_to_physical_scale,
        viewport_physical: PhysicalSize {
            w: viewport_backing.size.width,
            h: viewport_backing.size.height,
        },
        buttons,
        declared_buttons,
        backing_hidden_contract: backings
            .iter()
            .all(|backing| backing.painted_by_owner && backing.hidden_matches_window_key),
        backings,
        window_key,
        owner: owner_state.unwrap_or(NativeTitlebarOwnerState {
            installed: false,
            identity: None,
            draw_owner_count: owner_count,
            target_sequence: 0,
            applied_target_sequence: 0,
            draw_sequence: 0,
            mutation_sequence: 0,
            applying: false,
            last_apply_ok: false,
            last_apply_error: None,
            window_visible: window.isVisible(),
        }),
    }
}

#[cfg(target_os = "macos")]
fn composition_target(
    titlebar_physical: PhysicalRect,
    expected_css_to_physical_scale: f64,
    actual_css_to_physical_scale: f64,
    backing_scale: f64,
    viewport_physical: PhysicalRect,
    button_origin_x: [f64; 3],
) -> Result<CompositionTarget, String> {
    if !titlebar_physical.is_finite_positive() {
        return Err("titlebarPhysical must be a finite positive physical rect".to_string());
    }
    if !expected_css_to_physical_scale.is_finite()
        || expected_css_to_physical_scale <= 0.0
        || !actual_css_to_physical_scale.is_finite()
        || actual_css_to_physical_scale <= 0.0
        || !backing_scale.is_finite()
        || backing_scale <= 0.0
    {
        return Err("titlebar composition scales must be finite and positive".to_string());
    }
    if (expected_css_to_physical_scale - actual_css_to_physical_scale).abs() > 0.000_001 {
        return Err(format!(
            "titlebar scale changed before composition: expected {expected_css_to_physical_scale}, actual {actual_css_to_physical_scale}"
        ));
    }
    let rounding = 0.5;
    if titlebar_physical.x < -rounding
        || titlebar_physical.y < -rounding
        || titlebar_physical.x + titlebar_physical.w > viewport_physical.w + rounding
        || titlebar_physical.y + titlebar_physical.h > viewport_physical.h + rounding
    {
        return Err("titlebarPhysical must be contained by the native viewport".to_string());
    }
    let window_zoom = actual_css_to_physical_scale / backing_scale;
    if !window_zoom.is_finite() || window_zoom <= 0.0 {
        return Err("derived window zoom must be finite and positive".to_string());
    }
    if !button_origin_x.into_iter().all(f64::is_finite)
        || button_origin_x[1] <= button_origin_x[0]
        || button_origin_x[2] <= button_origin_x[1]
    {
        return Err("traffic-light horizontal origins must be finite and ordered".to_string());
    }
    Ok(CompositionTarget {
        titlebar_css: titlebar_physical.divided_by(expected_css_to_physical_scale),
        window_zoom,
        button_origin_x,
    })
}

#[cfg(target_os = "macos")]
fn traffic_light_buttons(window: &NSWindow) -> Result<[Retained<NSButton>; 3], String> {
    let (Some(close), Some(minimize), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return Err(
            "native window does not expose exactly three traffic-light buttons".to_string(),
        );
    };
    Ok([close, minimize, zoom])
}

#[cfg(target_os = "macos")]
unsafe fn align_buttons_x(buttons: [&NSView; 3], target_x: [f64; 3], backing_scale: f64) -> bool {
    let mut changed = false;
    for (index, button) in buttons.into_iter().enumerate() {
        let mut frame = NSView::frame(button);
        if ((frame.origin.x - target_x[index]) * backing_scale).abs() <= 0.5 {
            continue;
        }
        frame.origin.x = target_x[index];
        button.setFrameOrigin(frame.origin);
        changed = true;
    }
    changed
}

unsafe fn align_buttons_to_target(
    buttons: [&NSView; 3],
    viewport: &NSView,
    target: CompositionTarget,
) -> Result<bool, String> {
    let window = viewport
        .window()
        .ok_or_else(|| "native viewport is detached from its window".to_string())?;
    let backing_scale = window.backingScaleFactor();
    let css_to_physical_scale = backing_scale * target.window_zoom;
    let mut changed = align_buttons_x(buttons, target.button_origin_x, backing_scale);
    for button in buttons {
        let current = physical_rect_in_viewport(button, viewport);
        let Some(delta_y) = appkit_origin_y_delta(
            current,
            target.titlebar_css,
            backing_scale,
            css_to_physical_scale,
        ) else {
            return Err(
                "traffic-light composition geometry is not finite and positive".to_string(),
            );
        };
        let mut frame = NSView::frame(button);
        if (delta_y * backing_scale).abs() > 0.5 {
            frame.origin.y += delta_y;
            button.setFrameOrigin(frame.origin);
            changed = true;
        }
    }
    Ok(changed)
}

#[cfg(target_os = "macos")]
unsafe fn apply_owner_body(
    owner: &TitlebarCompositionDrawOwner,
    target: Option<(CompositionTarget, u64)>,
    allow_hierarchy_repair: bool,
) -> Result<bool, String> {
    let window = owner
        .window()
        .ok_or_else(|| format!("titlebar draw owner is detached: {}", owner.ivars().label))?;
    let viewport = window
        .contentView()
        .ok_or_else(|| "native window does not expose a content viewport".to_string())?;
    let buttons = traffic_light_buttons(&window)?;
    let button_views: [&NSView; 3] = [&buttons[0], &buttons[1], &buttons[2]];
    let mut changed = match target {
        Some((target, _)) => align_buttons_to_target(button_views, &viewport, target)?,
        None => {
            let target_x = owner
                .ivars()
                .declared_button_origin_x
                .get()
                .ok_or_else(|| "titlebar horizontal target is not declared".to_string())?;
            align_buttons_x(button_views, target_x, window.backingScaleFactor())
        }
    };
    let titlebar_parent = traffic_light_parent(&buttons)?;
    if !owner_below_all_buttons(&titlebar_parent, owner, button_views) {
        if !allow_hierarchy_repair {
            return Err("titlebar paint owner is not below all traffic-light buttons".to_string());
        }
        titlebar_parent.addSubview_positioned_relativeTo(
            owner,
            NSWindowOrderingMode::Below,
            Some(&buttons[0]),
        );
        changed = true;
    }
    if !owner_below_all_buttons(&titlebar_parent, owner, button_views) {
        return Err("titlebar paint owner hierarchy repair did not commit".to_string());
    }
    Ok(changed)
}

#[cfg(target_os = "macos")]
unsafe fn apply_registered_owner(label: &str) -> Result<(), String> {
    let owner = existing_draw_owner(label)
        .ok_or_else(|| format!("titlebar draw owner is not installed: {label}"))?;
    let ivars = owner.ivars();
    let target = ivars
        .target
        .get()
        .map(|target| (target, ivars.target_sequence.get()));
    // AppKit may reorder the standard-button hierarchy during a committed window layout. This
    // adapter-owned transaction restores the button target and the one paint owner's z-order.
    apply_owner_now(&owner, target, true)
}

/// Validate the renderer's exact owner/sequence receipt, restore the committed target, and flush
/// AppKit layout/display before the startup gate is allowed to reveal the window.
#[cfg(target_os = "macos")]
pub(crate) unsafe fn prepare_startup_presentation(
    window: &NSWindow,
    label: &str,
    expected_owner_identity: &str,
    expected_sequence: u64,
) -> Result<u64, String> {
    let owner = draw_owner_for_window(window, label)?;
    let ivars = owner.ivars();
    let actual_identity = format!("{}#{}", ivars.label, ivars.generation);
    if actual_identity != expected_owner_identity {
        return Err(format!(
            "startup titlebar owner generation changed for {label}: expected {expected_owner_identity}, got {actual_identity}"
        ));
    }
    let actual_sequence = ivars.target_sequence.get();
    if expected_sequence == 0 || actual_sequence != expected_sequence {
        return Err(format!(
            "startup titlebar sequence is stale for {label}: expected {expected_sequence}, got {actual_sequence}"
        ));
    }
    if ivars.applied_target_sequence.get() != actual_sequence
        || ivars.applying.get()
        || !ivars.last_apply_ok.get()
    {
        return Err(format!(
            "startup titlebar owner has no committed GREEN target for {label}"
        ));
    }
    let target = ivars
        .target
        .get()
        .ok_or_else(|| format!("startup titlebar target is absent for {label}"))?;
    // orderFront/makeKeyAndOrderFront may rebuild AppKit's titlebar hierarchy. Finish that native
    // layout first; applying before it would invalidate the committed button/owner transaction.
    window.layoutIfNeeded();
    // Startup presentation restores the button target and the one paint owner before display.
    apply_owner_now(&owner, Some((target, actual_sequence)), true)?;
    if let Some(viewport) = window.contentView() {
        viewport.setNeedsDisplay(true);
    }
    window.displayIfNeeded();
    if ivars.target_sequence.get() != actual_sequence
        || ivars.applied_target_sequence.get() != actual_sequence
        || ivars.applying.get()
        || !ivars.last_apply_ok.get()
    {
        return Err(format!(
            "startup titlebar target changed during presentation flush for {label}"
        ));
    }
    Ok(actual_sequence)
}

#[cfg(target_os = "macos")]
unsafe fn install_draw_owner(
    window: &NSWindow,
    label: &str,
    declared_origin_x: Option<f64>,
) -> Result<(), String> {
    if existing_draw_owner(label).is_some() {
        let owner = draw_owner_for_window(window, label)?;
        if let Some(declared_x) = declared_origin_x {
            if !declared_x.is_finite() || declared_x < 0.0 {
                return Err("declared traffic-light horizontal geometry is invalid".to_string());
            }
            let installed_x = owner
                .ivars()
                .declared_button_origin_x
                .get()
                .ok_or_else(|| "titlebar horizontal target is not declared".to_string())?[0];
            let tolerance = 0.5 / window.backingScaleFactor();
            if (declared_x - installed_x).abs() > tolerance {
                return Err(format!(
                    "titlebar draw owner horizontal declaration changed for {label}"
                ));
            }
        }
        if owner.ivars().target.get().is_none() {
            apply_owner_now(&owner, None, true)?;
        }
        return Ok(());
    }

    // Validate the complete immutable declaration before attaching or publishing an owner. A
    // failed install must not leave a half-owner that a later read mistakes for a live generation.
    let buttons = traffic_light_buttons(window)?;
    let current_x = [
        buttons[0].frame().origin.x,
        buttons[1].frame().origin.x,
        buttons[2].frame().origin.x,
    ];
    let first_x = declared_origin_x.unwrap_or(current_x[0]);
    let spacing = current_x[1] - current_x[0];
    let declared = [first_x, first_x + spacing, first_x + (spacing * 2.0)];
    if !first_x.is_finite() || first_x < 0.0 || !spacing.is_finite() || spacing <= 0.0 {
        return Err("declared traffic-light horizontal geometry is invalid".to_string());
    }
    let backing_scale = window.backingScaleFactor();
    if !backing_scale.is_finite() || backing_scale <= 0.0 {
        return Err("titlebar backing scale must be finite and positive".to_string());
    }

    let owner = allocate_draw_owner(label, declared, &buttons)?;
    if let Err(error) = apply_owner_now(&owner, None, true) {
        owner.removeFromSuperview();
        return Err(error);
    }
    COMPOSITION_DRAW_OWNERS.with(|owners| {
        owners.borrow_mut().insert(
            label.to_string(),
            TitlebarCompositionOwnerEntry {
                owner: owner.clone(),
                native_layout_observers: Vec::new(),
            },
        );
    });
    let native_layout_observers = install_native_layout_observers(label, &buttons);
    COMPOSITION_DRAW_OWNERS.with(|owners| {
        if let Some(entry) = owners.borrow_mut().get_mut(label) {
            entry.native_layout_observers = native_layout_observers;
        }
    });
    Ok(())
}

/// DidResize transaction hook. The AppKit resize owner calls this before its single display commit,
/// so traffic lights, DOM WKWebView and child native surfaces are painted from one geometry epoch.
#[cfg(target_os = "macos")]
pub(crate) fn recompose_from_appkit_resize(window: &NSWindow, label: &str) {
    let Some(owner) = existing_draw_owner(label) else {
        return;
    };
    let Some(owner_window) = owner.window() else {
        return;
    };
    if !std::ptr::eq(&*owner_window, window) {
        return;
    }
    unsafe {
        let _ = apply_registered_owner(label);
    }
}

/// macOS에만 등록되는 AppKit 사실면. 비 macOS에는 명령 자체가 존재하지 않는다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn titlebar_native_state(window: tauri::Window) -> Result<NativeTitlebarState, String> {
    let label = window.label().to_owned();
    let window_zoom = crate::webview::window_zoom_for_adapter(&label);
    let query_window = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = (|| unsafe {
                let ns_window = query_window
                    .ns_window()
                    .map(|pointer| &*(pointer as *const NSWindow))
                    .map_err(|error| error.to_string())?;
                let viewport = query_window
                    .ns_view()
                    .map(|pointer| &*(pointer as *const NSView))
                    .map_err(|error| error.to_string())?;
                let css_to_physical_scale = ns_window.backingScaleFactor() * window_zoom;
                Ok(read_native_state(
                    ns_window,
                    viewport,
                    label,
                    css_to_physical_scale,
                ))
            })();
            let _ = tx.send(result);
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(1), rx)
        .await
        .map_err(|_| "titlebar native state ACK timeout".to_string())?
        .map_err(|error| format!("titlebar native state ACK 실패: {error}"))?
}

/// 공개 DOM titlebar 목표를 AppKit 버튼 3개에 한 번 합성하고 같은 메인스레드 거래의 readback을
/// 영수증으로 돌려준다. 입력 scale은 직전 read-only 사실면과 같은 epoch인지 검증하는 낙관적 잠금이다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn titlebar_compose(
    window: tauri::Window,
    titlebar_physical: PhysicalRect,
    css_to_physical_scale: f64,
    expected_owner_identity: String,
    expected_sequence: u64,
) -> Result<NativeTitlebarState, String> {
    let label = window.label().to_owned();
    if label.is_empty() {
        return Err("titlebar composition requires a non-empty window label".to_string());
    }
    let window_zoom = crate::webview::window_zoom_for_adapter(&label);
    let compose_window = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = (|| unsafe {
                let ns_window = compose_window
                    .ns_window()
                    .map(|pointer| &*(pointer as *const NSWindow))
                    .map_err(|error| error.to_string())?;
                let viewport = compose_window
                    .ns_view()
                    .map(|pointer| &*(pointer as *const NSView))
                    .map_err(|error| error.to_string())?;
                let backing_scale = ns_window.backingScaleFactor();
                let actual_scale = backing_scale * window_zoom;
                let viewport_backing = viewport.convertRectToBacking(viewport.bounds());
                let owner = draw_owner_for_window(ns_window, &label)?;
                let actual_owner_identity = format!(
                    "{}#{}",
                    owner.ivars().label,
                    owner.ivars().generation,
                );
                if actual_owner_identity != expected_owner_identity {
                    return Err(format!(
                        "titlebar compose owner generation changed for {label}: expected {expected_owner_identity}, got {actual_owner_identity}"
                    ));
                }
                let actual_sequence = owner.ivars().target_sequence.get();
                if actual_sequence != expected_sequence {
                    return Err(format!(
                        "titlebar compose sequence changed before mutation for {label}: expected {expected_sequence}, got {actual_sequence}"
                    ));
                }
                let button_origin_x = owner
                    .ivars()
                    .declared_button_origin_x
                    .get()
                    .ok_or_else(|| "titlebar horizontal target is not declared".to_string())?;
                let target = composition_target(
                    titlebar_physical,
                    css_to_physical_scale,
                    actual_scale,
                    backing_scale,
                    PhysicalRect::from_ns(viewport_backing),
                    button_origin_x,
                )?;
                let sequence = next_sequence(expected_sequence, &label)?;
                apply_owner_now(&owner, Some((target, sequence)), true)?;
                owner.ivars().target.set(Some(target));
                owner.ivars().target_sequence.set(sequence);
                Ok(read_native_state(
                    ns_window,
                    viewport,
                    label,
                    actual_scale,
                ))
            })();
            let _ = tx.send(result);
        })
        .map_err(|error| error.to_string())?;
    rx.await
        .map_err(|error| format!("titlebar compose main-thread ACK failed: {error}"))?
}

// 프런트 테마 적용 시 호출 — 창별 paint owner의 백킹 색 동기화 + 즉시 redraw.
#[tauri::command]
pub async fn titlebar_backing(window: tauri::Window, r: f64, g: f64, b: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let color = BackingColor::new(r, g, b)?;
        let label = window.label().to_owned();
        let win = window.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let result = (|| unsafe {
                    let ptr = win.ns_window().map_err(|error| error.to_string())?;
                    let ns = &*(ptr as *const NSWindow);
                    let owner = draw_owner_for_window(ns, &label)?;
                    owner.ivars().backing_color.set(Some(color));
                    owner.setNeedsDisplay(true);
                    let target = owner
                        .ivars()
                        .target
                        .get()
                        .map(|target| (target, owner.ivars().target_sequence.get()));
                    apply_owner_now(&owner, target, true)
                })();
                let _ = tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        return rx
            .await
            .map_err(|error| format!("titlebar backing main-thread ACK failed: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, r, g, b);
        Ok(())
    }
}

// 창 생성 시 단일 draw owner를 설치한다. 목표는 renderer가 공개 DOM rect로 명시한다.
#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    declared_origin_x: Option<f64>,
) -> Result<(), String> {
    MainThreadMarker::new()
        .ok_or_else(|| "titlebar draw owner installation requires the main thread".to_string())?;
    let label = window.label().to_owned();
    let ptr = window.ns_window().map_err(|error| error.to_string())?;
    let ns = unsafe { &*(ptr as *const NSWindow) };
    unsafe { install_draw_owner(ns, &label, declared_origin_x) }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn production_source() -> &'static str {
        include_str!("titlebar.rs")
            .split_once("#[cfg(all(test, target_os = \"macos\"))]")
            .expect("production/test boundary")
            .0
    }

    fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        source
            .split_once(start)
            .unwrap_or_else(|| panic!("missing source start: {start}"))
            .1
            .split_once(end)
            .unwrap_or_else(|| panic!("missing source end: {end}"))
            .0
    }

    #[test]
    fn appkit_bottom_left_rect_is_projected_to_viewport_top_left_physical_pixels() {
        let viewport = PhysicalRect::new(10.0, 20.0, 1600.0, 1200.0);
        let appkit = PhysicalRect::new(34.0, 1162.0, 28.0, 28.0);
        assert_eq!(
            viewport_top_left_rect(appkit, viewport),
            PhysicalRect::new(24.0, 30.0, 28.0, 28.0),
        );
    }

    #[test]
    fn declared_button_rect_is_centered_in_the_declared_titlebar_coordinate_space() {
        let horizontal_projection = PhysicalRect::new(24.0, 999.0, 28.0, 28.0);
        let titlebar_css = PhysicalRect::new(0.0, 0.0, 800.0, 45.0);

        assert_eq!(
            center_rect_on_declared_titlebar(horizontal_projection, titlebar_css, 2.0),
            Some(PhysicalRect::new(24.0, 31.0, 28.0, 28.0)),
        );
        assert_eq!(
            center_rect_on_declared_titlebar(horizontal_projection, titlebar_css, 0.0),
            None,
        );
    }

    #[test]
    fn one_paint_owner_must_be_below_all_three_buttons() {
        assert!(owner_below_indices(Some(2), [Some(3), Some(4), Some(5)]));
        assert!(!owner_below_indices(Some(4), [Some(3), Some(5), Some(6)]));
        assert!(!owner_below_indices(None, [Some(3), Some(4), Some(5)]));
        assert!(!owner_below_indices(Some(2), [Some(3), None, Some(5)]));
    }

    #[test]
    fn owner_painted_backing_visibility_mirrors_window_key_state() {
        assert!(backing_hidden_matches_window_key(true, true, true));
        assert!(backing_hidden_matches_window_key(true, false, false));
        assert!(!backing_hidden_matches_window_key(false, false, false));
        assert!(!backing_hidden_matches_window_key(true, false, true));
    }

    #[test]
    fn native_observability_serializes_additive_machine_facts_in_camel_case() {
        let rect = PhysicalRect::new(24.0, 31.0, 28.0, 28.0);
        let state = NativeTitlebarState {
            schema_version: 3,
            kind: "tauri-titlebar-native-state",
            window: "main".to_string(),
            sequence: 1,
            coordinate_contract: "physical px, viewport top-left",
            css_to_physical_scale: 2.0,
            viewport_physical: PhysicalSize {
                w: 1600.0,
                h: 1200.0,
            },
            buttons: vec![NativeTitlebarElement {
                role: "close",
                rect: Some(rect),
                hidden: false,
            }],
            declared_buttons: vec![NativeTitlebarDeclaredElement {
                role: "close",
                rect: Some(rect),
            }],
            backings: vec![NativeTitlebarBackingElement {
                role: "close",
                rect: Some(rect),
                hidden: false,
                expected_hidden: false,
                painted_by_owner: true,
                owner_below_buttons: true,
                hidden_matches_window_key: true,
            }],
            window_key: false,
            backing_hidden_contract: true,
            owner: NativeTitlebarOwnerState {
                installed: true,
                identity: Some("main#1".to_string()),
                draw_owner_count: 1,
                target_sequence: 1,
                applied_target_sequence: 1,
                draw_sequence: 1,
                mutation_sequence: 1,
                applying: false,
                last_apply_ok: true,
                last_apply_error: None,
                window_visible: false,
            },
        };

        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["declaredButtons"][0]["rect"]["x"], 24.0);
        assert_eq!(value["owner"]["drawOwnerCount"], 1);
        assert_eq!(value["windowKey"], false);
        assert_eq!(value["backingHiddenContract"], true);
        assert_eq!(value["backings"][0]["paintedByOwner"], true);
        assert_eq!(value["backings"][0]["ownerBelowButtons"], true);
        assert_eq!(value["backings"][0]["expectedHidden"], false);
        assert_eq!(value["backings"][0]["hiddenMatchesWindowKey"], true);
    }

    #[test]
    fn workspace_button_center_is_moved_to_the_dom_titlebar_center_without_tolerance() {
        let current_button = PhysicalRect::new(14.0, 12.0, 28.0, 32.0);
        let titlebar_css = PhysicalRect::new(0.0, 0.0, 900.0, 45.0);
        let delta = appkit_origin_y_delta(current_button, titlebar_css, 2.0, 2.0).unwrap();

        assert_eq!(delta, -8.5);
        assert_eq!(
            current_button.y - (delta * 2.0) + (current_button.h / 2.0),
            45.0,
        );
    }

    #[test]
    fn every_supported_titlebar_height_centers_the_button_in_the_same_coordinate_contract() {
        let current_button = PhysicalRect::new(14.0, 12.0, 28.0, 32.0);
        for (height_css, css_to_physical_scale, backing_scale) in [
            (32.0, 1.0, 1.0),
            (45.0, 2.0, 2.0),
            (60.0, 1.5, 2.0),
            (90.0, 2.0, 2.0),
        ] {
            let titlebar = PhysicalRect::new(0.0, 0.0, 900.0, height_css);
            let delta = appkit_origin_y_delta(
                current_button,
                titlebar,
                backing_scale,
                css_to_physical_scale,
            )
            .unwrap();
            let moved_center = current_button.y - (delta * backing_scale)
                + (current_button.h / 2.0);
            let dom_center = height_css * css_to_physical_scale / 2.0;
            assert_eq!(moved_center, dom_center, "height={height_css}");
        }
    }

    #[test]
    fn invalid_composition_scales_are_rejected_instead_of_guessing() {
        let button = PhysicalRect::new(14.0, 12.0, 28.0, 32.0);
        let titlebar = PhysicalRect::new(0.0, 0.0, 900.0, 45.0);

        assert_eq!(appkit_origin_y_delta(button, titlebar, 0.0, 2.0), None);
        assert_eq!(appkit_origin_y_delta(button, titlebar, 2.0, 0.0), None);
    }

    #[test]
    fn compose_input_is_a_viewport_physical_rect_guarded_by_its_read_scale() {
        let target = composition_target(
            PhysicalRect::new(0.0, 0.0, 1_600.0, 90.0),
            2.0,
            2.0,
            2.0,
            PhysicalRect::new(0.0, 0.0, 1_600.0, 1_200.0),
            [12.0, 32.0, 52.0],
        )
        .unwrap();

        assert_eq!(
            target.titlebar_css,
            PhysicalRect::new(0.0, 0.0, 800.0, 45.0)
        );
        assert_eq!(target.window_zoom, 1.0);
        assert_eq!(target.button_origin_x, [12.0, 32.0, 52.0]);
        assert!(composition_target(
            PhysicalRect::new(0.0, 0.0, 1_600.0, 90.0),
            1.0,
            2.0,
            2.0,
            PhysicalRect::new(0.0, 0.0, 1_600.0, 1_200.0),
            [12.0, 32.0, 52.0],
        )
        .is_err());
        assert!(composition_target(
            PhysicalRect::new(0.0, 0.0, 1_601.0, 90.0),
            2.0,
            2.0,
            2.0,
            PhysicalRect::new(0.0, 0.0, 1_600.0, 1_200.0),
            [12.0, 32.0, 52.0],
        )
        .is_err());
        assert!(composition_target(
            PhysicalRect::new(0.0, 0.0, 1_600.0, 90.0),
            2.0,
            2.0,
            2.0,
            PhysicalRect::new(0.0, 0.0, 1_600.0, 1_200.0),
            [12.0, 12.0, 52.0],
        )
        .is_err());
    }

    #[test]
    fn explicit_target_sequence_uses_one_checked_step_and_never_wraps() {
        assert_eq!(next_sequence(0, "main").unwrap(), 1);
        assert_eq!(next_sequence(41, "workspace").unwrap(), 42);
        assert!(next_sequence(u64::MAX, "main").is_err());
    }

    #[test]
    fn native_layout_has_one_owner_and_synchronously_tracks_the_native_layout_graph() {
        let source = production_source();

        assert!(source.contains("struct TitlebarCompositionDrawOwner"));
        assert!(source.contains("method(viewWillDraw)"));
        assert!(source.contains("method(drawRect:)"));
        for required in [
            "NSViewFrameDidChangeNotification",
            "setPostsFrameChangedNotifications(true)",
            "install_native_layout_observers",
            "apply_registered_owner_from_native_layout",
            "native_layout_observers",
            "removeObserver",
        ] {
            assert!(source.contains(required), "missing native layout contract: {required}");
        }
        assert!(
            !source.contains("tokio::time::sleep"),
            "native titlebar correction must be event driven, never delayed polling",
        );
        assert!(
            !source.contains("NSWindowDidUpdateNotification"),
            "post-update correction exposes an intermediate wrong frame",
        );
        let draw = source
            .split_once("fn draw(&self")
            .expect("draw owner callback")
            .1
            .split_once("fn hit_test")
            .expect("draw owner callback end")
            .0;
        assert!(!draw.contains("setNeedsDisplay"));
        assert!(!draw.contains("draw_owner_for_window"));

        let pre_draw = source_between(source, "fn view_will_draw(&self)", "fn draw(&self");
        assert!(
            pre_draw.contains("apply_owner_now(self, target, true)"),
            "AppKit's supported pre-draw mutation hook must restore the complete owned backing hierarchy",
        );
        assert!(
            pre_draw.contains("msg_send![super(self), viewWillDraw]"),
            "the AppKit pre-draw override must preserve NSView's superclass contract",
        );
        let super_call = pre_draw
            .find("msg_send![super(self), viewWillDraw]")
            .expect("super viewWillDraw call");
        let apply = pre_draw
            .find("apply_owner_now(self, target, true)")
            .expect("titlebar composition apply");
        assert!(
            super_call < apply,
            "AppKit must finish superclass layout before the final pre-draw composition apply",
        );

        let allocation = source_between(source, "unsafe fn allocate_draw_owner(", "fn record_apply_result(");
        assert!(
            allocation.contains("let titlebar_parent = traffic_light_parent(buttons)?"),
            "the pre-draw owner must live in the standard buttons' own layout subtree",
        );
        assert!(
            allocation.contains(
                "titlebar_parent.addSubview_positioned_relativeTo(\n        &owner,\n        NSWindowOrderingMode::Below,\n        Some(&buttons[0]),",
            ),
            "the single paint owner must live behind all three standard buttons",
        );
    }

    #[test]
    fn native_state_exposes_declared_geometry_and_exact_hierarchy_contract_facts() {
        let source = production_source();

        for required in [
            "declared_buttons:",
            "draw_owner_count:",
            "window_key:",
            "backing_hidden_contract:",
            "expected_hidden:",
            "painted_by_owner:",
            "owner_below_buttons:",
            "hidden_matches_window_key:",
        ] {
            assert!(source.contains(required), "missing native fact: {required}");
        }
    }

    #[test]
    fn native_state_read_is_observation_only_and_draw_cannot_repair_hierarchy() {
        let source = production_source();
        let read = source_between(
            source,
            "unsafe fn read_native_state(",
            "fn composition_target(",
        );
        let backing_read = source_between(
            source,
            "unsafe fn native_backing_element(",
            "unsafe fn read_native_state(",
        );
        for forbidden in [
            "removeFromSuperview",
            "addSubview_positioned_relativeTo",
            "setFrame",
            "setHidden",
            "setFillColor",
        ] {
            assert!(
                !read.contains(forbidden),
                "read repaired native hierarchy: {forbidden}"
            );
            assert!(
                !backing_read.contains(forbidden),
                "backing observation repaired native hierarchy: {forbidden}"
            );
        }

        let draw = source_between(source, "fn draw(&self", "fn hit_test");
        assert!(draw.contains("apply_owner_body(self, target, false)"));
    }

    #[test]
    fn explicit_backing_apply_repairs_then_validates_one_fixed_hierarchy() {
        let source = production_source();
        assert!(
            !source.contains("NSBox"),
            "three independently laid-out NSBox siblings recreate the native composition race",
        );
        assert!(
            source.contains("draw_owned_backings"),
            "one titlebar owner must paint all three backing regions from the live button frames",
        );
        assert!(
            source.contains("owner_below_all_buttons"),
            "the single paint owner must expose and validate its native z-order",
        );
    }

    #[test]
    fn explicit_startup_and_resize_transactions_repair_appkit_reordered_backings() {
        let source = production_source();
        let startup = source_between(
            source,
            "pub(crate) unsafe fn prepare_startup_presentation(",
            "unsafe fn install_draw_owner(",
        );
        let resize = source_between(
            source,
            "unsafe fn apply_registered_owner(",
            "pub(crate) unsafe fn prepare_startup_presentation(",
        );

        assert!(
            startup.contains("apply_owner_now(&owner, Some((target, actual_sequence)), true)?"),
            "the post-orderFront startup transaction must repair AppKit's reordered backing hierarchy",
        );
        let layout = startup.find("window.layoutIfNeeded()").expect("startup AppKit layout");
        let apply = startup
            .find("apply_owner_now(&owner, Some((target, actual_sequence)), true)?")
            .expect("startup button/owner apply");
        let display = startup.find("window.displayIfNeeded()").expect("startup display commit");
        assert!(
            layout < apply && apply < display,
            "startup must settle AppKit layout before the button/owner apply and display commit",
        );
        assert!(
            resize.contains("apply_owner_now(&owner, target, true)"),
            "the ordered AppKit resize transaction must repair the same paint-owner hierarchy",
        );
    }

    #[test]
    fn mutating_titlebar_commands_never_time_out_before_their_main_thread_ack() {
        let source = production_source();
        let compose = source_between(source, "pub async fn titlebar_compose(", "// 프런트 테마 적용 시 호출");
        let backing = source_between(source, "pub async fn titlebar_backing(", "// 창 생성 시 단일 draw owner");

        for (name, transaction) in [("compose", compose), ("backing", backing)] {
            let compact: String = transaction.split_whitespace().collect();
            assert!(compact.contains("rx.await"), "{name} must await its exact ACK");
            assert!(
                !transaction.contains("tokio::time::timeout"),
                "{name} must not report failure while its queued mutation can still execute",
            );
        }
        assert!(
            backing.contains("owner.setNeedsDisplay(true)"),
            "a backing-color change must invalidate the single paint owner immediately",
        );
    }
}
