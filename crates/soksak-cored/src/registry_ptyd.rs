//! PTY 데몬 명령의 몸 — 표는 registry_table.rs 가, 판정은 코어의 ptyd 가 진다.
//!
//! 여기 있는 것은 링크를 세우고 코어에 묻는 배선뿐이다. 판정이 두 벌이면 같은 데몬을 두
//! 모양으로 답하고, 그 차이는 "판올림할 수 있는가"를 밖에서 읽는 값이라 곧 잘못된 결정이 된다.

use serde_json::Value;

use crate::ctx::Ctx;
use crate::registry::Outcome;

/// 데몬 상태 — 판정은 코어의 daemon_status 하나다. 링크는 이 프로세스의 신원으로 세운다
/// (스테이징 원천은 없다 — 여기서는 판올림하지 않고 읽기만 한다).
#[cfg(unix)]
pub(crate) fn run_pty_daemon_status(ctx: &Ctx, _params: &Value) -> Outcome {
    let link = soksak_core::ptyd::Link::new(ctx.identity().clone(), None);
    Outcome::Ok(soksak_core::ptyd::daemon_status(&link))
}

#[cfg(not(unix))]
pub(crate) fn run_pty_daemon_status(_ctx: &Ctx, _params: &Value) -> Outcome {
    Outcome::Failed("데몬은 유닉스 소켓 위에서만 선다".into())
}

/// 마지막으로 포커스했던 워크스페이스 창 — 밖에서 온 명령이 무대를 고를 때 쓴다.
///
/// 장부는 이 프로세스가 하나만 쥔다. 붙은 호스트가 `control_host_attach`·`control_windows` 로
/// 자기 창 사실을 보고하면 그 자리에서 갱신된다 — 두 프레임워크가 다 보고한다.
pub(crate) fn run_ipc_last_project_window(_ctx: &Ctx, _params: &Value) -> Outcome {
    Outcome::Ok(match crate::control::last_workspace_window() {
        Some(w) => Value::String(w),
        None => Value::Null,
    })
}
