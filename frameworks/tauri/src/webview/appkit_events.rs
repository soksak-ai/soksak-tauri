use super::{AppHandle, Manager, Serialize};
use soksak_core::native_surface_ledger::{EventThrottle, NativeWindowLabels};

// NSWindow 포인터 ↔ 창 label 캐시(MW1: 모든 네이티브 이벤트는 어느 창인지 label 로 식별).
//
// AppKit 통지 블록(클릭 모니터·포인터 부재·라이브 리사이즈)은 wry 가 창 맵(RefCell)을
// mutably 빌린 채에도 불린다 — 창 파괴 중 resign-key 가 동기 발화한다. 그 안에서
// Window::ns_window()(메인 스레드 인라인 wry 메시지 → 같은 RefCell 재차용)를 부르면
// 프로세스가 죽는다(실측 백트레이스: install_pointer_absence → ns_window →
// handle_user_message, "RefCell already mutably borrowed" wry lib.rs:3273 —
// 브라우저 하니스의 window.close 가 앱 전체를 죽였다). 그래서 역해소는 창 생성 직후
// (install_window_natives, 이벤트 루프 디스패치 밖 안전 문맥)에 채운 캐시 조회만으로
// 한다 — 통지 블록 안 wry 질의 0 이 이 캐시의 존재 이유다.
#[cfg(target_os = "macos")]
static NSWINDOW_LABELS: std::sync::LazyLock<NativeWindowLabels> =
    std::sync::LazyLock::new(NativeWindowLabels::default);
static MOUSE_MOVE_THROTTLE: std::sync::LazyLock<EventThrottle> =
    std::sync::LazyLock::new(EventThrottle::default);

/// 창 생성 직후(안전 문맥)에서 한 번 — NSWindow 포인터를 label 에 묶는다. 같은 label 재등록은
/// 갱신(멱등). window.reload 로 포인터가 바뀌어도 다음 등록이 걷는다.
#[cfg(target_os = "macos")]
pub fn note_nswindow_label(window: &tauri::Window) {
    if let Ok(ns) = window.ns_window() {
        NSWINDOW_LABELS.register(ns as usize, window.label());
    }
}

/// Destroyed — 그 창의 매핑 회수(포인터 재사용 시 죽은 label 로 오해소하지 않게).
#[cfg(target_os = "macos")]
pub fn forget_nswindow_label(label: &str) {
    NSWINDOW_LABELS.forget(label);
}

// 한 resize epoch의 AppKit 합성을 그 통지 차례 안에서 끝낸다.
//
// NSWindow의 frame만 바꾸고 이벤트 루프로 돌아가면 WindowServer는 다음 display까지 이전
// backing을 새 frame에 맞춰 확대·축소할 수 있다. DOM WKWebView와 네이티브 child surface가
// 섞인 창에서는 그 한 프레임도 서로 다른 좌표 epoch가 된다. 따라서 resize 통지에서 현재
// constraint를 먼저 layout하고, 전체 창을 invalidate한 뒤 즉시 display한다. 이 함수는 AppKit
// 객체만 만지며 wry/Tauri 창 레지스트리를 재진입하지 않는다.
#[cfg(target_os = "macos")]
pub(crate) fn commit_resize_composition(window: &objc2_app_kit::NSWindow) {
    window.layoutIfNeeded();
    if let Some(content) = window.contentView() {
        content.layoutSubtreeIfNeeded();
        content.setNeedsDisplay(true);
    }
    window.setViewsNeedDisplay(true);
    window.displayIfNeeded();
}

// AppKit 통지 블록에서의 이벤트 발행 — 블록 안에서는 wry 로 가는 어떤 호출도 금지다.
// emit_to 조차 eval_script(인라인 wry 메시지 → RefCell 재차용)라, 창 파괴 중 동기 발화된
// 블록에서 부르면 프로세스가 죽는다(실측 백트레이스 2호: install_pointer_absence →
// emit_to → eval_script → handle_user_message, wry lib.rs:3644). 별도 스레드에서 부르면
// proxy 경로로 큐잉되어 다음 이벤트 루프 차례에 실행된다(CloseRequested 지연과 동일 패턴).
// 저빈도 통지 전용 — 순서 민감 경로에 쓰지 않는다.
#[cfg(target_os = "macos")]
fn emit_from_appkit_block<P: serde::Serialize + Clone + Send + 'static>(
    handle: &AppHandle,
    label: Option<String>,
    event: &'static str,
    payload: P,
) {
    let h = handle.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        let _ = match label {
            Some(l) => h.emit_to(&l, event, payload),
            None => h.emit(event, payload),
        };
    });
}

