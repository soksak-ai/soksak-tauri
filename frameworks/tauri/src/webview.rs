// 브라우저 패널: 메인 창 안에 child webview(WKWebView)를 임베드한다(iframe 아님 —
// X-Frame-Options 제약 없이 실제 브라우저). 링크 클릭은 webview 기본 동작이고,
// 이전/이후는 history.back()/forward() eval, URL 변화는 on_navigation 으로 프론트에
// emit(폴링 없음). 위치/크기는 프론트 레이아웃(slot rect)을 따라 webview_bounds 로 동기화.
//
// 레이어 원칙(명시적 멀티 웹뷰 경계 — mod layer):
// browser child는 메인 DOM 웹뷰 아래에 고정하고 투명 content slot을 통해서만 보인다.
// 이동·모달 여부로 z-order를 왕복하지 않는다. 따라서 네이티브 표면이 전이 중 사이드바·버튼·
// 모달을 덮지 않으며, Electron의 순수 DOM 배치에는 이 Tauri 합성 규칙이 들어가지 않는다.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use soksak_core::geometry::{
    realign_carried_point, rect_delta, same_point, scale_rect, top_left_rect_to_parent_frame,
};
use soksak_core::native_surface_ledger::{NativeSurfaceLayout, SurfaceHole as Hole};

static SURFACE_LAYOUT: std::sync::LazyLock<NativeSurfaceLayout> = std::sync::LazyLock::new(NativeSurfaceLayout::default);

/// Tauri/macOS 어댑터가 DOM CSS 좌표를 AppKit backing 좌표로 투영할 때 소비하는 창 줌.
/// 장부의 소유권은 이 모듈에 남고, titlebar는 공개된 값만 읽는다.
#[cfg(target_os = "macos")]
pub(crate) fn window_zoom_for_adapter(window_label: &str) -> f64 {
    SURFACE_LAYOUT.window_zoom(window_label)
}
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
    WebviewWindowBuilder,
};

