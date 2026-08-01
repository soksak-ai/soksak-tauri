//! 클립보드 — **플랫폼 자원이라 이 프로세스가 진다.**
//!
//! 창의 것이 아니다(창이 없어도 클립보드는 있다). 프레임워크의 것도 아니다 — 프레임워크마다
//! 하나씩 두면 한쪽만 되고, 그 차이는 오류가 아니라 "저 앱에서는 복사가 안 잡힌다"로만
//! 나타난다(실측 2026-08-01: Tauri 는 감시가 됐고 Electron 은 "이 프레임워크는 그 사건을 주지
//! 않는다"로 거절했다 — 그런데 형제도 macOS 에서는 changeCount 폴링이었다. 원칙이 아니라
//! 사정이었고, 그 사정 하나가 능력을 두 벌로 만들었다).
//!
//! 변경 감시는 OS 가 준다: Win=WM_CLIPBOARDUPDATE · X11=XFixes · Wayland=wl-data-control.
//! macOS 만 NSPasteboard changeCount 폴링이다(이벤트 API 자체가 없다) — 그 넷을 `clipboard-rs`
//! 가 한 핸들러로 흡수하므로 여기서 폴링을 손으로 적지 않는다.
//!
//! **X11 은 창을 요구한다**(선택 전송을 받을 창). 이 프로세스에는 창이 없으므로 그 플랫폼에서는
//! 이름을 달고 거절하는 것이 옳다 — 능력 전체를 밖에 묶어 두는 대신 못 하는 한 자리만 말한다.
//!
//! 자기 쓰기의 메아리를 삼킨다: `write` 직후 도착하는 변경은 사용자가 복사한 것이 아니다.
//! 안 삼키면 붙여넣기 한 번이 감시자에게 무한 되먹임으로 보인다.

use std::sync::Mutex;

use clipboard_rs::{
    Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
    WatcherShutdown,
};

/// 이 프로세스가 방금 쓴 값 — 그 메아리를 가리는 표식.
static LAST_WRITTEN: Mutex<Option<String>> = Mutex::new(None);
/// 도는 감시자의 정지 손잡이. 없으면 안 돌고 있다는 뜻이다.
static SHUTDOWN: Mutex<Option<WatcherShutdown>> = Mutex::new(None);

/// 지금 클립보드의 텍스트. 비텍스트(이미지·파일)면 빈 문자열이다 — 호출자는 텍스트만 다룬다.
pub fn read() -> Result<String, String> {
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    Ok(ctx.get_text().unwrap_or_default())
}

/// 클립보드에 텍스트를 쓴다. 쓰기 **전에** 표식을 심는다 — 변경 사건이 쓰기보다 먼저 도착할 수
/// 있고, 그때 표식이 없으면 자기 쓰기를 사용자의 복사로 읽는다.
pub fn write(text: &str) -> Result<(), String> {
    *LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.to_string());
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    ctx.set_text(text.to_string()).map_err(|e| e.to_string())
}

/// 감시가 돌고 있는가 — 물어서 아는 자리.
pub fn watching() -> bool {
    SHUTDOWN.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

struct Handler<F: Fn(String) + Send + 'static> {
    emit: F,
}

impl<F: Fn(String) + Send + 'static> ClipboardHandler for Handler<F> {
    fn on_clipboard_change(&mut self) {
        let Ok(text) = read() else { return };
        if text.is_empty() {
            return;
        }
        // 자기 쓰기의 메아리는 사용자의 복사가 아니다 — 한 번만 가리고 표식을 거둔다.
        {
            let mut last = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
            if last.as_deref() == Some(text.as_str()) {
                *last = None;
                return;
            }
        }
        (self.emit)(text);
    }
}

/// 감시를 시작한다. 이미 돌고 있으면 **아무 일도 하지 않는다**(멱등) — 두 번 시작하면 감시자가
/// 둘이 되고 같은 변경이 두 번 나간다.
pub fn watch_start<F: Fn(String) + Send + 'static>(emit: F) -> Result<(), String> {
    let mut guard = SHUTDOWN.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Ok(());
    }
    let mut watcher: ClipboardWatcherContext<Handler<F>> =
        ClipboardWatcherContext::new().map_err(|e| e.to_string())?;
    let shutdown = watcher.add_handler(Handler { emit }).get_shutdown_channel();
    std::thread::spawn(move || {
        watcher.start_watch();
    });
    // 앞 세션의 잔존 표식을 걷는다 — 안 걷으면 첫 정상 복사를 메아리로 오해해 삼킨다.
    *LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *guard = Some(shutdown);
    Ok(())
}

/// 감시를 멈춘다. 안 돌고 있으면 성공이다(멱등) — 없음을 오류로 만들면 두 번 부르는 회수 경로가
/// 두 번째에 실패한다.
pub fn watch_stop() {
    if let Some(s) = SHUTDOWN.lock().unwrap_or_else(|e| e.into_inner()).take() {
        s.stop();
    }
    *LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