// 네이티브 child webview 위 클릭은 메인 webview DOM 에 도달하지 않아 포커스 추적(activeGroup)이
// 끊긴다. NSEvent 로컬 모니터(앱 전역 1회)로 *모든 창*의 좌클릭을 잡아 {label, 좌표}를 emit 한다 —
// 감지는 네이티브가, 판정(어느 창·그룹)은 레이아웃을 아는 프론트가 소유(자기 창 label 필터 +
// elementFromPoint). 이벤트는 그대로 통과(클릭 동작 불변). MW1/MW4 — 단일 창(main_ptr) 가정 제거.
#[cfg(target_os = "macos")]
pub fn install_click_monitor(app: &AppHandle) {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};

    #[derive(Clone, Serialize)]
    struct ClickPayload {
        x: f64,
        y: f64,
    }

    let handle = app.clone();
    let block = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        unsafe {
            let ev = event.as_ref();
            // Down/Dragged/Up 을 각각 native-mousedown/native-mousemove/native-mouseup 으로 브릿지한다.
            // 왜 3종인가: 네이티브 child(브라우저 등)는 OS 뷰라 그 위의 mousedown/move/up 이 DOM 에 오지
            // 않는다 → 그 위를 지나는 분할 divider 를 드래그로 리사이즈할 수 없다. 좌표를 프론트에 넘겨
            // 프론트가 divider 판정+합성 이벤트로 드래그를 구동하게 한다. 이벤트는 통과(동작 불변).
            // move/up 은 버튼 누른 드래그(LeftMouseDragged) 동안만 흐르므로 IPC 폭주 없음(hover 는 제외).
            let name = match ev.r#type() {
                NSEventType::LeftMouseDown => "native-mousedown",
                NSEventType::LeftMouseDragged => "native-mousemove",
                NSEventType::LeftMouseUp => "native-mouseup",
                // hover(버튼 안 누름) — divider 강조용. 브라우저 위 마우스 이동은 매우 빈번하므로
                // 25ms(~40Hz) 스로틀한다(드래그 Dragged 는 스로틀 없음 — 리사이즈 정밀).
                NSEventType::MouseMoved => {
                    if !MOUSE_MOVE_THROTTLE.allow_every_ms(25) {
                        return event.as_ptr();
                    }
                    "native-mousemove"
                }
                _ => return event.as_ptr(),
            };
            // 모니터 콜백은 메인 스레드에서 호출된다(AppKit 이벤트 루프).
            let Some(mtm) = MainThreadMarker::new() else {
                return event.as_ptr();
            };
            if let Some(win) = ev.window(mtm) {
                let ns_ptr = Retained::as_ptr(&win) as usize;
                if let Some(label) = NSWINDOW_LABELS.label(ns_ptr) {
                    if let Some(view) = win.contentView() {
                        let h = view.frame().size.height;
                        let loc = ev.locationInWindow();
                        // 그 창에만 — 블록 밖(별도 스레드 큐잉)으로 발행한다(블록 안 wry 금지).
                        emit_from_appkit_block(
                            &handle,
                            Some(label),
                            name,
                            ClickPayload {
                                x: loc.x,
                                y: h - loc.y,
                            },
                        );
                    }
                }
            }
            event.as_ptr()
        }
    });
    let mask = NSEventMask(
        NSEventMask::LeftMouseDown.0
            | NSEventMask::LeftMouseDragged.0
            | NSEventMask::LeftMouseUp.0
            | NSEventMask::MouseMoved.0,
    );
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    // 모니터는 앱 수명 동안 유지 — drop 되면 해제되므로 의도적으로 leak.
    std::mem::forget(monitor);

    install_pointer_absence(app);
}