// PaneSurfaceHost로 NSView 부모를 바꾼 뒤에도 label 정체성은 앱 전역 registry가 소유한다.
// Manager::get_webview의 부모 탐색 결과를 명령 가능성의 기준으로 쓰지 않는다.
fn registered_webview(app: &AppHandle, label: &str) -> Option<tauri::Webview> {
    app.webviews().get(label).cloned()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SurfaceLayoutContract {
    viewport_w: f64,
    viewport_h: f64,
    root_x: f64,
    root_y: f64,
    root_w: f64,
    root_h: f64,
    left_ratio: f64,
    top_ratio: f64,
    width_ratio: f64,
    height_ratio: f64,
    fixed_x: f64,
    fixed_y: f64,
    fixed_w: f64,
    fixed_h: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneMemberLayoutContract {
    host_w: f64,
    host_h: f64,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageLoadState {
    revision: u64,
    window: String,
    url: String,
    finished: bool,
}

static PAGE_LOAD_STATES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, PageLoadState>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
static PAGE_LOAD_EVENTS: std::sync::LazyLock<tokio::sync::broadcast::Sender<String>> =
    std::sync::LazyLock::new(|| tokio::sync::broadcast::channel(128).0);

fn record_page_load(label: &str, window: &str, url: &str, finished: bool) {
    if let Ok(mut states) = PAGE_LOAD_STATES.lock() {
        let revision = states.get(label).map(|state| state.revision + 1).unwrap_or(1);
        states.insert(label.to_owned(), PageLoadState {
            revision,
            window: window.to_owned(),
            url: url.to_owned(),
            finished,
        });
    }
    let _ = PAGE_LOAD_EVENTS.send(label.to_owned());
}

pub fn forget_window(window: &str) {
    if let Ok(mut states) = PAGE_LOAD_STATES.lock() { states.retain(|_, state| state.window != window); }
    #[cfg(target_os = "macos")]
    {
        // Display links retain their targets. Invalidate them while their pane NSViews are still
        // alive, then clear the native surface registries.
        presentation_trace::forget_window(window);
        layer::forget_window(window);
    }
}

fn loaded_page(label: &str) -> Option<PageLoadState> {
    PAGE_LOAD_STATES.lock().ok().and_then(|states| states.get(label).cloned())
        .filter(|state| state.finished && state.url != "about:blank")
}

/// child 생성 ACK와 페이지 준비 ACK는 다른 사실이다. on_page_load 사건만 소비하는 유한 장벽이며
/// 타이머 간격으로 상태를 재조회하지 않는다.
#[tauri::command]
pub async fn webview_wait_loaded(
    app: AppHandle,
    label: String,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    if registered_webview(&app, &label).is_none() {
        return Err(format!("webview 없음: {label}"));
    }
    let mut events = PAGE_LOAD_EVENTS.subscribe();
    if let Some(state) = loaded_page(&label) {
        return serde_json::to_value(state).map_err(|error| error.to_string());
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1, 60_000));
    tokio::time::timeout(timeout, async {
        loop {
            match events.recv().await {
                Ok(changed) if changed == label => {
                    if let Some(state) = loaded_page(&label) { return Ok(state); }
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return Err("webview page-load 사건 통로가 닫혔습니다".to_string());
                }
            }
        }
    }).await
        .map_err(|_| format!("webview page-load 시간 초과: {label}"))?
        .and_then(|state| serde_json::to_value(state).map_err(|error| error.to_string()))
}

/// **조합 중**인 글자를 넣는다 — 확정 입력과 다른 사실이다.
///
/// 한글·일본어·중국어는 확정 전에 조합 상태를 지나고, 그 동안 페이지는 `compositionstart`/
/// `compositionupdate` 를 받으며 아직 값이 아닌 글자를 보여 준다. 확정 문자열만 넣을 수 있으면
/// 그 구간은 검증할 수 없고, "한글이 들어간다" 는 조합을 지나지 않은 반쪽 증명이 된다.
///
/// `text` 가 비면 조합을 **푼다**(확정). 사람이 스페이스나 엔터로 끝내는 그 자리다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_mark_text(app: AppHandle, label: String, text: String) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let webview = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    webview
        .with_webview(move |platform| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{msg_send, sel};
            use objc2_foundation::{NSNotFound, NSRange, NSString};

            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.try_send(Err("WKWebView 핸들이 비어 있습니다".to_string()));
                return;
            }
            let window: *mut AnyObject = msg_send![&*wk, window];
            if window.is_null() {
                let _ = tx.try_send(Err("WKWebView가 창에 붙어 있지 않습니다".to_string()));
                return;
            }
            // 조합도 창이 키일 때만 페이지에 닿는다 — 아니면 보냈다고 답하면서 아무 일도 안 난다.
            let is_key: bool = msg_send![&*window, isKeyWindow];
            if !is_key {
                let _ = tx.try_send(Err(
                    "이 창이 키보드 포커스를 갖고 있지 않아 조합이 페이지에 닿지 않습니다. window.focus 로 그 창을 앞으로 가져온 뒤 다시 부르세요"
                        .to_string(),
                ));
                return;
            }
            let accepted: bool = msg_send![&*window, makeFirstResponder: &*wk];
            if !accepted {
                let _ = tx.try_send(Err("이 표면을 입력 자리로 세우지 못했습니다. 그 탭을 활성화한 뒤 다시 부르세요".to_string()));
                return;
            }
            let responder: *mut AnyObject = msg_send![&*window, firstResponder];
            if responder.is_null() {
                let _ = tx.try_send(Err("이 표면에 입력을 받을 자리가 없습니다. 먼저 그 입력 요소를 클릭하세요".to_string()));
                return;
            }
            let marks: bool = msg_send![&*responder,
                respondsToSelector: sel!(setMarkedText:selectedRange:replacementRange:)
            ];
            if !marks {
                let _ = tx.try_send(Err(
                    "child 웹뷰의 현재 입력자가 조합을 받지 않습니다(NSTextInputClient 아님)".to_string(),
                ));
                return;
            }
            let nothing = NSRange::new(NSNotFound as usize, 0);
            if text.is_empty() {
                // 조합을 푼다 — 사람이 스페이스·엔터로 끝내는 그 자리와 같은 경로다.
                let _: () = msg_send![&*responder, unmarkText];
            } else {
                let value = NSString::from_str(&text);
                // 커서는 조합 문자열 끝에 둔다 — 사람이 치는 동안 IME 가 그렇게 잡는다.
                let caret = NSRange::new(text.chars().count(), 0);
                let _: () = msg_send![
                    &*responder,
                    setMarkedText: &*value,
                    selectedRange: caret,
                    replacementRange: nothing
                ];
            }
            let _ = tx.try_send(Ok(()));
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "조합 입력자 응답 시간 초과".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_mark_text(_app: AppHandle, _label: String, _text: String) -> Result<(), String> {
    Err("webview_mark_text는 현재 macOS 구현이 필요합니다".into())
}

/// 이 창이 지금 **키보드를 받는 창인가.**
///
/// 창을 앞으로 올리는 요청은 성공하는데 키보드는 안 오는 경우가 있다 — 다른 앱이 활성이면 OS 가
/// 넘기지 않는다(실측 2026-08-08: `window.focus` 가 성공을 답했는데 그 창은 키가 아니었고, 그
/// 위에서 키보드 명령이 전부 거절됐다). 요청과 결과는 다른 사실이라 결과를 물을 자리가 있어야 한다.
#[tauri::command]
pub fn window_is_key(app: AppHandle, label: String) -> bool {
    use tauri::Manager;
    app.get_webview_window(&label)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// 이름 있는 키가 이 엔진에서 도는 **명령** — 사람이 칠 때 AppKit 이 보내는 그 자리다.
#[cfg(target_os = "macos")]
fn command_selector(key: &str) -> Option<objc2::runtime::Sel> {
    use objc2::sel;
    Some(match key {
        "Enter" => sel!(insertNewline:),
        "Tab" => sel!(insertTab:),
        "Escape" => sel!(cancelOperation:),
        "Backspace" => sel!(deleteBackward:),
        "Delete" => sel!(deleteForward:),
        "ArrowLeft" => sel!(moveLeft:),
        "ArrowRight" => sel!(moveRight:),
        "ArrowDown" => sel!(moveDown:),
        "ArrowUp" => sel!(moveUp:),
        _ => return None,
    })
}

/// 키 하나를 표면에 넣는다 — 글자가 아니라 **키**다.
///
/// 확정 문자열(`webview_type_text`)은 편집 경로로 들어가서 Enter·Escape·화살표 같은 것을 만들지
/// 못한다. 그런 것으로만 닿는 기능(주소줄 확정, 팔레트 이동, 단축키)은 그래서 검증할 수 없었다.
///
/// 창을 key/front 로 만들지 않는다 — 사람의 포커스를 빼앗지 않는다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_send_key(
    app: AppHandle,
    label: String,
    key: String,
    ctrl: Option<bool>,
    meta: Option<bool>,
    shift: Option<bool>,
    alt: Option<bool>,
) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    // 이름 있는 키는 코드로, 글자는 그대로 — 엔진이 `key` 를 이 두 축에서 만든다.
    let (code, chars): (u16, Option<&str>) = match key.as_str() {
        "Enter" => (36, Some("\r")),
        "Tab" => (48, Some("\t")),
        "Escape" => (53, None),
        "Backspace" => (51, None),
        "ArrowLeft" => (123, None),
        "ArrowRight" => (124, None),
        "ArrowDown" => (125, None),
        "ArrowUp" => (126, None),
        other if other.chars().count() == 1 => (0, Some(other)),
        other => return Err(format!(
            "이 키는 아직 넣을 수 없습니다: {other}. 한 글자이거나 Enter·Tab·Escape·Backspace·화살표 중 하나를 쓰세요"
        )),
    };
    let literal = chars.map(str::to_string);
    let webview = registered_webview(&app, &label)
        .ok_or_else(|| format!("이 이름의 표면이 없습니다: {label}. view.list 로 지금 있는 표면을 확인하세요"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    webview
        .with_webview(move |platform| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            use objc2_foundation::{NSPoint, NSString};

            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.try_send(Err("이 표면의 엔진 핸들이 비어 있습니다".to_string()));
                return;
            }
            let window: *mut AnyObject = msg_send![&*wk, window];
            if window.is_null() {
                let _ = tx.try_send(Err("이 표면이 창에 붙어 있지 않습니다. 그 탭을 활성화한 뒤 다시 부르세요".to_string()));
                return;
            }
            // **키보드는 창이 키일 때만 페이지에 닿는다.** 실측 2026-08-08: 창이 키가 아니면
            // 문서의 `hasFocus()` 가 거짓이고, responder 를 세우고 명령을 보내도 페이지는
            // keydown 을 0회 받았다. 조합도 같다.
            //
            // 창을 키로 만드는 것은 **사람의 포커스를 빼앗는 일**이라 여기서 하지 않는다.
            // 대신 그 사실을 이름으로 답한다 — 무엇을 하면 되는지까지.
            let is_key: bool = msg_send![&*window, isKeyWindow];
            if !is_key {
                let _ = tx.try_send(Err(
                    "이 창이 키보드 포커스를 갖고 있지 않아 키가 페이지에 닿지 않습니다. window.focus 로 그 창을 앞으로 가져온 뒤 다시 부르세요"
                        .to_string(),
                ));
                return;
            }
            // 키는 입력 responder 가 받는다 — 창을 key 로 만들지 않고 이 뷰만 세운다.
            let _: bool = msg_send![&*window, makeFirstResponder: &*wk];
            let responder: *mut AnyObject = msg_send![&*window, firstResponder];
            // **이름 있는 키는 명령으로 간다.** WKWebView 는 키를 텍스트 입력자로 해석하고,
            // Enter·Escape·화살표는 그 해석의 결과가 "명령"이다(실측 2026-08-08: 지어낸 키
            // 사건을 keyDown: 으로 넣었더니 페이지가 keydown 을 0회 받았다 — 글자도 이름 있는
            // 키도 전부). 사람이 치면 AppKit 이 같은 자리로 보낸다.
            if !responder.is_null() {
                if let Some(selector) = command_selector(&key) {
                    let _: () = msg_send![&*responder, doCommandBySelector: selector];
                    let _ = tx.try_send(Ok(()));
                    return;
                }
                // 글자는 그대로 넣는다 — 확정 입력과 같은 경로다.
                if let Some(literal) = literal.as_deref() {
                    let value = NSString::from_str(literal);
                    let nothing = objc2_foundation::NSRange::new(
                        objc2_foundation::NSNotFound as usize,
                        0,
                    );
                    let _: () = msg_send![
                        &*responder,
                        insertText: &*value,
                        replacementRange: nothing
                    ];
                    let _ = tx.try_send(Ok(()));
                    return;
                }
            }
            let mut flags: usize = 0;
            if ctrl.unwrap_or(false) { flags |= 1 << 18; }
            if shift.unwrap_or(false) { flags |= 1 << 17; }
            if alt.unwrap_or(false) { flags |= 1 << 19; }
            if meta.unwrap_or(false) { flags |= 1 << 20; }
            let text = NSString::from_str(literal.as_deref().unwrap_or(""));
            let window_number: isize = msg_send![&*window, windowNumber];
            let nil_ctx: *mut AnyObject = std::ptr::null_mut();
            let event_class = objc2::class!(NSEvent);
            for (kind, repeat) in [(10usize, false), (11usize, false)] {
                let event: *mut AnyObject = msg_send![
                    event_class,
                    keyEventWithType: kind,
                    location: NSPoint::new(0.0, 0.0),
                    modifierFlags: flags,
                    timestamp: 0f64,
                    windowNumber: window_number,
                    context: nil_ctx,
                    characters: &*text,
                    charactersIgnoringModifiers: &*text,
                    isARepeat: repeat,
                    keyCode: code
                ];
                if event.is_null() {
                    let _ = tx.try_send(Err("키 사건을 만들지 못했습니다".to_string()));
                    return;
                }
                let _: () = if kind == 10 {
                    msg_send![&*wk, keyDown: &*event]
                } else {
                    msg_send![&*wk, keyUp: &*event]
                };
            }
            let _ = tx.try_send(Ok(()));
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "키 입력자가 시간 안에 답하지 않았습니다".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_send_key(
    _app: AppHandle,
    _label: String,
    _key: String,
    _ctrl: Option<bool>,
    _meta: Option<bool>,
    _shift: Option<bool>,
    _alt: Option<bool>,
) -> Result<(), String> {
    Err("webview_send_key는 현재 macOS 구현이 필요합니다".into())
}

/// 포커스된 child 웹뷰 편집자에 확정 문자열을 전달한다.
///
/// DOM 값을 쓰는 자동화 명령이 아니다. AppKit responder chain의 NSTextInputClient 진입점으로
/// 들어가므로 WKWebView가 일반 사용자 텍스트 입력과 같은 beforeinput/input 편집 경로를 수행한다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_type_text(app: AppHandle, label: String, text: String) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let webview = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    webview
        .with_webview(move |platform| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{msg_send, sel};
            use objc2_foundation::{NSNotFound, NSRange, NSString};

            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.try_send(Err("WKWebView 핸들이 비어 있습니다".to_string()));
                return;
            }
            let window: *mut AnyObject = msg_send![&*wk, window];
            if window.is_null() {
                let _ = tx.try_send(Err("WKWebView가 창에 붙어 있지 않습니다".to_string()));
                return;
            }
            // 문서의 activeElement와 NSWindow firstResponder는 별개의 상태다. 특히 key가 아닌
            // 자동화 창에서는 eval로 input.focus()를 해도 window responder가 메인 UI 웹뷰에
            // 남을 수 있다. 대상 label로 찾은 child를 명시적으로 responder chain에 연결한다.
            // makeFirstResponder는 창을 key/front로 만들지 않으므로 사용자의 포커스를 빼앗지 않는다.
            let accepted: bool = msg_send![&*window, makeFirstResponder: &*wk];
            if !accepted {
                let _ = tx.try_send(Err("child 웹뷰를 입력 responder로 지정하지 못했습니다".to_string()));
                return;
            }
            let responder: *mut AnyObject = msg_send![&*window, firstResponder];
            if responder.is_null() {
                let _ = tx.try_send(Err("child 웹뷰에 포커스된 입력자가 없습니다".to_string()));
                return;
            }
            let accepts: bool = msg_send![&*responder,
                respondsToSelector: sel!(insertText:replacementRange:)
            ];
            if !accepts {
                let _ = tx.try_send(Err(
                    "child 웹뷰의 현재 입력자가 NSTextInputClient가 아닙니다".to_string(),
                ));
                return;
            }
            let value = NSString::from_str(&text);
            let replacement = NSRange::new(NSNotFound as usize, 0);
            let _: () = msg_send![&*responder, insertText: &*value, replacementRange: replacement];
            let _ = tx.try_send(Ok(()));
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "텍스트 입력자 응답 시간 초과".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_type_text(_app: AppHandle, _label: String, _text: String) -> Result<(), String> {
    Err("webview_type_text는 현재 macOS 입력 구현이 필요합니다".into())
}

/// 사건이 실은 위치가 창 base 좌표를 실었다고 볼 문턱(pt). AppKit이 정수로 반올림해도
/// 통과하고, 창 원점만 한 어긋남은 잡는다.
#[cfg(target_os = "macos")]
const WHEEL_POINT_TOLERANCE: f64 = 1.0;

/// 사건이 **창 좌표를 싣게** 만든다 — 자리는 가정하지 않고 요구한다.
///
/// 창에 붙지 않은 CGEvent 는 어느 좌표계를 답할지 우리가 정하지 못한다. 그래서 실어 만들고,
/// AppKit 이 답하는 값을 읽고, 어긋난 만큼 한 번 옮긴다. 그러고도 어긋나면 **안 보낸다** —
/// 닿지 못한 사건을 보냈다고 답할 수는 없다(실측 2026-08-07: 좌표가 조용히 틀리면 스크롤은
/// 도는데 DOM 이 센 사건은 0 이었다).
///
/// 휠과 마우스가 같은 규율을 쓴다. 두 벌로 적으면 한쪽만 고쳐지는 날이 오고, 그 차이는 오류가
/// 아니라 "어떤 입력만 안 닿는" 모습으로 나타난다.
#[cfg(target_os = "macos")]
unsafe fn place_event_in_window(
    event: &core_graphics::event::CGEvent,
    mut location: (f64, f64),
    wanted: (f64, f64),
    what: &str,
) -> Result<*mut objc2::runtime::AnyObject, String> {
    use core_graphics::geometry::CGPoint;
    use foreign_types::ForeignType;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSPoint;

    let event_class = objc2::class!(NSEvent);
    let event_ref = event.as_ptr().cast::<std::ffi::c_void>();
    let mut ns_event: *mut AnyObject = msg_send![event_class, eventWithCGEvent: event_ref];
    if ns_event.is_null() {
        return Err("NSEvent 변환 실패".to_string());
    }
    let first: NSPoint = msg_send![&*ns_event, locationInWindow];
    let mut carried = (first.x, first.y);
    if !same_point(carried, wanted, WHEEL_POINT_TOLERANCE) {
        location = realign_carried_point(location, carried, wanted, true);
        event.set_location(CGPoint::new(location.0, location.1));
        let retry: *mut AnyObject = msg_send![event_class, eventWithCGEvent: event_ref];
        if retry.is_null() {
            return Err("NSEvent 변환 실패".to_string());
        }
        ns_event = retry;
        let again: NSPoint = msg_send![&*ns_event, locationInWindow];
        carried = (again.x, again.y);
    }
    if !same_point(carried, wanted, WHEEL_POINT_TOLERANCE) {
        return Err(format!(
            "{what} 사건이 창 좌표를 싣지 못했습니다: 창 ({:.1},{:.1}) 사건 ({:.1},{:.1})",
            wanted.0, wanted.1, carried.0, carried.1,
        ));
    }
    Ok(ns_event)
}

/// 이 표면이 **지금 포인터를 받을 수 있는 상태인가** — AppKit 의 사실 그대로.
///
/// 입력이 안 닿을 때 "안 닿았다"만 알면 부른 쪽은 자기 좌표를 의심한다. 배달을 가르는 조건은
/// 전부 이 표면과 그 창의 상태다: 창에 붙었는가, 창이 이동 사건을 받도록 켜져 있는가, 이
/// 뷰가 입력 responder 인가, 그리고 **보이는 사각형**이 어디까지인가. 엔진은 마지막 것으로
/// hover 를 자르므로(첫 responder 이면서 그 밖이면 조용히 버린다) 그 값이 없으면 이동이 왜
/// 사라졌는지 영영 못 잰다.
///
/// 읽기만 한다 — 포커스도 자리도 건드리지 않는다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_input_state(
    app: AppHandle,
    label: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<serde_json::Value, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let webview = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<serde_json::Value>(1);
    webview
        .with_webview(move |platform| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            use objc2_foundation::NSRect;

            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.try_send(serde_json::json!({ "attached": false, "why": "WKWebView 핸들이 비어 있습니다" }));
                return;
            }
            let bounds: NSRect = msg_send![&*wk, bounds];
            let visible: NSRect = msg_send![&*wk, visibleRect];
            let hidden: bool = msg_send![&*wk, isHiddenOrHasHiddenAncestor];
            let flipped: bool = msg_send![&*wk, isFlipped];
            let window: *mut AnyObject = msg_send![&*wk, window];
            if window.is_null() {
                let _ = tx.try_send(serde_json::json!({
                    "attached": false,
                    "hidden": hidden,
                    "bounds": { "w": bounds.size.width, "h": bounds.size.height },
                }));
                return;
            }
            let window_number: isize = msg_send![&*window, windowNumber];
            let key: bool = msg_send![&*window, isKeyWindow];
            let accepts_moved: bool = msg_send![&*window, acceptsMouseMovedEvents];
            let responder: *mut AnyObject = msg_send![&*window, firstResponder];
            // **진짜 커서가 지금 어디 있는가.** 엔진이 hover 를 다룰 때 사건이 실은 좌표가
            // 아니라 실제 커서 자리를 볼 수 있다 — 그렇다면 커서를 옮기지 않는 한 주입한
            // 이동은 도착하지 않는다. 그 갈림을 여기서 값으로 답한다(커서는 건드리지 않는다).
            let event_class = objc2::class!(NSEvent);
            let cursor_screen: objc2_foundation::NSPoint = msg_send![event_class, mouseLocation];
            let cursor_window: NSRect = msg_send![
                &*window,
                convertRectFromScreen: NSRect::new(cursor_screen, objc2_foundation::NSSize::new(0.0, 0.0))
            ];
            let asked = x.zip(y);
            let cursor_local: objc2_foundation::NSPoint =
                msg_send![&*wk, convertPoint: cursor_window.origin, fromView: std::ptr::null_mut::<AnyObject>()];
            let bounds_rect: NSRect = msg_send![&*wk, bounds];
            // 엔진은 hover 를 넘기기 전에 **그 자리의 맨 위 창이 우리 창인지** 본다("다른 창
            // 위의 마우스 이동은 거절한다"). 아니면 조용히 버린다 — 보냈다는 답만 남는다.
            //
            // 묻는 자리는 좌표를 준 쪽이 정한다. 안 주면 지금 커서 자리다 — 사람이 손을 올린
            // 자리가 그 표면의 hover 가 성립하는지 재는 기본 질문이기 때문이다.
            let bounds_now: NSRect = msg_send![&*wk, bounds];
            let point_screen = match asked {
                Some((ax, ay)) => {
                    let local = objc2_foundation::NSPoint::new(
                        ax,
                        if flipped { ay } else { bounds_now.size.height - ay },
                    );
                    let in_window: objc2_foundation::NSPoint =
                        msg_send![&*wk, convertPoint: local, toView: std::ptr::null_mut::<AnyObject>()];
                    let r: NSRect = msg_send![
                        &*window,
                        convertRectToScreen: NSRect::new(in_window, objc2_foundation::NSSize::new(0.0, 0.0))
                    ];
                    r.origin
                }
                None => cursor_screen,
            };
            let window_class = objc2::class!(NSWindow);
            let top_at_point: isize = msg_send![
                window_class,
                windowNumberAtPoint: point_screen,
                belowWindowWithWindowNumber: 0isize
            ];
            let cursor_over = cursor_local.x >= 0.0
                && cursor_local.y >= 0.0
                && cursor_local.x <= bounds_rect.size.width
                && cursor_local.y <= bounds_rect.size.height;
            let _ = tx.try_send(serde_json::json!({
                "attached": true,
                "hidden": hidden,
                "flipped": flipped,
                "windowNumber": window_number,
                "windowIsKey": key,
                "acceptsMouseMovedEvents": accepts_moved,
                "isFirstResponder": std::ptr::eq(responder as *const AnyObject, wk as *const AnyObject),
                "bounds": { "w": bounds.size.width, "h": bounds.size.height },
                // 엔진이 hover 를 자르는 기준. 빈 사각형이면 이동은 전부 조용히 사라진다.
                "visibleRect": {
                    "x": visible.origin.x, "y": visible.origin.y,
                    "w": visible.size.width, "h": visible.size.height,
                },
                "cursorOverSurface": cursor_over,
                "askedPoint": asked.map(|(ax, ay)| serde_json::json!({ "x": ax, "y": ay })),
                "topWindowAtPoint": top_at_point,
                // 이 값이 거짓이면 이 창은 그 자리에서 맨 위가 아니고, 주입한 이동은 엔진이 버린다.
                "windowTopmostAtPoint": top_at_point == window_number,
                "cursorInSurface": { "x": cursor_local.x, "y": cursor_local.y },
            }));
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "입력 상태 응답 시간 초과".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_input_state(
    _app: AppHandle,
    _label: String,
    _x: Option<f64>,
    _y: Option<f64>,
) -> Result<serde_json::Value, String> {
    Err("webview_input_state는 현재 macOS 구현이 필요합니다".into())
}

/// child WKWebView 에 **실제** 마우스 사건을 전달한다.
///
/// 합성 DOM 사건이 아니다. 자식 표면은 메인 DOM 웹뷰 아래에 깔리므로 그 자리의 마우스는 위에
/// 있는 웹뷰가 받는다 — 아래로 내려보내는 길은 이것뿐이고, 호스트에서 `MouseEvent` 를 지어
/// 보내면 그 realm 은 **사용자 활성화가 없는** 입력을 받는다(창-열기·클립보드가 막히고,
/// 히트테스트가 엔진 것과 우리 것 두 벌이 된다). kit 도 같은 이유로 합성 조합을 금한다.
///
/// x/y 는 WKWebView 좌상단 기준 CSS px. 창을 key/front 로 만들지 않는다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_send_mouse(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    kind: String,
    button: Option<String>,
    click_count: Option<u32>,
) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    // AppKit 의 마우스 사건 종류 — 창에 붙여 **직접** 짓는다.
    //
    // CGEvent 를 NSEvent 로 바꿔 쓰면 그 사건은 어느 창의 것도 아니다(windowNumber 0). 누름·뗌은
    // 그래도 들어가는데 **이동은 아무 데도 안 닿았다**(실측 2026-08-08: 페이지가 mousemove 를
    // 0회 받았다) — 엔진이 hover 를 다룰 때 사건이 이 창의 것인지 보기 때문이다. 창 번호를 싣고
    // 좌표를 창 기준으로 주면 지어내는 순간부터 제자리다.
    const LEFT_DOWN: usize = 1;
    const LEFT_UP: usize = 2;
    const RIGHT_DOWN: usize = 3;
    const RIGHT_UP: usize = 4;
    const MOVED: usize = 5;
    const LEFT_DRAGGED: usize = 6;
    const RIGHT_DRAGGED: usize = 7;
    const ENTERED: usize = 8;
    const EXITED: usize = 9;

    // **이 엔진에는 프로그램으로 hover 를 넣는 길이 없다.**
    //
    // 실측 2026-08-08 — 다섯 가지 배달을 전부 시험했고 페이지가 받은 mousemove 는 매번 0회였다:
    // 뷰에 `mouseMoved:` 직접, 창에 `sendEvent:`, 창에 붙여 지은 NSEvent, `mouseEntered:` 짝,
    // 그리고 이 프로세스 큐로 넣는 `CGEventPostToPid`. 조건도 전부 만족시켜 봤다(숨김 아님,
    // 보이는 사각형 전체, 창이 key, 그 자리에서 맨 위, 이 뷰가 입력 responder). 같은 통로로
    // 누름·뗌·끌기는 **전부 도착한다**.
    //
    // 엔진의 hover 는 실제 포인터 스트림에서만 갱신된다. 그것을 만들려면 진짜 커서를 옮겨야
    // 하고, 그것은 사람의 포인터를 빼앗는 일이라 하지 않는다.
    //
    // 그래서 조용히 실패하지 않고 이름으로 거절한다. 누름이 hover 를 만든다는 사실까지 답에
    // 싣는다 — 실측에서 클릭 한 번이 mouseover·mouseenter·pointerover 를 모두 냈다.
    if matches!(kind.as_str(), "move" | "enter" | "exit") {
        return Err(format!(
            "이 엔진은 프로그램적 hover 를 페이지에 넣지 못합니다({kind}) — 실제 포인터 스트림에서만 갱신되고, 그것을 만들려면 사람의 커서를 빼앗아야 합니다. 누름(down)이 hover 를 만듭니다."
        ));
    }
    let right = button.as_deref() == Some("right");
    let event_type = match (kind.as_str(), right) {
        ("down", false) => LEFT_DOWN,
        ("up", false) => LEFT_UP,
        ("down", true) => RIGHT_DOWN,
        ("up", true) => RIGHT_UP,
        ("move", _) => MOVED,
        // 끌기는 이동이 아니다 — 버튼이 눌린 채 움직이면 OS 가 내는 사건이 따로 있고, 그것을
        // 이동으로 보내면 페이지가 받는 mousemove 의 `buttons` 가 0 이라 끌기가 성립하지 않는다.
        ("drag", false) => LEFT_DRAGGED,
        ("drag", true) => RIGHT_DRAGGED,
        // 진입·이탈은 이동과 다른 사실이다 — 사람의 포인터는 표면에 들어오고 나간다.
        ("enter", _) => ENTERED,
        ("exit", _) => EXITED,
        (other, _) => return Err(format!("모르는 마우스 사건: {other} (down|up|move|drag|enter|exit)")),
    };
    // 더블클릭은 별개의 사건이 아니라 **같은 누름이 든 수**다 — 엔진이 이 수로 만든다.
    // 이 값을 사건에 싣지 않으면 두 번 눌러도 엔진은 단발 둘로 읽는다(실측 2026-08-08:
    // `detail` 이 네 번 다 1 이었다).
    let clicks = click_count.unwrap_or(1).max(1) as i64;
    let webview = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    webview
        .with_webview(move |platform| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            use objc2_foundation::{NSPoint, NSRect};

            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.try_send(Err("WKWebView 핸들이 비어 있습니다".to_string()));
                return;
            }
            let window: *mut AnyObject = msg_send![&*wk, window];
            if window.is_null() {
                let _ = tx.try_send(Err("WKWebView가 창에 붙어 있지 않습니다".to_string()));
                return;
            }
            let bounds: NSRect = msg_send![&*wk, bounds];
            let flipped: bool = msg_send![&*wk, isFlipped];
            let local = NSPoint::new(
                x as f64,
                if flipped { y as f64 } else { bounds.size.height - y as f64 },
            );
            let nil_view: *mut AnyObject = std::ptr::null_mut();
            let window_point: NSPoint = msg_send![&*wk, convertPoint: local, toView: nil_view];
            let window_number: isize = msg_send![&*window, windowNumber];
            let nil_ctx: *mut AnyObject = std::ptr::null_mut();
            let event_class = objc2::class!(NSEvent);
            // 누른 채인 사건은 압력이 있다 — 0 으로 보내면 엔진이 뗀 손으로 읽는다.
            let pressure: f32 = if matches!(event_type, LEFT_DOWN | RIGHT_DOWN | LEFT_DRAGGED | RIGHT_DRAGGED) { 1.0 } else { 0.0 };
            // **진입·이탈은 다른 생성자로만 지어진다.** 버튼/이동용 생성자에 그 종류를 주면
            // AppKit 이 예외를 던지고 프로세스가 그 자리에서 죽는다(실측 2026-08-08: 창이
            // 전부 사라지고 `window.list` 가 NO_HOST 를 답했다). 종류마다 지을 자리가 다르다.
            let ns_event: *mut AnyObject = if matches!(event_type, ENTERED | EXITED) {
                msg_send![
                    event_class,
                    enterExitEventWithType: event_type,
                    location: window_point,
                    modifierFlags: 0usize,
                    timestamp: 0f64,
                    windowNumber: window_number,
                    context: nil_ctx,
                    eventNumber: 0isize,
                    trackingNumber: 0isize,
                    userData: std::ptr::null_mut::<std::ffi::c_void>()
                ]
            } else {
                msg_send![
                    event_class,
                    mouseEventWithType: event_type,
                    location: window_point,
                    modifierFlags: 0usize,
                    timestamp: 0f64,
                    windowNumber: window_number,
                    context: nil_ctx,
                    eventNumber: 0isize,
                    clickCount: clicks as isize,
                    pressure: pressure
                ]
            };
            if ns_event.is_null() {
                let _ = tx.try_send(Err("마우스 NSEvent 생성 실패".to_string()));
                return;
            }
            // 지어낸 자리가 그 창의 자리인지 사건 자신에게 되묻는다 — 좌표를 못 실은 사건은
            // 보냈다고 답하면서 아무 데도 안 닿는다.
            let carried: NSPoint = msg_send![&*ns_event, locationInWindow];
            if !same_point((carried.x, carried.y), (window_point.x, window_point.y), WHEEL_POINT_TOLERANCE) {
                let _ = tx.try_send(Err(format!(
                    "마우스 사건이 창 좌표를 싣지 못했습니다: 창 ({:.1},{:.1}) 사건 ({:.1},{:.1})",
                    window_point.x, window_point.y, carried.x, carried.y,
                )));
                return;
            }
            // 이동 사건은 창이 받도록 켜져 있어야 도착한다 — 기본값은 꺼짐이고, 안 켜면
            // 보냈다고 답하면서 아무 데도 안 닿는다.
            if matches!(event_type, MOVED | ENTERED | EXITED) {
                let _: () = msg_send![&*window, setAcceptsMouseMovedEvents: true];
            }
            // 누름은 그 뷰를 입력 responder 로 만든다 — 사람이 누른 것과 같은 순서다.
            if matches!(event_type, LEFT_DOWN | RIGHT_DOWN) {
                let _: bool = msg_send![&*window, makeFirstResponder: &*wk];
            }
            let selector_sent: () = match event_type {
                LEFT_DOWN => msg_send![&*wk, mouseDown: &*ns_event],
                LEFT_UP => msg_send![&*wk, mouseUp: &*ns_event],
                RIGHT_DOWN => msg_send![&*wk, rightMouseDown: &*ns_event],
                RIGHT_UP => msg_send![&*wk, rightMouseUp: &*ns_event],
                LEFT_DRAGGED => msg_send![&*wk, mouseDragged: &*ns_event],
                RIGHT_DRAGGED => msg_send![&*wk, rightMouseDragged: &*ns_event],
                ENTERED => msg_send![&*wk, mouseEntered: &*ns_event],
                EXITED => msg_send![&*wk, mouseExited: &*ns_event],

                // 위 목록이 kind 매칭과 짝이다 — 새 종류를 더하면 여기서도 자리를 준다.
                _ => {
                    let _ = tx.try_send(Err(format!("보낼 자리가 없는 마우스 사건: {kind}")));
                    return;
                }
            };
            let _ = selector_sent;
            let _ = tx.try_send(Ok(()));
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "마우스 입력자 응답 시간 초과".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

/// child WKWebView에 실제 scroll-wheel 사건을 전달한다.
///
/// x/y는 WKWebView의 좌상단 기준 CSS px이고 dx/dy의 부호는 DOM WheelEvent와 같다
/// (+오른쪽/+아래). AppKit/Quartz의 휠 부호는 반대이므로 이 경계에서 한 번만 변환한다.
/// 창을 key/front로 만들지 않고 지정된 child에 직접 보낸다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_send_wheel(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    dx: i32,
    dy: i32,
) -> Result<(), String> {
    use core_graphics::event::{CGEvent, ScrollEventUnit};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use foreign_types::ForeignType;
    use std::sync::mpsc;
    use std::time::Duration;

    let webview = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    webview
        .with_webview(move |platform| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::msg_send;
            use objc2_foundation::{NSPoint, NSRect};

            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.try_send(Err("WKWebView 핸들이 비어 있습니다".to_string()));
                return;
            }
            let window: *mut AnyObject = msg_send![&*wk, window];
            if window.is_null() {
                let _ = tx.try_send(Err("WKWebView가 창에 붙어 있지 않습니다".to_string()));
                return;
            }

            // 명령 좌표(좌상단)를 NSView local 좌표로 바꾸고, 다시 Quartz 전역 좌표로 바꾼다.
            // 이 위치가 있어야 문서 전체뿐 아니라 포인터 아래의 중첩 스크롤 영역도 같은 입력을 받는다.
            let bounds: NSRect = msg_send![&*wk, bounds];
            let flipped: bool = msg_send![&*wk, isFlipped];
            let local = NSPoint::new(
                x as f64,
                if flipped { y as f64 } else { bounds.size.height - y as f64 },
            );
            let nil_view: *mut AnyObject = std::ptr::null_mut();
            let window_point: NSPoint = msg_send![&*wk, convertPoint: local, toView: nil_view];
            let screen_point: NSPoint = msg_send![&*window, convertPointToScreen: window_point];
            let screen_class = objc2::class!(NSScreen);
            let main_screen: *mut AnyObject = msg_send![screen_class, mainScreen];
            if main_screen.is_null() {
                let _ = tx.try_send(Err("주 화면 좌표계를 찾지 못했습니다".to_string()));
                return;
            }
            let main_frame: NSRect = msg_send![&*main_screen, frame];

            let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
                Ok(source) => source,
                Err(()) => {
                    let _ = tx.try_send(Err("CGEventSource 생성 실패".to_string()));
                    return;
                }
            };
            let event = match CGEvent::new_scroll_event(
                source,
                ScrollEventUnit::PIXEL,
                2,
                dy.saturating_neg(),
                dx.saturating_neg(),
                0,
            ) {
                Ok(event) => event,
                Err(()) => {
                    let _ = tx.try_send(Err("scroll CGEvent 생성 실패".to_string()));
                    return;
                }
            };
            // WebKit은 이 사건의 자리를 -[NSEvent locationInWindow] 하나로만 읽고, 그 값을 창
            // base 좌표로 여겨 뷰 안 지점을 만든다. 그 지점이 뷰 밖으로 떨어지면 스크롤 트리는
            // root로 폴백해 문서를 옮기지만, wheel 추적 영역 밖이라 DOM에는 아무것도 닿지 않는다.
            // 실측(2026-08-07, B11/tauri): 스크롤 좌표는 0→480→0으로 정확히 움직이는데
            // 페이지가 센 wheel 사건은 0이었다 — 자리가 조용히 틀리면 그 모습으로 나타난다.
            // 자리를 요구하는 규율은 한 자리가 든다(place_event_in_window).
            let location = (screen_point.x, main_frame.size.height - screen_point.y);
            event.set_location(CGPoint::new(location.0, location.1));
            let ns_event = match place_event_in_window(&event, location, (window_point.x, window_point.y), "휠") {
                Ok(placed) => placed,
                Err(why) => {
                    let _ = tx.try_send(Err(why));
                    return;
                }
            };
            let _: () = msg_send![&*wk, scrollWheel: &*ns_event];
            let _ = tx.try_send(Ok(()));
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "휠 입력자 응답 시간 초과".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullCaptureResult {
    path: String,
    bytes: usize,
}

/// 지정 child 문서의 전체 rect를 WebKit PDF API로 한 장 생성하고 PNG로 래스터화한다.
/// WKSnapshotConfiguration은 viewport bounds 밖을 담지 못하므로 full-page 근거로 쓰지 않는다.
/// 스크롤 위치를 변경하거나 viewport 조각을 이어 붙이지 않는다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_capture_full(
    app: AppHandle,
    label: String,
    path: String,
    width: f64,
    height: f64,
) -> Result<FullCaptureResult, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("전체 캡처 문서 크기가 유효하지 않습니다".into());
    }
    let webview = registered_webview(&app, &label).ok_or_else(|| format!("webview 없음: {label}"))?;
    let output = path.clone();
    let (tx, rx) = mpsc::sync_channel::<Result<usize, String>>(1);
    webview.with_webview(move |platform| unsafe {
        use block2::RcBlock;
        use objc2::{msg_send, runtime::AnyObject};
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let wk = platform.inner() as *mut AnyObject;
        let config: *mut AnyObject = msg_send![objc2::class!(WKPDFConfiguration), new];
        if config.is_null() {
            let _ = tx.try_send(Err("WKPDFConfiguration 생성 실패".into()));
            return;
        }
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let _: () = msg_send![&*config, setRect: rect];
        let block = RcBlock::new(move |data: *mut AnyObject, error: *mut AnyObject| {
            let result = {
                if !error.is_null() {
                    let description: *mut AnyObject = msg_send![&*error, localizedDescription];
                    Err(format!("WebKit 전체 PDF 실패: {:?}", description))
                } else if data.is_null() {
                    Err("WebKit 전체 PDF가 비었습니다".into())
                } else {
                    let image: *mut AnyObject = msg_send![objc2::class!(NSImage), alloc];
                    let image: *mut AnyObject = msg_send![&*image, initWithData: &*data];
                    if image.is_null() { return tx.try_send(Err("WebKit PDF 래스터 이미지 생성 실패".into())).unwrap_or(()); }
                    let tiff: *mut AnyObject = msg_send![&*image, TIFFRepresentation];
                    let rep: *mut AnyObject = msg_send![objc2::class!(NSBitmapImageRep), imageRepWithData: tiff];
                    let props: *mut AnyObject = msg_send![objc2::class!(NSDictionary), dictionary];
                    let png: *mut AnyObject = msg_send![&*rep, representationUsingType: 4usize, properties: props];
                    if png.is_null() { Err("WebKit PDF PNG 변환 실패".into()) } else {
                        let len: usize = msg_send![&*png, length];
                        let bytes: *const u8 = msg_send![&*png, bytes];
                        let slice = std::slice::from_raw_parts(bytes, len);
                        std::fs::write(&output, slice).map(|_| len).map_err(|e| e.to_string())
                    }
                }
            };
            let _ = tx.try_send(result);
        });
        let _: () = msg_send![&*wk, createPDFWithConfiguration: &*config, completionHandler: &*block];
    }).map_err(|error| error.to_string())?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "전체 캡처 응답 시간 초과".to_string())?
    }).await.map_err(|error| error.to_string())??;
    Ok(FullCaptureResult { path, bytes })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_capture_full(
    _app: AppHandle, _label: String, _path: String, _width: f64, _height: f64,
) -> Result<FullCaptureResult, String> {
    Err("webview_capture_full은 현재 macOS 구현이 필요합니다".into())
}

