//! 클립보드 명령 표면 — 몸은 형제 파일(`clipboard.rs`)이 지고 여기는 표에 거는 배선이다.
//!
//! 클립보드는 **플랫폼 자원**이라 이 프로세스가 진다. 창의 것이 아니고(창이 없어도 클립보드는
//! 있다) 프레임워크의 것도 아니다 — 프레임워크마다 하나씩 두면 한쪽만 되고, 그 차이는 오류가
//! 아니라 "저 앱에서는 복사가 안 잡힌다"로만 나타난다(실측 2026-08-01).

use serde_json::{json, Value};

use crate::ctx::Ctx;
use crate::registry::{dispatch, NoArgs, Outcome};

/// 클립보드 변경을 창에 뿌리는 사건 이름 — 프론트가 같은 이름으로 듣는다.
const CLIPBOARD_CHANGE: &str = "clipboard-change";

pub(crate) fn run_clipboard_read(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| crate::clipboard::read())
}

#[derive(serde::Deserialize)]
struct ClipboardWriteArg {
    text: String,
}

pub(crate) fn run_clipboard_write(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ClipboardWriteArg| {
        crate::clipboard::write(&a.text).map(|()| Value::Null)
    })
}

/// 감시를 시작한다 — 변경은 **방송**으로 간다(창 전부). 클립보드는 한 시스템에 하나이므로
/// 어느 창이 시작했든 같은 사건이고, 창을 골라 보내면 그 선택이 곧 두 번째 규칙이 된다.
pub(crate) fn run_clipboard_watch_start(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| {
        crate::clipboard::watch_start(|text| {
            crate::control::broadcast(CLIPBOARD_CHANGE, json!({ "text": text }));
        })
        .map(|()| Value::Null)
    })
}

pub(crate) fn run_clipboard_watch_stop(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| {
        crate::clipboard::watch_stop();
        Ok(Value::Null)
    })
}