// 포인터가 더 이상 우리 위에 없다는 사실 — native-mouseleave.
//
// 위의 로컬 모니터는 "있음"만 말한다. 그 사실로 켜지는 상태(divider hover 강조)는 꺼질 방법이
// 없었다: 포인터가 창 밖으로 나가면 MouseMoved 가 끊기고, 끊긴 것과 "그 자리에 멈춰 있다"가
// 구별되지 않아 강조가 영원히 남는다(실측: accent 세로선이 창 본문 전체 높이로 브라우저를
// 가로지른 채 굳음 — ui.hit 이 divider s1:0 을 반환, 그 rect 가 네이티브 강조바 프레임과 동일).
// 스크린샷 단축키처럼 앱이 비활성화되는 순간이 전형적인 경로다.
//
// 있음만 말하는 소스에는 없음을 말하는 짝이 필요하다. 창이 key 를 잃거나 앱이 활성을 잃는
// 것은 포인터가 우리 것이 아니게 됐다는 뜻이고, 둘 다 저빈도 통지라 비용이 없다.
#[cfg(target_os = "macos")]
fn install_pointer_absence(app: &AppHandle) {
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSApplicationDidResignActiveNotification, NSWindow, NSWindowDidResignKeyNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let center = NSNotificationCenter::defaultCenter();

    // 창 단위 — key 를 잃은 그 창에만.
    let handle = app.clone();
    let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
        let note = unsafe { note.as_ref() };
        let Some(obj) = note.object() else { return };
        let Ok(ns) = obj.downcast::<NSWindow>() else {
            return;
        };
        let ns_ptr = Retained::as_ptr(&ns) as usize;
        if let Some(label) = NSWINDOW_LABELS.label(ns_ptr) {
            emit_from_appkit_block(&handle, Some(label), "native-mouseleave", ());
        }
    });
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidResignKeyNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(token);

    // 앱 단위 — 어느 창이 key 였든 앱을 떠났으면 전부 꺼진다(창 통지가 안 오는 경로 대비).
    let handle = app.clone();
    let block = block2::RcBlock::new(move |_note: std::ptr::NonNull<NSNotification>| {
        emit_from_appkit_block(&handle, None, "native-mouseleave", ());
    });
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidResignActiveNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(token);
}

// divider 강조바 = 순수 시각. hitTest 를 nil 반환해 마우스를 통과시킨다 — 그래야 강조바가 divider 위를
// 덮어도 그 밑 divider 가 native-mousedown(드래그/리사이즈)을 받는다. NSBox 서브클래스(fillColor 가
// NSColor 를 직접 받음 — CALayer.setBackgroundColor 는 objc2-core-graphics feature 게이트라 회피).
#[cfg(target_os = "macos")]
objc2::define_class!(
    #[unsafe(super(objc2_app_kit::NSBox))]
    #[thread_kind = objc2::MainThreadOnly]
    struct DividerHiliteBox;

    impl DividerHiliteBox {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: objc2_foundation::NSPoint) -> *mut objc2_app_kit::NSView {
            std::ptr::null_mut() // 마우스 통과 — 밑의 divider 가 드래그를 받는다
        }
    }
);

// 창별 divider 강조바(메인스레드 전용 — Retained 는 !Send 라 thread_local 로 소유).
#[cfg(target_os = "macos")]
thread_local! {
    static HL_BARS: std::cell::RefCell<
        std::collections::HashMap<String, objc2::rc::Retained<DividerHiliteBox>>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}

// hover 중인 divider 위치(창 클라이언트 좌표 top-left, px)에 accent 바를 브라우저(네이티브 뷰) "위"에
// 그린다. rect=None 이면 숨김. seam(child 물림) 방식과 달리 브라우저를 건드리지 않아 밀림/리플로우 0 이고,
// contentView 최상위 subview 라 브라우저(네이티브)를 덮어 flat 에서도 강조가 보인다.
#[cfg(target_os = "macos")]
pub fn set_divider_highlight(app: &AppHandle, label: String, rect: Option<(f64, f64, f64, f64)>) {
    use objc2::rc::Retained;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_app_kit::{NSBoxType, NSColor, NSTitlePosition, NSView, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(win) = app.get_window(&label) else {
            return;
        };
        let Ok(ns) = win.ns_window() else { return };
        if ns.is_null() {
            return;
        }
        let ns_window: &NSWindow = unsafe { &*(ns as *const NSWindow) };
        let Some(content) = ns_window.contentView() else {
            return;
        };
        let ch = content.frame().size.height;
        HL_BARS.with(|cell| {
            let mut bars = cell.borrow_mut();
            match rect {
                Some((x, y, w, h)) => {
                    // top-left(웹) → bottom-left(NSView) y-flip.
                    let frame = NSRect::new(
                        NSPoint::new(x, ch - (y + h)),
                        NSSize::new(w.max(1.0), h.max(1.0)),
                    );
                    let bar = bars.entry(label.clone()).or_insert_with(|| {
                        let b: Retained<DividerHiliteBox> =
                            unsafe { msg_send![mtm.alloc::<DividerHiliteBox>(), init] };
                        {
                            b.setBoxType(NSBoxType::Custom); // 커스텀 = fillColor 로 단색 채움(테두리/타이틀 X)
                            b.setTitlePosition(NSTitlePosition::NoTitle);
                            b.setBorderWidth(0.0);
                            b.setFillColor(&NSColor::controlAccentColor());
                        }
                        b
                    });
                    let view: &NSView = bar;
                    {
                        view.setFrame(frame);
                        view.removeFromSuperview();
                        content.addSubview(view); // 맨 위 subview = 브라우저 child 포함 모든 것 위.
                        view.setHidden(false);
                    }
                }
                None => {
                    if let Some(bar) = bars.get(&label) {
                        let view: &NSView = bar;
                        view.setHidden(true);
                    }
                }
            }
        });
    });
}