// 이 플랫폼에는 아직 이 통로가 없다 — 이름을 달고 거절한다. 조용히 성공하면 부른 쪽은
// 눌렀다고 믿는다.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_send_mouse(
    _app: AppHandle,
    _label: String,
    _x: i32,
    _y: i32,
    _kind: String,
    _button: Option<String>,
    _click_count: Option<u32>,
) -> Result<(), String> {
    Err("webview_send_mouse는 현재 macOS 구현이 필요합니다".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_send_wheel(
    _app: AppHandle,
    _label: String,
    _x: i32,
    _y: i32,
    _dx: i32,
    _dy: i32,
) -> Result<(), String> {
    Err("webview_send_wheel은 현재 macOS 입력 구현이 필요합니다".into())
}

#[derive(Clone, Serialize)]
// 카멜로 나간다 — 소비자는 카멜을 읽는다. 스네이크로 내면 undefined 를 읽고, 그것은 오류가
// 아니라 "항상 새 문서"로 나타난다(같은 축의 canBack 이 그렇게 갈렸던 자리다).
#[serde(rename_all = "camelCase")]
struct NavPayload {
    label: String,
    url: String,
    /// 문서가 바뀌었는가 — 같은 문서 안 이동이면 true.
    ///
    /// 이 축이 없으면 소비자가 새 문서와 같은 문서 안 이동을 구분 못 해 "이전 제목을 주소로
    /// 되돌린다" 같은 규칙이 모든 항행에서 돌고, 진짜 제목이 주소로 덮인다.
    /// 이 프레임워크의 페이지 적재 사건은 문서 커밋에서만 나므로 항상 false 다.
    in_page: bool,
}

// 새 링크(_blank/window.open)를 "앱 내 새 탭"으로 열 때 프론트로 보내는 페이로드.
// label = 이 이벤트를 emit 한 child webview 의 label — 플러그인 host 가 label 필터로 구독하므로
// (app.webview.on(label,"open-external")) 반드시 실어 보낸다(없으면 필터에서 드롭).
#[derive(Clone, Serialize)]
struct BrowserOpenPayload {
    label: String,
    url: String,
}

// 로딩 상태 + 히스토리 가능 여부 — 툴바 스피너/정지 토글·뒤로/앞으로 활성의 단일 소스.
// didStartProvisionalNavigation(Started)/didFinish(Finished) 시점에 emit(soksak-browser-kit nav-state 소비).
// macOS WKWebView 네비게이션/타이틀 이벤트 페이로드 — emit 이 macOS objc 경로에만 있어 다른 OS 는 미구성.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadingPayload {
    label: String,
    loading: bool,
    can_back: bool,
    can_forward: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Serialize)]
