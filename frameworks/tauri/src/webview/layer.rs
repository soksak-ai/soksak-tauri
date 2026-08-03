use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::sel;
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSArray, NSNumber, NSPoint, NSString};
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

// 창의 오버레이 게이트 갱신(프론트 ui 카운터 0↔1 전이 시 webview_overlay_active 가 호출).
pub fn set_overlay(label: &str, active: bool) {
    if let Ok(mut layers) = LAYERS.lock() {
        if let Some(w) = layers.get_mut(label) {
            w.overlay = active;
        }
    }
    if active {
        lower_window_surface_hosts(label);
    } else {
        raise_window_surface_hosts(label);
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

// Backend N surface 등록/해제 — webview_open 직후(가시 홀 편입), webview_close 직전(회수).
// 오프스크린 추출 webview(media_extract, -20000)는 홀이 아니므로 등록하지 않는다.
pub fn register_surface(ptr: usize, label: Option<&str>) {
    SURFACES.register(ptr, label);
}
pub fn unregister_surface(ptr: usize) {
    SURFACES.unregister(ptr);
}
pub fn surface_label(ptr: usize) -> Option<String> {
    SURFACES.label(ptr)
}
pub fn surface_host_ptr(label: &str) -> usize {
    SURFACE_HOSTS.ptr(label).unwrap_or(0)
}

fn place_surface_host(label: &str, mode: NSWindowOrderingMode) {
    let Some(host) = SURFACE_HOSTS.host(label) else {
        return;
    };
    let main_ptr = LAYERS
        .lock()
        .ok()
        .and_then(|layers| {
            layers.get(&host.window).map(|window| {
                if mode == NSWindowOrderingMode::Above && window.overlay {
                    0
                } else {
                    window.main_ptr
                }
            })
        })
        .unwrap_or(0);
    if main_ptr == 0 {
        return;
    }
    let main_view = unsafe { &*(main_ptr as *const NSView) };
    let Some(parent) = (unsafe { main_view.superview() }) else {
        return;
    };
    // AppKit이 기존 subview의 순서 변경을 명시적으로 보장하는 `subviews` 계약을 쓴다.
    // addSubview(_:positioned:relativeTo:)는 새 subview 삽입 API라 이미 붙은 host를 호출했을 때
    // 실제 sibling 배열이 바뀌지 않았다. 배열은 back-to-front이고, setSubviews는 기존 view를
    // 떼었다 붙이지 않은 채 필요한 항목만 이동한다.
    let siblings = parent.subviews().into_iter().collect::<Vec<_>>();
    let sibling_ptrs = siblings
        .iter()
        .map(|view| (&**view as *const NSView) as usize)
        .collect::<Vec<_>>();
    let ordered_ptrs = super::surface_sibling_order(
        &sibling_ptrs,
        host.ptr,
        main_ptr,
        mode == NSWindowOrderingMode::Above,
    );
    if ordered_ptrs == sibling_ptrs {
        return;
    }
    let ordered = ordered_ptrs
        .iter()
        .filter_map(|ptr| {
            siblings
                .iter()
                .find(|view| (&***view as *const NSView) as usize == *ptr)
                .cloned()
        })
        .collect::<Vec<_>>();
    parent.setSubviews(&NSArray::from_retained_slice(&ordered));
}

pub fn raise_surface_host(label: &str) {
    place_surface_host(label, NSWindowOrderingMode::Above);
}

pub fn lower_surface_host(label: &str) {
    place_surface_host(label, NSWindowOrderingMode::Below);
}

pub fn lower_window_surface_hosts(window_label: &str) {
    for label in SURFACE_HOSTS.labels_in(window_label) {
        lower_surface_host(&label);
    }
}

pub fn raise_window_surface_hosts(window_label: &str) {
    for label in SURFACE_HOSTS.labels_in(window_label) {
        raise_surface_host(&label);
    }
}

// child WKWebView를 전용 layer-backed NSView에 넣는다. host frame이 화면 좌표의 단일 진실이고
// child는 로컬 원점에 고정된다. addSubview는 기존 부모에서 표준 재부착을 수행한다.
pub fn adopt_surface_host<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    surface_label: &str,
    window_label: &str,
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
        parent.addSubview_positioned_relativeTo(
            &host,
            NSWindowOrderingMode::Above,
            Some(main_view),
        );
        child.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
        host.addSubview(child);
        let ptr = Retained::as_ptr(&host) as usize;
        SURFACES.register(ptr, Some(&surface_label));
        SURFACE_HOSTS.register(&surface_label, ptr, &window_label);
    });
}

pub fn set_surface_host_hidden(label: &str, hidden: bool) {
    if let Some(ptr) = SURFACE_HOSTS.ptr(label) {
        let host = unsafe { &*(ptr as *const NSView) };
        host.setHidden(hidden);
    }
}

pub fn remove_surface_host(label: &str) {
    let host = SURFACE_HOSTS.remove(label);
    let Some(host) = host else { return };
    SURFACES.unregister(host.ptr);
    let host = unsafe { &*(host.ptr as *const NSView) };
    host.removeFromSuperview();
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
    use objc2::MainThreadOnly; // NSView::alloc(mtm) 제공.
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
        let host = NSView::initWithFrame(NSView::alloc(mtm), bounds);
        // 합성 호스트는 레이어-백드여야 한다 — Chromium windowed 는 GPU 프로세스의 원격
        // CALayer(CAContext) 를 자기 뷰 레이어에 호스팅하는데, 부모 사슬이 레이어-백드가
        // 아니면 그 레이어가 창의 합성 트리에 영영 안 올라간다(실사고: 페이지 DOM 생존·
        // 뷰 정위치·unhidden 인데 픽셀만 없음 — 단독 하니스(winit 레이어-백드)는 GREEN,
        // 앱 임베딩만 블랭크). OSR 은 프레젠터가 자기 CALayer 를 직접 붙여 무사했다.
        host.setWantsLayer(true);
        // 컨테이너는 콘텐츠 전면을 채우고 리사이즈를 따라간다(원점 0,0 유지 → 좌표 identity).
        host.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        // 메인 webview 아래(형제 최하단)에 삽입 — DOM 이 항상 위, 엔진 콘텐츠가 그 아래로 비친다.
        content.addSubview_positioned_relativeTo(
            &host,
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