// 창 라이브 리사이즈(가장자리 드래그) 시작/끝을 네이티브로 감지해 프론트에 emit.
// 왜 네이티브인가: JS(ResizeObserver)는 "리사이즈 중"만 알 뿐 "끝났다"를 모른다 →
// 디바운스 추측으로 반영 지연이 생긴다(사용자 지적). 네이티브 신호는 정확하다 —
// 드래그 중엔 터미널 fit 을 멈춰 깜빡임 0, 놓는 즉시(didEnd) 0지연 reflow.
// 멀티플랫폼: 프론트는 "window-live-resize" {active} 한 채널만 소비한다. macOS 는
// NSWindow live-resize 알림이 신호원이고, Windows(WM_ENTER/EXITSIZEMOVE)·Linux 도
// 같은 이벤트를 자기 신호원으로 먹이면 프론트 로직은 그대로 재사용된다(Tauri 를
// 쓴 이유 — Rust 가 모든 플랫폼의 네이티브 창 이벤트를 잡는 단일 지점).
#[cfg(target_os = "macos")]
pub fn install_live_resize_monitor(app: &AppHandle) {
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSWindow, NSWindowDidEndLiveResizeNotification, NSWindowDidResizeNotification,
        NSWindowWillStartLiveResizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let center = NSNotificationCenter::defaultCenter();
    // 통지 이름 상수는 extern static — 접근은 unsafe(읽기 전용, 항상 유효).
    let events: [(bool, &'static objc2_foundation::NSNotificationName); 2] = unsafe {
        [
            (true, NSWindowWillStartLiveResizeNotification),
            (false, NSWindowDidEndLiveResizeNotification),
        ]
    };
    for (active, name) in events {
        let handle = app.clone();
        // object: None = 모든 창의 통지(MW1 — 단일 창 가정 제거). 콜백에서 통지의 NSWindow →
        // label 을 찾아 그 창에만 emit_to(프론트 필터 불필요). child webview 창/패널은 label 매칭
        // 실패로 자연 제외(webview_windows 에 없음).
        let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| unsafe {
            let obj: *mut objc2::runtime::AnyObject = objc2::msg_send![note.as_ref(), object];
            if let Some(label) = NSWINDOW_LABELS.label(obj as usize) {
                emit_from_appkit_block(&handle, Some(label), "window-live-resize", active);
            }
        });
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // 옵저버는 앱 수명 동안 유지 — 의도된 leak(앱 전역, 설치 1회).
        std::mem::forget(token);
    }

    // DidResize는 가장자리 live resize와 programmatic setSize 모두에 대해 발화한다. start/end만
    // 보면 자동화·복원 같은 programmatic 경로의 첫 합성 프레임을 놓친다. 등록된 앱 창만
    // transaction 대상으로 삼아 CEF가 만든 보조 NSWindow 등 타 소유 창에는 개입하지 않는다.
    let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
        let note = unsafe { note.as_ref() };
        let Some(obj) = note.object() else { return };
        let Ok(window) = obj.downcast::<NSWindow>() else {
            return;
        };
        let ns_ptr = Retained::as_ptr(&window) as usize;
        if let Some(label) = NSWINDOW_LABELS.label(ns_ptr) {
            super::layer::resize_registered_surface_hosts(&label);
            super::layer::resize_pane_surface_hosts(&label);
            commit_resize_composition(&window);
        }
    });
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidResizeNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(token);
}