struct TitlePayload {
    label: String,
    title: String,
}

// 내장 브라우저 상태표시줄용 — 링크 hover 시 그 URL(링크를 벗어나면 빈 문자열).
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct StatusPayload {
    label: String,
    url: String,
}

// 페이지 로드 완료 시 WKWebView.title(문서 <title>)을 네이티브로 읽어 프론트로 emit.
// IPC/eval 없이 KVO 와 동일 원천(WKWebView.title) — 폴링 없음. 빈 제목은 보내지 않아
// 프론트가 호스트명 폴백을 유지한다.
#[cfg(target_os = "macos")]
fn emit_page_title<R: tauri::Runtime>(webview: &tauri::Webview<R>, label: &str) {
    let app = webview.app_handle().clone();
    let label = label.to_string();
    let _ = webview.with_webview(move |pw| unsafe {
        use objc2_web_kit::WKWebView;
        let wk = &*(pw.inner() as *const WKWebView);
        if let Some(t) = wk.title() {
            let title = t.to_string();
            if !title.is_empty() {
                let _ = app.emit(soksak_spec_content_view::TITLE, TitlePayload { label, title });
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn emit_page_title<R: tauri::Runtime>(_webview: &tauri::Webview<R>, _label: &str) {}

// ── 상태표시줄(macOS): 내장 브라우저 링크 hover 통지 ──────────────────────────
// child webview(외부 사이트)엔 Tauri IPC 가 없으므로 WKScriptMessageHandler("soksakStatus")를
// 네이티브로 등록한다 — 내비게이션 마커 우회(soksak-popup.invalid)와 달리 페이지에 부작용이 없다.
// HOVER_SCRIPT 가 링크 href 를 postMessage 하면 받아 on_message(→ browser-status emit)로 넘긴다.
#[cfg(target_os = "macos")]
mod status {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{ns_string, NSObjectProtocol, NSString};
    use objc2_web_kit::{
        WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView,
    };

    // 링크 hover 감지 — closest('a[href]').href 가 바뀔 때만 보낸다(스팸 방지). 링크를 벗어나면
    // 빈 문자열(상태표시줄 숨김). 핸들러 미등록(초기 레이스) 시 try/catch 로 조용히 무시.
    pub const HOVER_SCRIPT: &str = r#"
(function () {
  var last = null;
  var send = function (u) {
    try { window.webkit.messageHandlers.soksakStatus.postMessage(u || ""); } catch (_) {}
  };
  document.addEventListener("mouseover", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    var h = a ? a.href : "";
    if (h !== last) { last = h; send(h); }
  }, true);
})();
"#;

    pub struct StatusHandlerIvars {
        pub on_message: Box<dyn Fn(String)>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = StatusHandlerIvars]
        pub struct StatusHandler;

        unsafe impl NSObjectProtocol for StatusHandler {}

        unsafe impl WKScriptMessageHandler for StatusHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(
                this: &StatusHandler,
                _controller: &WKUserContentController,
                msg: &WKScriptMessage,
            ) {
                let body = unsafe { msg.body() };
                if let Ok(s) = body.downcast::<NSString>() {
                    (this.ivars().on_message)(s.to_string());
                }
            }
        }
    );

    // 브라우저 webview 의 userContentController 에 soksakStatus 핸들러를 등록한다(메인 스레드).
    // addScriptMessageHandler 가 핸들러를 retain → controller(=webview) 수명에 묶여 자동 해제.
    pub fn install(wk: &WKWebView, on_message: Box<dyn Fn(String)>) {
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let controller = unsafe { wk.configuration().userContentController() };
        let handler = mtm
            .alloc::<StatusHandler>()
            .set_ivars(StatusHandlerIvars { on_message });
        let handler: Retained<StatusHandler> = unsafe { msg_send![super(handler), init] };
        let proto = ProtocolObject::from_ref(&*handler);
        unsafe {
            controller.addScriptMessageHandler_name(proto, ns_string!("soksakStatus"));
        }
    }
}

// DOM 오버레이 영역(사이드바 등) 사각형 — CSS 논리 px, top-left 원점(webview_bounds 와
// 동일 규약). 프론트가 getBoundingClientRect 로 측정해 webview_dom_holes 로 보고한다.
// 커맨드는 크로스플랫폼(모든 OS 등록)이나 좌표를 실제로 소비하는 hitTest 적용은 macOS objc 경로뿐.
// ── 레이어 정공법(macOS): z-순서 역전 + 투명 홀 + hitTest 위임 ────────────────
// Tauri 에는 webview z-order API 가 없으므로(docs.rs 실측) AppKit 수준에서 직접
// 수행한다 — webview.rs 의 기존 objc2 직접 호출(타이틀 KVO/eval/클릭 모니터)과
// 같은 층위. 홀의 단일 진실 = "보이는 child webview 의 frame" 그 자체라서 별도
// rect 레지스트리가 없다(set_position/set_size/hide 가 곧 홀 갱신).
#[cfg(target_os = "macos")]
mod layer;
#[cfg(target_os = "macos")]
mod presentation_clock;
mod presentation_trace;

#[cfg(target_os = "macos")]
pub(crate) fn resize_registered_surface_hosts(window: &str) {
    layer::resize_registered_surface_hosts(window);
}

#[cfg(target_os = "macos")]
pub(crate) fn resize_pane_surface_hosts(window: &str) {
    layer::resize_pane_surface_hosts(window);
}

// 엔진 사이드카의 native surface 를 레이어 시스템(SURFACES — hitTest 위임)에 편입/해제.
// 엔진이 surface-created/destroyed 호스트 사실을 emit 하면 sidecar.rs 가 여기로 relay 한다.
// 코어는 의미를 모른다 — 포인터 멤버십만 관리(엔진 중립: WKWebView·Chromium 동일 취급).
#[cfg(target_os = "macos")]
pub(crate) fn register_engine_surface(ptr: usize, label: Option<&str>) {
    if let Some(label) = label {
        if let Err(error) = layer::register_external_surface_host(ptr, label) {
            eprintln!("[layer] external native surface 등록 실패: {error}");
        }
    } else {
        layer::register_surface(ptr, None);
    }
}
#[cfg(target_os = "macos")]
pub(crate) fn unregister_engine_surface(ptr: usize) {
    if let Some(label) = layer::surface_label(ptr) {
        layer::remove_surface_host(&label);
    } else {
        layer::unregister_surface(ptr);
    }
}
// 엔진 호스트 컨테이너 취득(격리 계약) — sidecar content_view_of 가 모듈 surface 로 넘긴다.
// 메인 스레드 전용(NSView 생성). 미설치 창·실패 시 None(호출부가 contentView 폴백).
#[cfg(target_os = "macos")]
pub(crate) fn layer_ensure_engine_host(label: &str) -> Option<usize> {
    layer::ensure_engine_host(label)
}

// 엔진 호스트 컨테이너 표시/숨김 — 렌더러 재부팅 구간의 엔진 서피스 유령 차단.
// WKWebView 는 hide() 로 숨지만 엔진(CEF) 서피스는 코어 layer 의 NSView 라 webview 목록
// 어디에도 없다(실사고: reload 후 이전 브라우저 프레임이 부트 완료까지 그대로 떠 있음 —
// 관측 기준이 WKWebView 만 봐서 "없다"고 오판했다). 숨김은 load-start(lib.rs 단일 지점),
// 복귀는 부트 말미(engine_host_visible — 플러그인 활성·이벤트 재생 후)다.
#[cfg(target_os = "macos")]
pub fn set_engine_host_hidden(app: &AppHandle, label: String, hidden: bool) {
    let app2 = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        // 개별 서피스의 setHidden 직접 조작은 금지다 — WKWebView 는 hide→show 기상 로직
        // (wake_child_if_was_hidden — "레이어를 비운 채 잠듦" 방지)이 코어 hide 경로의 추적에
        // 걸려야 깨어난다. 직접 setHidden 은 그 추적을 우회해, 복귀 show 가 와도 픽셀이
        // 돌아오지 않는다(실사고: 활성 구글 페인이 검게 "안뜸"). 재부팅 숨김의 정본은
        // ① b-* child 는 wv.hide()(load-start 훅의 hidden-at-reload — 기상 추적에 실린다),
        // ② 엔진(CEF) 표면은 이 컨테이너(조상) 숨김 + 소유자(플러그인 장부)의 개별 지시다.
        let ptr = layer::engine_host_ptr(&label);
        if ptr == 0 {
            return;
        }
        let view: &objc2_app_kit::NSView = unsafe { &*(ptr as *const objc2_app_kit::NSView) };
        view.setHidden(hidden);
        crate::activity::publish(
            &app2,
            "webview.lifecycle",
            "webview",
            serde_json::json!({
                "event": if hidden { "engine-host-hidden" } else { "engine-host-shown" },
                "label": label,
                "origin": "internal",
                "message": format!("· engine host {}", if hidden { "hidden" } else { "shown" }),
            }),
        );
    });
}

// 부트 말미의 엔진 호스트 복귀(재부팅 숨김의 대칭 해제). 창 자동 주입(MW2).
#[tauri::command]
pub fn engine_host_visible(app: AppHandle, window: tauri::Window, visible: bool) {
    #[cfg(target_os = "macos")]
    set_engine_host_hidden(&app, window.label().to_string(), !visible);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, window, visible);
}

// DOM 오버레이 홀 관측 — 네이티브 층 아래에서도 DOM 이 마우스를 갖는 사각형들.
// 골·사이드바처럼 "DOM 이 받아야 하는 자리"의 계약을 값으로 읽는다(ui.holes).
#[tauri::command]
pub fn webview_holes(window: tauri::Window) -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        return layer::holes_of(window.label())
            .into_iter()
            .map(|h| serde_json::json!({ "x": h.x, "y": h.y, "w": h.w, "h": h.h }))
            .collect();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Vec::new()
    }
}

// 엔진 서피스 관측 — webview.surfaces 의 engine 축(WKWebView 목록이 못 보는 표면).
// 서피스별 실측: isHidden(자기 축)·effectivelyHidden(조상 포함 — 화면 사실)·frame 을
// 메인 스레드에서 직독한다. "registered 카운트" 기준은 유령을 못 갈랐다(실사고: 사용자는
// 이전 프레임을 보는데 카운트는 정상) — 판정 축은 개별 가시 사실이다.
#[tauri::command]
pub async fn engine_surface_stats(app: AppHandle, window: tauri::Window) -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_string();
        let ns_win = window.ns_window().ok().map(|p| p as usize).unwrap_or(0);
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        let _ = app.run_on_main_thread(move || {
            let preserves_content_during_live_resize = if ns_win != 0 {
                let native: &objc2_app_kit::NSWindow =
                    unsafe { &*(ns_win as *const objc2_app_kit::NSWindow) };
                native.preservesContentDuringLiveResize()
            } else {
                true
            };
            let host = layer::engine_host_ptr(&label);
            let host_hidden = if host != 0 {
                let v: &objc2_app_kit::NSView = unsafe { &*(host as *const objc2_app_kit::NSView) };
                v.isHidden()
            } else {
                true
            };
            // 창 소속은 판독 시점에 AppKit 실측 — 레지스트리는 ptr 만 알고(사이드카 발행에
            // 창 정보가 없다), NSView.window() 가 소속의 단일 진실이다. 남의 창 서피스를
            // 자기 화면 기준으로 판정하던 오염(실사고: 브라우저 없는 창에서 misplaced ×2,
            // holes 0)을 스코프로 막는다. 남의 창 것은 숫자만 남긴다(숨기지 않는다).
            let mut surfaces = Vec::new();
            let live = layer::live_registered_views(ns_win);
            let renderer_topology = live
                .first()
                .map(|ptr| layer::renderer_topology(&label, *ptr))
                .unwrap_or(serde_json::Value::Null);
            let other_windows = layer::surface_count().saturating_sub(live.len());
            for ptr in live {
                let v: &objc2_app_kit::NSView = unsafe { &*(ptr as *const objc2_app_kit::NSView) };
                let _ = ns_win; // 소속은 live 순회(이 창 트리)가 이미 보장한다
                let f = v.frame();
                let surface_label = layer::surface_label(ptr);
                let surface_pane = layer::surface_pane(surface_label.as_deref());
                // 통과시키는 빛 — hidden 과 같은 두 축이다. alpha 는 이 표면 자신의 선언이고
                // effectiveAlpha 는 조상까지 곱한 화면의 사실이다. 판정하는 쪽이 "어댑터가
                // 이중으로 감광하지 않는다"를 물을 자리가 여기 말고 없다.
                let mut effective_alpha = v.alphaValue();
                let mut ancestor = unsafe { v.superview() };
                while let Some(parent) = ancestor {
                    effective_alpha *= parent.alphaValue();
                    ancestor = unsafe { parent.superview() };
                }
                surfaces.push(serde_json::json!({
                    "ptr": ptr,
                    "label": surface_label,
                    "pane": surface_pane,
                    "hidden": v.isHidden(),
                    "effectivelyHidden": unsafe { v.isHiddenOrHasHiddenAncestor() },
                    "alpha": v.alphaValue(),
                    "effectiveAlpha": effective_alpha,
                    "autoresizingMask": v.autoresizingMask().0,
                    "layerContentsRedrawPolicy": v.layerContentsRedrawPolicy().0,
                    "layerContentsPlacement": v.layerContentsPlacement().0,
                    "frame": { "x": f.origin.x, "y": f.origin.y, "w": f.size.width, "h": f.size.height },
                }));
            }
            let _ = tx.send(serde_json::json!({
                "registered": surfaces.len(),
                "otherWindows": other_windows,
                "hostPresent": host != 0,
                "hostHidden": host_hidden,
                "preservesContentDuringLiveResize": preserves_content_during_live_resize,
                "rendererTopology": renderer_topology,
                "windowZoom": SURFACE_LAYOUT.window_zoom(&label),
                "surfaces": surfaces,
            }));
        });
        return rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_else(|_| serde_json::json!({ "error": "main-thread timeout" }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
        serde_json::json!({ "registered": 0, "hostPresent": false })
    }
}

// 오버레이(모달/메뉴/드롭다운) 상태 동기화 — 프론트 ui 스토어 카운터가 0↔1 을
// 넘을 때 호출한다. true 면 홀 마우스 통과 차단(hitTest 가 DOM 에 우선권).
#[tauri::command]
pub fn webview_overlay_active(window: tauri::Window, active: bool) {
    // window = 호출 창(MW2 — 자동 인지). 그 창의 오버레이 게이트만 갱신(프론트 label 전달 불요).
    #[cfg(target_os = "macos")]
    layer::set_overlay(window.label(), active);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, active);
}

// 패널 디바이더 드래그 제스처 릴레이 — 프론트(GroupArea)가 드래그 시작/끝에 호출한다.
// 코어 layer 안의 child(WKWebView)는 DOM freeze-frame 이 위에서 덮으므로 조치 불요하나,
// 엔진 사이드카(CEF) surface 는 코어 layer 밖(DOM 위)이라 모듈이 직접 숨김/유예해야 한다
// → 같은 호스트 사실을 로드된 모듈 전부에 통지(webview_overlay_active 와 동형, relay 만).
#[tauri::command]
pub fn webview_resize_gesture(window: tauri::Window, active: bool) {
    crate::sidecar::notify_all(&serde_json::json!({
        "type": "resize-gesture",
        "window": window.label(),
        "active": active,
    }));
}

// DOM 오버레이 홀 동기화 — 프론트가 사이드바 열림/닫힘·폭 변화·창 리사이즈 시 측정해 보고.
// 닫힘이면 빈 배열을 보내 홀을 비운다. holes 안은 풀사이즈 브라우저 위라도 DOM 이 받는다.
#[tauri::command]
pub fn webview_dom_holes(window: tauri::Window, holes: Vec<Hole>) {
    // window = 호출 창(자동 인지). 그 창의 홀만 갱신(프론트 label 전달 불요).
    #[cfg(target_os = "macos")]
    layer::set_holes(window.label(), holes);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, holes);
}

// 실측 프로브: 메인 창 뷰 계층 덤프(레이어 가정 검증·진단용).
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_debug_hierarchy(window: tauri::Window) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    // window = 호출 창(MW2). 그 창의 뷰 계층을 덤프 — 소켓이 emit_to 로 타겟 창에 보내므로 자동.
    let (tx, rx) = mpsc::sync_channel::<String>(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let mut out = String::new();
            unsafe {
                if let Ok(ns) = win.ns_window() {
                    let win_obj = &*(ns as *const objc2::runtime::AnyObject);
                    let content: *mut objc2_app_kit::NSView =
                        objc2::msg_send![win_obj, contentView];
                    if !content.is_null() {
                        layer::dump_view(&*content, 0, &mut out);
                    }
                }
            }
            let _ = tx.try_send(out);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "계층 덤프 시간 초과".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_debug_hierarchy(_app: AppHandle) -> Result<String, String> {
    Err("webview_debug_hierarchy 는 현재 macOS 전용".into())
}

// 한 창의 webview 에 레이어 역전 설치 — setup(main)·새 창 생성 시 그 창 label 로 호출.
#[cfg(target_os = "macos")]
pub fn install_layer_inversion(app: &AppHandle, label: &str) {
    layer::install(app, label);
}

static POPUP_SEQ: AtomicUsize = AtomicUsize::new(1);
const POPUP_MARKER_HOST: &str = "soksak-popup.invalid";

// 새 창 요청(target=_blank / window.open)을 마커 네비게이션으로 바꾼다. 외부 페이지는
// Tauri IPC 권한이 없으므로(주면 보안 구멍) "네비게이션" 자체를 채널로 쓴다 —
// on_navigation 이 마커를 감지해 차단하고 내장 브라우저 새 창(독립 OS 윈도우)을 연다.
const NEW_WINDOW_NAV: &str = r#"
(function () {
  var pop = function (u) {
    try {
      if (u) location.href = "https://soksak-popup.invalid/?u=" + encodeURIComponent(u);
    } catch (_) {}
  };
  window.open = function (u, target) {
    var tg = (target || "").toString().toLowerCase();
    if (u && (tg === "_self" || tg === "_top" || tg === "_parent")) { try { location.href = u; } catch (_) {} return window; }
    pop(u); return null;
  };
  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[target="_blank"]') : null;
    if (a && a.href) { e.preventDefault(); pop(a.href); }
  }, true);
})();
"#;

// 범용 미디어 스니프 — 페이지가 스스로 요청하는 미디어 URL(m3u8/mpd/mp4/...)을 패시브 기록한다.
// init script 라 페이지 스크립트보다 먼저 돌아 로드 시점의 요청까지 잡는다. 사이트 지식 0(어떤 페이지든
// 자기 미디어를 요청하면 기록 — 난독화·차단과 무관, 디코드 불요). 기록만 하고 동작은 안 바꾼다(near-zero
// 비용). 소비자는 window.__soksakMedia 를 webview_eval 로 읽는다(browser.media.sniff). 재사용 substrate.
const MEDIA_SNIFF: &str = r#"
(function () {
  if (window.__soksakMedia) return;
  var seen = {}, list = [];
  window.__soksakMedia = list;
  var RE = /\.(m3u8|mpd|mp4|m4s|webm|ts)(\?|#|$)/i;
  function add(u, via) {
    try {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('//') === 0) u = location.protocol + u;
      else if (u.charAt(0) === '/') u = location.origin + u;
      else if (!/^https?:/i.test(u)) return;
      if (!RE.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      list.push({ url: u, via: via, ref: location.href });
    } catch (_) {}
  }
  try {
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { add(u, 'xhr'); return ox.apply(this, arguments); };
  } catch (_) {}
  try {
    var of = window.fetch;
    if (of) window.fetch = function (i) {
      try { add(typeof i === 'string' ? i : (i && i.url), 'fetch'); } catch (_) {}
      return of.apply(this, arguments);
    };
  } catch (_) {}
  try {
    var mo = new MutationObserver(function (muts) {
      for (var a = 0; a < muts.length; a++) {
        var ns = muts[a].addedNodes || [];
        for (var b = 0; b < ns.length; b++) {
          var n = ns[b];
          if (!n || !n.tagName) continue;
          if ((n.tagName === 'VIDEO' || n.tagName === 'SOURCE') && n.src) add(n.src, n.tagName.toLowerCase());
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
"#;

// 마커 네비게이션이면 새 창으로 열 대상 URL 을 추출(query_pairs 가 percent-decode).
fn popup_target(url: &Url) -> Option<Url> {
    if url.host_str() != Some(POPUP_MARKER_HOST) {
        return None;
    }
    let u = url.query_pairs().find(|(k, _)| k == "u")?.1.into_owned();
    Url::parse(&u).ok()
}

// 내장 브라우저 새 창(독립 OS 윈도우). 새 창 안의 _blank 도 다시 새 창(재귀).
fn open_popup(app: &AppHandle, url: Url) {
    let label = format!("popup-{}", POPUP_SEQ.fetch_add(1, Ordering::Relaxed));
    let title = url.host_str().unwrap_or("browser").to_string();
    let nav_app = app.clone();
    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1100.0, 800.0)
        .initialization_script(NEW_WINDOW_NAV)
        .on_navigation(move |u| {
            if let Some(target) = popup_target(u) {
                open_popup(&nav_app, target);
                return false;
            }
            true
        })
        .build();
    if let Err(e) = result {
        eprintln!("popup 창 생성 실패: {e}");
    }
}

// child webview 생성(이미 있으면 무시). label = "b-<windowLabel>-<viewId>"(프론트 webviewLabels 단일
// 진실이 창 네임스페이스로 만든다 — Tauri webview label 은 앱 전역 유일해야 하므로 창별 viewId 만으론
// 충돌). Rust 는 그 label 을 받아 add_child 할 뿐 형식은 프론트가 소유.
#[tauri::command]
pub fn webview_open(
    app: AppHandle,
    window: tauri::Window,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    transparent: Option<bool>,
    layout: Option<SurfaceLayoutContract>,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    eprintln!("[open-trace] webview_open {label} 진입 (url={url})");
    if let Some(existing) = registered_webview(&app, &label) {
        // 실물 생존 검사 — 라벨은 registry 에 살아있어도 native view 가 창에서 떨어져 나간
        // 좀비일 수 있다(실사고: close 가 반쯤 진행된 라벨에 open 이 no-op → 영구 빈 홀,
        // visible/list 도 건강 오판). open 의 계약은 "호출하면 반드시 살아있는 child"다 —
        // 좀비면 잔재를 정리하고 아래에서 신규 생성한다. 검사·정리는 메인스레드 인라인.
        if child_is_newborn(&label) || native_child_alive(&existing) {
            #[cfg(target_os = "macos")]
            if let Some(layout) = layout {
                let _ = layer::accept_surface_layout(&label, layout);
            }
            #[cfg(debug_assertions)]
            eprintln!("[open-trace] webview_open {label}: 기존 생존 — no-op");
            return Ok(());
        }
        #[cfg(debug_assertions)]
        eprintln!("[vis-trace] webview_open {label}: 좀비 감지 — 정리 후 재생성");
        #[cfg(target_os = "macos")]
        layer::remove_surface_host(&label);
        let _ = existing.close();
        if registered_webview(&app, &label).is_some() {
            // close 정리가 아직 안 끝났다 — 충돌 생성 대신 명시 실패(호출자 힐이 재시도한다).
            return Err(format!("webview {label} 좀비 정리 대기 — 재시도 필요"));
        }
    }
    // window = 이 명령을 invoke 한 창(MW2 — Tauri 가 호출 창을 주입). 그 창에 child webview 를
    // 붙이므로 멀티 윈도우에서 BrowserView 가 실행된 창에 정확히 들어간다(프론트 label 전달 불요).
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let nav_app = app.clone();
    let nav_label = label.clone();
    let pl_app = app.clone();
    let pl_label = label.clone();
    let pl_window = window.label().to_owned();
    record_page_load(&label, &pl_window, "about:blank", false);
    // 상태표시줄용 hover 스크립트를 함께 주입(macOS — 메시지 핸들러가 받는다). 비-macOS 는 생략.
    #[cfg(target_os = "macos")]
    let init_script = format!("{NEW_WINDOW_NAV}\n{MEDIA_SNIFF}\n{}", status::HOVER_SCRIPT);
    #[cfg(not(target_os = "macos"))]
    let init_script = format!("{NEW_WINDOW_NAV}\n{MEDIA_SNIFF}");
    // Pane UI renderer만 생성 전부터 투명하다. 생성 뒤 WKWebView에 KVC를 쓰면 이미 만들어진
    // backing store의 흰 배경이 남는다. 일반 브라우저 surface는 기본 false라 페이지가
    // 불투명한 문서 표면이라는 기존 계약을 유지한다.
    let transparent = transparent.unwrap_or(false);
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .transparent(transparent)
        .initialization_script(init_script)
        // 새 창 마커(_blank 등)는 차단하고 내장 브라우저 새 창으로. URL 동기화는 여기서 하지 않는다 —
        // on_navigation 은 iframe 등 서브프레임 내비게이션에도 발화하고(wry 가 프레임 정보를 주지 않아
        // 메인/서브 구분 불가) 그러면 주소창이 서브프레임 URL(예: 구글 ogs 위젯)로 오염된다.
        // 주소창은 메인프레임 전용 신호인 on_page_load 로만 갱신한다.
        .on_navigation(move |url| {
            if let Some(target) = popup_target(url) {
                // 마커 가로채기는 항상 차단(false). 새 탭/새 창 분기는 프론트 설정이
                // 소유하므로 여기선 무조건 emit — 프론트가 browserNewWindow 로 라우팅한다.
                let _ = nav_app.emit(
                    soksak_spec_content_view::OPEN_EXTERNAL,
                    BrowserOpenPayload {
                        label: nav_label.clone(),
                        url: target.to_string(),
                    },
                );
                return false;
            }
            true // 허용
        })
        // 메인프레임 커밋/완료(didCommit/didFinish) 시점의 URL 만 주소창에 반영 — 서브프레임은 안 온다.
        // about:blank 는 WKWebView 초기화 중간 단계라 제외. 완료 시 문서 <title> 도 함께 emit.
        .on_page_load(move |webview, payload| {
            let u = payload.url().as_str();
            let finished = payload.event() == tauri::webview::PageLoadEvent::Finished;
            record_page_load(&pl_label, &pl_window, u, finished);
            if u != "about:blank" {
                let _ = pl_app.emit(
                    soksak_spec_content_view::NAV,
                    NavPayload {
                        label: pl_label.clone(),
                        url: u.to_string(),
                        in_page: false,
                    },
                );
            }
            if finished {
                emit_page_title(&webview, webview.label());
            }
            // 로딩 상태 emit — canGoBack/canGoForward 는 WKWebView 속성(메인스레드 디스패치 안에서 읽음).
            #[cfg(target_os = "macos")]
            {
                let ld_app = pl_app.clone();
                let ld_label = pl_label.clone();
                let _ = webview.with_webview(move |pw| unsafe {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;
                    let wk = pw.inner() as *mut AnyObject;
                    if wk.is_null() {
                        return;
                    }
                    let can_back: bool = msg_send![&*wk, canGoBack];
                    let can_forward: bool = msg_send![&*wk, canGoForward];
                    let _ = ld_app.emit(
                        soksak_spec_content_view::LOADING,
                        LoadingPayload {
                            label: ld_label.clone(),
                            loading: !finished,
                            can_back,
                            can_forward,
                        },
                    );
                });
            }
        });
    let webview = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[open-trace] webview_open {label}: add_child 실패 — {e}");
            e.to_string()
        })?;
    #[cfg(debug_assertions)]
    eprintln!("[open-trace] webview_open {label}: 생성 완료");
    crate::activity::publish(
        &app,
        "webview.lifecycle",
        "webview",
        serde_json::json!({ "label": label, "event": "created", "origin": "internal",
            "message": format!("· webview created {label}") }),
    );
    // 출생 기록 — 부착 완료 전 신생아를 생존 프로브(webview_alive/open 좀비 검사)가
    // 좀비로 오판해 정리하는 자멸을 막는다(유예 NEWBORN_GRACE_MS).
    if let Ok(mut m) = CHILD_BORN_AT.lock() {
        m.insert(label.clone(), std::time::Instant::now());
    }
    // 멀티 웹뷰 원칙: child는 자기 bounds에서 직접 합성되며 정상 상태의 z-order는 메인 앞에 고정한다.
    #[cfg(target_os = "macos")]
    {
        // WKWebView를 직접 화면 배치하지 않는다. 전용 layer-backed host가 z-order·frame·motion·
        // hit-test surface를 소유하고, WKWebView는 그 안의 고정 로컬 child다.
        layer::adopt_surface_host(&webview, &label, window.label(), transparent);
        if let Some(layout) = layout {
            let _ = layer::accept_surface_layout(&label, layout);
        }
        // 상태표시줄: 링크 hover → browser-status emit. 메시지 핸들러를 이 webview 에 등록.
        let st_app = app.clone();
        let st_label = label.clone();
        let _ = webview.with_webview(move |pw| {
            use objc2_web_kit::WKWebView;
            let wk = unsafe { &*(pw.inner() as *const WKWebView) };
            status::install(
                wk,
                Box::new(move |url| {
                    let _ = st_app.emit(
                        soksak_spec_content_view::STATUS,
                        StatusPayload {
                            label: st_label.clone(),
                            url,
                        },
                    );
                }),
            );
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = webview;
    Ok(())
}

// native 마우스 브릿지(App 의 native-mousedown/move/up)를 소켓으로 구동 — 브라우저(네이티브 child)
// 위 divider 드래그를 실제 마우스 없이 E2E 자가검증한다(ui.input.drag 와 짝: 이건 native 경로,
// 그건 DOM 경로). kind = native-mousedown | native-mousemove | native-mouseup. 전역 emit —
// App 의 getCurrentWebviewWindow().listen 은 전역 이벤트도 받는다.
/// 창 전체 줌(플랜 golden-swinging-lynx §2단계) — "값 하나, 소비 전원": 메인 웹뷰와 이 창의
/// 모든 자식 웹뷰(b-<label>-*)에 같은 배율을 일괄 적용한다. CEF 엔진 표면은 사이드카 계약
/// 확장(후속 레인). 배율은 0.5..2.0 클램프(프론트 계약과 동일).
#[tauri::command]
pub fn webview_zoom(window: tauri::Window, factor: f64) -> Result<(), String> {
    let f = factor.clamp(0.5, 2.0);
    let label = window.label().to_string();
    let app = window.app_handle();
    SURFACE_LAYOUT.set_window_zoom(&label, f);
    let child_prefix = format!("b-{label}-");
    for (wl, wv) in app.webviews() {
        if wl == label {
            wv.set_zoom(f).map_err(|e| e.to_string())?;
        }
        if wl.starts_with(&child_prefix) {
            wv.set_zoom(f * SURFACE_LAYOUT.view_zoom(&wl)).map_err(|e| e.to_string())?;
            // 프레임도 같은 배율로 즉시 재배치 — 프론트 레이아웃(CSS px)은 불변이라 여기서만 안다.
            if let Some(raw) = SURFACE_LAYOUT.raw(&wl) {
                apply_child_bounds(&wv, &wl, raw)?;
            }
        }
    }
    Ok(())
}

/// 뷰-단위 페이지 줌(플랜 3단계) — 브라우저 뷰 포커스 시 ⌘±의 응답. 유효 배율 =
/// 창 배율 × 뷰 배율(프레임은 창 배율만 — 콘텐츠 전용 축). 0.25..4.0 클램프(브라우저 관례).
#[tauri::command]
pub fn webview_zoom_view(app: AppHandle, label: String, factor: f64) -> Result<f64, String> {
    let f = factor.clamp(0.25, 4.0);
    SURFACE_LAYOUT.set_view_zoom(&label, f);
    if let Some(wv) = registered_webview(&app, &label) {
        let win_f = SURFACE_LAYOUT.window_zoom(wv.window().label());
        wv.set_zoom(win_f * f).map_err(|e| e.to_string())?;
    }
    Ok(f)
}

#[tauri::command]
pub fn webview_emit_native(window: tauri::Window, kind: String, x: f64, y: f64) {
    use tauri::Emitter;
    let _ = window
        .app_handle()
        .emit(&kind, serde_json::json!({ "x": x, "y": y }));
}

// hover 중인 divider(리사이즈 경계) 강조 — 프론트가 그 요소의 화면 rect 를 넘기면 코어가 accent 바를
// 브라우저 위 네이티브 레이어에 그린다(rect=None → 숨김). 네이티브 child 위에서도 보이는 유일한 길.
// 커맨드는 크로스플랫폼이나 rect 좌표를 그리는 네이티브 레이어는 macOS objc 경로뿐.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Deserialize)]
pub struct HlRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
#[tauri::command]
pub fn webview_divider_highlight(window: tauri::Window, rect: Option<HlRect>) {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        appkit_events::set_divider_highlight(
            &app,
            window.label().to_string(),
            rect.map(|r| (r.x, r.y, r.w, r.h)),
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, rect);
    }
}

// bounds 기반 가시성 동기화 상태 — 마지막으로 적용한 visible 값(라벨별). 변화시에만 show/hide
// 를 호출한다(bounds 는 드래그 중 ~30Hz — 매번 show 하면 WebKit 재합성 낭비). webview_close 가
// 지운다(라벨 재사용 시 stale 판정 방지).
// 창별 줌 배율(webview_zoom 이 기록) — 자식 웹뷰 배치는 CSS px 로 오므로, 메인 웹뷰가
// 줌되면 화면상 위치·크기는 배율만큼 이동한다. bounds 적용 시 이 배율을 곱해야 프레임과
// 콘텐츠(자식 자체 줌)가 나머지 UI 와 한 몸으로 스케일된다(실측: 미적용 시 프레임 제자리
// + 콘텐츠만 확대 = 브라우저 깨짐).
#[cfg(target_os = "macos")]
fn set_child_frame(
    wv: &tauri::Webview,
    label: &str,
    bounds: (f64, f64, f64, f64),
) -> Result<(), String> {
    let label = label.to_string();
    let (applied_tx, applied_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    wv.with_webview(move |pw| {
        let applied: Result<(), String> = (|| unsafe {
            use objc2_app_kit::NSView;
            use objc2_foundation::{NSPoint, NSRect, NSSize};

            let view = &*(pw.inner() as *const NSView);
            let Some(parent) = view.superview() else {
                return Err("native surface parent가 없다".into());
            };
            let host_ptr = layer::surface_host_ptr(&label);
            let coordinate_parent = if host_ptr != 0 {
                parent.superview().unwrap_or_else(|| parent.clone())
            } else {
                parent.clone()
            };
            let (x, y, w, h) = top_left_rect_to_parent_frame(
                coordinate_parent.bounds().size.height,
                coordinate_parent.isFlipped(),
                bounds,
            );
            let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(w, h));
            objc2_quartz_core::CATransaction::begin();
            objc2_quartz_core::CATransaction::setDisableActions(true);
            if host_ptr != 0 {
                let host = &*(host_ptr as *const NSView);
                host.setFrame(frame);
                view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)));
                layer::settle_surface_frame(view);
            } else {
                view.setFrame(frame);
                layer::settle_surface_frame(view);
            }
            objc2_quartz_core::CATransaction::commit();
            Ok(())
        })();
        let _ = applied_tx.send(applied);
    })
    .map_err(|e| e.to_string())?;
    applied_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|error| format!("native surface frame ACK 실패: {error}"))?
}

#[cfg(target_os = "macos")]
fn prepare_child_frame_transition(
    wv: &tauri::Webview,
    label: &str,
    bounds: (f64, f64, f64, f64),
    start_at_unix_ms: f64,
    duration_ms: f64,
) -> Result<(), String> {
    let label = label.to_string();
    let (applied_tx, applied_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    wv.with_webview(move |pw| {
        let applied: Result<(), String> = (|| unsafe {
            use objc2_app_kit::NSView;
            use objc2_foundation::{NSPoint, NSRect, NSSize};

            let view = &*(pw.inner() as *const NSView);
            let Some(parent) = view.superview() else {
                return Err("native surface parent가 없다".into());
            };
            let host_ptr = layer::surface_host_ptr(&label);
            if host_ptr == 0 {
                return Err(format!("native surface host가 없다: {label}"));
            }
            let coordinate_parent = parent.superview().unwrap_or_else(|| parent.clone());
            let (x, y, w, h) = top_left_rect_to_parent_frame(
                coordinate_parent.bounds().size.height,
                coordinate_parent.isFlipped(),
                bounds,
            );
            let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(w, h));
            layer::prepare_surface_host_translation(
                &label,
                view,
                frame,
                start_at_unix_ms,
                duration_ms,
            )
        })();
        let _ = applied_tx.send(applied);
    })
    .map_err(|error| error.to_string())?;
    applied_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|error| format!("native surface transition ACK 실패: {error}"))?
}

fn apply_child_bounds(
    wv: &tauri::Webview,
    label: &str,
    raw: (f64, f64, f64, f64),
) -> Result<(), String> {
    let win = wv.window();
    let f = SURFACE_LAYOUT.window_zoom(win.label());
    let (x, y, w, h) = scale_rect(raw, f);
    let prev = SURFACE_LAYOUT.applied(label);
    let (moved, resized) = rect_delta(prev, (x, y, w, h));
    if moved || resized {
        #[cfg(target_os = "macos")]
        set_child_frame(wv, label, (x, y, w, h))?;
        #[cfg(not(target_os = "macos"))]
        {
            if moved {
                wv.set_position(LogicalPosition::new(x, y))
                    .map_err(|e| e.to_string())?;
            }
            if resized {
                wv.set_size(LogicalSize::new(w, h))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    SURFACE_LAYOUT.set_applied(label, (x, y, w, h));
    Ok(())
}

// 패널 레이아웃 변화(분할/리사이즈/이동)에 맞춰 위치/크기 동기화.
//
// 이 명령은 순수 기하다. 같은 화면 좌표를 가진 비활성 탭도 존재하므로 rect는 가시성의 증거가
// 아니다. show/hide는 `webview_visible` 한 경로와 프론트의 `commitViewVisibility` 장부만 소유한다.
#[tauri::command]
pub fn webview_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    layout: Option<SurfaceLayoutContract>,
) -> Result<(), String> {
    if let Some(wv) = registered_webview(&app, &label) {
        // 갱신 케이던스 실측 트레이스(디버그 빌드 전용) — 위치 추종이 굼뜰 때 JS→Rust 송신
        // 주기를 dev 로그에서 바로 읽는다(스크린 녹화 없이 병목 층위 판정).
        #[cfg(debug_assertions)]
        eprintln!(
            "[bounds-trace] {} t={:.1} x={x:.0} y={y:.0} w={w:.0} h={h:.0}",
            label,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0)
        );
        SURFACE_LAYOUT.set_raw(&label, (x, y, w, h));
        #[cfg(target_os = "macos")]
        if let Some(layout) = layout {
            if !layer::accept_surface_layout(&label, layout) {
                #[cfg(debug_assertions)]
                eprintln!("[bounds-trace] {label} stale viewport 계약 거부");
                return Ok(());
            }
        }
        apply_child_bounds(&wv, &label, (x, y, w, h))?;
    }
    Ok(())
}

/**
 * 직전 frame/가시성 변경이 WebKit 원격 표시 트리에 반영된 후에만 답한다.
 * `afterScreenUpdates=true` snapshot 완료는 이미지를 제품에 쓰려는 것이 아니라 WKWebView가
 * pending screen update를 소비했다는 공식 완료 에지를 쓰는 표시 장벽이다.
 */
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_presented(app: AppHandle, label: String) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let Some(wv) = registered_webview(&app, &label) else {
        if !layer::has_surface_host(&label) {
            return Err(format!("webview 또는 external surface 없음: {label}"));
        }
        let scheduler = app.clone();
        let failure_label = label.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        scheduler
            .run_on_main_thread(move || {
                let result = layer::settle_external_surface_presentation(&label);
                let _ = tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        return rx
            .await
            .map_err(|_| format!("external surface presentation ACK 단절: {failure_label}"))?;
    };
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    wv.with_webview(move |pw| unsafe {
        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSImage;
        use objc2_foundation::NSError;
        use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

        let wk = &*(pw.inner() as *const WKWebView);
        let mtm = MainThreadMarker::new_unchecked();
        let config = WKSnapshotConfiguration::new(mtm);
        config.setAfterScreenUpdates(true);
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let outcome = if !error.is_null() {
                Err((*error).localizedDescription().to_string())
            } else if image.is_null() {
                Err("WKWebView 표시 snapshot이 비었습니다".into())
            } else {
                Ok(())
            };
            let _ = tx.try_send(outcome);
        });
        wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
    })
    .map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "WKWebView 표시 정착 시간 초과".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_presented(_app: AppHandle, _label: String) -> Result<(), String> {
    Ok(())
}

/** Tauri-only: 목표 model frame과 위치 전용 Core Animation을 DOM FLIP의 절대 epoch에 무장한다. */
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_transition_prepare(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    start_at_unix_ms: f64,
    duration_ms: f64,
) -> Result<(), String> {
    let Some(webview) = registered_webview(&app, &label) else { return Err(format!("webview 없음: {label}")); };
    let raw = (x, y, w, h);
    let factor = SURFACE_LAYOUT.window_zoom(webview.window().label());
    let scaled = scale_rect(raw, factor);
    prepare_child_frame_transition(&webview, &label, scaled, start_at_unix_ms, duration_ms)?;
    SURFACE_LAYOUT.set_raw(&label, raw);
    SURFACE_LAYOUT.set_applied(&label, scaled);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_transition_prepare(
    _app: AppHandle,
    _label: String,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
    _start_at_unix_ms: f64,
    _duration_ms: f64,
) -> Result<(), String> {
    Err("native compositor 위치 거래는 이 Tauri 플랫폼에 구현되지 않았다".into())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_transition_cancel(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let Some(webview) = registered_webview(&app, &label) else { return Ok(()); };
    let cancel_label = label.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    webview.with_webview(move |_| {
        layer::cancel_surface_host_translation(&cancel_label);
        let _ = tx.send(());
    }).map_err(|error| error.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|error| format!("native surface transition cancel ACK 실패: {error}"))?;
    let raw = (x, y, w, h);
    SURFACE_LAYOUT.set_raw(&label, raw);
    apply_child_bounds(&webview, &label, raw)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_transition_cancel(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    webview_bounds(app, label, x, y, w, h, None)
}

#[tauri::command]
pub fn webview_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let wv = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview not found: {label}"))?;
    wv.navigate(Url::parse(&url).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 인스펙트(devtools) 토글 — 이 브라우저 child webview 의 Web Inspector 를 연다/닫는다.
// WKWebView 는 CDP 가 없어 OS 인스펙터(WebKit Web Inspector)가 뜬다. devtools = debug 빌드 또는 devtools feature.
// **반드시 별도 창**: wry open_devtools 는 [_inspector show] 만 호출 → WebKit 이 마지막 도킹 상태를 기억해
// 브라우저 패널 '안'에 도킹돼 뜰 때가 있다. show 직후 [_inspector detach] 를 보내 항상 떼어낸 창으로 강제한다.
// 반환 = 토글 후 열림 여부(UI 버튼 on 동기화).
#[tauri::command]
pub fn webview_devtools(app: AppHandle, label: String) -> Result<bool, String> {
    if let Some(wv) = registered_webview(&app, &label) {
        if wv.is_devtools_open() {
            wv.close_devtools();
            Ok(false)
        } else {
            wv.open_devtools(); // [_inspector show] — 비동기(프론트엔드 로드). 마지막 도킹 상태로 뜸.
            #[cfg(target_os = "macos")]
            {
                // [_inspector detach] — 도킹 해제(반드시 별도 창, _WKInspector WebKit SPI). show 가 비동기라
                // 인스펙터가 연결된 뒤 떼어내야 한다 → 잠깐 대기 후 detach(with_webview 가 메인스레드 디스패치).
                let wv2 = wv.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(450));
                    let _ = wv2.with_webview(|pw| unsafe {
                        use objc2::runtime::AnyObject;
                        use objc2::{msg_send, rc::Retained};
                        let wk = pw.inner() as *mut AnyObject;
                        let inspector: Retained<AnyObject> = msg_send![&*wk, _inspector];
                        let () = msg_send![&inspector, detach];
                    });
                });
            }
            Ok(true)
        }
    } else {
        Ok(false)
    }
}

// 이전/이후: webview 세션 히스토리. 호출부는 전부 delta ±1(back/forward 버튼) — WKWebView.goBack/
// goForward 네이티브를 직접 호출한다(eval 미경유, JS 가 멈춰도 동작). Tauri 는 크로스플랫폼 history
// API 를 노출하지 않아 non-macos 는 플랫폼 native(WebView2/WebKitGTK) 배선 전까지 DOM history.go 로
// 폴백한다 — delta 는 타입드 i32 라 인젝션 표면이 없다(문자열 조립 아님, 정수 파라미터).
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_history(app: AppHandle, label: String, delta: i32) -> Result<(), String> {
    if let Some(wv) = registered_webview(&app, &label) {
        wv.with_webview(move |pw| unsafe {
            use objc2_web_kit::WKWebView;
            let wk = &*(pw.inner() as *const WKWebView);
            if delta < 0 {
                let _ = wk.goBack();
            } else if delta > 0 {
                let _ = wk.goForward();
            }
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// non-macos 폴백(플랫폼 native 미배선) — WebView2 ICoreWebView2::GoBack/GoForward, WebKitGTK
// webkit_web_view_go_back/forward 를 그 플랫폼에서 빌드·검증할 때 native 로 전환한다.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_history(app: AppHandle, label: String, delta: i32) -> Result<(), String> {
    if let Some(wv) = registered_webview(&app, &label) {
        wv.eval(format!("history.go({delta})"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 새로고침 — WKWebView reload.
///
/// 없어서 플러그인이 **현재 URL 로 다시 이동**해 흉내내고 있었다. 그건 새로고침이 아니라 새
/// 이동이라 이력이 한 칸 더 쌓이고, 뒤로 갔던 자리에서 새로고침하면 앞 자리로 되돌아간다 —
/// 실측 2026-08-08: 셋 중 하나만 새로고침 뒤 `len` 이 2 에서 3 이 되고 페이지가 바뀌었다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_reload(app: AppHandle, label: String, ignore_cache: Option<bool>) -> Result<(), String> {
    let wv = registered_webview(&app, &label).ok_or_else(|| format!("webview 없음: {label}"))?;
    let hard = ignore_cache.unwrap_or(false);
    wv.with_webview(move |pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let wk = pw.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        if hard {
            let _: () = msg_send![&*wk, reloadFromOrigin];
        } else {
            let _: () = msg_send![&*wk, reload];
        }
    })
    .map_err(|e| e.to_string())
}

// 이 플랫폼에는 아직 이 통로가 없다 — 이름을 달고 거절한다(조용한 성공 금지).
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_reload(_app: AppHandle, _label: String, _ignore_cache: Option<bool>) -> Result<(), String> {
    Err("webview_reload는 현재 macOS 구현이 필요합니다".into())
}

// 로딩 정지 — WKWebView stopLoading. 툴바 reload↔stop 토글(soksak-browser-kit nav-state)용.
#[tauri::command]
pub fn webview_stop(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = registered_webview(&app, &label) {
        #[cfg(target_os = "macos")]
        {
            let _ = wv.with_webview(|pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk = pw.inner() as *mut AnyObject;
                if !wk.is_null() {
                    let _: () = msg_send![&*wk, stopLoading];
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = wv;
    }
    Ok(())
}

// child 생성 시각 장부 — 갓 생성된 view 는 창 부착이 다음 틱이라 생존 프로브가 좀비로
// 오판한다(실사고: 이중 open 의 두 번째가 신생아를 정리해 영구 빈 홀). 유예 창 안의
// 라벨은 무조건 살아있다고 답한다. webview_close 가 지운다.
static CHILD_BORN_AT: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const NEWBORN_GRACE_MS: u128 = 2_000;

fn child_is_newborn(label: &str) -> bool {
    CHILD_BORN_AT
        .lock()
        .ok()
        .and_then(|m| m.get(label).map(|t| t.elapsed().as_millis() < NEWBORN_GRACE_MS))
        .unwrap_or(false)
}

// native child 실물 생존 — 라벨 registry 생존과 별개로, view 가 실제 창에 부착돼 있는가.
// 메인스레드 인라인(with_webview 동기 경로)이라 커맨드 문맥에서 동기적으로 판정된다.
fn native_child_alive(wv: &tauri::Webview) -> bool {
    #[cfg(target_os = "macos")]
    {
        let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = alive.clone();
        let _ = wv.with_webview(move |pw| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            let view = pw.inner() as *mut AnyObject;
            if view.is_null() {
                return;
            }
            let win: *mut AnyObject = msg_send![&*view, window];
            if !win.is_null() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
        alive.load(std::sync::atomic::Ordering::SeqCst)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wv;
        true
    }
}

// 실물 생존 관측면 — 소비자(플러그인 자가치유)가 "열림을 믿는 상태"와 실물을 대조한다.
// list/visible 은 registry 기준이라 좀비를 건강 오판한다 — 이 커맨드만이 실물을 답한다.
#[tauri::command]
pub fn webview_alive(app: AppHandle, label: String) -> bool {
    if child_is_newborn(&label) {
        return true; // 부착 전 신생아 — 좀비 아님
    }
    let registered = registered_webview(&app, &label);
    let alive = registered.as_ref().map(native_child_alive).unwrap_or(false);
    #[cfg(debug_assertions)]
    eprintln!(
        "[vis-trace] webview_alive {label}: registered={} alive={alive} thread_main={}",
        registered.is_some(),
        std::thread::current().name().map(|n| n == "main").unwrap_or(false),
    );
    alive
}

#[tauri::command]
pub fn webview_pane_group(
    app: AppHandle,
    window: tauri::Window,
    pane: String,
    renderer: String,
    members: Vec<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if registered_webview(&app, &renderer).is_none() {
        return Err(format!("pane renderer webview가 없습니다: {renderer}"));
    }
    for label in &members {
        let webview_registered = registered_webview(&app, label).is_some();
        #[cfg(target_os = "macos")]
        let native_surface_registered = layer::has_surface_host(label);
        #[cfg(not(target_os = "macos"))]
        let native_surface_registered = false;
        if !pane_member_available(webview_registered, native_surface_registered) {
            return Err(format!("pane member surface가 없습니다: {label}"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        layer::group_pane_surface_host(
            &pane,
            window.label(),
            &renderer,
            &members,
            (x, y, w, h),
        )?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, pane, renderer, members, x, y, w, h);
    }
    Ok(())
}

fn pane_member_available(webview_registered: bool, native_surface_registered: bool) -> bool {
    webview_registered || native_surface_registered
}

#[cfg(test)]
mod pane_member_availability_tests {
    use super::pane_member_available;

    #[test]
    fn accepts_tauri_webviews_and_registered_external_native_surfaces() {
        assert!(pane_member_available(true, false));
        assert!(pane_member_available(false, true));
        assert!(!pane_member_available(false, false));
    }
}

#[tauri::command]
pub fn webview_pane_bounds(
    pane: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    layout: Option<SurfaceLayoutContract>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { return layer::set_pane_surface_host_bounds(&pane, (x, y, w, h), layout); }
    #[cfg(not(target_os = "macos"))]
    { let _ = (pane, x, y, w, h, layout); Ok(()) }
}

#[tauri::command]
pub fn webview_pane_member_bounds(
    pane: String,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    layout: Option<PaneMemberLayoutContract>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { return layer::set_pane_surface_member_bounds(&pane, &label, (x, y, w, h), layout); }
    #[cfg(not(target_os = "macos"))]
    { let _ = (pane, label, x, y, w, h, layout); Ok(()) }
}

#[tauri::command]
pub fn webview_pane_transition_prepare(
    pane: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    start_at_unix_ms: f64,
    duration_ms: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return layer::prepare_pane_surface_host_translation(
            &pane,
            (x, y, w, h),
            start_at_unix_ms,
            duration_ms,
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (pane, x, y, w, h, start_at_unix_ms, duration_ms);
        Ok(())
    }
}

#[tauri::command]
pub fn webview_pane_hosts() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    { layer::pane_surface_host_state() }
    #[cfg(not(target_os = "macos"))]
    { serde_json::json!([]) }
}

/// Arms one finite, display-synchronized observation transaction for pane-owned native surfaces.
/// The explicit owner map is the public identity boundary; the adapter never parses pane names to
/// recover application view ids.
#[tauri::command]
pub async fn webview_presentation_trace_arm(
    app: AppHandle,
    window: tauri::Window,
    trace_id: String,
    owners: Vec<presentation_trace::PresentationTraceOwner>,
    max_events: Option<usize>,
) -> Result<serde_json::Value, String> {
    presentation_trace::arm(app, window.label().to_owned(), trace_id, owners, max_events).await
}

/// Closes the finite display trace, invalidates its native display link, and returns the immutable
/// presentation-event ledger. Reading never keeps the producer alive.
#[tauri::command]
pub async fn webview_presentation_trace_close(
    app: AppHandle,
    trace_id: String,
) -> Result<serde_json::Value, String> {
    presentation_trace::close(app, trace_id).await
}

// hide 를 거친 child 라벨 — show 시 재부착(뷰어빌리티 기상)이 필요한 대상. webview_close 가 지운다.
// 숨김의 단일 경로는 webview_visible이다. 좌표 명령은 이 장부를 건드리지 않는다.
#[cfg(target_os = "macos")]
static HIDDEN_CHILDREN: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

// hide→show 를 겪은 WKWebView 뷰어빌리티 기상 — 재부착이 didMoveToWindow 를 태워 재평가시킨다.
#[cfg(target_os = "macos")]
fn wake_child_if_was_hidden(wv: &tauri::Webview, label: &str) {
    if !HIDDEN_CHILDREN.lock().map(|mut s| s.remove(label)).unwrap_or(false) {
        return;
    }
    let _ = wv.with_webview(|pw| unsafe {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        let view = pw.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let superview: *mut AnyObject = msg_send![&*view, superview];
        if superview.is_null() {
            return;
        }
        let kept: Retained<AnyObject> = Retained::retain(view).unwrap();
        let _: () = msg_send![&*view, removeFromSuperview];
        let _: () = msg_send![&*superview, addSubview: &*kept];
    });
    // child는 전용 surface host 안에 다시 붙는다. host의 z-order와 frame은 불변이다.
}

// 탭/뷰 전환 시 표시/숨김(native 레이어는 DOM 위에 떠서 CSS visibility 가 안 닿는다).
#[tauri::command]
pub fn webview_visible(
    app: AppHandle,
    label: String,
    visible: bool,
    focus: Option<bool>,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    eprintln!("[vis-trace] webview_visible {label} visible={visible} focus={focus:?}");
    if let Some(wv) = registered_webview(&app, &label) {
        if visible {
            wv.show().map_err(|e| e.to_string())?;
            // hide→show 를 겪은 WKWebView 는 뷰어빌리티를 되찾지 못하고 레이어를 비운 채
            // 잠들 수 있다(실측: 페이지 JS 는 살아있고 frame·hidden 정상인데 픽셀만 없음 —
            // 리사이즈로도 안 깨어남). 숨겼던 child 에만 재부착 기상을 적용한다.
            #[cfg(target_os = "macos")]
            wake_child_if_was_hidden(&wv, &label);
            #[cfg(target_os = "macos")]
            layer::set_surface_host_hidden(&label, false);
            // 포커스를 임의로 옮기지 않는다 — 부모 창이 이미 활성일 때만 webview 에 포커스를 준다.
            // hide→show 첫 클릭 무시 방지는 활성 창 안(탭 전환)에서만 필요하고, 백그라운드 창의
            // 뷰 mount(부팅 리스폰·플러그인 활성화 ~수초 뒤)가 그 창을 앞으로 끌어오는 지연 포커스
            // 탈취를 없앤다. set_focus 는 child webview 지만 macOS 에서 부모 창을 key 로 만든다.
            // focus:false = 표현 전용 복귀(슬롯 동결 해동 등) — 사용자의 포커스 결정을 존중해
            // responder 를 건드리지 않는다(캡처·스탠드인 계층은 포커스를 탈취하지 않는다).
            if focus.unwrap_or(true) && wv.window().is_focused().unwrap_or(false) {
                let _ = wv.set_focus();
            }
        } else {
            #[cfg(target_os = "macos")]
            layer::set_surface_host_hidden(&label, true);
            #[cfg(target_os = "macos")]
            if let Ok(mut s) = HIDDEN_CHILDREN.lock() {
                s.insert(label.clone());
            }
            // 숨기기 전에, 이 webview(또는 그 자손)가 firstResponder 면 반납한다 — 숨은 WKWebView 가
            // responder 를 쥔 채 남으면 다음 실클릭 한 번이 responder 전환에 소모되어 앱 DOM 의 첫
            // 클릭(탭 전환 등)이 무시된다. show 쪽 set_focus(3d639a5)의 대칭: native↔native 전환은
            // show 가 즉시 responder 를 가져가 가려졌지만, offscreen 탭처럼 아무도 네이티브 포커스를
            // 가져가지 않는 전환에서 드러난다. makeFirstResponder(nil) 은 창 자신이 responder 가 되어
            // 다음 클릭이 정상 hit-test 로 즉시 전달된다.
            #[cfg(target_os = "macos")]
            {
                let _ = wv.with_webview(|pw| unsafe {
                    use objc2::runtime::AnyObject;
                    use objc2::{class, msg_send};
                    let view = pw.inner() as *mut AnyObject;
                    if view.is_null() {
                        return;
                    }
                    let win: *mut AnyObject = msg_send![&*view, window];
                    if win.is_null() {
                        return;
                    }
                    let mut r: *mut AnyObject = msg_send![&*win, firstResponder];
                    let mut is_ours = false;
                    while !r.is_null() {
                        if std::ptr::eq(r, view) {
                            is_ours = true;
                            break;
                        }
                        let is_view: bool = msg_send![&*r, isKindOfClass: class!(NSView)];
                        if !is_view {
                            break;
                        }
                        r = msg_send![&*r, superview];
                    }
                    if is_ours {
                        let _: bool =
                            msg_send![&*win, makeFirstResponder: std::ptr::null::<AnyObject>()];
                    }
                });
            }
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// 뷰가 영구히 닫힐 때 webview 정리.
#[tauri::command]
pub fn webview_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = registered_webview(&app, &label) {
        // 파괴 예고(webview_health) — 닫히는 webview 의 프로세스 종료를 크래시로 오분류하지 않는다.
        crate::webview_health::mark_expected_teardown(&app, &label);
        SURFACE_LAYOUT.remove_surface(&label);
        // 전용 surface host가 레지스트리·z-order·child containment를 함께 회수한다.
        #[cfg(target_os = "macos")]
        layer::remove_surface_host(&label);
        wv.close().map_err(|e| e.to_string())?;
        crate::activity::publish(
            &app,
            "webview.lifecycle",
            "webview",
            serde_json::json!({ "label": label, "event": "closed", "origin": "internal",
                "message": format!("· webview closed {label}") }),
        );
    }
    if let Ok(mut m) = CHILD_BORN_AT.lock() {
        m.remove(&label);
    }
    if let Ok(mut states) = PAGE_LOAD_STATES.lock() {
        states.remove(&label);
    }
    Ok(())
}

// 숨김 미디어 추출 — 오프스크린 child webview 를 잠깐 띄워 페이지가 스스로 요청하는 미디어 URL 을
// 코어 스니프 훅으로 수확하고 닫는다. 사용자에게 안 보이되(화면 밖), .hide() 가 아니라서 WKWebView 의
// occlusion 스로틀(타이머·미디어 정지)을 피한다 — 레거시가 쓰던 기법. 사이트 지식 0(R3): url 만 받고
// 페이지 자신의 요청을 가로챌 뿐 디코드·분기 없음. browser.media.sniff(보이는 탭)와 대칭인 숨김 경로.
//
// 플랫폼 중립: WKWebView 를 직접 만지지 않고 webview_eval 로 수확한다 — eval 이 동작하는 플랫폼이면
// 추출도 동작한다(macOS 하드코딩 아님). 비-macOS 의 webview_eval 미구현 갭은 별도 코어 과제이며,
// 추출은 그 위에 자동으로 올라탄다(미구현 플랫폼에선 eval 에러가 R9 로 표면화).
#[tauri::command]
pub async fn webview_media_extract(
    app: AppHandle,
    window: tauri::Window,
    url: String,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    use std::time::{Duration, Instant};
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let label = format!(
        "media-extract-{}",
        POPUP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let init_script = format!("{NEW_WINDOW_NAV}\n{MEDIA_SNIFF}");
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(init_script)
        .on_navigation(|_| true);
    // 화면 밖(-20000) — 보이지 않지만 합성기에는 살아있어 JS/미디어가 정상 동작(스로틀 회피).
    window
        .add_child(
            builder,
            LogicalPosition::new(-20000.0, -20000.0),
            LogicalSize::new(1280.0, 720.0),
        )
        .map_err(|e| e.to_string())?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15000).max(1000));
    let start = Instant::now();
    let mut triggered = false;
    let mut hits = serde_json::json!([]);
    loop {
        let raw = webview_eval(
            app.clone(),
            label.clone(),
            "return JSON.stringify(window.__soksakMedia || [])".to_string(),
        )
        .await
        .unwrap_or_else(|_| "[]".to_string());
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
            if !arr.is_empty() {
                hits = serde_json::json!(arr);
                // m3u8 이 잡혔으면 즉시 종료(아니면 더 기다려 본다).
                let has_m3u8 = serde_json::from_str::<Vec<serde_json::Value>>(&raw)
                    .ok()
                    .map(|v| {
                        v.iter().any(|h| {
                            h.get("url")
                                .and_then(|u| u.as_str())
                                .map(|s| s.contains(".m3u8"))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if has_m3u8 {
                    break;
                }
            }
        }
        if !triggered {
            triggered = true;
            let _ = webview_eval(
                app.clone(),
                label.clone(),
                "try{var v=document.querySelector('video'); if(v){v.muted=true; v.play&&v.play().catch(function(){});}}catch(e){} return null;".to_string(),
            )
            .await;
        }
        if start.elapsed() >= timeout {
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    if let Some(wv) = registered_webview(&app, &label) {
        // 파괴 예고 — 추출용 임시 webview 의 close 를 크래시로 오분류하지 않는다.
        crate::webview_health::mark_expected_teardown(&app, &label);
        let _ = wv.close();
    }
    Ok(hits)
}

// 존재하는 브라우저 child 웹뷰 라벨 목록(b-*). 프론트 GC 가 "웹뷰 집합 ⊆ 스토어의
// browser 뷰 집합" 불변식을 검증·회수하는 데 쓴다(생성/파괴 경쟁의 고아 방지).
#[tauri::command]
pub fn webview_list(app: AppHandle) -> Vec<String> {
    app.webviews()
        .keys()
        .filter(|l| l.starts_with(soksak_core::window_spec::BROWSER_PREFIX))
        .cloned()
        .collect()
}

// 내장 브라우저 새 창을 명령으로 직접 열기(browser.open where=window).
#[tauri::command]
pub fn webview_open_window(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    open_popup(&app, parsed);
    Ok(())
}

// 브라우저 페이지에서 JS 를 실행하고 "결과를 반환"한다 — AI 의 DOM 제어 통로.
// WKWebView callAsyncJavaScript(async/await 지원) + completion handler 네이티브 콜백:
// 외부 페이지 CSP/IPC 권한과 무관, 폴링 없음. js 는 async 함수 본문으로 실행되며
// (호출측 래퍼가 JSON.stringify 로 감싼) 문자열을 반환해야 한다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_eval(app: AppHandle, label: String, js: String) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let wv = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<String, String>>(1);

    wv.with_webview(move |pw| {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2::MainThreadMarker;
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::{WKContentWorld, WKWebView};

        // with_webview 클로저는 메인 스레드에서 실행된다(tauri 보장).
        unsafe {
            let wk = &*(pw.inner() as *const WKWebView);
            let mtm = MainThreadMarker::new_unchecked();
            let world = WKContentWorld::pageWorld(mtm);
            let body = NSString::from_str(&js);
            let tx = tx.clone();
            let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let outcome = if !error.is_null() {
                    Err((*error).localizedDescription().to_string())
                } else if result.is_null() {
                    Ok("null".to_string())
                } else {
                    match (*result).downcast_ref::<NSString>() {
                        Some(s) => Ok(s.to_string()),
                        None => Err("eval 결과가 문자열이 아님(JSON.stringify 필요)".into()),
                    }
                };
                let _ = tx.try_send(outcome);
            });
            wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &body,
                None,
                None,
                &world,
                Some(&block),
            );
        }
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "eval 시간 초과".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_eval(_app: AppHandle, _label: String, _js: String) -> Result<String, String> {
    Err("webview_eval 은 현재 macOS 전용".into())
}

// 열린 webview 에 init script(WKUserScript)를 주입한다 — 다음 내비게이션마다 자동 재주입.
// 코어가 하드코딩하던 NEW_WINDOW_NAV/MEDIA_SNIFF/HOVER_SCRIPT 를 브라우저 플러그인이 소유하게 하는 통로.
// phase = "document-start"(기본) | "document-end". macOS 전용(비-macOS no-op).
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_inject_script(
    app: AppHandle,
    label: String,
    code: String,
    phase: Option<String>,
) -> Result<(), String> {
    let wv = registered_webview(&app, &label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let at_start = phase.as_deref() != Some("document-end");
    wv.with_webview(move |pw| {
        use objc2::MainThreadMarker;
        use objc2_foundation::NSString;
        use objc2_web_kit::{WKUserScript, WKUserScriptInjectionTime, WKWebView};
        // with_webview 클로저는 메인 스레드(tauri 보장).
        unsafe {
            let wk = &*(pw.inner() as *const WKWebView);
            let mtm = MainThreadMarker::new_unchecked();
            let controller = wk.configuration().userContentController();
            let src = NSString::from_str(&code);
            let time = if at_start {
                WKUserScriptInjectionTime::AtDocumentStart
            } else {
                WKUserScriptInjectionTime::AtDocumentEnd
            };
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                mtm.alloc(),
                &src,
                time,
                true,
            );
            controller.addUserScript(&script);
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_inject_script(
    _app: AppHandle,
    _label: String,
    _code: String,
    _phase: Option<String>,
) -> Result<(), String> {
    Ok(()) // 비-macOS no-op
}

// webview 캡처(snapshot/record/occlusion)는 tauri-plugin-webview-capture 로 분리됨
// (별도 저장소, 멀티플랫폼). 앱은 .plugin(tauri_plugin_webview_capture::init()) 로
// 등록하고 sok 명령(window.snapshot/record/occlusion)이 plugin:webview-capture|* 를 호출.

#[cfg(target_os = "macos")]
pub(crate) mod appkit_events;

#[cfg(test)]
mod webview_tests;
